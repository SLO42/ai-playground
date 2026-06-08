// TASK 6.6 — /workflows list + run detail (UI-SPEC §47/§218; F-008; D-019).
//
// Serves the headless-pipeline surface: workflow DEFINITIONS, run HISTORY (workflow_run
// rows), and — when `?run=<id>` is set — the DETAIL of one run with its per-step session
// records (§4.11 "each executing step is a session"). All from REAL rows (F-008). Degrades
// honestly (D-019): DB not connected → connected:false + empty. Live (UI-SPEC §1.2): the
// SSE `workflow`/`workflow_run`/`session` watchers re-invalidate this loader.

import { fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { assertRecordId } from '$lib/server/db/validate';
import { listWorkflows, listWorkflowRuns, getWorkflowRunDetail, runWorkflow } from '$lib/server/workflows';
import type { WorkflowListItem, WorkflowRunListItem, WorkflowRunDetail } from '$lib/server/workflows';
import { getBus, getRuntime } from '$lib/server/harness';
import type { Actions, PageServerLoad } from './$types';

export interface WorkflowsData {
	connected: boolean;
	workflows: WorkflowListItem[];
	runs: WorkflowRunListItem[];
	detail: WorkflowRunDetail | null;
	selectedRun: string | null;
	/** A query/load failure while the DB IS connected (distinct from connection loss). */
	queryError?: string;
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
		// `tryGetDb()` can return a CACHED-but-DEAD handle (the SurrealDB process was
		// killed / the socket dropped mid-session), so a non-null handle does NOT prove
		// liveness. Classify the thrown error (shared with /projects + home): a genuine
		// connection loss is reported as DISCONNECTED — the same honest state as a server
		// that booted with the DB down — and ONLY a true query/parse/validation failure
		// keeps `connected: true` + the queryError "query failed" state (D-019).
		if (classifyDbError(err) === 'disconnected') {
			return { connected: false, workflows: [], runs: [], detail: null, selectedRun };
		}
		return {
			connected: true,
			workflows: [],
			runs: [],
			detail: null,
			selectedRun,
			queryError: (err as Error).message
		};
	}
};

export const actions: Actions = {
	/**
	 * Job-10 run trigger (PRODUCT §4.10): execute a workflow definition as a tracked
	 * workflow_run via the 2.17 DAG runner. Each step is a real session linked to the run,
	 * streamed live over the one SSE (§2.11). Honest when the credential is absent (F-008):
	 * returns the real reason rather than faking a run. The workflow id is validated at the
	 * boundary (D-016).
	 */
	run: async ({ request }) => {
		const form = await request.formData();
		const raw = form.get('workflowId');
		const workflowId = typeof raw === 'string' ? raw.trim() : '';
		if (!workflowId) {
			return fail(400, { run: { error: 'Pick a workflow to run.' } });
		}
		try {
			assertRecordId(workflowId);
		} catch {
			return fail(400, { run: { error: 'invalid workflow id' } });
		}

		const db = tryGetDb();
		if (!db) {
			return fail(503, { run: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		const runtimeAvail = await getRuntime(db);
		if (!runtimeAvail.available) {
			return fail(503, { run: { error: runtimeAvail.reason } });
		}

		try {
			const result = await runWorkflow({
				db,
				bus: getBus(),
				runtime: runtimeAvail.runtime,
				workflow: workflowId
			});
			return { run: { ok: true as const, runId: result.runId, status: result.status } };
		} catch (err) {
			return fail(500, { run: { error: (err as Error).message } });
		}
	}
};
