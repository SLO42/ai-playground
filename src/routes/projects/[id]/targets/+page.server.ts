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
	getTarget,
	removeTarget,
	listTargetRuns,
	runTargetAction,
	runSyncTarget,
	resolverForAdapter,
	buildAdapterCatalog,
	isInstalled,
	ADAPTER_KINDS,
	GateConfirmError,
	UnknownAdapterError,
	type ProjectTargetRow,
	type TargetRunRow,
	type CatalogEntry,
	type AdapterKind
} from '$lib/server/adapters';
import { listSyncIncidents, type SyncIncidentRow } from '$lib/server/sync';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/** All three D-037 families are declarable + driveable from this surface (12.4). */
const KINDS = ADAPTER_KINDS;
/** The GATED families (a confirm-token dry-run→publish flow); sync is idempotent, ungated. */
const GATED_KINDS = ['publish', 'deploy'] as const;
type GatedKind = (typeof GATED_KINDS)[number];

/** A declared target enriched with its honest per-target status (last run + open incidents). */
export interface TargetView extends ProjectTargetRow {
	/** True iff the target's adapter id is a REGISTERED adapter (false → "adapter not installed"). */
	installed: boolean;
	/** The most recent run through this target, or null (honest — never fabricated). */
	lastRun: TargetRunRow | null;
}

export interface TargetsData {
	connected: boolean;
	projectId: string;
	projectName?: string;
	kinds: readonly AdapterKind[];
	/** The registered adapters the project can choose from (all three families), with probes. */
	catalog: CatalogEntry[];
	/** The project's declared targets (real project_target rows) + per-target status. */
	targets: TargetView[];
	/** Recent runs across all families (real target_run rows — never silent, F-008). */
	runs: TargetRunRow[];
	/** Recent sync incidents (failures — never silent, F-008). */
	incidents: SyncIncidentRow[];
	error?: string;
}

export const load: PageServerLoad = async ({ params, depends }): Promise<TargetsData> => {
	depends('app:targets');
	depends('app:sync');

	let projectId: string;
	try {
		projectId = assertRecordId(`project:${params.id}`);
	} catch {
		throw error(404, 'invalid project id');
	}

	const db = tryGetDb();
	if (!db) {
		return { connected: false, projectId, kinds: KINDS, catalog: [], targets: [], runs: [], incidents: [] };
	}

	try {
		const project = await getProject(db, projectId);
		if (!project) throw error(404, 'project not found');

		// The UNIFIED catalog across all three families — publish/deploy from the AdapterRegistry,
		// sync from the SyncRegistry (the 12.4 retrofit). Each entry carries an honest probe.
		const catalog = await buildAdapterCatalog({ env, cwd: project.root_path, db, projectId });
		const declared = await listTargets(db, projectId);
		const runs = await listTargetRuns(db, projectId);
		const incidents = await listSyncIncidents(db, projectId);

		// Per-target status: is the adapter installed (else honest "not installed"), and its last run.
		const targets: TargetView[] = declared.map((t) => ({
			...t,
			installed: isInstalled(t.kind, t.adapter_id),
			lastRun: runs.find((r) => r.target === t.id || r.adapter_id === t.adapter_id) ?? null
		}));

		return {
			connected: true,
			projectId,
			projectName: project.name,
			kinds: KINDS,
			catalog,
			targets,
			runs,
			incidents
		};
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return {
			connected: false,
			projectId,
			kinds: KINDS,
			catalog: [],
			targets: [],
			runs: [],
			incidents: [],
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

/** A bare adapter id shape: lowercase, digits, dash/underscore — the D-016 id discipline. */
const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A named-secret reference shape: an env-var NAME (UPPER_SNAKE), never a value (D-026). */
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export const actions: Actions = {
	/**
	 * Declare (upsert) a per-project target: {adapterId, config} for a kind (publish · deploy ·
	 * sync). The adapter id may be a BUILT-IN or a CUSTOM id the core does not ship — a custom id
	 * is PERSISTED honestly (the D-037 scale story); the surface marks it "adapter not installed"
	 * and the driver fails closed at run time. Config is a JSON object; it may reference secrets by
	 * NAME only (D-026), captured in a dedicated `secret_ref` field — never a value.
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
		const kind = String(form.get('kind') ?? '') as AdapterKind;
		if (!KINDS.includes(kind)) return fail(400, { declare: { error: 'kind must be publish, deploy or sync' } });

		// The adapter id comes EITHER from the built-in picker OR the custom-id field (D-037 scale).
		const builtinId = String(form.get('adapterId') ?? '').trim();
		const customId = String(form.get('customAdapterId') ?? '').trim();
		const adapterId = customId || builtinId;
		if (!adapterId) return fail(400, { declare: { error: 'choose a built-in adapter or enter a custom adapter id' } });
		if (!ADAPTER_ID_RE.test(adapterId)) {
			return fail(400, {
				declare: { error: 'adapter id must be lowercase letters, digits, dash or underscore (e.g. my-cdn)' }
			});
		}

		let config: Record<string, unknown>;
		try {
			config = parseConfig(form.get('config'));
		} catch (err) {
			return fail(400, { declare: { error: `config: ${(err as Error).message}` } });
		}

		// Named-secret REFERENCE (D-026) — a NAME only. Stored in config.secret_ref so the adapter
		// (and the operator) know which .env var powers a real action. A VALUE is never accepted.
		const secretRef = String(form.get('secretRef') ?? '').trim();
		if (secretRef) {
			if (!SECRET_NAME_RE.test(secretRef)) {
				return fail(400, {
					declare: { error: 'secret reference must be an env-var NAME (UPPER_SNAKE_CASE) — never a value (D-026)' }
				});
			}
			config = { ...config, secret_ref: secretRef };
		}

		const label = String(form.get('label') ?? '').trim() || undefined;
		const isDefault = form.get('isDefault') === 'on';
		const enabled = form.get('enabled') !== 'off';

		const installed = isInstalled(kind, adapterId);
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
			return {
				declare: { ok: true as const, id: t.id, adapterId: t.adapter_id, kind: t.kind, installed }
			};
		} catch (err) {
			return fail(500, { declare: { error: (err as Error).message } });
		}
	},

	/**
	 * Run a project's CHOSEN sync target (D-037 retrofit, 12.4a) — GitHub task↔issue / board sync
	 * driven through the registry + the unified `target_run` ledger. Idempotent; the adapter
	 * degrades honestly (F-008). Default is a dry-run preview; `?dryRun=off` runs for real.
	 */
	syncRun: async ({ params, request }) => {
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
		let targetId: string | undefined;
		const rawTarget = String(form.get('targetId') ?? '').trim();
		if (rawTarget) {
			try {
				targetId = assertRecordId(rawTarget);
			} catch {
				return fail(400, { run: { error: 'invalid target id' } });
			}
		}
		const dryRun = form.get('dryRun') !== 'off';

		try {
			const out = await runSyncTarget({
				db,
				projectId,
				cwd: project.root_path,
				...(targetId ? { targetId } : {}),
				dryRun
			});
			return {
				run: {
					ok: out.run.ok,
					dryRun,
					kind: 'sync' as const,
					adapterId: out.target.adapter_id,
					target: out.result.target,
					summary: out.run.summary,
					steps: out.run.steps,
					warnings: out.result.errors
				}
			};
		} catch (err) {
			return fail(409, { run: { error: (err as Error).message } });
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
		const kind = String(form.get('kind') ?? '') as GatedKind;
		if (!GATED_KINDS.includes(kind)) return fail(400, { run: { error: 'kind must be publish or deploy' } });
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
	 * PACKAGE preflight (publishers only): run the chosen publisher's validate() + package() in
	 * DRY-RUN (plan only — always safe, no creds, no upload). Surfaces the honest VALIDATION verdict
	 * (blockers/warnings) + the produced ZIP CONTENTS listing (the package steps), so the operator
	 * sees exactly what WOULD ship before any publish (D-038 honest, F-008). Never mutates anything.
	 */
	packagePreview: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { pkg: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) return fail(503, { pkg: { error: 'Database not connected.' } });

		const project = await getProject(db, projectId);
		if (!project) return fail(404, { pkg: { error: 'project not found' } });

		const form = await request.formData();
		let targetId: string;
		try {
			targetId = assertRecordId(String(form.get('targetId') ?? ''));
		} catch {
			return fail(400, { pkg: { error: 'invalid target id' } });
		}

		const target = await getTarget(db, targetId);
		if (!target || target.project !== projectId) return fail(404, { pkg: { error: 'target not found' } });
		if (target.kind !== 'publish') return fail(400, { pkg: { error: 'package preview applies to publish targets only' } });

		const registry = getAdapterRegistry();
		if (!registry.has('publish', target.adapter_id)) {
			return fail(400, { pkg: { error: new UnknownAdapterError(target.adapter_id, 'publish').message } });
		}
		const adapter = registry.getPublisher(target.adapter_id);
		const secrets = resolverForAdapter(env, adapter);
		const runOpts = { projectId, cwd: project.root_path, dryRun: true as const, config: target.config, secrets };

		try {
			const validation = await adapter.validate(runOpts);
			const pkg = await adapter.package(runOpts);
			return {
				pkg: {
					ok: true as const,
					adapterId: target.adapter_id,
					target: pkg.target,
					valid: validation.ok,
					blockers: validation.blockers,
					warnings: [...new Set([...validation.warnings, ...pkg.warnings])],
					artifact: pkg.artifact ?? null,
					summary: pkg.summary,
					steps: pkg.steps
				}
			};
		} catch (err) {
			return fail(500, { pkg: { error: (err as Error).message } });
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
		const kind = String(form.get('kind') ?? '') as GatedKind;
		if (!GATED_KINDS.includes(kind)) return fail(400, { run: { error: 'kind must be publish or deploy' } });
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
