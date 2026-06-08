// TASK 6.4 — /projects/[id] detail page (UI-SPEC §51, §187–193 v0.1; F-008; D-019).
//
// The project workspace shell: loads ONE project's plan macro (purpose/vision/role/DoD)
// + its plan hierarchy (release / phase / feature / sprint) + its tasks + its Claude Code
// sessions, all from REAL rows (F-008 — never a fabricated count or row). The page renders
// three tabs per UI-SPEC §51 (plan / sessions / release); the Release tab links to the
// existing /projects/[id]/release child (3.4). Degrades honestly (D-019): a malformed id
// is a 404, an unknown project is a 404, and a DB-down boot returns connected:false +
// empty rather than zero-dressed-as-real. Live: the SSE `project`/`task`/`session`
// watchers re-invalidate this loader so the detail updates in place (UI-SPEC §1.2).

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	getProject,
	listReleases,
	listPhases,
	listFeatures,
	listSprints,
	type ProjectPlan,
	type ReleaseRow,
	type PhaseRow,
	type FeatureRow,
	type SprintRow
} from '$lib/server/projects/repo';
import { listTasksByProject } from '$lib/server/tasks/repo';
import { listFleetByProject, type FleetSession } from '$lib/server/analytics';
import { assertRecordId } from '$lib/server/db/validate';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** A task row reduced to what the detail page renders (plain, serializable). */
export interface TaskSummary {
	id: string;
	title: string;
	status: string;
	priority: string;
}

export interface ProjectDetailData {
	connected: boolean;
	projectId: string;
	/** Present only when the project exists + DB connected. */
	project?: {
		id: string;
		name: string;
		root_path: string;
		ecosystem: string[];
		status: string;
		build_tool?: string;
		test_command?: string;
		repo_url?: string;
		plan?: ProjectPlan;
	};
	releases: ReleaseRow[];
	phases: PhaseRow[];
	features: FeatureRow[];
	sprints: SprintRow[];
	tasks: TaskSummary[];
	sessions: FleetSession[];
	error?: string;
}

export const load: PageServerLoad = async ({ params, depends }): Promise<ProjectDetailData> => {
	// Live re-invalidation keys: the SSE watchers for these tables re-run this loader.
	depends('app:projects');
	depends('app:tasks');
	depends('app:fleet');

	// Validate the project id at the boundary (D-016) — a malformed param is a 404,
	// never an interpolated query.
	let projectId: string;
	try {
		projectId = assertRecordId(`project:${params.id}`);
	} catch {
		throw error(404, 'invalid project id');
	}

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			projectId,
			releases: [],
			phases: [],
			features: [],
			sprints: [],
			tasks: [],
			sessions: []
		};
	}

	try {
		const project = await getProject(db, projectId);
		if (!project) {
			throw error(404, 'project not found');
		}

		const [releases, phases, features, sprints, taskRows, sessions] = await Promise.all([
			listReleases(db, projectId),
			listPhases(db, projectId),
			listFeatures(db, projectId),
			listSprints(db, projectId),
			listTasksByProject(db, projectId),
			listFleetByProject(db, projectId, 30)
		]);

		const tasks: TaskSummary[] = taskRows.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			priority: t.priority
		}));

		return {
			connected: true,
			projectId,
			project: {
				id: project.id,
				name: project.name,
				root_path: project.root_path,
				ecosystem: project.ecosystem ?? [],
				status: project.status,
				...(project.build_tool ? { build_tool: project.build_tool } : {}),
				...(project.test_command ? { test_command: project.test_command } : {}),
				...(project.repo_url ? { repo_url: project.repo_url } : {}),
				...(project.plan ? { plan: project.plan } : {})
			},
			releases,
			phases,
			features,
			sprints,
			tasks,
			sessions
		};
	} catch (err) {
		// A 404 thrown above is a SvelteKit HttpError — rethrow it, don't swallow.
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return {
			connected: false,
			projectId,
			releases: [],
			phases: [],
			features: [],
			sprints: [],
			tasks: [],
			sessions: [],
			error: (err as Error).message
		};
	}
};
