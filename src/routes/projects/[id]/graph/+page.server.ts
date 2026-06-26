// LG-3 (LIFECYCLE-GRAPH-SPEC §LG-3) — /projects/[id]/graph: the live, animated causal
// node-graph of the project's lifecycle (Continue → sessions → PM → tasks).
//
// A PURE READ surface: it returns the LG-2 `buildLifecycleGraph` read model (assembled live
// from scene_event + session/task/agent_event REAL rows — F-008). The page renders + animates
// it off the EXISTING onDbChange SSE (no new live mechanism — the loader re-invalidates on a
// watched-table change). Degrades honestly (D-019): a malformed id is a 404, an unknown project
// is a 404, a DB-down boot returns connected:false + an empty graph (never zero-dressed-as-real),
// and a per-source failure surfaces as a PARTIAL graph (the LG-2 read model carries failedSources).
//
// BOUNDARY (D-016): the project id is validated at the chokepoint (assertRecordId) before any
// query. BOUNDED (F-014): the read model caps every source window; the graph is renderable, not
// all-history. BEST-EFFORT (D-019/F-048): a graph read NEVER blocks the orchestrator/PM/drain.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { getProject } from '$lib/server/projects/repo';
import { buildLifecycleGraph, type LifecycleGraph } from '$lib/server/observability';
import { assertRecordId } from '$lib/server/db/validate';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export interface GraphData {
	/** Honest connection state — false ⇒ DB-down boot (empty graph, not fabricated). */
	connected: boolean;
	/** The bare project id (`project:slug`) for child nav / re-fetch keys. */
	projectId: string;
	/** The project's display name, when the row exists. */
	projectName?: string;
	/** The LG-2 lifecycle read model (nodes + edges + honest partial/cap flags). */
	graph: LifecycleGraph;
	/** Set on a boot/read error (the page renders the disconnected state honestly). */
	error?: string;
}

/** An honest-empty graph for the disconnected / not-found shadow paths (F-008). */
function emptyGraph(projectId: string): LifecycleGraph {
	return {
		project: projectId,
		nodes: [],
		edges: [],
		complete: true,
		failedSources: [],
		capped: false,
		details: {}
	};
}

export const load: PageServerLoad = async ({ params, depends }): Promise<GraphData> => {
	// Live re-invalidation key — the SSE watchers (scene_event/session/task/agent_event) call
	// invalidate('app:lifecycle') so the graph grows in place (UI-SPEC §1.2). REUSE, no new stream.
	depends('app:lifecycle');

	// Validate at the boundary (D-016) — a malformed param is a 404, not a query.
	let projectId: string;
	try {
		projectId = assertRecordId(`project:${params.id}`);
	} catch {
		throw error(404, 'invalid project id');
	}

	const db = tryGetDb();
	if (!db) {
		// DB-down shadow path — honest connected:false + empty graph (D-019).
		return { connected: false, projectId, graph: emptyGraph(projectId) };
	}

	try {
		const project = await getProject(db, projectId);
		if (!project) {
			throw error(404, 'project not found');
		}
		// The read model isolates per-source failures (best-effort) and returns an honest partial.
		const graph = await buildLifecycleGraph(db, projectId);
		return { connected: true, projectId, projectName: project.name, graph };
	} catch (err) {
		// A 404 from getProject's guard must propagate as a 404, not be swallowed as connected:false.
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return {
			connected: false,
			projectId,
			graph: emptyGraph(projectId),
			error: (err as Error).message
		};
	}
};
