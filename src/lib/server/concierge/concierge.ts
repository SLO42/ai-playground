// CONCIERGE (D-040 self-hosting seam) — Stage-1 event-triggered atelier identity.
//
// WHAT THIS IS. The Stage-1 realization of the reserved D-040 "atelier self" identity
// (COGNITIVE-ARCHITECTURE.md §6). The concierge is the platform's apex advisor: a PM (or the
// operator) messages `to_kind:'atelier'` over the fleet bus asking for an agent recommendation;
// the concierge GROUNDS on the brain (S0 — reads live memory, cites what it used), answers via
// the EXISTING propose-only recommender (agent-library/recommend.ts), and REPLIES over the bus.
//
// EVENT-TRIGGERED, NOT persistent (operator decision). The concierge is NOT a 24/7 process — idle
// cost is $0. It is a reachable identity SPAWNED ON DEMAND: when a pending `atelier` message
// exists, the trigger (api/peer/send) fires handleAtelierMessages, which brings up a SHORT-LIVED
// project-less `atelier_self` session (so resolveAtelier resolves it LIVE while the turn runs),
// answers, replies, and ENDS the session (bounded — no idle spin, F-014).
//
// NON-STEERING (D-035a, LOCKED). The reply is ADVICE ONLY — "no agent commands another agent."
// The concierge never spawns anything, never issues a directive: it returns a recommendation the
// PM/operator weighs and acts on (or not). It writes exactly ONE thing: a peer_message reply
// (screened+fenced as DATA by the repo, D-026) back to the requester.
//
// HONEST (F-008). Every recommendation is scored against the REAL request text over the REAL
// on-disk library; every grounding citation is a REAL recalled memory row. No brain, no library,
// or an embedder-offline recall degrade to HONEST empty states surfaced in the reply — never a
// fabricated agent or a fabricated memory.
//
// DETERMINISTIC where it can be; LLM where it must be (Stage-2). recommend.ts is a pure scorer and
// recall is a pure vector+graph read, so the AGENT-RECOMMENDATION intent stays a deterministic, $0,
// unit-testable handler (no model spawn — no-regression). An OPEN-ENDED question instead takes ONE
// bounded turn on the CONFIGURED provider (cloud ClaudeProvider or the LOCAL Ollama model — the
// always-on-local-brain experiment; wire.ts resolves it from the defaultProvider toggle). Skill /
// hire asks are honestly DEFERRED (find-skills is gated; hiring is operator-gated §7) — never
// auto-drafted. Every branch is bounded + advisory; the LLM path degrades to HONEST states on no
// provider / model error (F-008), never a fabricated answer.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { FENCE_OPEN, FENCE_CLOSE } from '../memory/fence';
import { screen } from '../memory/screen';
import type { AgentPool, DefaultProvider } from '../config/load';
import { ATELIER_SELF_PM } from '../peer/resolve';
import { sendPeerMessage, type SendPeerMessageInput } from '../peer/repo';
import {
	recommendAgentsForTask,
	type AgentRecommendation,
	type RecommendAgentInput
} from '../agent-library/recommend';

// ── Injectable seams (production wiring in wire.ts; tests inject deterministic stubs) ────

/** One grounding memory item the concierge read + will cite (a projection of a RecallItem). */
export interface ConciergeGroundingItem {
	/** The recall citation id ([#N]) — surfaced in the reply so the advice is traceable to a row. */
	citationId: string;
	/** The already-screened memory body (D-029 raw-windowed, post-quarantine). Excerpted in the reply. */
	body: string;
	/** WMR score (0..1) — shown so the PM can weigh how relevant the grounding was. */
	score: number;
}

/** S0 grounding: read the live brain for context on `query`. Returns [] when the brain is empty
 *  or the embedder is offline (HONEST — the reply then says grounding was unavailable, F-008). */
export type ConciergeRecallFn = (query: string) => Promise<ConciergeGroundingItem[]>;

/** The library specialists to score (their published metadata). Production = listLibraryAgents. */
export type ConciergeListAgentsFn = () => RecommendAgentInput[];

/** The peer-bus reply writer. Production = (input) => sendPeerMessage(db, input). */
export type ConciergeSendFn = (input: SendPeerMessageInput) => Promise<unknown>;

/**
 * Stage-2 LLM seam: ONE bounded completion for an OPEN-ENDED question (system+user prompt →
 * raw text). Mirrors the benchmark JudgeModel shape exactly (analytics/benchmark/judge.ts). Prod
 * wires it (wire.ts) to the CONFIGURED provider — a cloud ClaudeProvider or the LOCAL Ollama model
 * — so the concierge turn is itself a provider sample. Unit tests inject a deterministic stub (NO
 * real model call). Absent (undefined) ⇒ the open-question path degrades to an HONEST "LLM turn
 * unavailable" reply, never a fabricated answer (F-008).
 */
export type ConciergeLlmFn = (prompt: { system: string; user: string }) => Promise<string>;

/** The model identity stamped on the atelier_self session (honest provenance of WHO answered). */
export interface ConciergeSessionModel {
	provider: string;
	model_id: string;
}

export interface ConciergeDeps {
	db: Db;
	recall: ConciergeRecallFn;
	listAgents: ConciergeListAgentsFn;
	/**
	 * Stage-2 open-question LLM turn (optional). Absent ⇒ open-ended questions get an honest
	 * "LLM turn unavailable (no provider configured)" reply. recommend/skill/hire intents never
	 * touch it (they are deterministic / honest-deferred).
	 */
	llm?: ConciergeLlmFn;
	/** Defaults to sendPeerMessage(db, …). Injectable so a unit test asserts the reply without a DB write. */
	send?: ConciergeSendFn;
	/** Clock seam (tests). Defaults to () => new Date(). */
	now?: () => Date;
	/** Max grounding memories to recall + cite (default 5). */
	recallLimit?: number;
	/** Max specialist recommendations to return (default 5). */
	recommendLimit?: number;
	/** Max pending atelier messages handled per trigger (bound the drain, F-014). Default 20. */
	maxPerTrigger?: number;
	/**
	 * Provider-aware identity stamped on the atelier_self session (default = the deterministic
	 * Stage-1 identity). wire.ts passes the RESOLVED concierge brain (e.g. ollama/gpt-oss:20b) so
	 * the session is an honest provider sample for the model-benchmark.
	 */
	sessionModel?: ConciergeSessionModel;
	/**
	 * S4 — the DERIVED soul/identity block (concise, screened, bounded) injected into the Stage-2
	 * open-question turn context so the concierge grounds its VOICE in Atelier's real accumulated
	 * identity (memory/soul.ts loadSoul→formatSoulBlock; wire.ts computes it best-effort). Absent
	 * (undefined) when the brain is cold OR the read faulted ⇒ the turn runs WITHOUT an identity
	 * block (honest omission, F-008 — never a fabricated persona). Only the open-question path uses it.
	 */
	soulBlock?: string;
}

// ── The atelier_self session (short-lived, project-less, LIVE only while the turn runs) ──

const ATELIER_AGENT_ID = 'atelier_self';
/** The Stage-1 concierge runs no model — the session `model` honestly names the deterministic
 *  handler (not a fabricated LLM). This is metadata describing WHO answered, not a fake metric. */
const ATELIER_MODEL = { provider: 'atelier', model_id: 'concierge-stage1' } as const;

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** The already-running atelier_self session id, or null. resolveAtelier keys off exactly this
 *  (a running session whose `pm` = ATELIER_SELF_PM). */
async function findRunningAtelierSession(db: Db): Promise<string | null> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM session WHERE status = "running" AND pm = $pm LIMIT 1;`,
		{ pm: ATELIER_SELF_PM }
	);
	const id = rows?.[0]?.id;
	return id != null ? String(id) : null;
}

/** Bring up the concierge presence: reuse a running atelier_self session if one exists, else
 *  CREATE a fresh SHORT-LIVED one (project-less, kind='discussion' — an existing enum value, no
 *  widening; §6). Stamps `pm`=ATELIER_SELF_PM (m0074) so loadFleetSnapshot keys it under
 *  ATELIER_PROJECT_KEY and resolveAtelier resolves an 'atelier' address to it LIVE. Returns the id
 *  + whether WE created it (only a session we created is ended after the turn — never a reused one). */
export async function ensureAtelierSession(
	db: Db,
	sessionModel?: ConciergeSessionModel
): Promise<{ sessionId: string; created: boolean }> {
	const existing = await findRunningAtelierSession(db);
	if (existing) return { sessionId: existing, created: false };
	// Stamp the resolved concierge brain (provider-aware, Stage-2) when supplied, else the honest
	// Stage-1 deterministic identity. Either way `model` names WHO answered — never a fake metric.
	const model = sessionModel ?? { provider: ATELIER_MODEL.provider, model_id: ATELIER_MODEL.model_id };
	const [created] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT $content RETURN AFTER;`,
		{
			content: {
				kind: 'discussion',
				model,
				runtime: 'claude-code',
				// m0069 scene identity + m0074 pm identity: both name the singular platform concierge.
				agent: ATELIER_AGENT_ID,
				pm: ATELIER_SELF_PM
				// project/task OMITTED — the atelier is the ONE project-LESS (global) identity (§11).
			}
		}
	);
	return { sessionId: String(created[0].id), created: true };
}

/** End a concierge session WE created (bounded — no idle presence, $0 idle). Best-effort. */
export async function endAtelierSession(db: Db, sessionId: string, now: () => Date): Promise<void> {
	await db.query(`UPDATE $sid MERGE $content;`, {
		sid: link(sessionId),
		content: { status: 'done', ended_at: now() }
	});
}

// ── The pending 'atelier' inbox (drained by IDENTITY — drain.ts drains only by session/role) ──

/** A pending atelier-addressed message the concierge must answer (minimal projection). */
export interface AtelierInboxMessage {
	id: string;
	fromSession: string;
	fromRole: string | null;
	/** The screened+fenced request body (never raw — repo.buildPeerBody wrote it). */
	body: string;
}

/** Fetch the pending `to_kind:'atelier'` inbox (oldest first, bounded). drain.ts resolves inboxes
 *  by session-id / role@project only (the pm/atelier IDENTITY is not session-drainable), so the
 *  concierge drains its own identity inbox here. Honest empty ([]) when nothing is pending. */
export async function fetchPendingAtelierInbox(db: Db, limit: number): Promise<AtelierInboxMessage[]> {
	// created_at is in the projection because SurrealDB requires an ORDER BY idiom to be a selected
	// field ("Missing order idiom" parse error otherwise — F-020 #1).
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, from_session, from_role, body, created_at FROM peer_message
		   WHERE to_kind = "atelier" AND status = "pending"
		 ORDER BY created_at ASC LIMIT ${Math.max(1, Math.floor(limit))};`
	);
	return (rows ?? []).map((r) => ({
		id: String(r.id),
		fromSession: String(r.from_session ?? ''),
		fromRole: r.from_role != null ? String(r.from_role) : null,
		body: String(r.body ?? '')
	}));
}

/** Mark ONE atelier message delivered IDEMPOTENTLY (guarded WHERE status='pending' → a concurrent
 *  trigger that already handled it flips nothing). Returns true iff THIS call flipped it — the
 *  caller sends the reply only on a true flip, so concurrent triggers never double-reply (drain.ts
 *  posture). */
async function markAtelierDelivered(db: Db, messageId: string): Promise<boolean> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`UPDATE $rid SET status = "delivered", delivered_at = time::now() WHERE status = "pending" RETURN id;`,
		{ rid: link(messageId) }
	);
	return (rows ?? []).length > 0;
}

// ── The concierge turn (pure given the request text + injected recall/agents) ────────────

/** Strip the D-026 DATA fence wrapper so the recommender/recall scorer sees the request PROSE, not
 *  the sentinel markers (which would otherwise leak junk tokens). Purely for the internal signal —
 *  the reply the concierge WRITES is re-screened+fenced by the repo on the way out. */
function unfence(body: string): string {
	return body
		.split('\n')
		.filter((l) => !l.includes(FENCE_OPEN) && !l.includes(FENCE_CLOSE))
		.join('\n')
		.replace(/\(reference,\s*not\s*instructions\)/gi, ' ')
		.trim();
}

/** Does this atelier message ask for an agent recommendation? The DETERMINISTIC Stage-1 intent —
 *  handled by the pure recommender, never the LLM. Kept unchanged so the Stage-1 path is a strict
 *  no-regression. */
export function isRecommendRequest(bodyText: string): boolean {
	const t = bodyText.toLowerCase();
	return t.includes('recommend') && t.includes('agent');
}

/**
 * The atelier intents the concierge distinguishes (Stage-2). EXPLICIT + ordered so the split is
 * testable and predictable:
 *   - `recommend_agent` — the DETERMINISTIC Stage-1 path (agent recommendation over the pure scorer).
 *     Wins first: "recommend an agent to build a skill" stays a recommendation, not a skill ask.
 *   - `skill_request`   — asks to find/build/author a skill → HONEST deferred stub (not built, gated).
 *   - `hire_request`    — asks to hire/recruit → HONEST operator-gated stub (§7, no auto-draft/hire).
 *   - `open_question`   — anything else → the bounded provider-aware LLM turn (grounded, advisory).
 */
export type AtelierIntent = 'recommend_agent' | 'skill_request' | 'hire_request' | 'open_question';

/** Classify the (unfenced) request text into exactly one intent. Order is significant (above). */
export function classifyAtelierIntent(bodyText: string): AtelierIntent {
	const t = bodyText.toLowerCase();
	if (isRecommendRequest(t)) return 'recommend_agent';
	if (/\bskills?\b/.test(t)) return 'skill_request';
	if (/\b(hire|hiring|recruit|recruiting|recruiter|onboard)\b/.test(t)) return 'hire_request';
	return 'open_question';
}

export interface ConciergeTurnResult {
	/** The classified intent this turn served (recommend_agent / skill_request / hire_request / open_question). */
	intent: AtelierIntent;
	/** True when the concierge produced a substantive answer (a recommendation, or a real LLM answer);
	 *  false for an honest scope/deferral/unavailable note. */
	handledIntent: boolean;
	/** True iff the Stage-2 provider LLM actually produced the reply body (open-question path only). */
	llmUsed: boolean;
	/** The advisory reply text (non-steering) the concierge will send back over the bus. */
	replyText: string;
	/** The grounding citation ids the reply cites (S0 — traceable to real memory rows). */
	groundingCitations: string[];
	/** The ranked specialist recommendations (propose-only; empty for non-recommend intents). */
	recommendations: AgentRecommendation[];
}

const ADVISORY_HEADER = '[Atelier Concierge — advisory, non-steering]';
const NON_STEERING_FOOTER =
	'These are recommendations only — you (the PM/operator) decide whether to act. The concierge ' +
	'advises; it never commands or spawns an agent.';

/** Excerpt a memory body for the citation line (bounded, single-line). */
function excerpt(body: string, max = 140): string {
	const oneLine = body.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** The system prompt for the Stage-2 open-question turn. Hard-codes the non-steering + ground-only +
 *  honesty contract INTO the model instruction (belt with the wrap-braces suspenders below). */
const OPEN_QUESTION_SYSTEM =
	'You are the Atelier Concierge — the platform\'s apex ADVISOR. A project manager or the operator ' +
	'has asked you an open-ended question over the internal advisory bus. RULES:\n' +
	'- ADVISE ONLY. You NEVER command, spawn, hire, or direct any agent — no agent commands another. ' +
	'Offer options and considerations; the PM/operator decides and acts.\n' +
	'- GROUND your answer ONLY in the MEMORY ITEMS provided. Cite the item id (e.g. [#1]) inline when you use it.\n' +
	'- If the memory items do not contain enough to answer, SAY SO HONESTLY — never invent facts, ' +
	'citations, agents, metrics, or capabilities.\n' +
	'- Be concise (a few sentences). Output prose only, no code fences.';

/** Assemble the (screened) user prompt: the question + the grounding block. */
function buildOpenQuestionUserPrompt(question: string, grounding: ConciergeGroundingItem[]): string {
	const memBlock = grounding.length
		? grounding.map((g) => `${g.citationId} (score ${g.score.toFixed(2)}): ${excerpt(g.body, 400)}`).join('\n')
		: '(no relevant memory available — the brain is empty or the embedder is offline)';
	const raw =
		`QUESTION:\n${question}\n\n` +
		`MEMORY ITEMS (your ONLY grounding — cite by id, do not invent beyond these):\n${memBlock}\n\n` +
		`Answer as advice only.`;
	// Belt-and-suspenders D-026: grounding bodies are screened at source; re-screen the ASSEMBLED
	// prompt so any newly-composed span is caught before it leaves the process (mirror the judge).
	return screen(raw).text;
}

/** Compose the Stage-2 open-question turn: ONE bounded provider LLM call, grounded + advisory.
 *  HONEST states (F-008): no provider → unavailable; model error/empty → honest note, never a
 *  fabricated answer. The reply is ALWAYS wrapped advisory (header + footer) so the shape is
 *  non-steering regardless of model text; the model text is D-026-screened before surfacing. */
async function runOpenQuestionTurn(
	deps: Pick<ConciergeTurnDeps, 'llm'>,
	question: string,
	grounding: ConciergeGroundingItem[],
	soulBlock?: string
): Promise<ConciergeTurnResult> {
	const citations = grounding.map((g) => g.citationId);
	// S4: prepend the DERIVED self-model so the model speaks grounded in Atelier's real identity.
	// Absent (cold brain / read fault) ⇒ the base system prompt is used UNCHANGED (honest omission).
	const system = soulBlock
		? `${OPEN_QUESTION_SYSTEM}\n\nYOUR IDENTITY (a self-model DERIVED from your real accumulated brain — ` +
			'speak grounded in this; do NOT invent traits, knowledge, or values beyond it):\n' +
			soulBlock
		: OPEN_QUESTION_SYSTEM;
	const base = {
		intent: 'open_question' as const,
		groundingCitations: citations,
		recommendations: [] as AgentRecommendation[]
	};

	if (!deps.llm) {
		return {
			...base,
			handledIntent: false,
			llmUsed: false,
			replyText: [
				ADVISORY_HEADER,
				'I could not answer this open-ended question: no model provider is configured for the ' +
					'concierge right now (set a defaultProvider / provider credentials). I did not fabricate an answer.',
				NON_STEERING_FOOTER
			].join('\n')
		};
	}

	let answer = '';
	try {
		const raw = await deps.llm({
			system,
			user: buildOpenQuestionUserPrompt(question, grounding)
		});
		answer = screen(typeof raw === 'string' ? raw : '').text.trim();
	} catch (err) {
		return {
			...base,
			handledIntent: false,
			llmUsed: false,
			replyText: [
				ADVISORY_HEADER,
				`I could not answer this open-ended question: the model was unavailable (${(err as Error).message}). ` +
					'I did not fabricate an answer.',
				NON_STEERING_FOOTER
			].join('\n')
		};
	}

	if (!answer) {
		return {
			...base,
			handledIntent: false,
			llmUsed: false,
			replyText: [
				ADVISORY_HEADER,
				'The model returned no usable answer for this question — nothing to report (no fabricated answer).',
				NON_STEERING_FOOTER
			].join('\n')
		};
	}

	return {
		...base,
		handledIntent: true,
		llmUsed: true,
		replyText: [ADVISORY_HEADER, answer, NON_STEERING_FOOTER].join('\n')
	};
}

/** The deterministic deps a single turn needs (no DB). */
export type ConciergeTurnDeps = Pick<
	ConciergeDeps,
	'recall' | 'listAgents' | 'recallLimit' | 'recommendLimit' | 'llm' | 'soulBlock'
>;

/**
 * Run ONE concierge turn. Classifies the intent, then:
 *   - recommend_agent → the DETERMINISTIC Stage-1 recommender (no LLM — pure, no-regression).
 *   - skill_request   → HONEST deferred stub (skill find/author not yet available, gated).
 *   - hire_request    → HONEST operator-gated stub (§7 — advises, never drafts/executes a hire).
 *   - open_question   → the bounded provider-aware LLM turn (grounded, advisory).
 * Grounding (S0) is read ONCE and shared. PURE given the injected `recall`/`listAgents`/`llm` — the
 * unit-test seam. NON-STEERING by construction (every branch wraps advisory framing + carries no
 * directive). HONEST: empty grounding / no provider / model error surface as explicit notes (F-008).
 */
export async function runConciergeTurn(
	deps: ConciergeTurnDeps,
	requestBody: string
): Promise<ConciergeTurnResult> {
	const signal = unfence(requestBody);
	const recallLimit = deps.recallLimit ?? 5;
	const recommendLimit = deps.recommendLimit ?? 5;
	const intent = classifyAtelierIntent(signal);

	// S0 grounding — read the brain, cite what we used. Best-effort: an embedder-offline / brain
	// fault degrades to an HONEST empty grounding (the reply says so), never a fabricated citation.
	let grounding: ConciergeGroundingItem[] = [];
	try {
		grounding = (await deps.recall(signal)).slice(0, recallLimit);
	} catch {
		grounding = [];
	}
	const citations = grounding.map((g) => g.citationId);

	if (intent === 'skill_request') {
		// Skill find/authoring is a CAPTURED roadmap item, not built here — decline honestly (no auto-draft).
		return {
			intent,
			handledIntent: false,
			llmUsed: false,
			groundingCitations: citations,
			recommendations: [],
			replyText: [
				ADVISORY_HEADER,
				'Finding or authoring a skill is not yet available — it is a captured, operator-gated ' +
					'roadmap item. I did not draft or install a skill. You can ask me to "recommend an agent" ' +
					'for a task, or ask an open question I can ground on the brain.',
				NON_STEERING_FOOTER
			].join('\n')
		};
	}

	if (intent === 'hire_request') {
		// Hiring is operator-gated (§7, D-039) — the concierge advises, it never drafts or executes a hire.
		return {
			intent,
			handledIntent: false,
			llmUsed: false,
			groundingCitations: citations,
			recommendations: [],
			replyText: [
				ADVISORY_HEADER,
				'Hiring is operator-gated: I advise on staffing but I never draft, certify, or execute a ' +
					'hire — bring the hire to the operator (the HR/recruiter ceremony owns it). I did not act on this.',
				NON_STEERING_FOOTER
			].join('\n')
		};
	}

	if (intent === 'open_question') {
		return runOpenQuestionTurn(deps, signal, grounding, deps.soulBlock);
	}

	// intent === 'recommend_agent' — the DETERMINISTIC Stage-1 path (unchanged).
	const recommendations = recommendAgentsForTask(
		{ description: signal },
		deps.listAgents(),
		{ limit: recommendLimit }
	);

	const lines: string[] = [ADVISORY_HEADER];

	if (grounding.length) {
		lines.push(`Grounded on ${grounding.length} memory item(s):`);
		for (const g of grounding) {
			lines.push(`  ${g.citationId} (score ${g.score.toFixed(2)}): ${excerpt(g.body)}`);
		}
	} else {
		lines.push('Grounding: no relevant memory available (brain empty or embedder offline).');
	}

	if (recommendations.length) {
		lines.push('Recommended specialist(s):');
		for (const r of recommendations) {
			lines.push(`  ${r.name} (match ${r.normalized.toFixed(2)}) — ${r.rationale}`);
		}
	} else {
		lines.push('No matching specialist in the library for this request.');
	}

	lines.push(NON_STEERING_FOOTER);

	return {
		intent,
		handledIntent: true,
		llmUsed: false,
		replyText: lines.join('\n'),
		groundingCitations: citations,
		recommendations
	};
}

// ── Provider resolution (pure) — honor the operator's defaultProvider toggle ───────────────

/** The resolved concierge brain: which provider ADAPTER + model runs the Stage-2 LLM turn. */
export interface ConciergeProviderChoice {
	/** The provider adapter name — 'ollama' (local) or a cloud provider (else → ClaudeProvider). */
	provider: string;
	/** The concrete model id (from the LIVE pool tier — never hardcoded). */
	model: string;
	/** The pool tier that supplied the choice (provenance). */
	tier: string;
}

/**
 * Map the operator's global `defaultProvider` toggle → a concrete provider+model for the concierge
 * LLM turn, read from the LIVE pool tiers (mirrors boot.ts resolveProviderOverride + judge's
 * resolveJudgeModel — never hardcoded). PURE (no I/O) so the toggle logic is unit-tested directly.
 *   - 'local'  → the `local` tier (the always-on-local-brain experiment).
 *   - 'cloud'  → a cloud tier (prefer `sonnet`, else the first non-ollama tier in the escalation ladder).
 *   - 'auto'/absent → cloud when a cloud key is present + a cloud tier exists, else local, else cloud.
 * Returns null (HONEST, F-008) when the needed tier is not configured — the caller then reports the
 * open-question path as unavailable rather than forcing a provider the pool can't serve.
 */
export function resolveConciergeProvider(
	dp: DefaultProvider | undefined,
	pool: AgentPool,
	opts: { hasCloudKey: boolean }
): ConciergeProviderChoice | null {
	const nonOllama = (name: string): boolean =>
		!!pool.tiers[name] && pool.tiers[name].provider !== 'ollama';
	const cloudTier = (): string | undefined => {
		if (nonOllama('sonnet')) return 'sonnet';
		const fromLadder = pool.escalation?.order?.find(nonOllama);
		if (fromLadder) return fromLadder;
		return Object.keys(pool.tiers).find(nonOllama);
	};
	const localTier = (): string | undefined => (pool.tiers.local ? 'local' : undefined);

	let tierName: string | undefined;
	if (dp === 'local') {
		tierName = localTier();
	} else if (dp === 'cloud') {
		tierName = cloudTier();
	} else {
		// 'auto' / absent: prefer cloud when a cloud key + cloud tier exist, else fall back to local.
		if (opts.hasCloudKey && cloudTier()) tierName = cloudTier();
		else tierName = localTier() ?? cloudTier();
	}
	if (!tierName) return null;
	const t = pool.tiers[tierName];
	return { provider: t.provider, model: t.model, tier: tierName };
}

// ── The event trigger (drain the atelier inbox, answer, reply, tear down) ─────────────────

export interface AtelierTriggerResult {
	/** Pending atelier messages that flipped delivered this trigger (we answered each). */
	handled: number;
	/** Advisory replies actually sent back over the bus. */
	replies: number;
	/** The concierge session id that served this trigger (LIVE for the resolveAtelier window). */
	sessionId: string | null;
}

/**
 * The Stage-1 concierge EVENT TRIGGER. Called best-effort when a `to_kind:'atelier'` message lands
 * (api/peer/send). Pipeline:
 *   1. Drain the pending atelier identity inbox (bounded). Empty ⇒ nothing to do (honest no-op).
 *   2. Bring the atelier_self session LIVE (resolveAtelier now resolves 'atelier' to it).
 *   3. Per message: run the turn (ground + recommend), mark it delivered IDEMPOTENTLY, and — only on
 *      a successful flip (single-reply guard vs. concurrent triggers) — send the advisory reply back
 *      to the requester session over the bus. A per-message fault is logged + skipped (fail-open).
 *   4. Tear the session DOWN if WE created it (bounded — no idle presence, $0 idle).
 *
 * Returns honest counts. NEVER throws to the caller (best-effort trigger, F-014): a fault is caught,
 * the session is still torn down, and the counts reflect what actually happened.
 */
export async function handleAtelierMessages(deps: ConciergeDeps): Promise<AtelierTriggerResult> {
	const { db } = deps;
	const now = deps.now ?? (() => new Date());
	const send: ConciergeSendFn = deps.send ?? ((input) => sendPeerMessage(db, input));
	const maxPerTrigger = deps.maxPerTrigger ?? 20;

	const inbox = await fetchPendingAtelierInbox(db, maxPerTrigger);
	if (inbox.length === 0) return { handled: 0, replies: 0, sessionId: null };

	const { sessionId, created } = await ensureAtelierSession(db, deps.sessionModel);
	let handled = 0;
	let replies = 0;

	try {
		for (const msg of inbox) {
			try {
				const turn = await runConciergeTurn(deps, msg.body);
				// IDEMPOTENT single-reply guard: flip pending→delivered FIRST; only the trigger that
				// wins the flip sends the reply (a concurrent trigger sees no flip → skips → no double-send).
				const flipped = await markAtelierDelivered(db, msg.id);
				if (!flipped) continue;
				handled++;
				// Reply to the requester session directly (advisory, non-steering). The atelier is the
				// one cross-project identity, so it may reach any requester; the reply persists pending
				// and drains when the requester next spawns (or live-delivers if it is running). The body
				// is screened+fenced by the repo (D-026) on the way out.
				if (msg.fromSession) {
					await send({
						from_session: sessionId,
						to_kind: 'session',
						to_session: msg.fromSession,
						body: turn.replyText
					});
					replies++;
				}
			} catch (perMsgErr) {
				// Fail-open per message (F-014): one bad message never sinks the whole drain — it stays
				// delivered/pending per what already flipped, and the rest are still handled.
				console.warn(
					`[concierge] failed handling atelier message ${msg.id} (fail-open): ${(perMsgErr as Error).message}`
				);
			}
		}
	} finally {
		// Tear down the presence we brought up (bounded — no idle spin). Best-effort; a reused
		// pre-existing session is left running (we did not create it).
		if (created) {
			await endAtelierSession(db, sessionId, now).catch((err) =>
				console.warn(`[concierge] failed ending atelier session ${sessionId}: ${(err as Error).message}`)
			);
		}
	}

	return { handled, replies, sessionId };
}
