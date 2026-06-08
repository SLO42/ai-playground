// TASK 3.4 — /projects/[id]/release, the Release tab (UI-SPEC §195 v0.3; F-008; D-019).
//
// Serves the release pipeline surface for one project: its release runs (each a tracked
// `workflow_run` of a "release <version>" workflow, driven by the 2.17 runner), newest
// first, with their per-stage step_state. Every row is a REAL workflow_run (F-008 — no
// fabricated run). Degrades honestly (D-019): DB not connected → `connected:false` +
// empty, never zero-dressed-as-real. Live: the SSE `workflow_run` watcher re-invalidates
// this loader so a running release's step_state updates in place (UI-SPEC §1.2).

import { tryGetDb } from '$lib/server/db/runtime-init';
import { getProject } from '$lib/server/projects/repo';
import { listReleaseRuns, RELEASE_STAGES, type ReleaseRunSummary } from '$lib/server/release';
import { assertRecordId } from '$lib/server/db/validate';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export interface ReleaseData {
	connected: boolean;
	projectId: string;
	projectName?: string;
	stages: string[];
	runs: ReleaseRunSummary[];
	error?: string;
}

export const load: PageServerLoad = async ({ params, depends }): Promise<ReleaseData> => {
	// Live re-invalidation key: the SSE workflow_run watcher calls invalidate('app:releases').
	depends('app:releases');

	// Validate the project id at the boundary (D-016) — a malformed param is a 404, not a query.
	let projectId: string;
	try {
		projectId = assertRecordId(`project:${params.id}`);
	} catch {
		throw error(404, 'invalid project id');
	}

	const stages = [...RELEASE_STAGES];
	const db = tryGetDb();
	if (!db) {
		return { connected: false, projectId, stages, runs: [] };
	}
	try {
		const project = await getProject(db, projectId);
		const runs = await listReleaseRuns(db, projectId);
		return {
			connected: true,
			projectId,
			projectName: project?.name,
			stages,
			runs
		};
	} catch (err) {
		return { connected: false, projectId, stages, runs: [], error: (err as Error).message };
	}
};
