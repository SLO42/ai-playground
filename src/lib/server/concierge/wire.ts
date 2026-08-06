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
	type ConciergeBrain,
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
/** Wall-clock bound on the turn's best-effort metering write (F-014) — see meterConciergeTurn. A
 *  DB that accepts the socket and never answers must not be able to hold a turn open. */
const CONCIERGE_METER_WRITE_TIMEOUT_MS = 5_000;

/** TEST SEAM (CG-3-1): shrink the turn's wall-clock bound so the abort path is testable in ms, not
 *  30s. `null` restores the production bound. Not exported from the barrel — tests only. */
let llmTimeoutOverrideMs: number | null = null;
export function __setConciergeLlmTimeoutForTest(ms: number | null): void {
	llmTimeoutOverrideMs = ms;
}
function llmTimeoutMs(): number {
	return llmTimeoutOverrideMs ?? CONCIERGE_LLM_TIMEOUT_MS;
}

/** TEST SEAM (CG-4-3): same, for the metering write's bound — so the stalled-write path is testable
 *  in ms. `null` restores the production bound. Not exported from the barrel — tests only. */
let meterWriteTimeoutOverrideMs: number | null = null;
export function __setConciergeMeterWriteTimeoutForTest(ms: number | null): void {
	meterWriteTimeoutOverrideMs = ms;
}
function meterWriteTimeoutMs(): number {
	return meterWriteTimeoutOverrideMs ?? CONCIERGE_METER_WRITE_TIMEOUT_MS;
}

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

/** How one concierge Stage-2 turn ENDED — the honest provenance of the metered row (CG-3-1). */
export type ConciergeTurnOutcome =
	| { kind: 'ok' }
	| { kind: 'timeout'; error: string }
	| { kind: 'error'; error: string };

/** The token legs to meter for one turn, plus WHERE they came from (measured vs estimated). */
export interface ConciergeTurnUsage {
	/** Omitted when nothing is knowable — the row then carries no tokens and cost_usd stays NONE. */
	tokensIn?: number;
	tokensOut?: number;
	/** TRUE ⇒ these numbers are a heuristic, not a provider report. Stamped onto the row. */
	estimated: boolean;
	/** How the legs were derived — the machine-readable provenance. */
	basis: 'measured-usage' | 'partial-stream' | 'worst-case-cap' | 'none';
	/** Plain-language explanation of the estimate (surfaced verbatim on the row). */
	note?: string;
	/** Set ONLY on the `worst-case-cap` basis: did the PROVIDER actually enforce the cap the output leg
	 *  was charged at? FALSE ⇒ the number is a nominal charge, not a ceiling (see ConciergeOutputCap). */
	capEnforced?: boolean;
}

/**
 * CG-4-2 — the turn's output cap, and whether the PROVIDER actually enforces it.
 *
 * The `worst-case-cap` estimate charges the output leg at this cap and calls it an UPPER bound. That
 * claim is only true when the provider was really built with the cap:
 *   • CLOUD (`ClaudeProvider`) IS constructed with `maxTokens: CONCIERGE_MAX_TOKENS` below, so the
 *     Anthropic request carries `max_tokens` and the turn genuinely cannot exceed it ⇒ enforced.
 *   • LOCAL (`OllamaProvider`) exposes NO max-output option at all — `OllamaOptions` is
 *     `{ endpoint, model, fetchImpl }` (providers/index.ts) and its request body is
 *     `{ model, messages, stream: true }` with no `options.num_predict`. A local turn is therefore
 *     UNCAPPED, and charging it 1024 with "the turn cannot have produced more than the cap" is a
 *     wrong number dressed as a guarantee (F-008). We still charge the nominal figure — metering zero
 *     would be worse — but the row says, in data and in words, that it is not a ceiling.
 *
 * DEFERRED (named, not silently dropped): giving `OllamaProvider` a real max-output option
 * (`options.num_predict`) would make the local cap enforceable too. That edit lives in
 * `src/lib/server/providers/index.ts`, outside this change's scope lock, so it is recorded rather
 * than made — see the deviation on this task.
 */
export interface ConciergeOutputCap {
	/** The output-token figure charged when nothing streamed back. */
	tokens: number;
	/** TRUE only when the constructed provider really carries the cap. */
	enforced: boolean;
}

/** The historical assumption — a cap the provider honours. Default for callers that do not say. */
const ENFORCED_OUTPUT_CAP: ConciergeOutputCap = { tokens: CONCIERGE_MAX_TOKENS, enforced: true };

/** Rough token count for a span of characters — the ~4-chars-per-token rule of thumb. ESTIMATE ONLY:
 *  every row built from it is stamped `estimated:true` with its basis, never passed off as measured. */
const CHARS_PER_TOKEN_ESTIMATE = 4;
function estimateTokensFromChars(chars: number): number {
	return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE) : 0;
}

/**
 * CG-3-1 — decide WHAT to meter for a turn, and how honestly it is known. Precedence:
 *
 *   1. The provider REPORTED a usage leg (a `done` chunk) ⇒ MEASURED. True even on an error path: a
 *      stream that reported usage and then threw is metered from the real numbers, not an estimate.
 *   2. The turn SUCCEEDED with no usage leg ⇒ meter NO tokens (basis `none`). Unchanged CG-2-1
 *      behaviour: cost_usd stays NONE rather than becoming a fabricated $0 (F-008). We do not estimate
 *      here because a clean success without usage is a provider-shape gap, not lost spend visibility.
 *   3. The turn was ABORTED (timeout) or THREW, and no usage leg arrived ⇒ ESTIMATE, because the tokens
 *      were really spent and metering nothing is exactly the un-metered-cloud-spend hole this closes.
 *      • Some output HAD streamed ⇒ estimate from the prompt + the delivered text (basis
 *        `partial-stream`). This is a LOWER bound — the provider may have generated more than we read.
 *      • NOTHING streamed ⇒ estimate the prompt and charge output at the turn's hard cap (basis
 *        `worst-case-cap`). This is an UPPER bound, deliberately: under-counting is the failure class.
 *
 * Shadow paths: a nil/non-array `chunks`, a zero-length `chunks`, and an upstream error are all handled
 * above and covered by unit tests. Pure + exported so those four paths are testable without a DB.
 */
export function resolveConciergeTurnUsage(
	chunks: StreamChunk[] | null | undefined,
	promptChars: number,
	outcome: ConciergeTurnOutcome,
	cap: ConciergeOutputCap = ENFORCED_OUTPUT_CAP
): ConciergeTurnUsage {
	const list = Array.isArray(chunks) ? chunks : [];
	const usage = list.find((c): c is Extract<StreamChunk, { type: 'done' }> => c.type === 'done')?.usage;
	if (usage) {
		return { tokensIn: usage.input, tokensOut: usage.output, estimated: false, basis: 'measured-usage' };
	}
	if (outcome.kind === 'ok') return { estimated: false, basis: 'none' };

	const streamedChars = list.reduce((n, c) => (c.type === 'text' ? n + c.text.length : n), 0);
	const tokensIn = estimateTokensFromChars(promptChars);
	if (streamedChars > 0) {
		return {
			tokensIn,
			tokensOut: estimateTokensFromChars(streamedChars),
			estimated: true,
			basis: 'partial-stream',
			note:
				`Tokens are ESTIMATED, not measured: the turn ended before the provider reported a usage total, ` +
				`so both legs are derived at ~${CHARS_PER_TOKEN_ESTIMATE} characters per token from the ${promptChars}-character ` +
				`prompt and the ${streamedChars} characters of output that did arrive. Treat it as a LOWER bound — the ` +
				`provider may have generated more than was read back.`
		};
	}
	const capPreamble =
		`Tokens are ESTIMATED, not measured: the turn ended with NO output read back and no usage total, so the ` +
		`input leg is derived at ~${CHARS_PER_TOKEN_ESTIMATE} characters per token from the ${promptChars}-character prompt and the ` +
		`output leg is charged at this turn's ${cap.tokens}-token cap.`;
	return {
		tokensIn,
		tokensOut: cap.tokens,
		estimated: true,
		basis: 'worst-case-cap',
		capEnforced: cap.enforced,
		note: cap.enforced
			? `${capPreamble} That cap IS enforced on this provider (it is built with the max-output limit), so treat ` +
				`the figure as an UPPER bound — the turn cannot have produced more than the cap, and under-counting real ` +
				`spend is the failure this guards.`
			: // CG-4-2: the local adapter takes no max-output option, so the same number is NOT a ceiling.
				`${capPreamble} That cap is NOT enforced on this provider — it takes no max-output option, so the turn ` +
				`could have produced more. Treat the figure as a NOMINAL charge, not an upper bound: it is recorded so the ` +
				`turn is not metered at zero, but the true output count for this turn is unknown.`
	};
}

/**
 * CG-4-3 — WALL-CLOCK-BOUND one best-effort analytics write.
 *
 * `writeAgentEvent` is a bare `db.query` (analytics/events.ts) with no bound of its own; only the
 * CONNECT is bounded (db/client.ts DEFAULT_CONNECT_TIMEOUT_MS). So a SurrealDB that accepts the socket
 * and then never answers leaves that promise pending FOREVER — and the turn awaiting it never settles.
 * A best-effort write is by definition allowed to fail, so it must also be allowed to be GIVEN UP ON:
 * past the bound we stop waiting and let the caller's catch NAME it (F-014 — a DB fault on a spend path
 * never hangs or crashes the caller).
 *
 * The abandoned write may still settle later. It is observed either way, so a late rejection can never
 * become an unhandled rejection (which on Node can take the process down) and a late failure is still
 * reported rather than silently swallowed.
 */
async function boundedMeterWrite(write: Promise<unknown>, what: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let overran = false;
	const bound = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			overran = true;
			reject(new Error(`${what} exceeded ${meterWriteTimeoutMs()}ms`));
		}, meterWriteTimeoutMs());
	});
	try {
		await Promise.race([write, bound]);
	} finally {
		if (timer) clearTimeout(timer);
		if (overran) {
			write.then(
				() => {},
				(err: unknown) =>
					console.warn(
						`[concierge] ${what} failed after its bound had already elapsed: ${(err as Error).message}`
					)
			);
		}
	}
}

/**
 * METER one concierge Stage-2 turn (CG-2-1, extended by CG-3-1): write the ONE `agent_event`
 * `type:'completion'` row for the turn, so its spend is (a) COUNTED by the budget (tokensSpentSince
 * sums every completion row) and (b) PRICED at the events.ts chokepoint — a CLOUD turn ⇒ a real
 * cost_usd from config/pricing.yaml; a LOCAL Ollama turn ⇒ a genuine $0 (recorded as 0, never a
 * fabricated charge — F-008), including when that local turn aborts.
 *
 * CG-3-1: this fires on EVERY terminal outcome — success, the 30s timeout, and a mid-stream throw.
 * Metering only the success branch left the exact un-metered-cloud-spend class alive on the error
 * path (a cloud turn burns tokens, times out, and was never counted). The caller guarantees it runs
 * at most ONCE per turn, so a turn is never double-metered.
 *
 * HONESTY (F-008, the hard constraint): an ESTIMATED row must be distinguishable from a MEASURED one.
 * The row carries `detail.estimated` + `detail.estimate_basis` (machine-readable) and
 * `detail.estimate_note` (plain language), and its `detail.summary` — the string every activity feed
 * renders via analytics/events.ts activityLabel — says "spend ESTIMATED, not measured" in words. So
 * the distinction survives into the UI without any surface having to know about this module.
 *
 * Session-less BY DESIGN: the atelier_self session is created downstream in handleAtelierMessages and
 * is not visible at this provider-call site, but the GLOBAL budget counter reads every completion row
 * regardless of session (and the concierge gate is project-less / global-only), so a session-less row
 * is still counted. BEST-EFFORT (F-014): any write fault is NAMED + logged, never thrown — a lost meter
 * row must not sink the advisory reply the turn already produced — and the write itself is wall-clock
 * bounded (boundedMeterWrite), so a DB that never answers is a logged fault rather than a hung turn.
 * Every branch here (happy, timeout, throw, no-double-meter) is asserted by wire.metering.test.ts
 * against a live SurrealDB, so this catch never silently drops spend without a covering test.
 */
async function meterConciergeTurn(
	db: Db,
	model: { provider: string; modelId: string; tier: string },
	chunks: StreamChunk[],
	promptChars: number,
	durationMs: number,
	outcome: ConciergeTurnOutcome,
	cap: ConciergeOutputCap
): Promise<void> {
	try {
		const usage = resolveConciergeTurnUsage(chunks, promptChars, outcome, cap);
		const spendNote = usage.estimated
			? 'spend ESTIMATED, not measured'
			: usage.basis === 'measured-usage'
				? 'spend measured from the provider usage report'
				: 'no token usage reported';
		const summary =
			outcome.kind === 'ok'
				? 'concierge Stage-2 open-question turn'
				: `concierge Stage-2 open-question turn — ${
						outcome.kind === 'timeout' ? 'TIMED OUT' : 'FAILED mid-stream'
					} (${spendNote})`;
		const write = writeAgentEvent(db, {
			type: 'completion',
			model: { provider: model.provider, modelId: model.modelId, tier: model.tier },
			// Tokens are metered when they are knowable — measured off the usage leg, or (on an abort
			// only) a labelled estimate. A clean success with no usage leg still meters NO tokens, so
			// cost_usd stays honest NONE rather than a fabricated 0 (F-008).
			...(usage.tokensIn !== undefined ? { tokensIn: usage.tokensIn } : {}),
			...(usage.tokensOut !== undefined ? { tokensOut: usage.tokensOut } : {}),
			durationMs,
			detail: {
				ok: outcome.kind === 'ok',
				summary,
				source: 'concierge',
				// The how/why of THIS row: how the turn ended, and how confident its numbers are.
				outcome: outcome.kind,
				...(outcome.kind === 'ok' ? {} : { error: outcome.error }),
				estimated: usage.estimated,
				estimate_basis: usage.basis,
				...(usage.note ? { estimate_note: usage.note } : {}),
				// CG-4-2: on the worst-case-cap basis, say whether the cap charged is a real ceiling.
				...(usage.capEnforced !== undefined ? { output_cap_enforced: usage.capEnforced } : {})
			}
		});
		// CG-4-3: BOUNDED. The caller AWAITS this write, so leaving it unbounded made a stalled DB —
		// not a wedged provider — the thing that could hold a turn open indefinitely.
		await boundedMeterWrite(write, 'metering write');
	} catch (err) {
		console.warn(`[concierge] metering write failed (best-effort): ${(err as Error).message}`);
	}
}

/**
 * CG-3-2 — record a stream fault raised AFTER the wall-clock timeout already ended the turn.
 *
 * The turn IS cancelled when the timeout wins (CG-4-1: the drain aborts the signal, stops reading and
 * finalizes the generator), but cancellation is a request, not a guarantee: a read already in flight can
 * still settle afterwards, and an adapter that ignores the signal can throw at its own pace. Such a
 * throw lands on a promise nobody is awaiting → an unhandled rejection (which on Node can take the
 * process down). Swallowing it in a bare `.catch` would trade a crash for an invisible failure, so a
 * GENUINE late fault is PERSISTED as an `agent_event` `type:'error'` row instead of a console line — a
 * real operator-visible signal that this provider is failing late.
 *
 * A cancellation error we caused ourselves is NOT a late fault and never reaches here (isCancellationError
 * filters it): reporting our own teardown as "the provider failed" would be a fabricated failure.
 *
 * The row carries NO tokens: the turn's spend was already accounted for by the estimated completion row,
 * and a second spend-bearing row would double-count. The DB write itself is best-effort; only if THAT
 * fails do we fall back to a named console warning (there is nowhere left to record it).
 */
async function recordLateStreamFault(
	db: Db,
	model: { provider: string; modelId: string; tier: string },
	err: unknown
): Promise<void> {
	const message = err instanceof Error ? err.message : String(err);
	try {
		await writeAgentEvent(db, {
			type: 'error',
			model: { provider: model.provider, modelId: model.modelId, tier: model.tier },
			detail: {
				ok: false,
				source: 'concierge',
				phase: 'post-timeout-stream',
				error: message,
				summary: `concierge Stage-2 stream failed AFTER the turn had already timed out: ${message}`,
				reason:
					'The turn was closed out earlier by the wall-clock bound and its spend was already metered as an ' +
					'estimate, so this fault adds no further spend — it is recorded so a provider that fails late is ' +
					'visible rather than silent.'
			}
		});
	} catch (writeErr) {
		console.warn(
			`[concierge] late stream-fault event write failed (best-effort): ${(writeErr as Error).message} (original fault: ${message})`
		);
	}
}

/**
 * CG-4-1 — where ONE turn's Provider comes from.
 *
 * A bare `Provider` is used as-is: the shape unit tests pass, and the only shape available to a caller
 * holding an already-built adapter. It can be cancelled at the ITERATOR level (the drain stops reading
 * and calls `return()` on the generator) but not below it.
 *
 * A FACTORY is handed the turn's `AbortSignal` and can wire it all the way down to its transport — see
 * `fetchWithSignal`. That is what makes a WEDGED HTTP provider genuinely cancellable rather than merely
 * abandoned, because `Provider.stream(messages, tools?)` (providers/index.ts) takes no signal of its own.
 */
export type ConciergeProviderSource = Provider | ((signal: AbortSignal) => Provider);

/**
 * Wrap a fetch impl so EVERY request it issues carries `signal`.
 *
 * The `Provider.stream` contract takes no AbortSignal, so this is how a turn's cancellation reaches the
 * socket: both adapters accept an injected `fetchImpl`, and the concierge builds them per-turn with this
 * wrapper. Aborting then rejects the in-flight `fetch`, which unwinds the adapter's generator (running its
 * `finally`, releasing the response reader lock) instead of leaving it suspended for the process lifetime.
 *
 * Shadow paths: `init` absent (a bare GET) ⇒ our signal is used alone; `init.signal` already present ⇒ the
 * two are COMBINED with `AbortSignal.any` so neither cancellation source is silently dropped (no adapter
 * sets one today, but dropping a caller's signal would be a latent bug). `base` defaults to global fetch.
 */
export function fetchWithSignal(signal: AbortSignal, base: typeof fetch = fetch): typeof fetch {
	return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const merged = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
		return base(input, { ...(init ?? {}), signal: merged });
	}) as typeof fetch;
}

/** Sentinel resolved by the turn's cancellation promise — distinguishable from any IteratorResult. */
const TURN_CANCELLED = Symbol('concierge-turn-cancelled');

/**
 * Is this error OUR OWN cancellation coming back at us, rather than a provider fault?
 *
 * An aborted `fetch` surfaces as a `DOMException` named `AbortError`, but both adapters re-wrap transport
 * failures as `ProviderError: <kind> request failed: <message>` — so the NAME is not reliable and the
 * message is matched too. Named explicitly because the alternative is worse than a leak: reporting a
 * teardown we initiated as "the provider failed late" is a fabricated failure (F-008).
 */
function isCancellationError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === 'AbortError' || /\babort(ed|ing)?\b/i.test(err.message);
}

/** Options for one wired concierge LLM fn. */
export interface ProviderToLlmOptions {
	/** The output cap charged by the worst-case-cap estimate, and whether the provider enforces it.
	 *  Defaults to the historical assumption (enforced) — see ConciergeOutputCap. */
	outputCap?: ConciergeOutputCap;
}

/** Wrap a Provider's stream into the ConciergeLlmFn shape (system+user → text), wall-clock bounded.
 *  Mirrors makeClaudeJudge but is provider-agnostic (works for the local Ollama model too).
 *  `providerKind` is the resolved provider label ('ollama'/'local' vs 'claude') threaded into the
 *  budget gate so a genuinely-$0 LOCAL turn is EXEMPT (COST-GOVERNANCE-SPEC §1 invariant 5) — see below;
 *  `modelId`/`tier` name the concrete brain so the metered completion row is priced correctly. */
export function providerToLlmFn(
	source: ConciergeProviderSource,
	db: Db,
	providerKind: string,
	modelId: string,
	tier: string,
	opts: ProviderToLlmOptions = {}
): ConciergeLlmFn {
	const outputCap = opts.outputCap ?? ENFORCED_OUTPUT_CAP;
	return async ({ system, user }) => {
		// CG-4-1 — the turn OWNS an AbortController, and the turn's end aborts it (see the teardown
		// attached to `raced` below — deliberately ahead of the metering await, CG-4-3).
		// Before this, the drain was a detached IIFE with no cancellation at all: when the 30s bound won
		// the race the underlying stream was never cancelled, so a wedged provider left a suspended async
		// generator, a promise that never settled, and its chunk buffer retained — for the PROCESS
		// LIFETIME. The signal is handed to a provider FACTORY (so it reaches the adapter's fetch) and is
		// also what stops the drain loop below, so cancellation works even for an adapter that ignores it.
		//
		// Built BEFORE the budget gate ON PURPOSE: a factory that throws (e.g. OllamaProvider rejecting a
		// `/v1` endpoint) must not leave a gate RESERVATION un-released, and there is no try/finally to
		// catch it in yet. Both adapter constructors are pure validate-and-store — no I/O — so nothing is
		// spent by building one the gate then refuses.
		const ctrl = new AbortController();
		const provider = typeof source === 'function' ? source(ctrl.signal) : source;

		// CG-2 (COST-GOVERNANCE-SPEC) — the concierge Stage-2 turn is a direct provider call (NOT
		// launchSession). CG-2-1 wires its metering HERE: after the turn we write the one agent_event
		// completion row (meterConciergeTurn), so this turn's spend IS counted by tokensSpentSince and
		// priced at the events.ts chokepoint (cloud ⇒ real cost_usd; local ⇒ genuine $0). This is its
		// only metering site (no launchSession), so it is never double-metered.
		// CG-3-1 closed the hole the first pass left: metering fired only on the race's SUCCESS branch,
		// so a cloud turn that burned tokens and then TIMED OUT or threw mid-stream was never counted —
		// the same un-metered-cloud-spend class, surviving on the error path. Now EVERY terminal outcome
		// meters exactly once (meterOnce), with the abort paths metering a clearly-labelled estimate
		// rather than nothing (see resolveConciergeTurnUsage for how honest those numbers are).
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
		const promptChars = (system?.length ?? 0) + (user?.length ?? 0);
		const startedAt = Date.now();
		const meterModel = { provider: providerKind, modelId, tier };

		// CG-3-1: the chunk buffer is HOISTED out of the IIFE. It used to be closure-local, so when the
		// timeout won the race the caller could see NOTHING the provider had already delivered — the
		// spend was real and permanently invisible. Held here, whatever arrived before the abort is
		// still readable by the metering path.
		const chunks: StreamChunk[] = [];

		// Kept by identity so the catch can tell "the bound fired" from "the provider threw" without
		// string-matching an error message. Declared before the drain: the orphan handler reads it.
		let timeoutErr: Error | undefined;

		/** Resolves the instant this turn is cancelled — the drain races every read against it, so no
		 *  read can outlive the turn even when the provider never answers. */
		const cancelled = new Promise<typeof TURN_CANCELLED>((resolve) => {
			if (ctrl.signal.aborted) resolve(TURN_CANCELLED);
			else ctrl.signal.addEventListener('abort', () => resolve(TURN_CANCELLED), { once: true });
		});

		/** Terminal handler for the ONE read we orphan at cancellation. Two jobs, both named: never leave
		 *  its rejection unobserved (an unhandled rejection can take Node down), and still surface a
		 *  GENUINE provider fault as a persisted event — while filtering out our own abort, which is not
		 *  a provider failure and must not be reported as one. */
		const onOrphanedRead = (err: unknown): void => {
			if (!timeoutErr) return;
			if (isCancellationError(err)) return;
			void recordLateStreamFault(db, meterModel, err);
		};

		const collect = (async (): Promise<StreamChunk[]> => {
			const iter = provider.stream(messages)[Symbol.asyncIterator]();
			try {
				for (;;) {
					const pending = iter.next();
					const r = await Promise.race([pending, cancelled]);
					if (r === TURN_CANCELLED) {
						pending.then(() => {}, onOrphanedRead);
						break;
					}
					if (r.done) break;
					chunks.push(r.value);
				}
				return chunks;
			} finally {
				// ASK the generator to finalize: this runs its own `finally`, which in providers/index.ts
				// releases the response reader lock. Deliberately NOT awaited — a generator suspended on a
				// promise that never settles would make this hang, which is the exact leak being closed
				// (the fetch-level signal is what tears that case down for real).
				void Promise.resolve(iter.return?.(undefined)).catch(() => {});
			}
		})();

		// Exactly ONE accounting of this turn's spend, whichever way it ends (never double-metered).
		// The flag flips synchronously before the await, so a late fault handler can never race in.
		let metered = false;
		const meterOnce = async (outcome: ConciergeTurnOutcome): Promise<void> => {
			if (metered) return;
			metered = true;
			await meterConciergeTurn(db, meterModel, chunks, promptChars, Date.now() - startedAt, outcome, outputCap);
		};

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timeoutErr = new Error(`concierge LLM turn exceeded ${llmTimeoutMs()}ms`);
				reject(timeoutErr);
			}, llmTimeoutMs());
		});

		// CG-3-2: `collect` can still reject in the window between the timeout winning the race and the
		// teardown aborting the turn — a throw there has no awaiter left and would be an UNHANDLED
		// rejection. Attach a terminal handler that RECORDS a genuine fault (a persisted agent_event, not
		// a console line) and ignores our own cancellation. When the race has not yet been decided by the
		// timeout, the race path owns the error and meters/surfaces it there — recording again here would
		// double-report one fault.
		collect.catch((err: unknown) => {
			if (!timeoutErr) return;
			if (isCancellationError(err)) return;
			void recordLateStreamFault(db, meterModel, err);
		});

		// CG-4-1 — CANCEL, THE INSTANT THE RACE SETTLES. However the turn ended, it is over: stop the
		// drain, finalize the generator and abort the adapter's in-flight request so nothing outlives
		// the turn. Idempotent and safe on the success path (the stream is already exhausted there).
		//
		// CG-4-3 — WHY IT IS HERE AND NOT IN THE `finally` BELOW. It used to be in that finally, i.e.
		// SEQUENCED BEHIND `await meterOnce(...)` — a DB write. A metering write that stalls therefore
		// held the cancellation hostage: the drain kept pulling, `chunks` kept growing and the provider's
		// generator was never finalized — the exact leak CG-4-1 exists to close, reachable through the
		// teardown path itself. Cancellation must never be conditional on I/O completing, so it now runs
		// in a `.finally()` on the race itself — the moment the race settles, ahead of everything the
		// turn awaits afterwards. Nothing metered moves: `resolveConciergeTurnUsage` snapshots `chunks`
		// synchronously as meterConciergeTurn's first statement, and CG-2's ordering invariant is about
		// the GATE RESERVATION dropping after the meter row lands (gate.release stays below) — not
		// about the abort.
		//
		// The turn's timer dies here too: past the race it can only fire spuriously, and setting
		// `timeoutErr` late would mislabel a genuine post-turn fault as one of ours.
		const raced = Promise.race([collect, timeout]).finally(() => {
			if (timer) clearTimeout(timer);
			ctrl.abort();
		});

		try {
			const done = await raced;
			// METER the turn (CG-2-1) BEFORE releasing the gate reservation, so the spend the gate
			// accounted for is a durable, counted completion row by the time the reservation drops.
			await meterOnce({ kind: 'ok' });
			return collectText(done);
		} catch (err) {
			// CG-3-1: the turn still SPENT. Meter it before rethrowing, so the budget sees it. The
			// rethrow is intact — runOpenQuestionTurn turns it into the honest "model unavailable"
			// reply (concierge.ts:641), never a fabricated answer.
			const message = err instanceof Error ? err.message : String(err);
			await meterOnce(err === timeoutErr ? { kind: 'timeout', error: message } : { kind: 'error', error: message });
			throw err;
		} finally {
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
	/** COMPLETION-LEDGER Wave A — the resolved brain, for the thinking ledger (see below). */
	llmBrain: ConciergeBrain | undefined;
} {
	let pool, orchestration;
	try {
		pool = loadAgentPool(`${dir}/agent-pool.yaml`);
		orchestration = loadOrchestration(`${dir}/orchestration.yaml`);
	} catch (err) {
		console.warn(`[concierge] config unreadable — LLM turn disabled: ${(err as Error).message}`);
		return { llm: undefined, sessionModel: undefined, llmBrain: undefined };
	}

	const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
	const choice = resolveConciergeProvider(orchestration.defaultProvider, pool, {
		hasCloudKey: !!apiKey
	});
	if (!choice) return { llm: undefined, sessionModel: undefined, llmBrain: undefined };

	// CG-4-1 — the adapter is built PER TURN from the turn's AbortSignal (not once, here), so the
	// signal reaches its `fetch` and a wedged request is torn down when the turn's bound fires. The
	// endpoint is resolved ONCE, outside the factory: config reads must not repeat per turn.
	let source: ConciergeProviderSource;
	// CG-4-2 — is CONCIERGE_MAX_TOKENS actually enforced on this provider? See ConciergeOutputCap.
	let outputCap: ConciergeOutputCap;
	if (choice.provider === 'ollama') {
		const endpoint = readProviderEndpoint(dir, 'ollama', 'http://127.0.0.1:11434');
		source = (signal) =>
			new OllamaProvider({ endpoint, model: choice.model, fetchImpl: fetchWithSignal(signal) });
		// OllamaOptions has no max-output field, so the local turn is UNCAPPED — the worst-case-cap
		// estimate records its 1024 as a NOMINAL charge rather than claiming a ceiling it cannot hold.
		outputCap = { tokens: CONCIERGE_MAX_TOKENS, enforced: false };
	} else {
		// A cloud (ClaudeProvider) turn needs a key; without it we cannot run it honestly.
		if (!apiKey) {
			console.warn(
				`[concierge] defaultProvider resolved to cloud tier '${choice.tier}' but no ANTHROPIC_API_KEY — LLM turn disabled (honest).`
			);
			return { llm: undefined, sessionModel: undefined, llmBrain: undefined };
		}
		const endpoint = readProviderEndpoint(dir, 'claude', 'https://api.anthropic.com');
		source = (signal) =>
			new ClaudeProvider({
				endpoint,
				model: choice.model,
				apiKey,
				maxTokens: CONCIERGE_MAX_TOKENS,
				fetchImpl: fetchWithSignal(signal)
			});
		// The request really carries `max_tokens`, so the cap IS a ceiling for this turn.
		outputCap = ENFORCED_OUTPUT_CAP;
	}

	return {
		llm: providerToLlmFn(source, db, choice.provider, choice.model, choice.tier, { outputCap }),
		sessionModel: { provider: choice.provider, model_id: choice.model },
		// The brain that IS available to serve an open question. The thinking ledger records it as
		// `brainConfigured` and stamps `modelUsed` ONLY when a model actually ran — so a deterministic
		// turn under a configured CLOUD brain is never misreported as a cloud call (F-008).
		llmBrain: { provider: choice.provider, model: choice.model, tier: choice.tier }
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
		const { llm, sessionModel, llmBrain } = buildConciergeLlm(dir, db);
		const soulBlock = await buildSoulBlock(db);
		const skillSearch = buildSkillSearch();
		return await handleAtelierMessages({
			db,
			recall,
			listAgents,
			recallLimit,
			...(llm ? { llm } : {}),
			...(sessionModel ? { sessionModel } : {}),
			...(llmBrain ? { llmBrain } : {}),
			...(soulBlock ? { soulBlock } : {}),
			...(skillSearch ? { skillSearch } : {})
		});
	} catch (err) {
		console.warn(`[concierge] trigger failed (best-effort): ${(err as Error).message}`);
		return null;
	}
}
