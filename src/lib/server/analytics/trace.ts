// TASK 2.4 — analytics: the how/why trace for a single action (VERIFY clause).
//
// "Pick an action and trace its how/why chain." An action = one task's run. The chain is
// reconstructed from REAL rows (F-008) across the analytics tables that already record
// the decision rationale:
//
//   routing_event (WHY this model — method + reason + intent + alternatives, D-020)
//     → session   (the run, with its chosen model + status)
//       → retrieval_outcome* (WHY the agent had the context it did — which recalled
//                             memory informed the run + whether using it succeeded,
//                             D-030/§4.13 — the recall link in the how/why chain)
//       → agent_event* (spawn → … → escalation? → completion/error — WHAT happened,
//                       each carrying its own how/why `detail`)
//
// Every step is queried, never invented; a task with no run yields an empty chain, not a
// fabricated one. Record ids bind via StringRecordId through the D-016 guard.
//
// TASK 4.4 (v1.0 observability closeout): the recall link (retrieval_outcome) was the one
// missing rung — the chain could say WHICH model and WHAT it did, but not WHY the agent had
// the context that shaped the action. Folding retrieval_outcome in closes "answer how/why
// for ANY agent action": the recalled memory's content + its measured utility now appear in
// the same time-ordered chain, joined to the session, read-only (it is ranker input only,
// D-030 — the trace never mutates it).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** One step in the how/why chain, normalized for rendering. */
export interface TraceStep {
	/** Which table this step came from. */
	source: 'routing_event' | 'session' | 'retrieval_outcome' | 'agent_event';
	/** The row id. */
	id: string;
	/** When it happened (ISO). */
	at: string;
	/** A short label (e.g. 'route: classify', 'spawn', 'completion'). */
	label: string;
	/** The WHY/how text for this step (routing reason / event detail summary). */
	why: string;
	/** Raw structured detail for drill-down (model, tokens, alternatives, etc.). */
	detail: Record<string, unknown>;
}

export interface ActionTrace {
	/** The task whose action was traced (record id). */
	taskId: string;
	/** Ordered chain, oldest → newest. */
	steps: TraceStep[];
}

function iso(at: unknown): string {
	if (at instanceof Date) return at.toISOString();
	return typeof at === 'string' ? at : new Date().toISOString();
}

/**
 * Reconstruct the how/why chain for one task's action. Walks:
 *   routing_event(s) for the task → session(s) for the task → agent_event(s) per session,
 * merging them into one time-ordered list of {source, why, detail} steps.
 *
 * Pure reads; binds the task id as a record link via the D-016 chokepoint.
 */
export async function traceAction(db: Db, taskId: string): Promise<ActionTrace> {
	const tid = new StringRecordId(assertRecordId(taskId));

	// 1. Routing decisions for the task (WHY this model was chosen — D-020 rationale).
	const [routes] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, at, method, reason, complexity, chosen, alternatives
		   FROM routing_event WHERE task = $tid ORDER BY at ASC;`,
		{ tid }
	);

	// 2. Sessions for the task (the runs the route produced).
	const [sessions] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, started_at, status, model FROM session WHERE task = $tid ORDER BY started_at ASC;`,
		{ tid }
	);

	const steps: TraceStep[] = [];

	for (const r of routes ?? []) {
		const chosen = (r.chosen ?? {}) as Record<string, unknown>;
		steps.push({
			source: 'routing_event',
			id: String(r.id),
			at: iso(r.at),
			label: `route: ${String(r.method ?? 'unknown')}`,
			why: String(r.reason ?? 'no rationale recorded'),
			detail: {
				method: r.method,
				complexity: r.complexity,
				chosen,
				alternatives: r.alternatives ?? []
			}
		});
	}

	// 3. Lifecycle events per session (WHAT happened, each with its own how/why detail).
	for (const s of sessions ?? []) {
		const sid = String(s.id);
		steps.push({
			source: 'session',
			id: sid,
			at: iso(s.started_at),
			label: `session ${String(s.status ?? 'running')}`,
			why: `run started for task; model ${describeModel(s.model)}`,
			detail: { status: s.status, model: s.model }
		});

		const sidLink = new StringRecordId(assertRecordId(sid));

		// 3a. Retrieval outcomes for the session (WHY the agent had its context — which
		// recalled memory informed the run + whether using it helped). Joins the memory's
		// content so the chain shows the actual recalled text, not just an id. Read-only:
		// retrieval_outcome is ranker input only (D-030); the trace never writes it.
		const [outcomes] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT id, created_at, citation_id, utilized, cited, tool_success, score, was_neighbor,
			        memory, memory.content AS memory_content, memory.kind AS memory_kind
			   FROM retrieval_outcome WHERE session = $sid ORDER BY created_at ASC, score DESC;`,
			{ sid: sidLink }
		);
		for (const o of outcomes ?? []) {
			steps.push({
				source: 'retrieval_outcome',
				id: String(o.id),
				at: iso(o.created_at),
				label: 'recall',
				why: whyForRecall(o),
				detail: {
					memory: o.memory != null ? String(o.memory) : undefined,
					memory_kind: o.memory_kind,
					memory_content: o.memory_content,
					citation_id: o.citation_id,
					cited: o.cited,
					utilized: o.utilized,
					tool_success: o.tool_success,
					score: o.score,
					was_neighbor: o.was_neighbor
				}
			});
		}

		const [evs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT id, at, type, model, tokens_in, tokens_out, cost_usd, duration_ms, detail
			   FROM agent_event WHERE session = $sid ORDER BY at ASC;`,
			{ sid: sidLink }
		);
		for (const e of evs ?? []) {
			steps.push({
				source: 'agent_event',
				id: String(e.id),
				at: iso(e.at),
				label: String(e.type ?? 'event'),
				why: whyForEvent(e),
				detail: {
					model: e.model,
					tokens_in: e.tokens_in,
					tokens_out: e.tokens_out,
					cost_usd: e.cost_usd,
					duration_ms: e.duration_ms,
					...(e.detail && typeof e.detail === 'object' ? (e.detail as object) : {})
				}
			});
		}
	}

	steps.sort((a, b) => a.at.localeCompare(b.at));
	return { taskId, steps };
}

function describeModel(model: unknown): string {
	if (!model || typeof model !== 'object') return 'unknown';
	const m = model as Record<string, unknown>;
	return `${m.provider ?? '?'}/${m.model_id ?? '?'}${m.tier ? ` (${m.tier})` : ''}`;
}

/**
 * Derive the human WHY for one retrieval_outcome — the recall rung of the chain. Explains
 * WHICH recalled memory the agent had and whether it earned its place: a short content
 * preview + the measured utility (cited / utilized / tool outcome). `tool_success` is
 * `undefined` (NONE) when no tool ran that turn — reported honestly as "no tool signal",
 * never fabricated (F-008).
 */
function whyForRecall(o: Record<string, unknown>): string {
	const preview = previewContent(o.memory_content);
	const score = typeof o.score === 'number' ? o.score.toFixed(2) : '?';
	const neighbor = o.was_neighbor === true ? ' (graph neighbor)' : '';
	let utility: string;
	if (o.cited === true) utility = 'cited in the response';
	else if (o.utilized === true) utility = 'utilized (implicit path-hit)';
	else utility = 'recalled, not cited';
	const tool =
		o.tool_success === true
			? '; turn tools succeeded'
			: o.tool_success === false
				? '; turn tools failed'
				: '; no tool signal';
	return `recalled${neighbor} [score ${score}]: ${preview} — ${utility}${tool}`;
}

/** A one-line preview of recalled memory content (trimmed; never the full body). */
function previewContent(content: unknown): string {
	if (typeof content !== 'string' || content.length === 0) return '(no content)';
	const oneLine = content.replace(/\s+/g, ' ').trim();
	return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

/** Derive the human WHY for one agent_event from its type + detail. */
function whyForEvent(e: Record<string, unknown>): string {
	const d = (e.detail ?? {}) as Record<string, unknown>;
	switch (e.type) {
		case 'spawn':
			return d.reason ? String(d.reason) : `spawned${d.intent ? ` for ${d.intent}` : ''}`;
		case 'escalation':
			return `escalated ${d.from ?? '?'} → ${d.to ?? '?'}${d.reason ? `: ${d.reason}` : ''}`;
		case 'completion':
			return d.summary ? String(d.summary) : d.ok === false ? 'completed with failure' : 'completed';
		case 'cancel':
			return `cancelled${d.by ? ` by ${d.by}` : ''}${d.reason ? `: ${d.reason}` : ''}`;
		case 'error':
			return d.error ? `error: ${d.error}` : 'error';
		default:
			return String(e.type ?? 'event');
	}
}
