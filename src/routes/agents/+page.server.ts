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
// UO-3 (USAGE-OBSERVABILITY-SPEC) — the granted-vs-used roll-up read model (UO-1 granted set +
// UO-2 tool_use fold). Pure READ over already-persisted data; no new write path. Answers the
// operator's "what agents/hires/tasks use what tools/skills?" on the surface that already owns
// the capability-bundle view (/agents, UI-SPEC §198). Bounded (F-014), honest (F-008).
import { usageRollup } from '$lib/server/observability';
import type { UsageRollup } from '$lib/server/observability';
import { loadOrchestration } from '$lib/server/config';
// TASK 16.7b — W-D7c workforce surfaces (WORKFORCE-SPEC §8). Read-only panel aggregator
// + the §3.4 adjudication write-path (reuses 16.6's adjudicateInterviewRun — not forked).
import {
	loadWorkforcePanel,
	adjudicateInterviewRun,
	applyHireDecision,
	listRecentRoleEvents,
	HIRE_LIFECYCLE_OPS,
	HireGateError,
	StaffingGateError,
	WorkforceInputError,
	type WorkforcePanelData,
	type AmbiguousResolution,
	type RecentRoleEventRow
} from '$lib/server/workforce';
import { BriefError } from '$lib/server/projects';
import { IdentifierError } from '$lib/server/db/validate';
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
	/**
	 * UO-3 — the capability-usage roll-up: per-session GRANTED capabilities (UO-1) alongside the
	 * USED tools (UO-2), and a cross-session roll-up keyed by skill/tool (who's granted it, who
	 * used it). Honest null when disconnected (the page degrades to its existing disconnected
	 * state); a connected-but-empty DB yields empty arrays (honest empty, F-008).
	 */
	usageRollup: UsageRollup | null;
	/**
	 * COMPLETION-LEDGER Wave A — the HIRING & CERTIFICATION activity feed: the durable role_event
	 * ledger narrowed to the hire lifecycle (HIRE_LIFECYCLE_OPS). This is the human-visible half of
	 * the wave: the engine now records every hire/cert decision with its WHY, and this is where an
	 * operator actually reads it. Empty array = nothing has been hired or certified yet (honest
	 * empty, F-008 — the card says so rather than rendering a plausible-looking placeholder).
	 */
	hiring: RecentRoleEventRow[];
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
		return {
			connected: false,
			pool: [],
			fleet: [],
			usage: [],
			catalog: [],
			workforce: null,
			usageRollup: null,
			hiring: []
		};
	}
	try {
		const [pool, fleet, usage, catalogRows, workforce, rollup, hiring] = await Promise.all([
			listPoolSlots(db),
			listFleet(db, 30),
			buildTierUsage(db, { windowDays: 30 }),
			listAgentCatalog(db),
			loadWorkforcePanel(db),
			// UO-3 — granted-vs-used roll-up over the recent session window. Bounded by the read
			// model's own caps (F-014); the result carries sessionsCapped/toolRowsCapped so the UI
			// surfaces a truncated read honestly rather than implying it scanned everything.
			usageRollup(db),
			// COMPLETION-LEDGER Wave A — the hire/cert ledger, newest-first and bounded (F-014).
			// Deliberately NOT wrapped in its own best-effort catch: a fault here belongs to the
			// page-level catch below, which degrades the whole page to connected:false + an honest
			// error. A local catch would silently render an empty hiring feed while the rest of the
			// page looked healthy — the exact "best-effort catch hides a developer bug" defect
			// (F-020 sweep) this wave is meant to eliminate, not reproduce.
			listRecentRoleEvents(db, 40, HIRE_LIFECYCLE_OPS)
		]);
		const bundles = agentBundleMap();
		const catalog: CatalogAgent[] = catalogRows.map((a) => ({
			...a,
			bundles: bundles.get(a.name) ?? []
		}));
		return { connected: true, pool, fleet, usage, catalog, workforce, usageRollup: rollup, hiring };
	} catch (err) {
		return {
			connected: false,
			pool: [],
			fleet: [],
			usage: [],
			catalog: [],
			workforce: null,
			usageRollup: null,
			hiring: [],
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
	},

	// ── HR-5 §7.5 / B4 — the OPERATOR HIRE GATE on the /agents hire queue. The recruiter
	// PROPOSES (the open cert_hire brief); the operator DISPOSES here. APPROVE flips the cert
	// and (when chosen) feeds the BL-3 staffing flow; REJECT flips nothing. The B4 gate is the
	// operatorConfirmed tick: an approve WITHOUT it fail-closes (HireGateError → 409) and the
	// cert never flips — there is NO auto-hire (D-039). Staffing from the hire gate is a SEPARATE
	// D-039 act on the staffing board, so this action certifies-only (no staffingProposal); the
	// operator staffs the role afterward. Reuses applyHireDecision verbatim — no fork. Every named
	// error is mapped to an honest operator-facing reason; nothing leaks as a masked 500.
	applyHire: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { hire: { error: 'database not connected' } });
		const form = await request.formData();
		const brief = String(form.get('brief') ?? '').trim();
		const action = String(form.get('action') ?? '').trim();
		if (!brief) return fail(400, { hire: { error: 'missing brief id' } });
		if (action !== 'approve' && action !== 'reject') {
			return fail(400, { hire: { brief, error: `action must be approve | reject (got ${action || '(none)'})` } });
		}
		// B4 — an APPROVE writes a cert (and may staff); it REQUIRES the operator's explicit
		// confirm. Without the tick we refuse BEFORE calling the engine (the engine would also
		// fail-closed, but a named UI reason is friendlier than the gate's prose). A REJECT
		// withholds and needs no confirm.
		const confirmed = form.get('operatorConfirmed') === 'on';
		if (action === 'approve' && !confirmed) {
			return fail(400, {
				hire: {
					brief,
					error: 'confirm the hire — approving certifies the role (D-039; there is NO auto-hire). Tick to proceed.'
				}
			});
		}
		try {
			const res = await applyHireDecision(db, brief, action, { operatorConfirmed: confirmed });
			return {
				hire: {
					ok: true,
					brief,
					action,
					status: res.brief.status,
					recommendation: res.recommendation,
					certFlipped: res.certFlipped,
					lifecycle: res.lifecycle
				}
			};
		} catch (err) {
			// Every error has a name — map to an honest operator-facing reason, never a masked 500:
			//   IdentifierError  — a malformed brief id (boundary), 400;
			//   HireGateError    — a B1/B4 boundary violation or wrong-artifact-kind/missing brief
			//                      (a forged/cross-role/non-cert_hire id fails closed here), 409;
			//   StaffingGateError — only reachable if a staffing feed were attached (it isn't here),
			//                      mapped for completeness;
			//   BriefError       — illegal brief state (already-decided relabel), 409.
			if (err instanceof IdentifierError) return fail(400, { hire: { brief, error: 'invalid brief id' } });
			if (err instanceof HireGateError) return fail(409, { hire: { brief, error: err.message } });
			if (err instanceof StaffingGateError) return fail(409, { hire: { brief, error: err.message } });
			if (err instanceof WorkforceInputError) return fail(409, { hire: { brief, error: err.message } });
			if (err instanceof BriefError) return fail(409, { hire: { brief, error: err.message } });
			return fail(500, { hire: { brief, error: (err as Error).message } });
		}
	}
};
