// CONCIERGE — production wiring for the event trigger (Stage-1 recommender + Stage-2 LLM turn).
//
// Assembles the LIVE deps for handleAtelierMessages from the real platform seams:
//   • recall     — the live MemoryService (S0 grounding). Ollama-offline ⇒ HONEST empty grounding.
//   • listAgents — the real on-disk agent library (listLibraryAgents), scored on cheap metadata
//                  (no when-to-use body read — bounded per-trigger cost; recommend.ts supports it).
//   • llm        — the Stage-2 open-question completion on the CONFIGURED provider (defaultProvider
//                  toggle → resolveConciergeProvider → a cloud ClaudeProvider or the LOCAL Ollama
//                  model). Undefined when no provider is configured/credentialed ⇒ the open-question
//                  path degrades to an HONEST "LLM turn unavailable" reply (F-008). Mirrors the
//                  benchmark judge wiring (analytics/benchmark/judge.ts makeClaudeJudge) — the same
//                  provider seam, so the concierge turn is itself a provider sample for the benchmark.
//   • send       — the peer_message repo writer (default inside handleAtelierMessages).
//
// Split from concierge.ts so the core stays dependency-light + purely unit-testable (no harness /
// no disk / no config / no network); this module is the ONLY concierge code that touches them.

import type { Db } from '../db/client';
import { enforceTokenBudget, resolveDailyTokenBudget } from '../analytics/spend-budget';
import { writeAgentEvent } from '../analytics/events';
import { getMemoryService } from '../harness';
import { loadSoul, formatSoulBlock } from '../memory/soul';
import { listLibraryAgents } from '../agent-library/library';
import { asRecommendAgentInput, type RecommendAgentInput } from '../agent-library/recommend';
import { loadAgentPool, loadModels, loadOrchestration } from '../config/load';
import {
	ClaudeProvider,
	OllamaProvider,
	collectText,
	type ChatMessage,
	type Provider,
	type StreamChunk
} from '../providers';
import {
	handleAtelierMessages,
	resolveConciergeProvider,
	parseSkillsSearchResponse,
	type AtelierTriggerResult,
	type ConciergeGroundingItem,
	type ConciergeLlmFn,
	type ConciergeRecallFn,
	type ConciergeSessionModel,
	type ConciergeSkillSearchFn
} from './concierge';

/** Wall-clock bound on ONE concierge LLM turn (F-014) — a wedged local model can't hang the drain. */
const CONCIERGE_LLM_TIMEOUT_MS = 30_000;
/** Output cap for the concierge turn (advisory prose is short; keeps cost + latency bounded). */
const CONCIERGE_MAX_TOKENS = 1024;

// ── Stage-3 skill-discovery transport (GATED, opt-in, READ-ONLY) ──────────────────────────
//
// The skills.sh leaderboard search endpoint (find-skills). A pure HTTP GET — chosen over shelling
// out to `npx skills find` (subprocess spawn + ANSI parsing + injection surface) because it is
// structured JSON, has NO install/side-effect surface (a GET can only read), and is trivially
// bounded via AbortController. The endpoint returns `{ skills: [{ id, name, source, installs }], … }`.
const SKILLS_SEARCH_ENDPOINT = 'https://skills.sh/api/search';
/** Wall-clock bound on the search (F-014 — no spin, honest fallback on abort). */
const SKILL_SEARCH_TIMEOUT_MS = 8_000;
/** Cap the hits parsed from a response (bound cost; the gate ranks + trims further). */
const SKILL_SEARCH_MAX_RESULTS = 12;
/** Bound the outbound query length (defensive — the PM request is natural language). */
const SKILL_QUERY_MAX_LEN = 200;

/**
 * Build the Stage-3 skill-search fn — a bounded, READ-ONLY HTTP GET against skills.sh.
 *
 * OPT-IN (security-sensitive: outbound network to a third-party endpoint). Returns `undefined`
 * unless the operator sets `CONCIERGE_SKILL_SEARCH` truthy — when absent the skill_request branch
 * gives an honest manual-path explainer (strictly better than the old bare stub). The fn NEVER
 * installs and has no mutate path: it only issues a GET and parses JSON. On non-200 / bad-JSON /
 * timeout it THROWS, which the concierge turn catches → honest "unavailable" reply (no fabrication).
 */
export function buildSkillSearch(): ConciergeSkillSearchFn | undefined {
	const enabled = /^(1|true|yes|on)$/i.test(process.env.CONCIERGE_SKILL_SEARCH?.trim() ?? '');
	if (!enabled) return undefined;
	return async (query: string): Promise<ReturnType<typeof parseSkillsSearchResponse>> => {
		const q = (query ?? '').trim().slice(0, SKILL_QUERY_MAX_LEN);
		if (!q) return [];
		const url = `${SKILLS_SEARCH_ENDPOINT}?q=${encodeURIComponent(q)}`;
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), SKILL_SEARCH_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				signal: ctrl.signal,
				headers: { accept: 'application/json' }
			});
			if (!res.ok) throw new Error(`skills.sh search HTTP ${res.status}`);
			const json: unknown = await res.json();
			return parseSkillsSearchResponse(json, SKILL_SEARCH_MAX_RESULTS);
		} finally {
			clearTimeout(t);
		}
	};
}

/** Build the S0 grounding recall fn over the live MemoryService. When Ollama / the embedding model
 *  is unavailable, recall degrades to an HONEST empty grounding ([]) — never a fabricated memory. */
async function buildRecallFn(db: Db, limit: number): Promise<ConciergeRecallFn> {
	const mem = await getMemoryService(db);
	if (!mem.available) {
		return async () => [];
	}
	return async (query: string): Promise<ConciergeGroundingItem[]> => {
		// Global recall (project OMITTED — the atelier reads across the whole brain, §11).
		const res = await mem.memory.recall(query, { limit });
		return res.items.map((it) => ({ citationId: it.citationId, body: it.body, score: it.score }));
	};
}

/**
 * S4 — derive the concierge's soul/identity block from the LIVE brain (compute-on-read). Best-effort:
 * a cold brain returns null (block omitted honestly) and ANY read fault degrades to undefined — the
 * open-question turn then runs WITHOUT an identity block, never a fabricated persona (F-008). Bounded
 * (a few count() + two small ORDER BY LIMIT reads); does not touch the reply path on failure.
 */
async function buildSoulBlock(db: Db): Promise<string | undefined> {
	try {
		const block = formatSoulBlock(await loadSoul(db));
		return block ?? undefined;
	} catch (err) {
		console.warn(`[concierge] soul derivation failed (honest omit): ${(err as Error).message}`);
		return undefined;
	}
}

/** Read the on-disk library specialists as recommender inputs (metadata-only — bounded). */
function listAgents(): RecommendAgentInput[] {
	return listLibraryAgents().map((a) => asRecommendAgentInput(a));
}

/** Read a provider endpoint from models config; `fallback` when absent/unreadable (mirror reports). */
function readProviderEndpoint(dir: string, provider: string, fallback: string): string {
	for (const file of [`${dir}/models.json5`, `${dir}/models.yaml`]) {
		try {
			const models = loadModels(file) as { providers?: Record<string, { endpoint?: string }> };
			const ep = models.providers?.[provider]?.endpoint;
			if (typeof ep === 'string' && ep.trim()) return ep.trim();
		} catch {
			// try the next candidate path
		}
	}
	return fallback;
}

/**
 * METER one concierge Stage-2 turn (CG-2-1): pull the final token usage off the drained stream and
 * write the ONE `agent_event` `type:'completion'` row for it, so the turn's spend is (a) COUNTED by
 * the budget (tokensSpentSince sums every completion row) and (b) PRICED at the events.ts chokepoint
 * — a CLOUD turn ⇒ a real cost_usd from config/pricing.yaml; a LOCAL Ollama turn ⇒ a genuine $0
 * (recorded as 0, never a fabricated charge — F-008). Session-less BY DESIGN: the atelier_self session
 * is created downstream in handleAtelierMessages and is not visible at this provider-call site, but the
 * GLOBAL budget counter reads every completion row regardless of session (and the concierge gate is
 * project-less / global-only), so a session-less row is still counted. This is the turn's ONLY metering
 * site (no launchSession path), so a turn is NEVER double-metered. Absent `done` usage (a stream that
 * ended without a usage leg) ⇒ tokens OMITTED → cost_usd stays NONE (never a fabricated 0). BEST-EFFORT
 * (F-014): any write fault is NAMED + logged, never thrown — a lost meter row must not sink the advisory
 * reply the turn already produced. The happy path (a completion row lands with the right tokens/cost) is
 * asserted by wire.metering.test.ts, so this catch never silently drops spend without a covering test.
 */
async function meterConciergeTurn(
	db: Db,
	model: { provider: string; modelId: string; tier: string },
	chunks: StreamChunk[],
	durationMs: number
): Promise<void> {
	try {
		const usage = chunks.find((c): c is Extract<StreamChunk, { type: 'done' }> => c.type === 'done')?.usage;
		await writeAgentEvent(db, {
			type: 'completion',
			model: { provider: model.provider, modelId: model.modelId, tier: model.tier },
			// Only meter tokens we actually observed — an absent usage leg stays honest NONE, never a
			// fabricated 0-token completion that would price as a fake $0 (F-008).
			...(usage ? { tokensIn: usage.input, tokensOut: usage.output } : {}),
			durationMs,
			detail: { ok: true, summary: 'concierge Stage-2 open-question turn', source: 'concierge' }
		});
	} catch (err) {
		console.warn(`[concierge] metering write failed (best-effort): ${(err as Error).message}`);
	}
}

/** Wrap a Provider's stream into the ConciergeLlmFn shape (system+user → text), wall-clock bounded.
 *  Mirrors makeClaudeJudge but is provider-agnostic (works for the local Ollama model too).
 *  `providerKind` is the resolved provider label ('ollama'/'local' vs 'claude') threaded into the
 *  budget gate so a genuinely-$0 LOCAL turn is EXEMPT (COST-GOVERNANCE-SPEC §1 invariant 5) — see below;
 *  `modelId`/`tier` name the concrete brain so the metered completion row is priced correctly. */
export function providerToLlmFn(
	provider: Provider,
	db: Db,
	providerKind: string,
	modelId: string,
	tier: string
): ConciergeLlmFn {
	return async ({ system, user }) => {
		// CG-2 (COST-GOVERNANCE-SPEC) — the concierge Stage-2 turn is a direct provider call (NOT
		// launchSession). CG-2-1 wires its metering HERE: after the turn we write the one agent_event
		// completion row (meterConciergeTurn), so this turn's spend IS counted by tokensSpentSince and
		// priced at the events.ts chokepoint (cloud ⇒ real cost_usd; local ⇒ genuine $0). This is its
		// only metering site (no launchSession), so it is never double-metered.
		// The budget GATE below bounds the CLOUD path: it is a background/autonomous consult (no operator
		// override), so over budget ⇒ TokenBudgetExceededError, which runOpenQuestionTurn's own try/catch
		// turns into an HONEST "model unavailable" reply (F-008 — never a fabricated answer). Uncapped (0)
		// ⇒ a cheap no-op.
		// LOCAL EXEMPTION: the always-on local brain runs on Ollama ($0), so `provider` is threaded in
		// and enforceTokenBudget skips the GATE for it entirely (a genuinely-free turn is never refused
		// on a real-money ceiling). The gate is skipped, but the turn is STILL METERED as an honest $0
		// completion row (mirroring a launched local session, launch.ts:1150) — the exemption is about
		// not REFUSING a free turn, not about hiding it. The reservation the gate takes on the cloud path
		// is released in the finally AFTER the completion is metered, so the spend it reserved for is now
		// a durable, counted row — tight concurrency accounting (finding #1).
		const gate = await enforceTokenBudget(db, {
			budget: resolveDailyTokenBudget(),
			source: 'concierge',
			provider: providerKind
		});
		const messages: ChatMessage[] = [
			{ role: 'system', content: system },
			{ role: 'user', content: user }
		];
		const startedAt = Date.now();
		const collect = (async () => {
			const chunks: StreamChunk[] = [];
			for await (const c of provider.stream(messages)) chunks.push(c);
			return chunks;
		})();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`concierge LLM turn exceeded ${CONCIERGE_LLM_TIMEOUT_MS}ms`)),
				CONCIERGE_LLM_TIMEOUT_MS
			);
		});
		try {
			const chunks = await Promise.race([collect, timeout]);
			// METER the turn (CG-2-1) BEFORE releasing the gate reservation, so the spend the gate
			// accounted for is a durable, counted completion row by the time the reservation drops.
			await meterConciergeTurn(db, { provider: providerKind, modelId, tier }, chunks, Date.now() - startedAt);
			return collectText(chunks);
		} finally {
			if (timer) clearTimeout(timer);
			gate.release();
		}
	};
}

/**
 * Resolve the Stage-2 concierge brain from the LIVE config (defaultProvider toggle → pool tier) and
 * build the bounded LLM fn on the CONFIGURED provider. Returns `{ llm: undefined }` HONESTLY when no
 * provider is configured, or when the resolved cloud tier has no ANTHROPIC_API_KEY (the open-question
 * path then reports unavailable — never a fabricated answer). `sessionModel` is set ONLY when a real
 * LLM was built, so the atelier_self session names a brain it can actually run (honest provenance).
 */
function buildConciergeLlm(dir: string, db: Db): {
	llm: ConciergeLlmFn | undefined;
	sessionModel: ConciergeSessionModel | undefined;
} {
	let pool, orchestration;
	try {
		pool = loadAgentPool(`${dir}/agent-pool.yaml`);
		orchestration = loadOrchestration(`${dir}/orchestration.yaml`);
	} catch (err) {
		console.warn(`[concierge] config unreadable — LLM turn disabled: ${(err as Error).message}`);
		return { llm: undefined, sessionModel: undefined };
	}

	const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
	const choice = resolveConciergeProvider(orchestration.defaultProvider, pool, {
		hasCloudKey: !!apiKey
	});
	if (!choice) return { llm: undefined, sessionModel: undefined };

	let provider: Provider;
	if (choice.provider === 'ollama') {
		provider = new OllamaProvider({
			endpoint: readProviderEndpoint(dir, 'ollama', 'http://127.0.0.1:11434'),
			model: choice.model
		});
	} else {
		// A cloud (ClaudeProvider) turn needs a key; without it we cannot run it honestly.
		if (!apiKey) {
			console.warn(
				`[concierge] defaultProvider resolved to cloud tier '${choice.tier}' but no ANTHROPIC_API_KEY — LLM turn disabled (honest).`
			);
			return { llm: undefined, sessionModel: undefined };
		}
		provider = new ClaudeProvider({
			endpoint: readProviderEndpoint(dir, 'claude', 'https://api.anthropic.com'),
			model: choice.model,
			apiKey,
			maxTokens: CONCIERGE_MAX_TOKENS
		});
	}

	return {
		llm: providerToLlmFn(provider, db, choice.provider, choice.model, choice.tier),
		sessionModel: { provider: choice.provider, model_id: choice.model }
	};
}

/**
 * Fire the concierge for a landed `to_kind:'atelier'` message (best-effort, event-driven).
 * NEVER throws to the caller — a fault is caught + logged so it can never break the peer-send
 * response path (the send already succeeded; this is the async advisory follow-up).
 */
export async function triggerConcierge(db: Db): Promise<AtelierTriggerResult | null> {
	try {
		const recallLimit = 5;
		const recall = await buildRecallFn(db, recallLimit);
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		const { llm, sessionModel } = buildConciergeLlm(dir, db);
		const soulBlock = await buildSoulBlock(db);
		const skillSearch = buildSkillSearch();
		return await handleAtelierMessages({
			db,
			recall,
			listAgents,
			recallLimit,
			...(llm ? { llm } : {}),
			...(sessionModel ? { sessionModel } : {}),
			...(soulBlock ? { soulBlock } : {}),
			...(skillSearch ? { skillSearch } : {})
		});
	} catch (err) {
		console.warn(`[concierge] trigger failed (best-effort): ${(err as Error).message}`);
		return null;
	}
}
