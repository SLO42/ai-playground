// TASK 6.6 — /memory global knowledge-graph + recall explorer (UI-SPEC §43/§204; F-008; D-019).
//
// Serves the global memory explorer: a recall LIST of recent active memory rows + the
// knowledge-GRAPH (entity nodes + typed edges), all from REAL rows (F-008 — nothing
// fabricated). Degrades honestly (D-019): DB not connected → connected:false + empty,
// never a fake graph. Live (UI-SPEC §1.2): the SSE `memory`/`entity` watchers re-invalidate
// this loader so the list + graph update in place.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { listMemories, listGraph } from '$lib/server/memory';
import type { MemoryRow, MemoryGraph } from '$lib/server/memory';
import { buildSceneGraph, listSceneEvents, type SceneGraph, type SceneEvent } from '$lib/server/scene';
import type { PageServerLoad } from './$types';

export interface MemoryData {
	connected: boolean;
	memories: MemoryRow[];
	graph: MemoryGraph;
	/**
	 * MEMORY-SCENE-SPEC §7.2 — the living-brain scene's node/edge TRUTH, DERIVED LIVE from
	 * the source tables (MEMORY + USAGE/JOBS; no denormalized copy, F-008). This is the data
	 * foundation the Scene lens (§7.3 UI wave) renders. Honest empty when nothing is active.
	 */
	scene: SceneGraph;
	/**
	 * MEMORY-SCENE-SPEC §5 — the recent scene_event activity slice (the "what's happening now"
	 * feed). DERIVED, append-only, rolling; each row mirrors a real observed row-change. Honest
	 * empty ('no recent activity') when nothing has fired yet (F-008).
	 */
	activity: SceneEvent[];
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<MemoryData> => {
	// Live re-invalidation keys: a memory or entity row change re-runs this loader. The scene
	// graph derives off the SAME source tables, so it re-runs on the same triggers; the
	// USAGE/JOBS layer additionally re-derives when session/work_item rows change.
	depends('app:memory');
	depends('app:graph');
	depends('app:scene');

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			memories: [],
			graph: { nodes: [], edges: [] },
			scene: { nodes: [], edges: [] },
			activity: []
		};
	}
	try {
		const [memories, graph, scene, activity] = await Promise.all([
			listMemories(db, 100),
			listGraph(db, 300),
			buildSceneGraph(db),
			listSceneEvents(db, 40)
		]);
		return { connected: true, memories, graph, scene, activity };
	} catch (err) {
		return {
			connected: false,
			memories: [],
			graph: { nodes: [], edges: [] },
			scene: { nodes: [], edges: [] },
			activity: [],
			error: (err as Error).message
		};
	}
};
