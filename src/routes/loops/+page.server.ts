// LOOPS — the global Loops surface loader (LOOP-ENGINEERING.md; operator directive 2026-06-29).
//
// Phase 1 = VIEW + IDENTIFY. Serves the FOUR real recurring loops Atelier runs as one honest typed
// view (LP-1 getLoops) — every global loop plus every project's PM loops — alongside a project-id →
// display-name map so the grouped UI can title each per-project block. Degrades honestly (D-019,
// F-008): a disconnected DB or a cached-but-dead handle yields connected:false + empty loops, never a
// fabricated card. getLoops itself surfaces honest 'not running'/'not yet run' states when the live
// orchestrator/PM singletons are absent.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { listProjects } from '$lib/server/projects/repo';
import { getLoops, type LoopView } from '$lib/server/loops/read';
import type { PageServerLoad } from './$types';

export interface LoopsData {
	connected: boolean;
	loops: LoopView[];
	/** project record id → display name, for the per-project group headings. */
	projectNames: Record<string, string>;
}

function disconnected(): LoopsData {
	return { connected: false, loops: [], projectNames: {} };
}

export const load: PageServerLoad = async ({ depends }): Promise<LoopsData> => {
	// Live by default (§1.2): a run-history event, a PM arm/cadence change, a session change, or a
	// project change re-invalidates and re-reads getLoops (which re-samples the live armed singletons).
	depends('app:loops');
	depends('app:analytics'); // agent_event — run history + drain activity
	depends('app:pm'); // pm — cadence / authority / autonomous arm changes
	depends('app:fleet'); // session — loop activity
	depends('app:projects'); // project — names + membership

	const db = tryGetDb();
	if (!db) return disconnected();

	try {
		const [loops, projects] = await Promise.all([getLoops(db), listProjects(db)]);
		const projectNames: Record<string, string> = {};
		for (const p of projects) projectNames[p.id] = p.name;
		return { connected: true, loops, projectNames };
	} catch (err) {
		// A cached-but-dead handle throws here — a non-null handle does not prove liveness. Classify
		// the same way Home/Workflows do and degrade to honest disconnected (D-019), never a fake loop.
		void classifyDbError(err);
		return disconnected();
	}
};
