// TASK 6.6 — /workflows list + run detail (UI-SPEC §47/§218; F-008; D-019).
//
// Serves the headless-pipeline surface: workflow DEFINITIONS, run HISTORY (workflow_run
// rows), and — when `?run=<id>` is set — the DETAIL of one run with its per-step session
// records (§4.11 "each executing step is a session"). All from REAL rows (F-008). Degrades
// honestly (D-019): DB not connected → connected:false + empty. Live (UI-SPEC §1.2): the
// SSE `workflow`/`workflow_run`/`session` watchers re-invalidate this loader.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { assertRecordId } from '$lib/server/db/validate';
import { listWorkflows, listWorkflowRuns, getWorkflowRunDetail } from '$lib/server/workflows';
import type { WorkflowListItem, WorkflowRunListItem, WorkflowRunDetail } from '$lib/server/workflows';
import type { PageServerLoad } from './$types';

export interface WorkflowsData {
	connected: boolean;
	workflows: WorkflowListItem[];
	runs: WorkflowRunListItem[];
	detail: WorkflowRunDetail | null;
	selectedRun: string | null;
	error?: string;
}

export const load: PageServerLoad = async ({ depends, url }): Promise<WorkflowsData> => {
	depends('app:workflows');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, workflows: [], runs: [], detail: null, selectedRun: null };
	}

	// Validate the `?run=` param at the boundary (D-016) — only a well-formed record id
	// reaches the detail read; anything else is ignored (no detail fetched).
	const runParam = url.searchParams.get('run');
	let selectedRun: string | null = null;
	if (runParam) {
		try {
			selectedRun = assertRecordId(runParam);
		} catch {
			selectedRun = null;
		}
	}

	try {
		const [workflows, runs, detail] = await Promise.all([
			listWorkflows(db, 100),
			listWorkflowRuns(db, 100),
			selectedRun ? getWorkflowRunDetail(db, selectedRun) : Promise.resolve(null)
		]);
		return { connected: true, workflows, runs, detail, selectedRun };
	} catch (err) {
		return {
			connected: false,
			workflows: [],
			runs: [],
			detail: null,
			selectedRun: null,
			error: (err as Error).message
		};
	}
};
