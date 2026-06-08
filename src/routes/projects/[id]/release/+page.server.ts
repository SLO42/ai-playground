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
import { listReleaseRuns, runRelease, RELEASE_STAGES, type ReleaseRunSummary } from '$lib/server/release';
import { getBus, getRuntime, DEFAULT_MODEL } from '$lib/server/harness';
import { assertRecordId } from '$lib/server/db/validate';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

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

export const actions: Actions = {
	/**
	 * Job-10 release run (PRODUCT §4.10 / §4.5): run the canonical dry-run → test → changelog
	 * → version → tag → publish pipeline as a tracked workflow_run, each stage a real session
	 * streamed live over the one SSE (§2.11). Honest when the credential is absent (F-008).
	 * The project id is the route param (validated); the target version is validated here.
	 */
	run: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { release: { error: 'invalid project id' } });
		}

		const formData = await request.formData();
		const raw = formData.get('version');
		const version = typeof raw === 'string' ? raw.trim() : '';
		if (!version) {
			return fail(400, { release: { error: 'Enter a target version, e.g. v0.4.' } });
		}
		if (version.length > 64) {
			return fail(400, { release: { error: 'Version is too long.' } });
		}

		const db = tryGetDb();
		if (!db) {
			return fail(503, { release: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		const project = await getProject(db, projectId);
		if (!project) {
			return fail(404, { release: { error: 'project not found' } });
		}

		const runtimeAvail = await getRuntime(db);
		if (!runtimeAvail.available) {
			return fail(503, { release: { error: runtimeAvail.reason } });
		}

		try {
			const result = await runRelease({
				db,
				bus: getBus(),
				runtime: runtimeAvail.runtime,
				projectId,
				version,
				cwd: project.root_path,
				model: DEFAULT_MODEL
			});
			return {
				release: { ok: true as const, runId: result.runId, status: result.status, version }
			};
		} catch (err) {
			return fail(500, { release: { error: (err as Error).message } });
		}
	}
};
