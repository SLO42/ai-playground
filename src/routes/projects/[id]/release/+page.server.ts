// TASK 3.4 — /projects/[id]/release, the Release tab (UI-SPEC §195 v0.3; F-008; D-019).
//
// Serves the release pipeline surface for one project: its release runs (each a tracked
// `workflow_run` of a "release <version>" workflow, driven by the 2.17 runner), newest
// first, with their per-stage step_state. Every row is a REAL workflow_run (F-008 — no
// fabricated run). Degrades honestly (D-019): DB not connected → `connected:false` +
// empty, never zero-dressed-as-real. Live: the SSE `workflow_run` watcher re-invalidates
// this loader so a running release's step_state updates in place (UI-SPEC §1.2).

import { env } from '$env/dynamic/private';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { getProject } from '$lib/server/projects/repo';
import { listReleaseRuns, runRelease, RELEASE_STAGES, type ReleaseRunSummary } from '$lib/server/release';
import { getBus, getRuntime, DEFAULT_MODEL } from '$lib/server/harness';
import { assertRecordId } from '$lib/server/db/validate';
import {
	listTargets,
	listTargetRuns,
	lastRunFor,
	runTargetAction,
	runTargetVerify,
	buildAdapterCatalog,
	isInstalled,
	getAdapterRegistry,
	GateConfirmError,
	type ProjectTargetRow,
	type TargetRunRow,
	type CatalogEntry
} from '$lib/server/adapters';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/** The GATED families the release pipeline drives end-to-end (sync lives on the Sync surface). */
const GATED_KINDS = ['publish', 'deploy'] as const;
type GatedKind = (typeof GATED_KINDS)[number];

/** A release-relevant target (publish/deploy) + whether its adapter is installed + its last run. */
export interface ReleaseTargetView extends ProjectTargetRow {
	installed: boolean;
	lastRun: TargetRunRow | null;
	/** TASK 14.7: true iff this is a publish target whose adapter implements verify(). */
	canVerify: boolean;
}

/** True iff a registered PUBLISH adapter implements the optional verify() (14.7). Never throws. */
function adapterHasVerify(kind: string, adapterId: string): boolean {
	if (kind !== 'publish') return false;
	try {
		return typeof getAdapterRegistry().getPublisher(adapterId).verify === 'function';
	} catch {
		return false;
	}
}

export interface ReleaseData {
	connected: boolean;
	projectId: string;
	projectName?: string;
	stages: string[];
	runs: ReleaseRunSummary[];
	/** The project's declared publish/deploy targets — what this release ships through (D-037). */
	targets: ReleaseTargetView[];
	/** The unified adapter catalog (probe + secret presence) for the publish/deploy families. */
	catalog: CatalogEntry[];
	error?: string;
}

export const load: PageServerLoad = async ({ params, depends }): Promise<ReleaseData> => {
	// Live re-invalidation key: the SSE workflow_run watcher calls invalidate('app:releases').
	depends('app:releases');
	depends('app:targets');

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
		return { connected: false, projectId, stages, runs: [], targets: [], catalog: [] };
	}
	try {
		const project = await getProject(db, projectId);
		const runs = await listReleaseRuns(db, projectId);

		// The project's publish/deploy targets + per-target status, and the catalog (probe/secrets)
		// so the release tab shows what it ships through and can drive the gated flow (D-037).
		const cwd = project?.root_path ?? '';
		const allTargets = await listTargets(db, projectId);
		const targetRuns = await listTargetRuns(db, projectId);
		const catalogAll = await buildAdapterCatalog({ env, cwd, db, projectId });
		const targets: ReleaseTargetView[] = allTargets
			.filter((t) => t.kind === 'publish' || t.kind === 'deploy')
			.map((t) => ({
				...t,
				installed: isInstalled(t.kind, t.adapter_id),
				// STRICT target-link match (13.4a) — an adapter_id fallback cross-attributes runs.
				lastRun: lastRunFor(targetRuns, t.id),
				canVerify: adapterHasVerify(t.kind, t.adapter_id)
			}));
		const catalog = catalogAll.filter((c) => c.kind === 'publish' || c.kind === 'deploy');

		return {
			connected: true,
			projectId,
			projectName: project?.name,
			stages,
			runs,
			targets,
			catalog
		};
	} catch (err) {
		return {
			connected: false,
			projectId,
			stages,
			runs: [],
			targets: [],
			catalog: [],
			error: (err as Error).message
		};
	}
};

export const actions: Actions = {
	/**
	 * Job-10 release run (PRODUCT §4.10 / §4.5): run the canonical dry-run → test → changelog
	 * → version → tag → publish → verify pipeline as a tracked workflow_run, each stage a real session
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
	},

	/**
	 * Drive the project's CHOSEN publish/deploy target through the gated driver in DRY-RUN (plan
	 * only — always safe, no creds). The release tab's end-to-end gated flow (D-037/D-018): returns
	 * the honest plan + the confirm token a follow-up REAL publish needs.
	 */
	targetDryRun: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { target: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) return fail(503, { target: { error: 'Database not connected.' } });
		const project = await getProject(db, projectId);
		if (!project) return fail(404, { target: { error: 'project not found' } });

		const form = await request.formData();
		const kind = String(form.get('kind') ?? '') as GatedKind;
		if (!GATED_KINDS.includes(kind)) return fail(400, { target: { error: 'kind must be publish or deploy' } });
		let targetId: string | undefined;
		const rawTarget = String(form.get('targetId') ?? '').trim();
		if (rawTarget) {
			try {
				targetId = assertRecordId(rawTarget);
			} catch {
				return fail(400, { target: { error: 'invalid target id' } });
			}
		}

		try {
			const out = await runTargetAction({
				db,
				env,
				projectId,
				cwd: project.root_path,
				kind,
				...(targetId ? { targetId } : {}),
				dryRun: true
			});
			return {
				target: {
					ok: true as const,
					dryRun: true,
					kind,
					adapterId: out.target.adapter_id,
					targetRef: out.result.target,
					summary: out.result.summary,
					steps: out.result.steps,
					warnings: out.result.warnings,
					confirmToken: out.confirmToken
				}
			};
		} catch (err) {
			return fail(409, { target: { error: (err as Error).message } });
		}
	},

	/**
	 * The gated REAL publish/deploy from the release tab (D-018): requires the confirm token from a
	 * prior dry-run. Thunderstore EXECUTES its real 4-step upload when THUNDERSTORE_TOKEN is set
	 * (TASK 14.7); a missing credential — and the npm/GitHub/static-host built-ins — return an
	 * honest "deferred to operator credentials". A missing/stale token fails CLOSED.
	 */
	targetConfirm: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { target: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) return fail(503, { target: { error: 'Database not connected.' } });
		const project = await getProject(db, projectId);
		if (!project) return fail(404, { target: { error: 'project not found' } });

		const form = await request.formData();
		const kind = String(form.get('kind') ?? '') as GatedKind;
		if (!GATED_KINDS.includes(kind)) return fail(400, { target: { error: 'kind must be publish or deploy' } });
		const confirmToken = String(form.get('confirmToken') ?? '').trim();
		let targetId: string | undefined;
		const rawTarget = String(form.get('targetId') ?? '').trim();
		if (rawTarget) {
			try {
				targetId = assertRecordId(rawTarget);
			} catch {
				return fail(400, { target: { error: 'invalid target id' } });
			}
		}

		try {
			const out = await runTargetAction({
				db,
				env,
				projectId,
				cwd: project.root_path,
				kind,
				...(targetId ? { targetId } : {}),
				dryRun: false,
				confirmToken
			});
			return {
				target: {
					ok: out.result.ok,
					dryRun: false,
					kind,
					adapterId: out.target.adapter_id,
					targetRef: out.result.target,
					summary: out.result.summary,
					steps: out.result.steps,
					warnings: out.result.warnings
				}
			};
		} catch (err) {
			if (err instanceof GateConfirmError) return fail(403, { target: { error: err.message } });
			return fail(500, { target: { error: (err as Error).message } });
		}
	},

	/**
	 * Post-publish VERIFY (TASK 14.7): drive the publish adapter's verify() — poll the external
	 * target until the published version is visible. Read-only (no gate needed), bounded in
	 * wall-clock, ledgered to target_run; an unconfirmed verify raises an incident (never silent).
	 */
	targetVerify: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { target: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) return fail(503, { target: { error: 'Database not connected.' } });
		const project = await getProject(db, projectId);
		if (!project) return fail(404, { target: { error: 'project not found' } });

		const form = await request.formData();
		let targetId: string | undefined;
		const rawTarget = String(form.get('targetId') ?? '').trim();
		if (rawTarget) {
			try {
				targetId = assertRecordId(rawTarget);
			} catch {
				return fail(400, { target: { error: 'invalid target id' } });
			}
		}

		try {
			const out = await runTargetVerify({
				db,
				env,
				projectId,
				cwd: project.root_path,
				...(targetId ? { targetId } : {})
			});
			return {
				target: {
					ok: out.result.ok,
					dryRun: false,
					verify: true as const,
					kind: 'publish' as const,
					adapterId: out.target.adapter_id,
					targetRef: out.result.target,
					summary: out.result.summary,
					steps: out.result.steps,
					warnings: out.result.warnings
				}
			};
		} catch (err) {
			return fail(409, { target: { error: (err as Error).message } });
		}
	}
};
