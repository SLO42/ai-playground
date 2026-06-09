// TASK 2.4 + 11.3 — /agents fleet + usage + CATALOG LENS, LIVE data (UI-SPEC §198–200; F-008; D-019).
//
// The tier-centric LENS: pool tier/role DEFINITIONS (config mirror), the live fleet of
// running/recent sessions (liveness from session.status — NEVER agent_slot.busy, §199),
// per-tier usage analytics, and (11.3) the AGENT-TYPE CATALOG — every available agent
// type from the cc_agent mirror (cc-config sync, 1.8/7.3) with its role, where it's
// defined (global / which project), and which orchestration capability bundles (D-036)
// may provision it. All from REAL rows (F-008). Degrades honestly (D-019): DB not
// connected → connected:false + empty. Live: the SSE `session`/`agent_event`/`cc_agent`
// watchers re-invalidate this loader so the fleet grid + usage + catalog update in place.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	listPoolSlots,
	listFleet,
	buildTierUsage,
	listAgentCatalog
} from '$lib/server/analytics';
import type { PoolSlot, FleetSession, TierUsage, AgentCatalogEntry } from '$lib/server/analytics';
import { loadOrchestration } from '$lib/server/config';
import type { PageServerLoad } from './$types';

/** One agent-type catalog entry enriched with the capability bundles that may provision it. */
export interface CatalogAgent extends AgentCatalogEntry {
	/** Orchestration intents (D-036 bundles) whose `capabilities.agents` lists this agent name. */
	bundles: string[];
}

export interface AgentsData {
	connected: boolean;
	pool: PoolSlot[];
	fleet: FleetSession[];
	usage: TierUsage[];
	catalog: CatalogAgent[];
	error?: string;
}

/** The config dir for orchestration.yaml — same resolution as the rest of the app. */
function configDir(): string {
	return process.env.CONFIG_DIR?.trim() || 'config';
}

/**
 * Build name → [intent…] from orchestration.yaml's per-intent capability bundles (D-036).
 * This is the honest "where it's used": the data model does NOT record which cc_agent drove
 * a given session, so we never invent per-session attribution; instead we surface the
 * declared capability-bundle membership (which intents may provision each agent). Best-effort:
 * a missing/malformed orchestration.yaml yields an empty map rather than failing the page.
 */
function agentBundleMap(): Map<string, string[]> {
	const map = new Map<string, string[]>();
	try {
		const orch = loadOrchestration(`${configDir()}/orchestration.yaml`);
		for (const [intent, bundle] of Object.entries(orch.bundles ?? {})) {
			for (const name of bundle?.capabilities?.agents ?? []) {
				const arr = map.get(name) ?? [];
				if (!arr.includes(intent)) arr.push(intent);
				map.set(name, arr);
			}
		}
	} catch {
		// honest empty — the catalog still renders, just without bundle tags.
	}
	return map;
}

export const load: PageServerLoad = async ({ depends }): Promise<AgentsData> => {
	depends('app:fleet');
	depends('app:analytics');
	depends('app:claude-code'); // cc_agent mirror changes refresh the catalog

	const db = tryGetDb();
	if (!db) {
		return { connected: false, pool: [], fleet: [], usage: [], catalog: [] };
	}
	try {
		const [pool, fleet, usage, catalogRows] = await Promise.all([
			listPoolSlots(db),
			listFleet(db, 30),
			buildTierUsage(db, { windowDays: 30 }),
			listAgentCatalog(db)
		]);
		const bundles = agentBundleMap();
		const catalog: CatalogAgent[] = catalogRows.map((a) => ({
			...a,
			bundles: bundles.get(a.name) ?? []
		}));
		return { connected: true, pool, fleet, usage, catalog };
	} catch (err) {
		return {
			connected: false,
			pool: [],
			fleet: [],
			usage: [],
			catalog: [],
			error: (err as Error).message
		};
	}
};
