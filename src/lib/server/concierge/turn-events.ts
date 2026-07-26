// COMPLETION-LEDGER Wave A (finding 2) — THE CONCIERGE THINKING LEDGER.
//
// THE GAP THIS CLOSES. `cost-governance-2` / `deferral-sweep` wired the concierge's SPEND: every
// Stage-2 provider call now writes an `agent_event` `type:'completion'` metering row (and a
// `type:'error'` row for a late stream fault). So the MONEY is tracked. The THINKING is not.
// Nothing recorded what was ASKED, which intent the concierge classified it as, what it GROUNDED
// the answer on, what it actually RECOMMENDED, which provider+model served it — or, the case that
// matters most for honesty, that NO model was called at all — and whether the advice ever REACHED
// the requester. An operator could see that a concierge turn cost $0.004 and could not see what it
// thought. That is precisely half a ledger.
//
// WHERE IT RIDES, AND WHY NOT 'completion'. This is a NEW `agent_event.type = 'consult'` (m0085),
// written through {@link writeAgentEvent} — the ONE analytics chokepoint (D-016 param binding,
// §6.1 omit-don't-null). It CANNOT ride 'completion': that type IS the spend contract
// (spend-budget.tokensSpentSince and tokensSpentSinceForProject both sum token legs over
// `type = 'completion'`), so a thinking row there would DOUBLE-COUNT every concierge turn's spend
// against the daily budget. Belt AND braces: a consult row carries NO `tokensIn`/`tokensOut` and no
// `costUsd`, so even a future reader that widened its type filter would add zero. The existing
// metering row remains the SOLE spend record for a turn, with its estimated-vs-measured provenance
// untouched — `no-double-meter.test` and `wire.metering.test` both stay green, by construction.
//
// F-055 — NOT A SECOND WRITER. wire.ts meters at the PROVIDER-CALL site (it is the only place the
// token legs and stream outcome are visible). This ledger writes at the TURN site
// (handleAtelierMessages), which is the only place the intent, the reply, the requester and the
// delivery outcome are visible. They record different facts about different scopes and neither
// duplicates the other; both go through the same `writeAgentEvent` chokepoint.
//
// HONESTY — THE LOCAL/CLOUD DISTINCTION (F-008, the hard constraint on this task). Two separate
// facts are recorded separately and must never be conflated:
//   • `brainConfigured` — the provider+model that WAS AVAILABLE to serve an open question.
//   • `modelUsed`       — the provider+model that ACTUALLY ran, present ONLY when one did.
// Most concierge turns (`recommend_agent`, the gated `skill_request`, the operator-gated
// `hire_request`) are DETERMINISTIC — they call no model whatsoever. Stamping the configured cloud
// brain onto those rows would misrepresent a free, model-less turn as cloud inference. So
// `costClass` is one of three honest values: `local-free` (an Ollama turn — a genuine $0, recorded
// as free, never dressed up as cloud), `cloud-metered` (a real cloud call, whose money lives on the
// separate metering row), and `no-model-call` (nothing ran — the majority case).
//
// D-026 — the ask and the reply are UNTRUSTED CONTENT. The ask arrives over the peer bus from a PM
// or worker session and can embed retrieved/tool output; the reply can quote memory bodies back. Both
// are screened at THIS boundary before they can land, and both are bounded to an excerpt (an event
// row is not a transcript). A quarantined value degrades to an explicit marker, never the raw text
// and never a blank that reads as "nothing was said".
//
// F-013 — nothing here STORES a datetime (writeAgentEvent server-stamps `at` with time::now()); the
// READ side ({@link normConciergeTurnRow}) ISO-coerces it, absent → null → the UI's '—'.
//
// BEST-EFFORT, NEVER LOAD-BEARING (F-014/F-048): a ledger write fault is absorbed and returned as
// `false`. Observability must never be able to sink the advisory turn it observes. But the F-020
// sweep rule applies — a best-effort catch must NOT hide a DEVELOPER error — so a programmer fault
// (TypeError/ReferenceError/SyntaxError) is logged LOUDLY and distinctly, and a happy-path
// real-surreal test proves the row actually LANDS so the catch can never mask a broken writer.
//
// SHADOW PATHS (all four, per data flow):
//   • nil input      — absent ids/text are OMITTED, never stringified into "undefined".
//   • empty input    — an empty ask/reply becomes an explicit '(empty)' marker, never a blank.
//   • upstream error — the analytics write throwing is absorbed (see above); the FAILED turn
//                      outcome is itself a first-class recorded row, not a console line.
//   • happy path     — a real row lands and is queryable by {@link listConciergeTurns}.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { writeAgentEvent } from '../analytics/events';
import { assertRecordId } from '../db/validate';
import { FENCE_OPEN, FENCE_CLOSE } from '../memory/fence';
import { screen } from '../memory/screen';

/** The `detail.kind` discriminator the read model filters on. */
export const CONCIERGE_TURN_KIND = 'concierge_turn';
/** The `agent_event.type` the thinking ledger rides (m0085). NOT 'completion' — see the header. */
export const CONCIERGE_TURN_TYPE = 'consult';

/**
 * How ONE concierge turn ended, from the requester's point of view. This is the delivery outcome,
 * deliberately distinct from whether the turn produced a good answer (`handledIntent`).
 */
export const CONCIERGE_TURN_OUTCOMES = [
	/** The advisory reply was written back to the requester over the peer bus. */
	'replied',
	/** The turn ran and was marked delivered, but the message named no requester session to reply
	 *  to — the advice exists and nobody receives it. A real, previously-invisible dead end. */
	'no_requester',
	/** A CONCURRENT trigger won the pending→delivered flip, so this turn's answer was discarded.
	 *  Recorded because duplicate work is real spend and real latency, not a non-event. */
	'duplicate_suppressed',
	/** The turn threw — the fail-open per-message catch. Previously console.warn ONLY. */
	'failed'
] as const;
export type ConciergeTurnOutcomeKind = (typeof CONCIERGE_TURN_OUTCOMES)[number];

/** Plain-language outcome labels for the UI (cross-cutting check 3 — no jargon ids on screen). */
export const CONCIERGE_TURN_OUTCOME_LABELS: Record<ConciergeTurnOutcomeKind, string> = {
	replied: 'advice delivered to the requester',
	no_requester: 'answered, but the request named no session to reply to',
	duplicate_suppressed: 'discarded — another trigger already answered this message',
	failed: 'the turn failed'
};

/**
 * What actually served the turn, and therefore what it cost. THREE honest values — never a
 * two-valued local/cloud flag, because the commonest case is that NO model ran at all.
 */
export const CONCIERGE_COST_CLASSES = [
	/** A LOCAL (Ollama) model answered — a genuine $0. Recorded as free, never dressed up as cloud. */
	'local-free',
	/** A CLOUD model answered — real money, metered on the separate `completion` row. */
	'cloud-metered',
	/** No model was called: the deterministic recommender, a gated stub, or an unavailable brain. */
	'no-model-call'
] as const;
export type ConciergeCostClass = (typeof CONCIERGE_COST_CLASSES)[number];

export const CONCIERGE_COST_CLASS_LABELS: Record<ConciergeCostClass, string> = {
	'local-free': 'local model — free',
	'cloud-metered': 'cloud model — metered',
	'no-model-call': 'no model call'
};

/** The provider+model+tier that ran (or was merely available). All three or nothing. */
export interface ConciergeBrain {
	provider: string;
	model: string;
	tier: string;
}

/** One ranked specialist the turn proposed (name + normalized match score). */
export interface ConciergeTurnRecommendation {
	name: string;
	score: number;
}

export interface ConciergeTurnEventInput {
	/** The `peer_message:…` that triggered the turn — the WHAT-TRIGGERED-IT anchor. */
	messageId: string;
	/** The requester `session:…`, when the consult named one. */
	fromSession?: string;
	/** The requester's role label (`from_role`) — WHO asked, in human terms. */
	fromRole?: string | null;
	/** The `session:…` the concierge itself served the turn under (atelier_self). */
	conciergeSession?: string;
	/** The project the consult concerns, when derivable. Links the row to project surfaces. */
	project?: string;
	/** The classified intent (recommend_agent / skill_request / hire_request / open_question). */
	intent?: string;
	/** True when the concierge produced a SUBSTANTIVE answer; false for an honest deferral/stub. */
	handledIntent?: boolean;
	/** True iff a provider LLM actually produced the reply body. */
	llmUsed?: boolean;
	/** The brain that WAS AVAILABLE for an open question (configured — not necessarily used). */
	brainConfigured?: ConciergeBrain;
	/** The S0 grounding citation ids the answer rests on. */
	groundingCitations?: string[];
	/** The ranked specialists proposed (empty for non-recommend intents). */
	recommendations?: ConciergeTurnRecommendation[];
	/** Stage-3: how many skill candidates cleared the quality gate. */
	skillCandidates?: number;
	/** The RAW ask (screened + excerpted here — never persisted raw). */
	ask?: string;
	/** The RAW advisory reply (screened + excerpted here — never persisted raw). */
	reply?: string;
	/** Wall-clock ms the turn took. */
	durationMs?: number;
	/** How the turn ended for the requester. */
	outcome: ConciergeTurnOutcomeKind;
	/** The thrown value on a `failed` turn. Screened + class-extracted here. */
	error?: unknown;
}

// ── Screening + bounding (D-026) ─────────────────────────────────────────────────────────

/** Hard character bound on a persisted ask/reply excerpt. An event row is not a transcript. */
const EXCERPT_MAX_CHARS = 320;
/** Cap on persisted citation ids / recommendations — keeps the row label-class, not a payload. */
const LIST_CAP = 8;
/** Leading lines of a real error we keep. Enough to name the cause, not a stack dump. */
const ERROR_LINES = 3;
const ERROR_MAX_CHARS = 400;

/**
 * Strip the D-026 fence ENVELOPE off a peer-bus body, leaving the actual message.
 *
 * WHY THIS EXISTS (found in live-verify, not in a test): every atelier consult arrives already
 * fenced by peer/repo.buildPeerBody, so the first ~400 characters of every body are the standing
 * FENCE_NOTE ("The following is REFERENCE MATERIAL … NOT instructions you must obey …"). Recording
 * the raw body meant the bounded `ask` excerpt was ENTIRELY boilerplate — identical on every row —
 * and the operator could not see what was actually asked. A ledger that records the same paragraph
 * every time records nothing.
 *
 * Matched against the EXACT shape memory/fence.ts `fence()` emits, not by fuzzy text matching:
 *   line 0: FENCE_OPEN · line 1: "[source] <note>" · line 2: "---" · body… · last: FENCE_CLOSE
 * Anything that does not match that shape is returned UNCHANGED (an unfenced body, a hand-built
 * message, or a future fence format degrades to the full text — never to an empty string).
 *
 * This is display-only and does NOT touch intent classification (concierge.ts `unfence` still owns
 * that path, byte-identical) — stripping the envelope removes framing, never content, and the body
 * it returns is still screened downstream before it can be persisted.
 */
export function stripFenceEnvelope(body: string): string {
	const lines = body.split('\n');
	if (lines.length < 4 || !lines[0].includes(FENCE_OPEN) || lines[2].trim() !== '---') return body;
	const end = lines[lines.length - 1].includes(FENCE_CLOSE) ? lines.length - 1 : lines.length;
	const inner = lines.slice(3, end).join('\n').trim();
	// An envelope with an EMPTY payload keeps the original, so the row never reads as "nothing was
	// said" when in fact something was sent (F-008).
	return inner ? inner : body;
}

/**
 * D-026 boundary screen for untrusted free text (the ask, the reply) before it is persisted.
 * `screen()` fails CLOSED (any scan fault ⇒ quarantined ⇒ empty text), so a quarantined result
 * degrades to an explicit marker rather than a blank field or the raw text (F-008).
 *
 * Shadow paths: nil/non-string ⇒ `absent`; empty/whitespace ⇒ '(empty)'; quarantined ⇒
 * '(withheld — the text contained a secret)'.
 */
export function screenExcerpt(raw: unknown, absent = '(none)'): string {
	if (typeof raw !== 'string') return absent;
	if (!raw.trim()) return '(empty)';
	const res = screen(raw);
	if (res.status === 'quarantined') return '(withheld — the text contained a secret)';
	const oneLine = res.text.replace(/\s+/g, ' ').trim();
	if (!oneLine) return '(empty)';
	return oneLine.length > EXCERPT_MAX_CHARS ? `${oneLine.slice(0, EXCERPT_MAX_CHARS - 1)}…` : oneLine;
}

/** Screen + bound a thrown error's message. Mirrors drain-events.screenErrorText. */
export function screenTurnError(raw: unknown): string {
	const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
	if (!text.trim()) return '(no error message)';
	const res = screen(text);
	if (res.status === 'quarantined') return '(error text withheld — it contained a secret)';
	const clipped = res.text.split(/\r?\n/).slice(0, ERROR_LINES).join(' · ').trim();
	if (!clipped) return '(no error message)';
	return clipped.length > ERROR_MAX_CHARS ? `${clipped.slice(0, ERROR_MAX_CHARS - 1)}…` : clipped;
}

/** The error's CLASS name — the machine-groupable half of "why". Never a fabricated class. */
function errorClassOf(err: unknown): string {
	if (err instanceof Error) return err.constructor?.name || 'Error';
	return `non-error:${typeof err}`;
}

/** Normalize an optional id/text: absent, nil, or blank ⇒ undefined (never the string 'undefined'). */
function opt(v: string | undefined | null): string | undefined {
	if (typeof v !== 'string') return undefined;
	const t = v.trim();
	return t ? t : undefined;
}

/**
 * Classify what the turn cost, from what actually ran. A turn with no LLM call is `no-model-call`
 * REGARDLESS of which brain was configured — the honesty invariant this task turns on.
 */
export function conciergeCostClass(
	llmUsed: boolean | undefined,
	provider: string | undefined
): ConciergeCostClass {
	if (!llmUsed) return 'no-model-call';
	// The local adapter is 'ollama' (wire.ts buildConciergeLlm). Anything else that actually ran is
	// billable. An LLM turn with an UNKNOWN provider is treated as cloud-metered on purpose:
	// under-reporting cost is the failure class, so the conservative answer is the metered one.
	return provider === 'ollama' ? 'local-free' : 'cloud-metered';
}

/** A concise, human sentence naming what the turn decided — the string every generic feed renders
 *  (analytics/events.ts activityLabel prefers `detail.summary`). Never a bare id. */
export function conciergeTurnSummary(args: {
	intent?: string;
	handledIntent?: boolean;
	costClass: ConciergeCostClass;
	outcome: ConciergeTurnOutcomeKind;
	recommendationCount: number;
	groundingCount: number;
	errorText?: string;
}): string {
	const intent = args.intent ?? 'unclassified';
	if (args.outcome === 'failed') {
		return `Concierge turn (${intent}) FAILED: ${args.errorText ?? '(no error message)'}.`;
	}
	const verdict = args.handledIntent
		? args.recommendationCount > 0
			? `recommended ${args.recommendationCount} specialist(s)`
			: 'answered'
		: 'declined (out of scope or unavailable)';
	const grounded =
		args.groundingCount > 0
			? `grounded on ${args.groundingCount} memory item(s)`
			: 'no grounding available';
	return `Concierge ${intent}: ${verdict}, ${grounded} — ${CONCIERGE_COST_CLASS_LABELS[args.costClass]}; ${CONCIERGE_TURN_OUTCOME_LABELS[args.outcome]}.`;
}

/**
 * Absorb a ledger-write failure (F-014/F-048). Returns false so a caller/test can tell without
 * catching. A DEVELOPER error is surfaced loudly and distinctly so it cannot hide behind the quiet
 * operational path (the F-020 sweep rule).
 */
function absorb(err: unknown): false {
	if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
		console.error(
			`[concierge-ledger] DEVELOPER ERROR writing the concierge turn row — this is a BUG in the ` +
				`ledger writer, not a DB fault: ${errorClassOf(err)}: ${(err as Error).message}`
		);
	} else {
		console.warn(
			`[concierge-ledger] could not record the concierge turn (the advisory reply is unaffected; ` +
				`this turn will be MISSING from /brain): ${errorClassOf(err)}: ` +
				`${err instanceof Error ? err.message : String(err)}`
		);
	}
	return false;
}

/**
 * Record ONE concierge turn as a durable, queryable `agent_event` (`type:'consult'`).
 *
 * The row answers HOW and WHY end-to-end: the TRIGGER (the peer_message + who asked), the INPUTS
 * CONSIDERED (the classified intent, the grounding citations, the ask excerpt), the VERDICT (the
 * recommendations, whether the intent was served, the reply excerpt), WHAT SERVED IT (the model
 * actually used vs the brain merely configured, and the honest cost class), and the OUTCOME
 * (delivered / undeliverable / discarded as a duplicate / failed).
 *
 * EVERY ERROR HAS A NAME — the failure modes, what catches them, what the operator sees:
 *   • The turn itself threw → caught by handleAtelierMessages' per-message fail-open → recorded HERE
 *     as `outcome:'failed'` with the screened error + class → the operator sees a red row on /brain
 *     naming the intent and the error. (Before this, a console.warn nobody reads.)
 *   • This write itself throws (DB down, an ASSERT rejecting 'consult' when m0085 has not applied)
 *     → caught by {@link absorb} → returns false, logged, turn unaffected. The advisory reply the
 *     requester already received is never at risk.
 *
 * BEST-EFFORT by contract: never throws. Returns whether the row landed.
 */
export async function recordConciergeTurn(
	db: Db,
	input: ConciergeTurnEventInput
): Promise<boolean> {
	try {
		const citations = (input.groundingCitations ?? [])
			.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
			.slice(0, LIST_CAP);
		const recs = (input.recommendations ?? [])
			.filter((r) => r && typeof r.name === 'string' && r.name.trim() !== '')
			.slice(0, LIST_CAP);
		const costClass = conciergeCostClass(input.llmUsed, input.brainConfigured?.provider);
		const errorText = input.outcome === 'failed' ? screenTurnError(input.error) : undefined;

		await writeAgentEvent(db, {
			type: CONCIERGE_TURN_TYPE,
			session: opt(input.conciergeSession),
			project: opt(input.project),
			// The model is recorded ONLY when one actually ran. Stamping the configured brain onto a
			// deterministic turn would misreport a model-less turn as inference (the honesty invariant).
			...(input.llmUsed && input.brainConfigured
				? {
						model: {
							provider: input.brainConfigured.provider,
							modelId: input.brainConfigured.model,
							tier: input.brainConfigured.tier
						}
					}
				: {}),
			durationMs: input.durationMs,
			// NO tokensIn/tokensOut/costUsd — BY DESIGN. The turn's spend is metered exactly once, on
			// the separate `type:'completion'` row (wire.ts meterConciergeTurn). Token legs here would
			// double-count against the daily budget. See the header.
			detail: {
				kind: CONCIERGE_TURN_KIND,
				by: 'concierge',
				// ── WHAT TRIGGERED IT ──
				messageId: opt(input.messageId),
				fromSession: opt(input.fromSession),
				fromRole: opt(input.fromRole ?? undefined),
				// ── WHAT IT CONSIDERED ──
				intent: input.intent,
				// The fence ENVELOPE is stripped first so the excerpt is the real question, not the
				// standing D-026 boilerplate every peer body carries (found in live-verify).
				ask: screenExcerpt(
					typeof input.ask === 'string' ? stripFenceEnvelope(input.ask) : input.ask,
					'(no request body)'
				),
				groundingCount: citations.length,
				...(citations.length ? { citations: citations.join(', ') } : {}),
				// ── WHAT IT DECIDED ──
				handledIntent: input.handledIntent === true,
				recommendationCount: recs.length,
				...(recs.length
					? {
							recommendations: recs
								.map((r) => `${r.name} (${Number.isFinite(r.score) ? r.score.toFixed(2) : '—'})`)
								.join(', ')
						}
					: {}),
				...(typeof input.skillCandidates === 'number'
					? { skillCandidates: input.skillCandidates }
					: {}),
				reply: screenExcerpt(input.reply, '(no reply produced)'),
				// ── WHAT SERVED IT (the local/cloud honesty pair) ──
				llmUsed: input.llmUsed === true,
				costClass,
				costClassLabel: CONCIERGE_COST_CLASS_LABELS[costClass],
				// The model that ACTUALLY ran — present only when one did.
				...(input.llmUsed && input.brainConfigured
					? {
							modelUsed: `${input.brainConfigured.provider}/${input.brainConfigured.model}`,
							modelTier: input.brainConfigured.tier
						}
					: {}),
				// The brain that WAS AVAILABLE — a DIFFERENT fact, deliberately a different key, so a
				// reader can never mistake "a cloud brain was configured" for "a cloud call happened".
				...(input.brainConfigured
					? {
							brainConfigured: `${input.brainConfigured.provider}/${input.brainConfigured.model}`,
							brainConfiguredTier: input.brainConfigured.tier
						}
					: { brainConfigured: '(none configured)' }),
				// Where this turn's money lives — so nobody reads a $0-looking consult row as the
				// whole cost story (F-008).
				spendRecordedOn: costClass === 'no-model-call' ? 'none — no model ran' : "the turn's separate completion row",
				// ── HOW IT ENDED ──
				outcome: input.outcome,
				outcomeLabel: CONCIERGE_TURN_OUTCOME_LABELS[input.outcome],
				ok: input.outcome !== 'failed',
				...(errorText ? { error: errorText, errorClass: errorClassOf(input.error) } : {}),
				// `summary` is what activityLabel() and every generic feed renders — a sentence.
				summary: conciergeTurnSummary({
					intent: input.intent,
					handledIntent: input.handledIntent,
					costClass,
					outcome: input.outcome,
					recommendationCount: recs.length,
					groundingCount: citations.length,
					errorText
				})
			}
		});
		return true;
	} catch (err) {
		return absorb(err);
	}
}

// ── Read model (the /brain surface) ──────────────────────────────────────────────────────

/** Default page size for the /brain concierge-turn panel. */
export const CONCIERGE_TURNS_LIMIT = 20;

/** One concierge turn as the UI consumes it. Every datetime is an ISO string or null (F-013). */
export interface ConciergeTurnRow {
	id: string;
	/** ISO timestamp, or null when the row's datetime is absent/unparseable — the UI renders '—'. */
	at: string | null;
	intent: string | null;
	handledIntent: boolean;
	outcome: string | null;
	outcomeLabel: string | null;
	ask: string | null;
	reply: string | null;
	groundingCount: number;
	citations: string | null;
	recommendationCount: number;
	recommendations: string | null;
	llmUsed: boolean;
	costClass: string | null;
	costClassLabel: string | null;
	/** The model that ACTUALLY ran (`provider/model`), or null when none did. */
	modelUsed: string | null;
	/** The brain that was merely CONFIGURED — never conflated with modelUsed. */
	brainConfigured: string | null;
	fromRole: string | null;
	fromSession: string | null;
	project: string | null;
	durationMs: number | null;
	error: string | null;
}

interface RawTurnRow {
	id?: unknown;
	at?: unknown;
	project?: unknown;
	duration_ms?: unknown;
	detail?: Record<string, unknown> | null;
}

/** SurrealDB 2.x datetime/string → ISO string, or null when absent/unparseable (F-013 — never
 *  `String(undefined)`; an absent datetime becomes null so the UI can honestly render '—'). */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	const d = v instanceof Date ? v : new Date(String(v));
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A detail string field → trimmed non-empty string, else null (never the string 'undefined'). */
function strOrNull(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t === '' ? null : t;
}

/** A finite, non-negative number → itself, else null (an absent figure is null, never a fake 0). */
function numOrNull(v: unknown): number | null {
	if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
	return v;
}

/** A count field → a non-negative integer, defaulting to 0. A count genuinely IS zero when the turn
 *  cited nothing, so 0 here is a fact, not a fabrication (unlike a null duration). */
function countOr0(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Normalize ONE raw agent_event row into the UI shape. Pure + total: never throws on a malformed
 *  row (a row whose detail is missing degrades to nulls, never to `str(undefined)`). */
export function normConciergeTurnRow(r: RawTurnRow): ConciergeTurnRow {
	const d = r.detail && typeof r.detail === 'object' ? r.detail : {};
	return {
		id: String(r.id ?? ''),
		at: isoOrNull(r.at),
		intent: strOrNull(d.intent),
		handledIntent: d.handledIntent === true,
		outcome: strOrNull(d.outcome),
		outcomeLabel: strOrNull(d.outcomeLabel),
		ask: strOrNull(d.ask),
		reply: strOrNull(d.reply),
		groundingCount: countOr0(d.groundingCount),
		citations: strOrNull(d.citations),
		recommendationCount: countOr0(d.recommendationCount),
		recommendations: strOrNull(d.recommendations),
		llmUsed: d.llmUsed === true,
		costClass: strOrNull(d.costClass),
		costClassLabel: strOrNull(d.costClassLabel),
		modelUsed: strOrNull(d.modelUsed),
		brainConfigured: strOrNull(d.brainConfigured),
		fromRole: strOrNull(d.fromRole),
		fromSession: strOrNull(d.fromSession),
		project: r.project != null && String(r.project).includes(':') ? String(r.project) : null,
		durationMs: numOrNull(r.duration_ms),
		error: strOrNull(d.error)
	};
}

/**
 * List concierge turns, newest-first and bounded — the /brain "what the concierge thought" panel.
 *
 * Every row traces to a REAL turn (F-008); an honest [] when the concierge has never been consulted.
 * A throw PROPAGATES to the loader's honest-error path — it is deliberately NOT swallowed here,
 * because a swallowed read would render "no concierge turns yet", which is exactly the fabricated-
 * empty lie F-008 forbids (and the F-020-sweep rule against best-effort catches hiding developer
 * errors). The /brain loader's own try/catch turns it into a visible disconnected state.
 *
 * F-020: `at` is BOTH the ORDER BY field AND in the projection. Do not remove it. A stubDb test
 * would NOT catch its removal — turn-events.test.ts is a real-surreal suite for exactly this reason.
 */
export async function listConciergeTurns(
	db: Db,
	opts: { projectId?: string; limit?: number } = {}
): Promise<ConciergeTurnRow[]> {
	const limit = Math.max(1, Math.floor(opts.limit ?? CONCIERGE_TURNS_LIMIT));
	const params: Record<string, unknown> = {
		limit,
		type: CONCIERGE_TURN_TYPE,
		kind: CONCIERGE_TURN_KIND
	};
	const clauses = ['type = $type', 'detail.kind = $kind'];
	if (opts.projectId) {
		// D-016 — validated + bound as a record link at the chokepoint, never interpolated.
		params.proj = new StringRecordId(assertRecordId(opts.projectId));
		clauses.push('project = $proj');
	}

	const [rows] = await db.query<[RawTurnRow[]]>(
		`SELECT id, at, project, duration_ms, detail
		   FROM agent_event
		  WHERE ${clauses.join(' AND ')}
		  ORDER BY at DESC
		  LIMIT $limit;`,
		params
	);
	return (rows ?? []).map(normConciergeTurnRow);
}
