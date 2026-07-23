// COST-GOVERNANCE-SPEC CG-6 — per-PROJECT usage attribution (the session→project join).
//
// buildProviderUsage answered "which PROVIDER spent what"; CG-6 answers "which PROJECT spent
// what". The SOURCE OF TRUTH for a run's project is its SESSION (session.project) — many events
// land with `session` set and their own `project` unset, so we attribute through the join
// agent_event → session → session.project (F-008: a real link, never a guessed bucket). But some
// rows are legitimately SESSION-LESS while carrying the denormalized `agent_event.project` set
// directly (e.g. sync/github.ts's completion rows write `project` with no session) — those must
// attribute to their real project, not misbucket to 'unknown' (CG2-3). So the projection COALESCES
// `session.project ?? project`: the session link WINS when present, else we fall back to the row's
// own denormalized project, and only a row with BOTH absent lands under 'unknown' — honest, not
// dropped (mirrors buildProviderUsage's 'unknown' provider lane at :101/:149).
//
// Aggregation style mirrors buildProviderUsage / buildTierUsage (rollup.ts): SELECT a bounded
// window of raw rows (the join resolved by SurrealDB record-link traversal in the projection),
// fold in JS. This sidesteps 2.x GROUP BY quirks; the LIMIT bounds the scan. F-020: the ORDER BY
// field (`at`) is in the projection. Cost stays priced-rows-only (buildProviderUsage :34/:148) —
// an unpriced project reads null, never a fabricated $0.

import type { Db } from '../db/client';

/** One project's usage rollup (all figures from real agent_event rows; F-008). */
export interface ProjectUsage {
	/** The project record id (e.g. 'project:rounds'); 'unknown' when no session/project link. */
	project: string;
	/** Distinct sessions attributed to this project in the window. */
	sessions: number;
	/** Spawn events (runs started). */
	runs: number;
	/** Completion events (runs that finished). */
	completions: number;
	/** Error events. */
	errors: number;
	/** Σ tokens_in. */
	tokensIn: number;
	/** Σ tokens_out. */
	tokensOut: number;
	/** Σ cost_usd across PRICED rows; null when none were priced (F-008 — never a fake $0). */
	costUsd: number | null;
}

export interface ProjectUsageOptions {
	/** Trailing window in days (default 30). */
	windowDays?: number;
	/** Hard cap on rows scanned (safety bound; default 50_000). */
	maxRows?: number;
}

/** Minimal raw projection the fold consumes (`project` = session.project ?? agent_event.project). */
interface RawProjectRow {
	project?: unknown;
	session?: unknown;
	tokens_in?: number | null;
	tokens_out?: number | null;
	cost_usd?: number | null;
	type?: string;
}

interface Acc extends ProjectUsage {
	_sessions: Set<string>;
	_priced: boolean;
}

/**
 * Roll `agent_event` up per PROJECT over the trailing window, attributed through the
 * agent_event → session → session.project join (F-008 — real link only). A row whose session
 * (or its project) is absent lands under the 'unknown' bucket rather than being dropped (honest,
 * not silently lossy). Returns [] when there are no rows in the window (the honest empty state a
 * per-project cost surface renders as "no runs yet"). Sorted by total tokens desc (busiest spend
 * first), tie-broken by runs.
 */
export async function buildProjectUsage(
	db: Db,
	opts: ProjectUsageOptions = {}
): Promise<ProjectUsage[]> {
	const windowDays = opts.windowDays ?? 30;
	const maxRows = opts.maxRows ?? 50_000;
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	// `session.project ?? project` COALESCES the join (record-link traversal, resolved by SurrealDB
	// in the projection) with the row's own denormalized `project`: session wins when linked, else
	// the session-less-but-project-set rows (e.g. github.ts completion writes) fall back to their own
	// project (CG2-3). Only a row with BOTH a NONE session/project-link AND a NONE own-project yields
	// NONE here → the 'unknown' bucket below. F-020: `at` (the ORDER BY idiom) is projected.
	const [rows] = await db.query<[RawProjectRow[]]>(
		`SELECT (session.project ?? project) AS project, session, tokens_in, tokens_out, cost_usd, type, at
		   FROM agent_event WHERE at >= $since ORDER BY at ASC LIMIT $lim;`,
		{ since, lim: maxRows }
	);

	const byProject = new Map<string, Acc>();
	for (const r of rows ?? []) {
		const project = r.project != null ? String(r.project) : 'unknown';
		let u = byProject.get(project);
		if (!u) {
			u = {
				project,
				sessions: 0,
				runs: 0,
				completions: 0,
				errors: 0,
				tokensIn: 0,
				tokensOut: 0,
				costUsd: null,
				_sessions: new Set<string>(),
				_priced: false
			};
			byProject.set(project, u);
		}
		if (r.session != null) u._sessions.add(String(r.session));
		if (r.type === 'spawn') u.runs++;
		else if (r.type === 'completion') u.completions++;
		else if (r.type === 'error') u.errors++;
		if (typeof r.tokens_in === 'number') u.tokensIn += r.tokens_in;
		if (typeof r.tokens_out === 'number') u.tokensOut += r.tokens_out;
		if (typeof r.cost_usd === 'number') {
			u.costUsd = (u.costUsd ?? 0) + r.cost_usd;
			u._priced = true;
		}
	}

	return [...byProject.values()]
		.map((u) => ({
			project: u.project,
			sessions: u._sessions.size,
			runs: u.runs,
			completions: u.completions,
			errors: u.errors,
			tokensIn: u.tokensIn,
			tokensOut: u.tokensOut,
			// Keep cost null unless a real priced row landed (never dress an unpriced project as $0).
			costUsd: u._priced ? u.costUsd : null
		}))
		.sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) || b.runs - a.runs);
}
