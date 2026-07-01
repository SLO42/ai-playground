// MODEL-BENCHMARK-SPEC step 1 (class A — Objective) — the local-vs-cloud comparison rollup.
//
// The measurement view the benchmark needs FIRST: a `GROUP BY model.provider` fold over the SAME
// real `agent_event` rows the rest of /reports reads (F-008 — every figure traces to a row; an
// unpriced provider stays cost=null, never a fake $0). It answers "how does the local provider
// (Ollama, free) compare to cloud (Claude) as Atelier's brain/worker" on the objective axes that
// already land per session: sessions, runs, tokens, cost, latency, and agent-spawn fan-out
// (parent_event_id chains). No new capture — this is a read over existing rows.
//
// Aggregation style mirrors buildTierUsage (rollup.ts): SELECT a bounded window of raw rows, fold
// in JS. This keeps the SurrealQL simple (no GROUP BY / math::* quirks across 2.x point builds)
// while the LIMIT bounds the scan. Inter-hire comms volume (peer_message to/from the session) is a
// declared FOLLOW-ON here: it lives in a separate table keyed by session (not provider), so
// attributing it per-provider needs a session→provider join — surfaced honestly, not half-built.

import type { Db } from '../db/client';

/** One provider's objective usage rollup (all figures from real agent_event rows; F-008). */
export interface ProviderUsage {
	/** The model provider (e.g. 'ollama' = local/free, 'claude' = cloud). 'unknown' when unset. */
	provider: string;
	/** Distinct sessions that ran at this provider in the window. */
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
	/** Σ cost_usd across PRICED rows; null when none were priced (local is free ⇒ typically null/0). */
	costUsd: number | null;
	/** Mean duration_ms across rows that reported one; null when none did (latency proxy). */
	avgDurationMs: number | null;
	/** Events carrying a parent_event_id — the model's agent-spawn fan-out (chain children). */
	childSpawns: number;
}

export interface ProviderUsageOptions {
	/** Trailing window in days (default 30). */
	windowDays?: number;
	/** Restrict to one project (record id `project:…`); omitted ⇒ portfolio-wide. */
	projectId?: string;
	/** Hard cap on rows scanned (safety bound; default 50_000). */
	maxRows?: number;
}

interface RawProviderRow {
	provider?: string | null;
	session?: unknown;
	tokens_in?: number | null;
	tokens_out?: number | null;
	cost_usd?: number | null;
	duration_ms?: number | null;
	parent?: unknown;
	type?: string;
}

interface Acc extends ProviderUsage {
	_sessions: Set<string>;
	_durSum: number;
	_durN: number;
	_priced: boolean;
}

/**
 * Roll `agent_event` up per model.provider over the trailing window (F-008 — real rows only). A row
 * with no provider on its model lands under the 'unknown' bucket rather than being dropped (honest,
 * not silently lossy). Returns [] when there are no rows in the window (the honest empty state the
 * comparison view renders as "no runs yet" per provider).
 */
export async function buildProviderUsage(
	db: Db,
	opts: ProviderUsageOptions = {}
): Promise<ProviderUsage[]> {
	const windowDays = opts.windowDays ?? 30;
	const maxRows = opts.maxRows ?? 50_000;
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	const params: Record<string, unknown> = { since, lim: maxRows };
	let where = `at >= $since`;
	if (opts.projectId) {
		const { StringRecordId } = await import('surrealdb');
		const { assertRecordId } = await import('../db/validate');
		params.pid = new StringRecordId(assertRecordId(opts.projectId));
		where += ` AND project = $pid`;
	}

	const [rows] = await db.query<[RawProviderRow[]]>(
		`SELECT model.provider AS provider, session, tokens_in, tokens_out, cost_usd,
		        duration_ms, parent_event_id AS parent, type, at
		   FROM agent_event WHERE ${where} ORDER BY at ASC LIMIT $lim;`,
		params
	);

	const byProvider = new Map<string, Acc>();
	for (const r of rows ?? []) {
		const provider = (r.provider as string) || 'unknown';
		let u = byProvider.get(provider);
		if (!u) {
			u = {
				provider,
				sessions: 0,
				runs: 0,
				completions: 0,
				errors: 0,
				tokensIn: 0,
				tokensOut: 0,
				costUsd: null,
				avgDurationMs: null,
				childSpawns: 0,
				_sessions: new Set<string>(),
				_durSum: 0,
				_durN: 0,
				_priced: false
			};
			byProvider.set(provider, u);
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
		if (typeof r.duration_ms === 'number') {
			u._durSum += r.duration_ms;
			u._durN++;
		}
		if (r.parent != null) u.childSpawns++;
	}

	return [...byProvider.values()]
		.map((u) => ({
			provider: u.provider,
			sessions: u._sessions.size,
			runs: u.runs,
			completions: u.completions,
			errors: u.errors,
			tokensIn: u.tokensIn,
			tokensOut: u.tokensOut,
			// Keep cost null unless a real priced row landed (never dress an unpriced provider as $0).
			costUsd: u._priced ? u.costUsd : null,
			avgDurationMs: u._durN > 0 ? Math.round(u._durSum / u._durN) : null,
			childSpawns: u.childSpawns
		}))
		.sort((a, b) => b.runs - a.runs || b.sessions - a.sessions);
}
