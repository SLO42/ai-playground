// TASK 2.4 — /agents fleet + usage LENS, LIVE data (UI-SPEC §198–200; F-008; D-019).
//
// The tier-centric LENS: pool tier/role DEFINITIONS (config mirror), the live fleet of
// running/recent sessions (liveness from session.status — NEVER agent_slot.busy, §199),
// and per-tier usage analytics. All from REAL rows (F-008). Degrades honestly (D-019):
// DB not connected → connected:false + empty. Live: the SSE `session` + `agent_event`
// watchers re-invalidate this loader so the fleet grid + usage update in place.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { listPoolSlots, listFleet, buildTierUsage } from '$lib/server/analytics';
import type { PoolSlot, FleetSession, TierUsage } from '$lib/server/analytics';
import type { PageServerLoad } from './$types';

export interface AgentsData {
	connected: boolean;
	pool: PoolSlot[];
	fleet: FleetSession[];
	usage: TierUsage[];
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<AgentsData> => {
	depends('app:fleet');
	depends('app:analytics');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, pool: [], fleet: [], usage: [] };
	}
	try {
		const [pool, fleet, usage] = await Promise.all([
			listPoolSlots(db),
			listFleet(db, 30),
			buildTierUsage(db, { windowDays: 30 })
		]);
		return { connected: true, pool, fleet, usage };
	} catch (err) {
		return { connected: false, pool: [], fleet: [], usage: [], error: (err as Error).message };
	}
};
