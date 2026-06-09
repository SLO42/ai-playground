// TASK 12.1 — the D-037 adapter REGISTRY + per-project target store.
//
// Two responsibilities, both the strategic seam D-037 calls for:
//
//   1. AdapterRegistry — the id→adapter map for the publish + deploy families (the sync family
//      keeps its own registry in sync/index.ts; this registry can ALSO see sync adapters for a
//      uniform resolve). Built-in adapters register at module load (builtins.ts); a project
//      resolves its adapter by the id it declares. An UNKNOWN id fails CLOSED with an honest
//      error (UnknownAdapterError) — a typo or a missing custom adapter is loud, never silent.
//
//   2. The per-project TARGET store — `project_target` CRUD (migration 0026). A project declares
//      its deploy/publish/sync targets as {adapterId, config} rows; THIS is the per-project
//      config the registry resolves against. Reuses the project settings storage discipline
//      from 10.4 (projects/repo.ts): boundary-validated ids bound as $param, option<T> omitted,
//      MERGE updates, SurrealDB datetime coerced to ISO strings in the normalizer (F-013).
//
// Boundary discipline (D-016): every VALUE binds via $param; the only interpolated token is the
// validated project/target record id (StringRecordId at the db/validate.ts chokepoint).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import {
	UnknownAdapterError,
	type ActionAdapter,
	type AdapterKind,
	type DeployTarget,
	type PublisherAdapter
} from './types';

// ── The id→adapter registry (publish + deploy families) ────────────────────────────────

/**
 * The D-037 registry for the gated-action adapters (publish + deploy). Holds NO state beyond
 * the id→adapter map; an adapter instance is stateless, so one process-wide instance is safe.
 * The sync family is registered in its own SyncRegistry (sync/index.ts) — this registry mirrors
 * the SAME shape so a caller resolves any family uniformly.
 */
export class AdapterRegistry {
	#publishers = new Map<string, PublisherAdapter>();
	#deployers = new Map<string, DeployTarget>();

	/** Register an adapter. Throws on a duplicate id within its family (programming error). */
	register(adapter: ActionAdapter): this {
		if (adapter.kind === 'publish') {
			if (this.#publishers.has(adapter.id)) {
				throw new Error(`publish adapter id already registered: ${adapter.id}`);
			}
			this.#publishers.set(adapter.id, adapter);
		} else {
			if (this.#deployers.has(adapter.id)) {
				throw new Error(`deploy adapter id already registered: ${adapter.id}`);
			}
			this.#deployers.set(adapter.id, adapter as DeployTarget);
		}
		return this;
	}

	/** Resolve a PUBLISHER by id. @throws {UnknownAdapterError} (fail closed) if unregistered. */
	getPublisher(id: string): PublisherAdapter {
		const a = this.#publishers.get(id);
		if (!a) throw new UnknownAdapterError(id, 'publish');
		return a;
	}

	/** Resolve a DEPLOY target by id. @throws {UnknownAdapterError} (fail closed) if unregistered. */
	getDeployer(id: string): DeployTarget {
		const a = this.#deployers.get(id);
		if (!a) throw new UnknownAdapterError(id, 'deploy');
		return a;
	}

	/** Resolve any action adapter by (kind, id) — fail closed on an unknown id. */
	get(kind: AdapterKind, id: string): ActionAdapter {
		if (kind === 'publish') return this.getPublisher(id);
		if (kind === 'deploy') return this.getDeployer(id);
		throw new UnknownAdapterError(id, kind);
	}

	/** True iff an adapter is registered for (kind, id). */
	has(kind: AdapterKind, id: string): boolean {
		if (kind === 'publish') return this.#publishers.has(id);
		if (kind === 'deploy') return this.#deployers.has(id);
		return false;
	}

	/** All registered publishers (for a "which targets are available" surface). */
	listPublishers(): PublisherAdapter[] {
		return [...this.#publishers.values()];
	}

	/** All registered deploy targets. */
	listDeployers(): DeployTarget[] {
		return [...this.#deployers.values()];
	}
}

// ── Per-project target store (project_target — migration 0026) ──────────────────────────

/** A persisted `project_target` row (SDK RecordId/Date coerced to plain JSON). */
export interface ProjectTargetRow {
	id: string;
	project: string;
	kind: AdapterKind;
	adapter_id: string;
	label: string;
	config: Record<string, unknown>;
	enabled: boolean;
	is_default: boolean;
	created_at: string;
	updated_at: string;
}

export interface DeclareTargetInput {
	project: string;
	kind: AdapterKind;
	adapterId: string;
	label?: string;
	config?: Record<string, unknown>;
	enabled?: boolean;
	isDefault?: boolean;
}

/** Coerce a SurrealDB datetime (Date / wrapped) to a plain ISO string (F-013), or '' when absent. */
function iso(v: unknown): string {
	if (v == null) return '';
	if (v instanceof Date) return v.toISOString();
	return String(v);
}

function normTarget(row: Record<string, unknown>): ProjectTargetRow {
	return {
		id: String(row.id),
		project: String(row.project),
		kind: String(row.kind) as AdapterKind,
		adapter_id: String(row.adapter_id),
		label: String(row.label ?? row.adapter_id ?? ''),
		config: (row.config && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {}),
		enabled: Boolean(row.enabled),
		is_default: Boolean(row.is_default),
		created_at: iso(row.created_at),
		updated_at: iso(row.updated_at)
	};
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Declare (upsert) a per-project target. Idempotent by (project, kind, adapter_id) — the UNIQUE
 * dedup index makes a re-declare an UPDATE (preserving created_at), never a duplicate. A target
 * marked default clears the default flag off the project's OTHER targets of the same kind first
 * (one default per kind). The label defaults to the adapter id. Config is bound as a $param blob
 * (FLEXIBLE column) — it may reference secrets by NAME only (D-026), never a value.
 */
export async function declareTarget(db: Db, input: DeclareTargetInput): Promise<ProjectTargetRow> {
	const project = link(input.project);
	const label = (input.label ?? input.adapterId).trim() || input.adapterId;
	const config = input.config ?? {};
	const enabled = input.enabled ?? true;
	const isDefault = input.isDefault ?? false;

	// One default per (project, kind): clear the flag off siblings before setting this one.
	if (isDefault) {
		await db.query(
			`UPDATE project_target SET is_default = false
			  WHERE project = $project AND kind = $kind AND is_default = true;`,
			{ project, kind: input.kind }
		);
	}

	// Upsert by the (project, kind, adapter_id) tuple.
	const [existing] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM project_target
		  WHERE project = $project AND kind = $kind AND adapter_id = $adapter_id LIMIT 1;`,
		{ project, kind: input.kind, adapter_id: input.adapterId }
	);

	if (existing.length) {
		const rid = new StringRecordId(assertRecordId(String(existing[0].id)));
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(
			`UPDATE $rid MERGE $content RETURN AFTER;`,
			{ rid, content: { label, config, enabled, is_default: isDefault, updated_at: new Date() } }
		);
		return normTarget(rows[0]);
	}

	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`CREATE project_target CONTENT $content RETURN AFTER;`,
		{
			content: {
				project,
				kind: input.kind,
				adapter_id: input.adapterId,
				label,
				config,
				enabled,
				is_default: isDefault
			}
		}
	);
	return normTarget(rows[0]);
}

/** List a project's declared targets (optionally filtered by kind), newest first. */
export async function listTargets(
	db: Db,
	projectId: string,
	kind?: AdapterKind
): Promise<ProjectTargetRow[]> {
	const project = link(projectId);
	const q = kind
		? `SELECT * FROM project_target WHERE project = $project AND kind = $kind ORDER BY created_at;`
		: `SELECT * FROM project_target WHERE project = $project ORDER BY kind, created_at;`;
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(q, { project, kind });
	return rows.map(normTarget);
}

/** Get one target by id, or null. */
export async function getTarget(db: Db, targetId: string): Promise<ProjectTargetRow | null> {
	const rid = link(targetId);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? normTarget(rows[0]) : null;
}

/**
 * Resolve the target a project uses for a kind: the one flagged `is_default` if present, else
 * the first enabled target of that kind, else null. The publish/deploy pipeline calls this to
 * pick the CHOSEN adapter (D-037) — not a fixed script.
 */
export async function resolveDefaultTarget(
	db: Db,
	projectId: string,
	kind: AdapterKind
): Promise<ProjectTargetRow | null> {
	const targets = (await listTargets(db, projectId, kind)).filter((t) => t.enabled);
	if (targets.length === 0) return null;
	return targets.find((t) => t.is_default) ?? targets[0];
}

/** Remove a target declaration. Returns true iff a row was deleted. */
export async function removeTarget(db: Db, targetId: string): Promise<boolean> {
	const rid = link(targetId);
	const [rows] = await db.query<[unknown[]]>(`DELETE $rid RETURN BEFORE;`, { rid });
	return rows.length > 0;
}

// ── target_run ledger (recorded gated actions — never silent, F-008) ────────────────────

export interface TargetRunRow {
	id: string;
	project: string;
	target?: string;
	kind: AdapterKind;
	adapter_id: string;
	dry_run: boolean;
	ok: boolean;
	target_ref?: string;
	summary: string;
	steps: string[];
	at: string;
}

export interface RecordTargetRunInput {
	project: string;
	target?: string;
	kind: AdapterKind;
	adapterId: string;
	dryRun: boolean;
	ok: boolean;
	targetRef?: string;
	summary: string;
	steps?: string[];
}

function normTargetRun(row: Record<string, unknown>): TargetRunRow {
	return {
		id: String(row.id),
		project: String(row.project),
		...(row.target != null ? { target: String(row.target) } : {}),
		kind: String(row.kind) as AdapterKind,
		adapter_id: String(row.adapter_id),
		dry_run: Boolean(row.dry_run),
		ok: Boolean(row.ok),
		...(row.target_ref != null ? { target_ref: String(row.target_ref) } : {}),
		summary: String(row.summary ?? ''),
		steps: Array.isArray(row.steps) ? row.steps.map(String) : [],
		at: iso(row.at)
	};
}

/** Record one gated action attempt (publish/deploy) — every run is a real row (F-008). */
export async function recordTargetRun(db: Db, input: RecordTargetRunInput): Promise<TargetRunRow> {
	const content: Record<string, unknown> = {
		project: link(input.project),
		kind: input.kind,
		adapter_id: input.adapterId,
		dry_run: input.dryRun,
		ok: input.ok,
		summary: input.summary,
		steps: input.steps ?? []
	};
	if (input.target) content.target = link(input.target);
	if (input.targetRef !== undefined) content.target_ref = input.targetRef;
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`CREATE target_run CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normTargetRun(rows[0]);
}

/** Recent target runs for a project, newest first (the surface's run history). */
export async function listTargetRuns(db: Db, projectId: string, limit = 25): Promise<TargetRunRow[]> {
	const project = link(projectId);
	// `at` must appear in the projection to be used in ORDER BY (SurrealDB 2.x, the 6.9 bug).
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT *, at FROM target_run WHERE project = $project ORDER BY at DESC LIMIT $limit;`,
		{ project, limit }
	);
	return rows.map(normTargetRun);
}
