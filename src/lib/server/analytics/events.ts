// TASK 2.4 — analytics: the shared agent_event writer (DATA-MODEL §4.4; D-024).
//
// Analytics is FIRST-CLASS (PRODUCT principle / feedback_analytics-first-class): every
// agent lifecycle step writes a queryable `agent_event` row, and every row carries
// enough context to explain *how* and *why* the decision was made (not just *that* it
// happened). This module is the ONE chokepoint every producer routes through so the
// shape stays consistent and the how/why `detail` contract is enforced in one place.
//
// Producers (this wave):
//   • session launch (1.6b) — spawn / completion / error  (refactored to call here)
//   • routing escalation (2.3/2.16 groundwork) — escalation (from→to + reason)
//   • session control (cancel/stop) — cancel
//
// Boundary discipline (D-016): record ids pass the db/validate chokepoint and bind as
// StringRecordId so the SDK serializes a true record link; every value binds via $param;
// absent optionals are OMITTED, never set to explicit NULL (option<T> rejects NULL —
// MEMORY-SPEC §6.1). The `cost_usd` column is written ONLY when a price is known — we
// never fabricate a dollar figure (F-008); an unpriced model leaves cost_usd NONE.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** The five lifecycle types the schema's ASSERT accepts (DATA-MODEL §4.4). */
export const AGENT_EVENT_TYPES = [
	'spawn',
	'completion',
	'escalation',
	'cancel',
	'error'
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** A model selection as analytics records it (mirrors runtime ModelSelection). */
export interface AgentEventModel {
	provider: string;
	modelId: string;
	tier?: string;
}

/**
 * The how/why detail contract. EVERY field is optional, but a producer SHOULD carry the
 * rationale for its event so a reader can reconstruct the decision chain end-to-end:
 *   • spawn      → { intent, reason } (why this model/intent)
 *   • completion → { ok, summary }    (what the run concluded)
 *   • escalation → { from, to, reason } (why the tier changed — the core how/why row)
 *   • cancel     → { reason, by }     (who/what stopped it and why)
 *   • error      → { error }          (the failure)
 * The column is SCHEMAFULL-FLEXIBLE (schema migration 008), so arbitrary extra context
 * round-trips intact — record enough to explain the decision (feedback rule).
 */
export interface AgentEventDetail {
	/** Classified/forced intent that drove the route (spawn). */
	intent?: string;
	/** Human-readable WHY (spawn rationale / escalation reason / cancel reason). */
	reason?: string;
	/** Escalation: the tier/model the run came FROM. */
	from?: string;
	/** Escalation: the tier/model the run went TO. */
	to?: string;
	/** Completion outcome. */
	ok?: boolean;
	summary?: string;
	/** Error message (error events). */
	error?: string;
	/** Who initiated a cancel ('operator' | 'orchestrator' | 'budget' | …). */
	by?: string;
	/** The routing_event this lifecycle step traces back to (the how/why join key). */
	routing_event?: string;
	/** Any further structured context. */
	[k: string]: unknown;
}

/** Input to {@link writeAgentEvent}. Ids are plain `table:id` strings — validated here. */
export interface WriteAgentEventInput {
	type: AgentEventType;
	/** Session this event belongs to (omitted ⇒ NONE for a session-less event). */
	session?: string;
	/** Project (omitted ⇒ NONE). */
	project?: string;
	model?: AgentEventModel;
	tokensIn?: number;
	tokensOut?: number;
	/** Cost in USD — pass ONLY a real, priced figure; omit to leave NONE (never fake $). */
	costUsd?: number;
	durationMs?: number;
	detail?: AgentEventDetail;
	/**
	 * LIFECYCLE-GRAPH (m0067) — the EXPLICIT causal back-link: the `table:id` of the event/work that
	 * CAUSED this spawn (the triggering work_item, a completion, or a pm_tick scene_event). Set ONLY
	 * where the cause is known at spawn (the orchestrator drain knows the triggering work_item id);
	 * OMITTED otherwise → the column stays NONE and the graph falls back to timestamp inference for
	 * that edge (honest — never a fabricated parent, F-008). A free-form `table:id` STRING, not a typed
	 * record link (the cause spans heterogeneous tables — work_item / agent_event / scene_event). It is
	 * an opaque id, not free text, so it carries no secret span — bound straight via $param (NOT screened).
	 */
	parentEventId?: string;
}

/**
 * Derive a human-readable one-line label for an agent_event from its persisted `detail`
 * (TASK 14.4c — F-008). Events without a model/session (e.g. a github-sync completion)
 * DO persist their how/why in `detail` (summary/reason/error) — but the feed projections
 * dropped it, so the tray/home rendered a bare "completion — —" with no identifying
 * content. This is the ONE place that turns the detail contract into a feed label:
 * summary > reason > error, first line only, bounded. Returns null when the row truly
 * carries no usable context (the renderer then shows an HONEST fallback, never blanks).
 */
export function activityLabel(detail: unknown, maxLen = 96): string | null {
	if (!detail || typeof detail !== 'object') return null;
	const d = detail as Record<string, unknown>;
	const raw =
		(typeof d.summary === 'string' && d.summary.trim()) ||
		(typeof d.reason === 'string' && d.reason.trim()) ||
		(typeof d.error === 'string' && d.error.trim()) ||
		'';
	if (!raw) return null;
	const line = raw.split(/\r?\n/, 1)[0].trim();
	if (!line) return null;
	return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Write ONE `agent_event` row (DATA-MODEL §4.4). The single chokepoint every lifecycle
 * producer routes through. Record-id links pass the D-016 guard and bind as
 * StringRecordId; all values bind via $param; absent optionals are OMITTED (§6.1).
 * Returns the new row id (so a producer can chain a follow-up join if it wants).
 */
export async function writeAgentEvent(db: Db, input: WriteAgentEventInput): Promise<string> {
	const content = omitUndefined({
		session: input.session ? link(input.session) : undefined,
		project: input.project ? link(input.project) : undefined,
		type: input.type,
		model: input.model
			? omitUndefined({
					provider: input.model.provider,
					model_id: input.model.modelId,
					tier: input.model.tier
				})
			: undefined,
		tokens_in: input.tokensIn,
		tokens_out: input.tokensOut,
		cost_usd: input.costUsd,
		duration_ms: input.durationMs,
		// LIFECYCLE-GRAPH (m0067): an opaque `table:id` cause ref (work_item / completion / pm_tick).
		// Trimmed → an empty/blank ref is treated as "unknown" (omitted, NONE) rather than stored as ''.
		parent_event_id:
			typeof input.parentEventId === 'string' && input.parentEventId.trim()
				? input.parentEventId.trim()
				: undefined,
		detail:
			input.detail && Object.keys(omitUndefined(input.detail)).length
				? omitUndefined(input.detail)
				: undefined
	});

	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE agent_event CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return String(rows[0].id);
}
