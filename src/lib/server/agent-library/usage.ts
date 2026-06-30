// AGENT LIBRARY — usage bridge (best-effort, name/slug join).
//
// The library agents (.md definitions) and the HR workforce roles (role/role_version the
// sessions actually run AS) are SEPARATE catalogs with NO foreign key (DATA-MODEL: the two
// are bridged only by name/slug convention). `session.agent` is the SLOT id (e.g. "sonnet-1"),
// NOT the specialist name — so it must NOT be used to identify the .md agent. The only honest
// bridge is `session.role.slug` ⋈ the agent's name.
//
// This read folds the recent session window by role.slug into per-slug usage stats (calls,
// last-used, status split, avg wall-clock duration). The loader joins each library agent's NAME
// to this map; a name with no matching slug is honestly UNMAPPED ("no runs yet"), never a
// fabricated zero-with-confidence. Bounded SELECT (F-014); every figure is `number | null`
// where absence is real (avg duration null when no session both started AND ended) — F-008.

import type { Db } from '../db/client';

/** Per-slug session usage — keyed by role.slug, joined to a library agent by name===slug. */
export interface AgentUsage {
	/** role.slug — the bridge key. */
	slug: string;
	/** role.name (display), or null. */
	roleName: string | null;
	/** Total sessions that ran as this role (source-row count) in the window. */
	calls: number;
	/** Status split — real counts (0 is honest here). */
	done: number;
	failed: number;
	cancelled: number;
	running: number;
	/** Most recent session start (ISO), or null when none. */
	lastUsedAt: string | null;
	/** Mean wall-clock duration (ms) over sessions with BOTH start+end; null when none qualify. */
	avgDurationMs: number | null;
}

/** Coerce a persisted datetime to ms-since-epoch, or null when absent/unparseable (F-013). */
function epochMs(at: unknown): number | null {
	if (at == null) return null;
	const t = new Date(String(at)).getTime();
	return Number.isNaN(t) ? null : t;
}

/** Coerce to ISO string or null (never a raw SDK datetime out of the loader — F-013). */
function iso(at: unknown): string | null {
	const t = epochMs(at);
	return t == null ? null : new Date(t).toISOString();
}

/**
 * Fold the recent session window into a per-slug usage map (keyed by role.slug). Sessions with
 * no role link are skipped (they cannot bridge to a library agent). Bounded by `limit` (the most
 * recent sessions); a `windowCapped` is exposed by the caller if it needs to flag truncation.
 * Pure read of the DB singleton — no disk, no spawn.
 */
export async function agentUsageBySlug(db: Db, limit = 4000): Promise<Map<string, AgentUsage>> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT status, started_at, ended_at, role.slug AS role_slug, role.name AS role_name
		   FROM session
		  WHERE role != NONE
		  ORDER BY started_at DESC
		  LIMIT $lim
		  FETCH role;`,
		{ lim: limit }
	);

	const bySlug = new Map<string, AgentUsage & { _durSum: number; _durN: number }>();
	for (const r of rows ?? []) {
		const slug = r.role_slug == null ? '' : String(r.role_slug).trim();
		if (!slug) continue;
		const entry =
			bySlug.get(slug) ??
			({
				slug,
				roleName: r.role_name == null ? null : String(r.role_name),
				calls: 0,
				done: 0,
				failed: 0,
				cancelled: 0,
				running: 0,
				lastUsedAt: null,
				avgDurationMs: null,
				_durSum: 0,
				_durN: 0
			} as AgentUsage & { _durSum: number; _durN: number });

		entry.calls++;
		const status = String(r.status ?? 'running');
		if (status === 'done') entry.done++;
		else if (status === 'failed') entry.failed++;
		else if (status === 'cancelled') entry.cancelled++;
		else entry.running++;

		// last-used = max started_at (rows are DESC, but a legacy null start could slip through).
		const startedIso = iso(r.started_at);
		if (startedIso && (entry.lastUsedAt == null || startedIso > entry.lastUsedAt)) {
			entry.lastUsedAt = startedIso;
		}
		const s = epochMs(r.started_at);
		const e = epochMs(r.ended_at);
		if (s != null && e != null && e >= s) {
			entry._durSum += e - s;
			entry._durN++;
		}
		bySlug.set(slug, entry);
	}

	const out = new Map<string, AgentUsage>();
	for (const [slug, e] of bySlug) {
		out.set(slug, {
			slug: e.slug,
			roleName: e.roleName,
			calls: e.calls,
			done: e.done,
			failed: e.failed,
			cancelled: e.cancelled,
			running: e.running,
			lastUsedAt: e.lastUsedAt,
			avgDurationMs: e._durN > 0 ? Math.round(e._durSum / e._durN) : null
		});
	}
	return out;
}
