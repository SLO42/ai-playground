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
// Live execution status (TASK 14.7): Thunderstore's real branch EXECUTES the 4-step upload when
// the gate confirm passed and THUNDERSTORE_TOKEN is present (missing token → honest deferral).
// The npm / GitHub-releases / static-host built-ins still return an honest "deferred to operator
// credentials" — the gate + recording machinery is fully exercised either way.

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
 * Canonical JSON: object keys sorted recursively so two semantically-equal configs hash to the
 * SAME string regardless of key order (a re-serialised config must derive the same token), while
 * ANY value change produces a different string (so an edit invalidates outstanding tokens).
 */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const obj = value as Record<string, unknown>;
	const entries = Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
	return `{${entries.join(',')}}`;
}

/**
 * The kinds of GATED action a confirm token can bind. The three D-037 adapter families
 * (publish/deploy/sync = {@link AdapterKind}) PLUS other gated OUTWARD actions that reuse this
 * EXACT deterministic derivation instead of hand-rolling their own token — currently
 * 'repo-create' (the repo-creation gate, RC-2/REPO-CREATION-SPEC). Distinct kind strings keep a
 * publish token from ever confirming a repo-create (and vice-versa) — they hash differently.
 */
export type GatedActionKind = AdapterKind | 'repo-create';

/**
 * The confirm token binding a real action to the dry-run it followed. A sha256 of the
 * (project, kind, adapterId, sha256(canonical-JSON of the resolved target config)) tuple —
 * deterministic so a dry-run and its confirm derive the SAME token, but specific enough that
 * a token from one target can't confirm another AND a CONFIG EDIT between dry-run and confirm
 * changes the config hash → invalidates the outstanding token (fail closed, D-018).
 */
export function confirmTokenFor(input: {
	projectId: string;
	kind: GatedActionKind;
	adapterId: string;
	config: Record<string, unknown>;
}): string {
	const configHash = createHash('sha256').update(canonicalJson(input.config), 'utf8').digest('hex');
	return createHash('sha256')
		.update(`${input.projectId}|${input.kind}|${input.adapterId}|${configHash}`, 'utf8')
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

	// The token binds confirm→dry-run for THIS (project, kind, adapter, RESOLVED CONFIG) — a
	// config edit between dry-run and confirm changes the hash and invalidates the token (D-018).
	const token = confirmTokenFor({
		projectId: input.projectId,
		kind: input.kind,
		adapterId: target.adapter_id,
		config: target.config
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

// ── Post-publish VERIFY (TASK 14.7) ─────────────────────────────────────────────────────
//
// Drives a publish adapter's OPTIONAL verify() (poll the external target until the published
// version is visible). READ-ONLY — no external mutation, so no confirm gate (D-018 gates
// mutations); but it is still RECORDED to the unified target_run ledger (F-008) and an honest
// verify failure (timeout / not visible) raises an incident — never silent.

export interface RunTargetVerifyInput {
	db: Db;
	env: EnvLike;
	projectId: string;
	cwd: string;
	/** A specific publish `project_target` id, OR omit to use the project's default publish target. */
	targetId?: string;
}

export interface RunTargetVerifyResult {
	result: AdapterRunResult;
	run: TargetRunRow;
	target: ProjectTargetRow;
}

/**
 * Verify a publish target's last-published version is live, via the adapter's verify(). Resolves
 * the target (explicit or default publish), fails CLOSED on an unknown adapter id (D-037), and
 * fails HONESTLY when the adapter declares no verify(). Records every attempt as a target_run
 * row; an unconfirmed verify (ok:false — e.g. the bounded poll timed out) raises an incident.
 */
export async function runTargetVerify(input: RunTargetVerifyInput): Promise<RunTargetVerifyResult> {
	const target = await resolveTarget(input.db, input.projectId, 'publish', input.targetId);
	const adapter = getAdapterRegistry().getPublisher(target.adapter_id);
	if (typeof adapter.verify !== 'function') {
		throw new Error(
			`publish adapter "${target.adapter_id}" does not implement verify() — ` +
				`no automatic visibility check is available; verify manually per the runbook.`
		);
	}

	const secrets = resolverForAdapter(input.env, adapter);
	let result: AdapterRunResult;
	try {
		result = await adapter.verify({
			projectId: input.projectId,
			cwd: input.cwd,
			dryRun: false,
			config: target.config,
			secrets
		});
	} catch (err) {
		// An adapter throw is a failed verify — record it + raise an incident (never silent, F-008).
		const summary = `publish verify via ${target.adapter_id} failed: ${(err as Error).message}`;
		await recordTargetRun(input.db, {
			project: input.projectId,
			target: target.id,
			kind: 'publish',
			adapterId: target.adapter_id,
			dryRun: false,
			ok: false,
			summary,
			steps: []
		}).catch(() => {});
		await recordIncident(input.db, { title: summary, severity: 'error', detail: (err as Error).stack }).catch(() => {});
		throw err;
	}

	const run = await recordTargetRun(input.db, {
		project: input.projectId,
		target: target.id,
		kind: 'publish',
		adapterId: target.adapter_id,
		dryRun: false,
		ok: result.ok,
		targetRef: result.target,
		summary: `verify: ${result.summary}`,
		steps: result.steps
	});

	// An unconfirmed verify (honest timeout / not visible) raises an incident (TASK 14.7).
	if (!result.ok) {
		await recordIncident(input.db, {
			title: `publish verify via ${target.adapter_id} did not confirm`,
			severity: 'warn',
			detail: [result.summary, ...result.warnings].join('\n')
		}).catch(() => {});
	}

	return { result, run, target };
}

// ── SYNC family driver (TASK 12.4) ──────────────────────────────────────────────────────
//
// Sync is the third D-037 family. It is NOT a gated publish/deploy (no confirm token — a sync is
// idempotent + reversible, and the issue/board adapters already degrade honestly + record their
// OWN incidents). But to FINISH the framework we drive a project's DECLARED sync target through
// the SAME registry + the SAME `target_run` ledger as publish/deploy — so a sync run shows up in
// the unified run history beside publishes, and an UNKNOWN sync adapter id fails CLOSED the same
// way (D-037). This is the retrofit (12.4a): GitHub sync resolved + run as a registry adapter.

import { getSyncRegistry } from '../sync';
import type { SyncDirection, SyncResult } from '../sync/adapter';

export interface RunSyncTargetInput {
	db: Db;
	projectId: string;
	cwd: string;
	/** A specific sync `project_target` id, OR omit to use the project's default sync target. */
	targetId?: string;
	direction?: SyncDirection;
	dryRun?: boolean;
}

export interface RunSyncTargetResult {
	result: SyncResult;
	run: TargetRunRow;
	target: ProjectTargetRow;
}

/**
 * Drive a project's CHOSEN sync adapter (D-037) through the registry + the unified `target_run`
 * ledger. Resolves the declared sync target (explicit or default), resolves the adapter from the
 * SYNC registry (UNKNOWN id fails CLOSED — D-037), runs it idempotently, and RECORDS the attempt
 * as a `target_run` row (F-008 — the run history is one machine across all three families). The
 * adapter does its own honest degrade + incident recording, so this never gates with a token.
 */
export async function runSyncTarget(input: RunSyncTargetInput): Promise<RunSyncTargetResult> {
	const dryRun = input.dryRun ?? true;
	const direction = input.direction ?? 'both';
	const target = await resolveTarget(input.db, input.projectId, 'sync', input.targetId);

	// Resolve the adapter from the SYNC registry — an unknown id fails CLOSED (D-037).
	const registry = getSyncRegistry();
	if (!registry.has(target.adapter_id)) {
		throw new Error(
			`no sync adapter registered for id: ${JSON.stringify(target.adapter_id)} — ` +
				`a project's configured sync target points at an unknown adapter (fail closed, D-037).`
		);
	}
	const adapter = registry.get(target.adapter_id);

	let result: SyncResult;
	try {
		result = await adapter.sync(input.db, {
			projectId: input.projectId,
			cwd: input.cwd,
			direction,
			dryRun
		});
	} catch (err) {
		const summary = `sync via ${target.adapter_id} failed: ${(err as Error).message}`;
		await recordTargetRun(input.db, {
			project: input.projectId,
			target: target.id,
			kind: 'sync',
			adapterId: target.adapter_id,
			dryRun,
			ok: false,
			summary,
			steps: []
		}).catch(() => {});
		await recordIncident(input.db, { title: summary, severity: 'error', detail: (err as Error).stack }).catch(() => {});
		throw err;
	}

	const ok = result.errors.length === 0;
	const summary =
		`sync ${result.direction}${dryRun ? ' (dry-run)' : ''} ${result.target}: ` +
		`+${result.created} ~${result.updated} ↓${result.pulled} ⇄${result.linked} ·${result.skipped}` +
		(result.errors.length ? ` (${result.errors.length} error${result.errors.length === 1 ? '' : 's'})` : '');
	const run = await recordTargetRun(input.db, {
		project: input.projectId,
		target: target.id,
		kind: 'sync',
		adapterId: target.adapter_id,
		dryRun,
		ok,
		targetRef: result.target,
		summary,
		steps: result.items.map((i) => `${i.taskId}: ${i.action}${i.externalId ? ` → #${i.externalId}` : ''}`)
	});

	return { result, run, target };
}
