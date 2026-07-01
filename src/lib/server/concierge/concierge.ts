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
// DETERMINISTIC (Stage-1). recommend.ts is a pure scorer and recall is a pure vector+graph read —
// the Stage-1 turn needs NO LLM, so it is a deterministic, unit-testable handler (not a model
// spawn). That keeps it $0, bounded, and flake-free. A richer LLM-authored turn is a later stage.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { FENCE_OPEN, FENCE_CLOSE } from '../memory/fence';
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

export interface ConciergeDeps {
	db: Db;
	recall: ConciergeRecallFn;
	listAgents: ConciergeListAgentsFn;
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
	db: Db
): Promise<{ sessionId: string; created: boolean }> {
	const existing = await findRunningAtelierSession(db);
	if (existing) return { sessionId: existing, created: false };
	const [created] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT $content RETURN AFTER;`,
		{
			content: {
				kind: 'discussion',
				model: { provider: ATELIER_MODEL.provider, model_id: ATELIER_MODEL.model_id },
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

/** Does this atelier message ask for an agent recommendation? Stage-1 handles exactly this intent;
 *  anything else gets an honest scope note (below). Deliberately simple + explicit — a richer intent
 *  taxonomy is a later stage. */
export function isRecommendRequest(bodyText: string): boolean {
	const t = bodyText.toLowerCase();
	return t.includes('recommend') && t.includes('agent');
}

export interface ConciergeTurnResult {
	/** True when the request was an agent-recommendation ask (else a scope note was produced). */
	handledIntent: boolean;
	/** The advisory reply text (non-steering) the concierge will send back over the bus. */
	replyText: string;
	/** The grounding citation ids the reply cites (S0 — traceable to real memory rows). */
	groundingCitations: string[];
	/** The ranked specialist recommendations (propose-only). */
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

/**
 * Run ONE concierge turn: ground on the brain, score the library, compose an advisory reply.
 * PURE given the injected `recall` + `listAgents` (no DB, no LLM) — the unit-test seam. NON-STEERING
 * by construction (the reply is framed as advice + carries no directive). HONEST: empty grounding /
 * empty recommendations surface as explicit "none available" lines, never fabricated (F-008).
 */
export async function runConciergeTurn(
	deps: Pick<ConciergeDeps, 'recall' | 'listAgents' | 'recallLimit' | 'recommendLimit'>,
	requestBody: string
): Promise<ConciergeTurnResult> {
	const signal = unfence(requestBody);
	const recallLimit = deps.recallLimit ?? 5;
	const recommendLimit = deps.recommendLimit ?? 5;

	// S0 grounding — read the brain, cite what we used. Best-effort: an embedder-offline / brain
	// fault degrades to an HONEST empty grounding (the reply says so), never a fabricated citation.
	let grounding: ConciergeGroundingItem[] = [];
	try {
		grounding = (await deps.recall(signal)).slice(0, recallLimit);
	} catch {
		grounding = [];
	}

	if (!isRecommendRequest(signal)) {
		// Honest Stage-1 scope note — still grounded (the concierge read the brain) but declines to
		// invent an answer to an intent it does not yet handle.
		const replyText = [
			ADVISORY_HEADER,
			'I am the Stage-1 concierge and currently answer AGENT-RECOMMENDATION requests only ' +
				'(ask me to "recommend an agent" for a task). I did not act on this message.',
			NON_STEERING_FOOTER
		].join('\n');
		return {
			handledIntent: false,
			replyText,
			groundingCitations: grounding.map((g) => g.citationId),
			recommendations: []
		};
	}

	// The propose-only recommender over the REAL on-disk library, scored against the request signal.
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
		handledIntent: true,
		replyText: lines.join('\n'),
		groundingCitations: grounding.map((g) => g.citationId),
		recommendations
	};
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

	const { sessionId, created } = await ensureAtelierSession(db);
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
