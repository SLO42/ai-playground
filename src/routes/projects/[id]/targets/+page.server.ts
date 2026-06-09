// TASK 12.1 — /projects/[id]/targets, the D-037 deploy/publish targets surface (F-008; D-026).
//
// Serves the per-project adapter-target surface: the targets the project has DECLARED
// ({adapterId, config} rows — real `project_target` rows, F-008), the registered adapters it can
// choose from (the registry's built-ins + any custom id), each adapter's honest probe + its
// named-secret PRESENCE (D-026 — never a value), and the run history (real `target_run` rows).
//
// Actions:
//   • declare  — declare/update a target ({adapterId, config}). An UNKNOWN adapter id fails CLOSED.
//   • remove   — remove a target declaration.
//   • dryRun   — drive the CHOSEN adapter through the gated driver in DRY-RUN (plan only, always
//                safe). Returns the plan + the confirm token a real action would need.
//   • confirm  — the gated REAL action (D-018): requires the confirm token from the dry-run; in
//                this track the built-ins return an honest "deferred to operator credentials"
//                (NO real external call) — the gate + recording machinery is fully exercised.
//
// Credentials are resolved from `$env/dynamic/private` into a CONFINED resolver at call time
// (D-026); the value never enters the DB, a log, or this surface.

import { env } from '$env/dynamic/private';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { getProject } from '$lib/server/projects/repo';
import { assertRecordId } from '$lib/server/db/validate';
import {
	getAdapterRegistry,
	declareTarget,
	listTargets,
	removeTarget,
	listTargetRuns,
	runTargetAction,
	describeAdapterSecrets,
	resolverForAdapter,
	GateConfirmError,
	UnknownAdapterError,
	type ProjectTargetRow,
	type TargetRunRow,
	type AdapterProbe,
	type SecretPresence,
	type AdapterKind,
	type ActionAdapter
} from '$lib/server/adapters';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

const ACTION_KINDS = ['publish', 'deploy'] as const;
type ActionKind = (typeof ACTION_KINDS)[number];

interface AdapterCatalogEntry {
	id: string;
	label: string;
	kind: AdapterKind;
	probe: AdapterProbe;
	secrets: SecretPresence[];
}

export interface TargetsData {
	connected: boolean;
	projectId: string;
	projectName?: string;
	kinds: readonly ActionKind[];
	/** The registered adapters the project can choose from (built-ins + custom), with probes. */
	catalog: AdapterCatalogEntry[];
	/** The project's declared targets (real project_target rows). */
	targets: ProjectTargetRow[];
	/** Recent gated-action runs (real target_run rows — never silent, F-008). */
	runs: TargetRunRow[];
	error?: string;
}

/** Probe + secret-presence for one adapter (honest — never throws; D-026 presence only). */
async function describeAdapter(adapter: ActionAdapter, cwd: string): Promise<AdapterCatalogEntry> {
	const secrets = describeAdapterSecrets(env, adapter);
	const resolver = resolverForAdapter(env, adapter);
	let probe: AdapterProbe;
	try {
		probe = await adapter.probe({ cwd, secrets: resolver });
	} catch (err) {
		probe = { available: false, reason: (err as Error).message };
	}
	return { id: adapter.id, label: adapter.label, kind: adapter.kind, probe, secrets };
}

export const load: PageServerLoad = async ({ params, depends }): Promise<TargetsData> => {
	depends('app:targets');

	let projectId: string;
	try {
		projectId = assertRecordId(`project:${params.id}`);
	} catch {
		throw error(404, 'invalid project id');
	}

	const db = tryGetDb();
	if (!db) {
		return { connected: false, projectId, kinds: ACTION_KINDS, catalog: [], targets: [], runs: [] };
	}

	try {
		const project = await getProject(db, projectId);
		if (!project) throw error(404, 'project not found');

		const registry = getAdapterRegistry();
		const adapters: ActionAdapter[] = [...registry.listPublishers(), ...registry.listDeployers()];
		const catalog = await Promise.all(adapters.map((a) => describeAdapter(a, project.root_path)));
		const targets = await listTargets(db, projectId);
		const runs = await listTargetRuns(db, projectId);

		return {
			connected: true,
			projectId,
			projectName: project.name,
			kinds: ACTION_KINDS,
			catalog,
			targets,
			runs
		};
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return {
			connected: false,
			projectId,
			kinds: ACTION_KINDS,
			catalog: [],
			targets: [],
			runs: [],
			error: (err as Error).message
		};
	}
};

/** Parse + validate a config JSON blob from the form (empty → {}). Throws on malformed JSON. */
function parseConfig(raw: FormDataEntryValue | null): Record<string, unknown> {
	const s = typeof raw === 'string' ? raw.trim() : '';
	if (!s) return {};
	const parsed = JSON.parse(s);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('config must be a JSON object');
	}
	return parsed as Record<string, unknown>;
}

export const actions: Actions = {
	/**
	 * Declare (upsert) a per-project target: {adapterId, config} for a kind. The adapter id is
	 * validated against the registry — an UNKNOWN id fails CLOSED with an honest error (D-037).
	 * Config is a JSON object; it may reference secrets by NAME only (D-026), never a value.
	 */
	declare: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { declare: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) return fail(503, { declare: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const kind = String(form.get('kind') ?? '') as ActionKind;
		if (!ACTION_KINDS.includes(kind)) return fail(400, { declare: { error: 'kind must be publish or deploy' } });
		const adapterId = String(form.get('adapterId') ?? '').trim();
		if (!adapterId) return fail(400, { declare: { error: 'choose an adapter' } });

		// Fail CLOSED on an unknown adapter id (D-037) — surface it honestly, never persist a dud.
		const registry = getAdapterRegistry();
		if (!registry.has(kind, adapterId)) {
			return fail(400, {
				declare: { error: new UnknownAdapterError(adapterId, kind).message }
			});
		}

		let config: Record<string, unknown>;
		try {
			config = parseConfig(form.get('config'));
		} catch (err) {
			return fail(400, { declare: { error: `config: ${(err as Error).message}` } });
		}
		const label = String(form.get('label') ?? '').trim() || undefined;
		const isDefault = form.get('isDefault') === 'on';
		const enabled = form.get('enabled') !== 'off';

		try {
			const t = await declareTarget(db, {
				project: projectId,
				kind,
				adapterId,
				...(label ? { label } : {}),
				config,
				enabled,
				isDefault
			});
			return { declare: { ok: true as const, id: t.id, adapterId: t.adapter_id, kind: t.kind } };
		} catch (err) {
			return fail(500, { declare: { error: (err as Error).message } });
		}
	},

	/** Remove a target declaration (by id). */
	remove: async ({ params, request }) => {
		try {
			assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { remove: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) return fail(503, { remove: { error: 'Database not connected.' } });
		const form = await request.formData();
		let targetId: string;
		try {
			targetId = assertRecordId(String(form.get('targetId') ?? ''));
		} catch {
			return fail(400, { remove: { error: 'invalid target id' } });
		}
		try {
			const ok = await removeTarget(db, targetId);
			return { remove: { ok } };
		} catch (err) {
			return fail(500, { remove: { error: (err as Error).message } });
		}
	},

	/**
	 * Dry-run the chosen adapter through the gated driver (plan only — always safe, no creds).
	 * Returns the honest plan + the confirm token a follow-up REAL action would need (D-018).
	 */
	dryRun: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { run: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) return fail(503, { run: { error: 'Database not connected.' } });

		const project = await getProject(db, projectId);
		if (!project) return fail(404, { run: { error: 'project not found' } });

		const form = await request.formData();
		const kind = String(form.get('kind') ?? '') as ActionKind;
		if (!ACTION_KINDS.includes(kind)) return fail(400, { run: { error: 'kind must be publish or deploy' } });
		let targetId: string | undefined;
		const rawTarget = String(form.get('targetId') ?? '').trim();
		if (rawTarget) {
			try {
				targetId = assertRecordId(rawTarget);
			} catch {
				return fail(400, { run: { error: 'invalid target id' } });
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
				run: {
					ok: true as const,
					dryRun: true,
					kind,
					adapterId: out.target.adapter_id,
					target: out.result.target,
					summary: out.result.summary,
					steps: out.result.steps,
					warnings: out.result.warnings,
					confirmToken: out.confirmToken
				}
			};
		} catch (err) {
			return fail(409, { run: { error: (err as Error).message } });
		}
	},

	/**
	 * The gated REAL action (D-018): requires the confirm token from a prior dry-run. In this
	 * track the built-in adapters perform NO real external call — they return an honest "deferred
	 * to operator credentials". A missing/stale token fails CLOSED (GateConfirmError → 403).
	 */
	confirm: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { run: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) return fail(503, { run: { error: 'Database not connected.' } });

		const project = await getProject(db, projectId);
		if (!project) return fail(404, { run: { error: 'project not found' } });

		const form = await request.formData();
		const kind = String(form.get('kind') ?? '') as ActionKind;
		if (!ACTION_KINDS.includes(kind)) return fail(400, { run: { error: 'kind must be publish or deploy' } });
		const confirmToken = String(form.get('confirmToken') ?? '').trim();
		let targetId: string | undefined;
		const rawTarget = String(form.get('targetId') ?? '').trim();
		if (rawTarget) {
			try {
				targetId = assertRecordId(rawTarget);
			} catch {
				return fail(400, { run: { error: 'invalid target id' } });
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
				run: {
					ok: out.result.ok,
					dryRun: false,
					kind,
					adapterId: out.target.adapter_id,
					target: out.result.target,
					summary: out.result.summary,
					steps: out.result.steps,
					warnings: out.result.warnings
				}
			};
		} catch (err) {
			if (err instanceof GateConfirmError) {
				return fail(403, { run: { error: err.message } });
			}
			return fail(500, { run: { error: (err as Error).message } });
		}
	}
};
