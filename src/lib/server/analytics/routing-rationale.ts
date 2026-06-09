// TASK 11.1 — RoutingRationale analytics (UI-SPEC §206; F-008; F-013; D-016; §2.5).
//
// The operator's stated core requirement: see HOW and WHY every routing decision was made.
// This is the CONSUMER side — it only QUERIES `routing_event` (routing is that table's sole
// producer — §2.5; resolve.ts writes it) plus a read-only outcome join, never writing either.
//
// A decision row carries everything the route already persisted: the task → chosen
// tier/model/provider, the METHOD that fired (explicit override / classify / tier / fallback),
// the WHY (the human `reason`, with the classified intent folded in), the `complexity` score,
// and the `alternatives` considered-but-rejected. The OUTCOME is derived read-only by joining
// the decision's task to its session status (running/done/failed/cancelled) — so the operator
// sees not just what was chosen but how the run turned out. A decision whose task never ran
// shows outcome `pending` honestly (F-008) — never a fabricated result.
//
// The aggregate panel rolls the same real rows up into: decisions by tier, decisions by model,
// decisions by method, and the OVERRIDE RATE (explicit decisions ÷ total) — the single number
// that tells the operator how often they reached past the router. Every count traces to a real
// row; an empty window yields empty aggregates, never zero-dressed-as-real.
//
// F-013 GOTCHA: SurrealDB 2.x datetime fields come back as a non-POJO `DateTime` class, not a
// JS `Date` — coerced to an ISO string in the row normalizer here (and regression-tested through
// the same projection). D-016: the only interpolated identifier is a validated record id
// (StringRecordId); every value binds via $param; absent optionals are simply omitted.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** How a routing decision turned out, derived read-only from the task's session status. */
export type DecisionOutcome = 'done' | 'failed' | 'cancelled' | 'running' | 'pending';

/** One routing decision, normalized for the RoutingRationale view (all fields from a real row). */
export interface RoutingDecision {
	/** routing_event row id. */
	id: string;
	/** ISO timestamp (coerced from the SurrealDB DateTime — F-013). */
	at: string;
	/** Linked task id (`task:…`) or null for a task-less decision (e.g. chat routing). */
	taskId: string | null;
	/** Linked project id (`project:…`) or null. */
	projectId: string | null;
	/** Chosen provider (e.g. "claude", "ollama"). */
	provider: string;
	/** Chosen model id. */
	model: string;
	/** Chosen tier name (opus/sonnet/haiku/local), or null when the route carried none. */
	tier: string | null;
	/** Which step decided the route: explicit | classify | tier | fallback. */
	method: string;
	/** The human WHY — the persisted rationale (intent folded in). */
	reason: string;
	/** Complexity score in [0,1], or null for an explicit override (no scoring runs). */
	complexity: number | null;
	/** Tiers/providers considered-but-rejected, for drill-down (raw objects). */
	alternatives: Array<Record<string, unknown>>;
	/** Read-only outcome derived from the task's session status (F-008 — "pending" if none). */
	outcome: DecisionOutcome;
}

/** A {name → count} aggregate bucket, sorted desc, for the aggregate panel. */
export interface RationaleBucket {
	name: string;
	count: number;
}

/** The aggregate panel: decisions rolled up by tier / model / method + the override rate. */
export interface RationaleAggregate {
	/** Total decisions in the window. */
	total: number;
	/** Decisions by chosen tier (desc). */
	byTier: RationaleBucket[];
	/** Decisions by chosen provider/model (desc). */
	byModel: RationaleBucket[];
	/** Decisions by method (explicit/classify/tier/fallback) (desc). */
	byMethod: RationaleBucket[];
	/** Explicit-override decisions ÷ total in [0,1]; null when there were no decisions. */
	overrideRate: number | null;
	/** Count of explicit-override decisions (the numerator of overrideRate). */
	overrides: number;
}

/** The full RoutingRationale read model the loader serves. */
export interface RoutingRationale {
	decisions: RoutingDecision[];
	aggregate: RationaleAggregate;
}

export interface RoutingRationaleOptions {
	/** How many days back to include (default 14). */
	windowDays?: number;
	/** Restrict to one project (`project:…`); omitted ⇒ portfolio-wide. */
	projectId?: string;
	/** Restrict to one chosen model id (exact match on chosen.model_id). */
	model?: string;
	/** Hard cap on decision rows returned (default 500). */
	limit?: number;
}

/**
 * Normalise a SurrealDB datetime to an ISO string (F-013). The 2.x JS SDK returns a
 * `DateTime` class instance (NOT a JS `Date`); both expose `toISOString()`, so accept
 * either, then a plain string. Anything else ⇒ '' (rendered "—"; honest).
 */
function iso(at: unknown): string {
	if (at instanceof Date) return at.toISOString();
	if (typeof at === 'string') return at;
	if (at && typeof (at as { toISOString?: unknown }).toISOString === 'function') {
		try {
			return (at as { toISOString: () => string }).toISOString();
		} catch {
			return '';
		}
	}
	return '';
}

/** Map a session status to a decision outcome; a task with no session is "pending". */
function outcomeFromStatus(status: unknown): DecisionOutcome {
	switch (status) {
		case 'done':
			return 'done';
		case 'failed':
			return 'failed';
		case 'cancelled':
			return 'cancelled';
		case 'running':
			return 'running';
		default:
			return 'pending';
	}
}

/** Increment a {name → count} map. */
function bump(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

/** A Map → sorted-desc bucket list (stable by name on ties for deterministic rendering). */
function toBuckets(map: Map<string, number>): RationaleBucket[] {
	return [...map.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Build the RoutingRationale read model from REAL `routing_event` rows in the trailing
 * window (F-008). For each decision we derive the outcome read-only by joining the
 * decision's task to that task's MOST-RECENT session status — so the per-decision row
 * shows task → chosen tier/model + WHY + how it turned out. The project + model filters
 * bind via $param (StringRecordId for the project link — D-016); the window + limit bound
 * the scan. Aggregates roll the same rows up (by tier/model/method + override rate).
 *
 * One bounded follow-up query resolves all task outcomes in a single round-trip (no N+1):
 * we collect the decisions' task ids, then fetch the latest session status per task.
 */
export async function buildRoutingRationale(
	db: Db,
	opts: RoutingRationaleOptions = {}
): Promise<RoutingRationale> {
	const windowDays = opts.windowDays ?? 14;
	const limit = opts.limit ?? 500;
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	const params: Record<string, unknown> = { since, lim: limit };
	let where = 'at >= $since';
	if (opts.projectId) {
		params.pid = new StringRecordId(assertRecordId(opts.projectId));
		where += ' AND project = $pid';
	}
	if (opts.model) {
		params.model = opts.model;
		where += ' AND chosen.model_id = $model';
	}

	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, at, task, project, chosen, method, reason, complexity, alternatives
		   FROM routing_event WHERE ${where} ORDER BY at DESC LIMIT $lim;`,
		params
	);
	const raw = rows ?? [];

	// Resolve outcomes in ONE follow-up query: latest session status per referenced task.
	const taskIds = [...new Set(raw.map((r) => (r.task != null ? String(r.task) : '')).filter(Boolean))];
	const outcomeByTask = new Map<string, DecisionOutcome>();
	if (taskIds.length > 0) {
		const links = taskIds.map((t) => new StringRecordId(assertRecordId(t)));
		const [sessions] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT task, status, started_at FROM session
			   WHERE task IN $tasks ORDER BY started_at DESC;`,
			{ tasks: links }
		);
		// Rows are newest-first; the FIRST status we see for a task is its latest run.
		for (const s of sessions ?? []) {
			const tid = s.task != null ? String(s.task) : '';
			if (tid && !outcomeByTask.has(tid)) {
				outcomeByTask.set(tid, outcomeFromStatus(s.status));
			}
		}
	}

	const decisions: RoutingDecision[] = raw.map((r) => {
		const chosen = (r.chosen ?? {}) as Record<string, unknown>;
		const taskId = r.task != null ? String(r.task) : null;
		const alts = Array.isArray(r.alternatives)
			? (r.alternatives as Array<Record<string, unknown>>)
			: [];
		return {
			id: String(r.id),
			at: iso(r.at),
			taskId,
			projectId: r.project != null ? String(r.project) : null,
			provider: String(chosen.provider ?? '?'),
			model: String(chosen.model_id ?? '?'),
			tier: chosen.tier != null ? String(chosen.tier) : null,
			method: String(r.method ?? 'unknown'),
			reason: String(r.reason ?? 'rationale not recorded'),
			complexity: typeof r.complexity === 'number' ? r.complexity : null,
			alternatives: alts,
			outcome: taskId ? (outcomeByTask.get(taskId) ?? 'pending') : 'pending'
		};
	});

	const aggregate = aggregateDecisions(decisions);
	return { decisions, aggregate };
}

/**
 * Roll a decision list up into the aggregate panel (pure — unit-testable with no DB). Buckets
 * by tier / prov;model / method and computes the override rate (explicit ÷ total). Every count
 * comes from the real decisions passed in; an empty list yields empty buckets + a null rate
 * (never a fabricated 0% — F-008).
 */
export function aggregateDecisions(decisions: RoutingDecision[]): RationaleAggregate {
	const byTier = new Map<string, number>();
	const byModel = new Map<string, number>();
	const byMethod = new Map<string, number>();
	let overrides = 0;

	for (const d of decisions) {
		bump(byTier, d.tier ?? 'untiered');
		bump(byModel, `${d.provider}/${d.model}`);
		bump(byMethod, d.method);
		if (d.method === 'explicit') overrides++;
	}

	const total = decisions.length;
	return {
		total,
		byTier: toBuckets(byTier),
		byModel: toBuckets(byModel),
		byMethod: toBuckets(byMethod),
		overrideRate: total > 0 ? overrides / total : null,
		overrides
	};
}
