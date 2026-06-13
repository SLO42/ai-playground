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
// TASK 16.7b — W-D7c workforce surfaces (WORKFORCE-SPEC §8). Read-only panel aggregator
// + the §3.4 adjudication write-path (reuses 16.6's adjudicateInterviewRun — not forked).
import {
	loadWorkforcePanel,
	adjudicateInterviewRun,
	WorkforceInputError,
	type WorkforcePanelData,
	type AmbiguousResolution
} from '$lib/server/workforce';
import { fail, type Actions } from '@sveltejs/kit';
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
	/** TASK 16.7b — the workforce panel (role cards + §3.4 adjudication queue); honest
	 *  null when disconnected (the page degrades to its existing disconnected state). */
	workforce: WorkforcePanelData | null;
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
	depends('app:workforce'); // role/role_version/interview_run/panel_verdict/role_event

	const db = tryGetDb();
	if (!db) {
		return { connected: false, pool: [], fleet: [], usage: [], catalog: [], workforce: null };
	}
	try {
		const [pool, fleet, usage, catalogRows, workforce] = await Promise.all([
			listPoolSlots(db),
			listFleet(db, 30),
			buildTierUsage(db, { windowDays: 30 }),
			listAgentCatalog(db),
			loadWorkforcePanel(db)
		]);
		const bundles = agentBundleMap();
		const catalog: CatalogAgent[] = catalogRows.map((a) => ({
			...a,
			bundles: bundles.get(a.name) ?? []
		}));
		return { connected: true, pool, fleet, usage, catalog, workforce };
	} catch (err) {
		return {
			connected: false,
			pool: [],
			fleet: [],
			usage: [],
			catalog: [],
			workforce: null,
			error: (err as Error).message
		};
	}
};

// ── TASK 16.7b — §3.4 ambiguous-match adjudication (the operator is the judge; there is
// no judge agent). One ceremony resolves ALL queued items of one run; the write-path is
// 16.6's adjudicateInterviewRun, reused verbatim. The live SSE interview_run watcher
// re-invalidates the loader, so the queue empties in place on success.
const VALID_RESOLUTIONS = new Set<AmbiguousResolution>(['confirm_hit', 'false_positive', 'dismiss']);

export const actions: Actions = {
	adjudicate: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { workforce: { error: 'database not connected' } });
		const form = await request.formData();
		const run = String(form.get('run') ?? '').trim();
		const raw = String(form.get('resolutions') ?? '');
		if (!run) return fail(400, { workforce: { error: 'missing run id' } });

		// resolutions arrive as JSON: [{ index, resolution, note? }]. Validate at the
		// boundary (every field has a name) before the engine sees it.
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return fail(400, { workforce: { error: 'resolutions must be valid JSON' } });
		}
		if (!Array.isArray(parsed)) {
			return fail(400, { workforce: { error: 'resolutions must be an array' } });
		}
		const resolutions: Array<{ index: number; resolution: AmbiguousResolution; note?: string }> = [];
		for (const r of parsed) {
			const o = r as Record<string, unknown>;
			const index = Number(o.index);
			const resolution = String(o.resolution) as AmbiguousResolution;
			if (!Number.isInteger(index) || !VALID_RESOLUTIONS.has(resolution)) {
				return fail(400, {
					workforce: { error: 'each resolution needs an integer index and a valid resolution' }
				});
			}
			resolutions.push({
				index,
				resolution,
				...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim() } : {})
			});
		}

		try {
			const updated = await adjudicateInterviewRun(db, run, { resolutions });
			return { workforce: { ok: true, run: updated.id, status: updated.status } };
		} catch (err) {
			// WorkforceInputError = a named operator/validation error (bad index, wrong
			// status, partial queue) — surface its message; anything else is a 500-class.
			if (err instanceof WorkforceInputError) {
				return fail(400, { workforce: { error: err.message } });
			}
			return fail(500, { workforce: { error: (err as Error).message } });
		}
	}
};
