// AGENT LIBRARY — usage bridge (best-effort, name join).
//
// The library agents (.md definitions) and the HR workforce roles (role/role_version the
// sessions actually run AS) are SEPARATE catalogs with NO foreign key (DATA-MODEL: the two
// are bridged only by name/slug convention). Two honest bridges to a `.claude/agents` agent's
// NAME exist, and this fold UNIONs them:
//   1. `session.specialist` (m0070) — the EXACT specialist name a caller routed to at spawn.
//      When present it is the authoritative bridge key (a real, deliberate invocation of THAT
//      specialist). `session.agent` is the SLOT id (e.g. "sonnet-1"), NOT the specialist — it is
//      never used as the bridge.
//   2. `session.role.slug` — the certified HR role the session ran as (stamped by workforce
//      activation). The historical/fallback bridge: agent name === role.slug.
//
// A session is folded under its `specialist` when set, ELSE under `role.slug`. Both contribute to
// the SAME per-name key, so an agent's usage UNIONs its specialist-tracked invocations and its
// role-bridged sessions. A name with no matching specialist AND no matching slug is honestly
// UNMAPPED ("no runs yet"), never a fabricated zero-with-confidence. Bounded SELECT (F-014);
// every figure is `number | null` where absence is real (avg duration null when no session both
// started AND ended) — F-008.

import type { Db } from '../db/client';

/** Which bridge(s) contributed a per-name usage entry — honest about how the count was derived. */
export type UsageBridge = 'specialist' | 'role' | 'mixed';

/** Per-name session usage — keyed by specialist name (m0070) ∪ role.slug, joined to a library agent by name. */
export interface AgentUsage {
	/** The bridge key — a `.claude/agents` agent name (from session.specialist or role.slug). */
	key: string;
	/**
	 * Back-compat alias of `key` (the catalog historically read `usage.slug`). Same value as `key`
	 * — kept so existing surfaces keep rendering while preferring the bridge-agnostic `key`.
	 */
	slug: string;
	/** role.name (display) when the role bridge contributed, or null (specialist-only entries). */
	roleName: string | null;
	/** How this entry was bridged: specialist-only, role-only, or both (mixed). */
	bridge: UsageBridge;
	/** Sessions bridged by `session.specialist` (the exact, deliberate invocations). */
	viaSpecialist: number;
	/** Sessions bridged by `role.slug` (the certified-role fallback). */
	viaRole: number;
	/** Total sessions counted for this name (viaSpecialist + viaRole) in the window. */
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

interface Accum extends AgentUsage {
	_durSum: number;
	_durN: number;
}

/**
 * Fold the recent session window into a per-NAME usage map. Each session is bridged by its
 * `session.specialist` (m0070) when set, ELSE by `role.slug`; a session with NEITHER is skipped
 * (it cannot bridge to a library agent). Both bridges fold into the same per-name key, so the
 * result UNIONs an agent's specialist-tracked invocations with its role-bridged sessions. Bounded
 * by `limit` (the most recent sessions). Pure read of the DB singleton — no disk, no spawn.
 */
export async function agentUsageByName(db: Db, limit = 4000): Promise<Map<string, AgentUsage>> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT status, started_at, ended_at, specialist, role.slug AS role_slug, role.name AS role_name
		   FROM session
		  WHERE specialist != NONE OR role != NONE
		  ORDER BY started_at DESC
		  LIMIT $lim
		  FETCH role;`,
		{ lim: limit }
	);

	const byName = new Map<string, Accum>();
	for (const r of rows ?? []) {
		const specialist = r.specialist == null ? '' : String(r.specialist).trim();
		const slug = r.role_slug == null ? '' : String(r.role_slug).trim();
		// Prefer the exact specialist bridge; fall back to the certified role slug.
		const usedSpecialist = specialist !== '';
		const key = usedSpecialist ? specialist : slug;
		if (!key) continue; // no honest bridge → cannot attribute to a library agent.

		const entry =
			byName.get(key) ??
			({
				key,
				slug: key,
				// role.name is only meaningful when the role bridge contributes; seed null and set
				// it the first time a role-bridged session lands.
				roleName: null,
				bridge: usedSpecialist ? 'specialist' : 'role',
				viaSpecialist: 0,
				viaRole: 0,
				calls: 0,
				done: 0,
				failed: 0,
				cancelled: 0,
				running: 0,
				lastUsedAt: null,
				avgDurationMs: null,
				_durSum: 0,
				_durN: 0
			} satisfies Accum);

		// Track the contributing bridge(s); the final 'specialist'|'role'|'mixed' is derived from
		// the two counts at output (below) so order of arrival never matters.
		if (usedSpecialist) {
			entry.viaSpecialist++;
		} else {
			entry.viaRole++;
			if (entry.roleName == null && r.role_name != null) entry.roleName = String(r.role_name);
		}

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
		byName.set(key, entry);
	}

	const out = new Map<string, AgentUsage>();
	for (const [key, e] of byName) {
		const bridge: UsageBridge =
			e.viaSpecialist > 0 && e.viaRole > 0 ? 'mixed' : e.viaSpecialist > 0 ? 'specialist' : 'role';
		out.set(key, {
			key: e.key,
			slug: e.slug,
			roleName: e.roleName,
			bridge,
			viaSpecialist: e.viaSpecialist,
			viaRole: e.viaRole,
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

/**
 * Back-compat alias. The bridge is now per-NAME (specialist ∪ role.slug), not slug-only; existing
 * callers that imported `agentUsageBySlug` keep working unchanged. Prefer {@link agentUsageByName}.
 */
export const agentUsageBySlug = agentUsageByName;
