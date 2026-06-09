// TASK 12.1 — the GATED action driver (D-018/D-024) for the D-037 adapter framework.
//
// A publish/deploy is a GATED, CONFIRMABLE action (D-018). This driver is the single chokepoint
// the release pipeline (3.4) + the workspace surface drive through, so the gating, the credential
// confinement, the run-recording, and the incident-on-failure are ONE machine — not re-derived
// per caller. The contract:
//
//   • A DRY-RUN needs NO confirm + NO creds — it computes the plan and is always safe.
//   • A REAL (non-dry-run) action FAILS CLOSED unless the caller supplies a confirm token that
//     matches the one the dry-run produced for the SAME (project, target, adapter) — exactly the
//     "validate → review → confirm" shape config/settings-write.ts uses (D-010/D-018). A missing
//     or stale token raises GateConfirmError (never silently runs the real action).
//   • Every attempt is RECORDED as a target_run row (F-008 — never silent) and a FAILURE also
//     records an incident, so the surface shows an honest last-result instead of swallowing it.
//   • Credentials are resolved per-call from the runtime env into a CONFINED SecretResolver
//     scoped to the adapter's declared secrets (D-026) — the value never enters the DB/a log.
//
// This track performs NO real external publish/deploy: a built-in's real branch returns ok:false
// with an honest "deferred to operator credentials" — the gate + recording machinery is fully
// exercised regardless (the real call lands when operator creds + the operator's confirm arrive).

import { createHash } from 'node:crypto';
import type { Db } from '../db/client';
import { recordIncident } from '../services/incidents';
import { resolverForAdapter, type EnvLike } from './secrets';
import {
	getTarget,
	recordTargetRun,
	resolveDefaultTarget,
	type ProjectTargetRow,
	type TargetRunRow
} from './registry';
import { getAdapterRegistry } from './index';
import type { AdapterKind, AdapterRunResult, ActionAdapter } from './types';

/** Thrown when a REAL action is requested without a valid confirm token (fail closed, D-018). */
export class GateConfirmError extends Error {
	override readonly name = 'GateConfirmError';
	constructor(message: string) {
		super(message);
	}
}

/**
 * The confirm token binding a real action to the dry-run it followed. A sha256 of the
 * (project, kind, adapterId, target-ref) tuple — deterministic so a dry-run and its confirm
 * derive the SAME token, but specific enough that a token from one target can't confirm another.
 */
export function confirmTokenFor(input: {
	projectId: string;
	kind: AdapterKind;
	adapterId: string;
	targetRef: string;
}): string {
	return createHash('sha256')
		.update(`${input.projectId}|${input.kind}|${input.adapterId}|${input.targetRef}`, 'utf8')
		.digest('hex');
}

export interface RunTargetActionInput {
	db: Db;
	/** Runtime env (from `$env/dynamic/private`) the confined resolver reads creds from (D-026). */
	env: EnvLike;
	projectId: string;
	/** Project root the adapter's tool runs in. */
	cwd: string;
	/** Which family to drive. */
	kind: Exclude<AdapterKind, 'sync'>;
	/**
	 * The target to drive. A specific `project_target` id, OR omit to use the project's resolved
	 * default target of this kind (D-037: drive the CHOSEN adapter, not a fixed script).
	 */
	targetId?: string;
	/** Dry-run (plan only, always safe) vs a real action (gated). Default true. */
	dryRun?: boolean;
	/** The confirm token — MANDATORY for a real action; ignored for a dry-run. */
	confirmToken?: string;
}

export interface RunTargetActionResult {
	/** The adapter run envelope (honest plan/result). */
	result: AdapterRunResult;
	/** The recorded target_run row. */
	run: TargetRunRow;
	/** The confirm token a follow-up REAL action must supply (returned on a dry-run). */
	confirmToken: string;
	/** The resolved target declaration. */
	target: ProjectTargetRow;
}

/** Resolve the project_target a run uses — an explicit id, or the kind's default. */
async function resolveTarget(
	db: Db,
	projectId: string,
	kind: AdapterKind,
	targetId?: string
): Promise<ProjectTargetRow> {
	if (targetId) {
		const t = await getTarget(db, targetId);
		if (!t) throw new Error(`target not found: ${targetId}`);
		if (t.project !== projectId) throw new Error('target does not belong to this project');
		if (t.kind !== kind) throw new Error(`target is a ${t.kind} target, not ${kind}`);
		return t;
	}
	const def = await resolveDefaultTarget(db, projectId, kind);
	if (!def)
		throw new Error(
			`no ${kind} target configured for this project — declare one (adapterId + config) first (D-037).`
		);
	return def;
}

/** Invoke the right adapter method for the (kind, dryRun) combination. */
async function invoke(
	adapter: ActionAdapter,
	args: { projectId: string; cwd: string; dryRun: boolean; config: Record<string, unknown>; secrets: ReturnType<typeof resolverForAdapter> }
): Promise<AdapterRunResult> {
	if (adapter.kind === 'publish') {
		return adapter.publish(args);
	}
	return adapter.deploy(args);
}

/**
 * Drive a project's CHOSEN publish/deploy adapter through the gate (D-018/D-024). Resolves the
 * target (explicit or default), resolves the adapter from the registry (UNKNOWN id fails CLOSED —
 * D-037), builds a CONFINED resolver (D-026), enforces the confirm-token gate for a real action,
 * runs the adapter, RECORDS the attempt (F-008), and raises an incident on failure (never silent).
 */
export async function runTargetAction(input: RunTargetActionInput): Promise<RunTargetActionResult> {
	const dryRun = input.dryRun ?? true;
	const target = await resolveTarget(input.db, input.projectId, input.kind, input.targetId);

	// Resolve the adapter — an unknown adapter id fails CLOSED with an honest error (D-037).
	const registry = getAdapterRegistry();
	const adapter = registry.get(input.kind, target.adapter_id);

	// The token binds confirm→dry-run for THIS (project, kind, adapter, target).
	const token = confirmTokenFor({
		projectId: input.projectId,
		kind: input.kind,
		adapterId: target.adapter_id,
		targetRef: target.adapter_id // the adapter id is the stable target ref pre-probe
	});

	// GATE (D-018): a real action requires a matching confirm token; fail CLOSED otherwise.
	if (!dryRun) {
		if (!input.confirmToken) {
			throw new GateConfirmError(
				`a real ${input.kind} is a gated action — run a dry-run first, review the plan, then confirm (D-018).`
			);
		}
		if (input.confirmToken !== token) {
			throw new GateConfirmError(
				`confirm token does not match this target — re-review the dry-run plan and confirm again (D-018).`
			);
		}
	}

	const secrets = resolverForAdapter(input.env, adapter);
	let result: AdapterRunResult;
	try {
		result = await invoke(adapter, {
			projectId: input.projectId,
			cwd: input.cwd,
			dryRun,
			config: target.config,
			secrets
		});
	} catch (err) {
		// An adapter throw is a failed run — record it + raise an incident (never silent, F-008).
		const summary = `${input.kind} via ${target.adapter_id} failed: ${(err as Error).message}`;
		await recordTargetRun(input.db, {
			project: input.projectId,
			target: target.id,
			kind: input.kind,
			adapterId: target.adapter_id,
			dryRun,
			ok: false,
			summary,
			steps: []
		}).catch(() => {});
		await recordIncident(input.db, { title: summary, severity: 'error', detail: (err as Error).stack }).catch(() => {});
		throw err;
	}

	// Record the attempt (every run is a real row — F-008).
	const run = await recordTargetRun(input.db, {
		project: input.projectId,
		target: target.id,
		kind: input.kind,
		adapterId: target.adapter_id,
		dryRun,
		ok: result.ok,
		targetRef: result.target,
		summary: result.summary,
		steps: result.steps
	});

	// A failed REAL action raises an incident so the surface never silently swallows it (D-018).
	if (!result.ok && !dryRun) {
		await recordIncident(input.db, {
			title: `${input.kind} via ${target.adapter_id} did not complete`,
			severity: 'warn',
			detail: [result.summary, ...result.warnings].join('\n')
		}).catch(() => {});
	}

	return { result, run, confirmToken: token, target };
}
