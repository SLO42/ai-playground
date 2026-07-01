// LOOP MANIFEST — the DECLARED layer over the derived runtime loop view (LOOP-ENGINEERING.md step 3).
//
// loops/read.ts (getLoops) is the RUNNING view: it synthesizes the loop families from live pm/orchestrator
// state. THIS module is the durable DECLARED layer (migration 0072, table `loop`): the operator's per-loop
// declaration + its Loop Design Checklist readiness state. It does NOT drive execution (pm/orchestrator
// still do) — it records the declaration and grades readiness, and RECONCILES declared-vs-running so the
// surface is honest (F-008): a declared-but-not-running loop is surfaced as exactly that, never a fake card;
// a running-but-undeclared loop is surfaced as undeclared, never silently hidden.
//
// Boundary discipline (D-016): record ids / table names validated at db/validate first; every VALUE binds
// via $param. The manifest is keyed by `identifier` (the SAME stable id the runtime LoopView uses) so the
// reconcile join is a string-equality on identifier === LoopView.id.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { LoopView, LoopScope } from './read';
import type { ChecklistState, DeclaredPhase } from '../../components/loops/readiness-core';
import { evaluateReadiness, type ReadinessResult } from '../../components/loops/readiness-core';

/** Manifest loop kinds — the runtime LoopKind set plus the forward-looking game-verify loop. */
export type LoopManifestKind =
	| 'orchestrator'
	| 'pm-autonomous'
	| 'pm-cadence'
	| 'memory-review'
	| 'game-verify';

/** A persisted `loop` manifest row (migration 0072). Datetimes are ISO strings or null (F-013). */
export interface LoopManifestRow {
	id: string;
	/** Stable identifier — the SAME id the runtime LoopView uses (the reconcile join key). */
	identifier: string;
	kind: LoopManifestKind;
	label: string;
	/** Set for project-scoped loops; null for the GLOBAL loops (orchestrator, memory-review). */
	projectId: string | null;
	/** Declared cadence (free text mirror of the live cadence); null when unset. */
	cadence: string | null;
	/** Declared maturity phase (L1/L2/L3) the operator has promoted this loop to. */
	phase: DeclaredPhase;
	enabled: boolean;
	/** The Loop Design Checklist state: item id → checked. Absent keys ⇒ unchecked (F-008). */
	checklist: ChecklistState;
	/** The operator's sovereign "arm anyway" override of the readiness gate. */
	override: boolean;
	overrideReason: string | null;
	overrideAt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/** Identity an upsert declares a loop with — grounded in the live LoopView (never invented; F-008). */
export interface UpsertLoopInput {
	identifier: string;
	kind: LoopManifestKind;
	label: string;
	/** Project record id for a project-scoped loop; omit/null for a global loop. */
	projectId?: string | null;
	cadence?: string | null;
	phase?: DeclaredPhase;
}

const ALLOWED_KINDS: ReadonlySet<string> = new Set([
	'orchestrator',
	'pm-autonomous',
	'pm-cadence',
	'memory-review',
	'game-verify'
]);

/** Coerce a SurrealDB datetime (non-POJO in 2.x) to ISO, or null when absent — never 'undefined' (F-013). */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	if (v instanceof Date) return v.toISOString();
	const s = String(v);
	return s && s !== 'undefined' && s !== 'null' ? s : null;
}

interface RawLoopRow {
	id: unknown;
	identifier?: unknown;
	kind?: unknown;
	label?: unknown;
	project?: unknown;
	cadence?: unknown;
	phase?: unknown;
	enabled?: unknown;
	checklist?: unknown;
	override?: unknown;
	override_reason?: unknown;
	override_at?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
}

/** Normalize a raw `loop` row to the typed manifest view — honest coercions only (F-008/F-013). */
function normLoop(row: RawLoopRow): LoopManifestRow {
	const kind = typeof row.kind === 'string' && ALLOWED_KINDS.has(row.kind)
		? (row.kind as LoopManifestKind)
		: 'orchestrator';
	const phase = row.phase === 'L2' || row.phase === 'L3' ? (row.phase as DeclaredPhase) : 'L1';
	const checklist: ChecklistState =
		row.checklist && typeof row.checklist === 'object' ? (row.checklist as ChecklistState) : {};
	return {
		id: String(row.id),
		identifier: typeof row.identifier === 'string' ? row.identifier : '',
		kind,
		label: typeof row.label === 'string' ? row.label : '',
		projectId: row.project != null ? String(row.project) : null,
		cadence: typeof row.cadence === 'string' && row.cadence ? row.cadence : null,
		phase,
		enabled: row.enabled !== false,
		checklist,
		override: row.override === true,
		overrideReason:
			typeof row.override_reason === 'string' && row.override_reason ? row.override_reason : null,
		overrideAt: isoOrNull(row.override_at),
		createdAt: isoOrNull(row.created_at),
		updatedAt: isoOrNull(row.updated_at)
	};
}

function projectLink(projectId: string): StringRecordId {
	return new StringRecordId(assertRecordId(projectId));
}

/** Every manifest row, or only one project's (the per-project tab). Global rows have project = NULL. */
export async function listLoopManifest(
	db: Db,
	opts: { projectId?: string } = {}
): Promise<LoopManifestRow[]> {
	if (opts.projectId) {
		const pid = projectLink(opts.projectId);
		const [rows] = await db.query<[RawLoopRow[]]>(
			`SELECT * FROM loop WHERE project = $pid ORDER BY identifier;`,
			{ pid }
		);
		return (rows ?? []).map(normLoop);
	}
	const [rows] = await db.query<[RawLoopRow[]]>(`SELECT * FROM loop ORDER BY identifier;`);
	return (rows ?? []).map(normLoop);
}

/** One manifest row by its stable identifier, or null when the loop has not been declared yet. */
export async function getLoopManifest(db: Db, identifier: string): Promise<LoopManifestRow | null> {
	const [rows] = await db.query<[RawLoopRow[]]>(
		`SELECT * FROM loop WHERE identifier = $identifier LIMIT 1;`,
		{ identifier }
	);
	return rows.length ? normLoop(rows[0]) : null;
}

/**
 * Declare (or update the declared identity of) a loop, keyed by identifier. Idempotent: an existing row
 * MERGEs its identity fields (preserving checklist/override/enabled); a new row is CREATEd with the
 * Design Checklist empty (readiness not green until the operator ticks it). The kind is validated against
 * the allow-list; an unknown kind is rejected at the boundary rather than written (EVERY ERROR HAS A NAME).
 */
export async function upsertLoopManifest(db: Db, input: UpsertLoopInput): Promise<LoopManifestRow> {
	if (!ALLOWED_KINDS.has(input.kind)) {
		throw new Error(`upsertLoopManifest: unknown loop kind "${input.kind}"`);
	}
	const existing = await getLoopManifest(db, input.identifier);
	const phase: DeclaredPhase = input.phase ?? existing?.phase ?? 'L1';
	// `project` is option<record> — option<T> REJECTS NULL (§6.1), so SET it only when present and CLEAR
	// it with NONE otherwise (a global loop has no project). cadence is option<string> — same discipline.
	const projectSet = input.projectId ? 'project = $project' : 'project = NONE';
	const cadenceSet = input.cadence ? 'cadence = $cadence' : 'cadence = NONE';
	const binds: Record<string, unknown> = {
		kind: input.kind,
		label: input.label,
		phase
	};
	if (input.projectId) binds.project = projectLink(input.projectId);
	if (input.cadence) binds.cadence = input.cadence;

	if (existing) {
		const [rows] = await db.query<[RawLoopRow[]]>(
			`UPDATE $rid SET kind = $kind, label = $label, phase = $phase, ${projectSet}, ${cadenceSet},
				updated_at = time::now() RETURN AFTER;`,
			{ ...binds, rid: new StringRecordId(assertRecordId(existing.id)) }
		);
		return normLoop(rows[0]);
	}
	const [rows] = await db.query<[RawLoopRow[]]>(
		`CREATE loop SET identifier = $identifier, kind = $kind, label = $label, phase = $phase,
			${projectSet}, ${cadenceSet} RETURN AFTER;`,
		{ ...binds, identifier: input.identifier }
	);
	return normLoop(rows[0]);
}

/** Set/clear one Design-Checklist item on a declared loop. Returns null when the loop is not declared. */
export async function setLoopChecklistItem(
	db: Db,
	identifier: string,
	itemId: string,
	checked: boolean
): Promise<LoopManifestRow | null> {
	const existing = await getLoopManifest(db, identifier);
	if (!existing) return null;
	const checklist: ChecklistState = { ...existing.checklist, [itemId]: checked === true };
	const [rows] = await db.query<[RawLoopRow[]]>(
		`UPDATE $rid MERGE { checklist: $checklist, updated_at: time::now() } RETURN AFTER;`,
		{ rid: new StringRecordId(assertRecordId(existing.id)), checklist }
	);
	return rows.length ? normLoop(rows[0]) : null;
}

/** Promote/demote a declared loop's maturity phase. Returns null when the loop is not declared. */
export async function setLoopPhase(
	db: Db,
	identifier: string,
	phase: DeclaredPhase
): Promise<LoopManifestRow | null> {
	const existing = await getLoopManifest(db, identifier);
	if (!existing) return null;
	const [rows] = await db.query<[RawLoopRow[]]>(
		`UPDATE $rid MERGE { phase: $phase, updated_at: time::now() } RETURN AFTER;`,
		{ rid: new StringRecordId(assertRecordId(existing.id)), phase }
	);
	return rows.length ? normLoop(rows[0]) : null;
}

/**
 * Enable/disable a declared loop — a lightweight, reversible, NO-restart DB-MERGE (mirrors setLoopPhase):
 * the manifest records the operator's declared intent; nothing in the running engine reads it at boot, so
 * flipping it takes effect the moment the surface re-reads. Returns null when the loop is not declared
 * (no fabricated row; F-008).
 */
export async function setLoopEnabled(
	db: Db,
	identifier: string,
	enabled: boolean
): Promise<LoopManifestRow | null> {
	const existing = await getLoopManifest(db, identifier);
	if (!existing) return null;
	const [rows] = await db.query<[RawLoopRow[]]>(
		`UPDATE $rid MERGE { enabled: $enabled, updated_at: time::now() } RETURN AFTER;`,
		{ rid: new StringRecordId(assertRecordId(existing.id)), enabled: enabled === true }
	);
	return rows.length ? normLoop(rows[0]) : null;
}

/**
 * Record (or clear) the operator's sovereign readiness-gate override on a declared loop. Setting it true
 * stamps override_at + the reason (the recorded "arm anyway" decision); clearing it wipes both. Returns
 * null when the loop is not declared.
 */
export async function setLoopOverride(
	db: Db,
	identifier: string,
	override: boolean,
	reason?: string | null
): Promise<LoopManifestRow | null> {
	const existing = await getLoopManifest(db, identifier);
	if (!existing) return null;
	const on = override === true;
	const trimmed = (reason ?? '').trim();
	const sets = on
		? `override = true, override_reason = $reason, override_at = time::now()`
		: `override = false, override_reason = NONE, override_at = NONE`;
	const [rows] = await db.query<[RawLoopRow[]]>(
		`UPDATE $rid SET ${sets}, updated_at = time::now() RETURN AFTER;`,
		{ rid: new StringRecordId(assertRecordId(existing.id)), reason: trimmed || 'operator override' }
	);
	return rows.length ? normLoop(rows[0]) : null;
}

// ── Reconcile (declared-vs-running) — the honest join (F-008) ───────────────────────────────────────

/** How a declared loop lines up with the live running view (mirrors the drain configured-vs-running). */
export type ReconcileStatus = 'declared-and-running' | 'declared-not-running' | 'running-undeclared';

/** One reconciled loop: its running view and/or its manifest row, plus the honest status of the join. */
export interface ReconciledLoop {
	identifier: string;
	label: string;
	kind: string;
	projectId: string | null;
	scope: LoopScope;
	running: LoopView | null;
	manifest: LoopManifestRow | null;
	status: ReconcileStatus;
	/** Readiness computed from the manifest checklist (all-missing when undeclared). */
	readiness: ReadinessResult;
}

/**
 * Reconcile the DECLARED manifest against the RUNNING view, joined on identifier === LoopView.id. PURE
 * (no DB) so it is directly unit-testable. Every running loop appears (enriched with its manifest row if
 * declared); every declared loop with no running counterpart appears as 'declared-not-running' (honest —
 * a real declaration whose loop is not currently live), never dropped and never fabricated into a running
 * card. Running order is preserved first, then declared-only rows in identifier order.
 */
export function reconcileLoops(
	manifest: readonly LoopManifestRow[],
	running: readonly LoopView[]
): ReconciledLoop[] {
	const byIdentifier = new Map<string, LoopManifestRow>();
	for (const m of manifest) byIdentifier.set(m.identifier, m);

	const out: ReconciledLoop[] = [];
	const seen = new Set<string>();

	for (const view of running) {
		const m = byIdentifier.get(view.id) ?? null;
		seen.add(view.id);
		out.push({
			identifier: view.id,
			label: view.name,
			kind: view.kind,
			projectId: view.projectId ?? null,
			scope: view.scope,
			running: view,
			manifest: m,
			status: m ? 'declared-and-running' : 'running-undeclared',
			readiness: evaluateReadiness(m?.checklist)
		});
	}

	// Declared loops with no live counterpart — honest 'declared, not currently running'.
	const declaredOnly = manifest
		.filter((m) => !seen.has(m.identifier))
		.sort((a, b) => a.identifier.localeCompare(b.identifier));
	for (const m of declaredOnly) {
		out.push({
			identifier: m.identifier,
			label: m.label,
			kind: m.kind,
			projectId: m.projectId,
			scope: m.projectId ? 'project' : 'global',
			running: null,
			manifest: m,
			status: 'declared-not-running',
			readiness: evaluateReadiness(m.checklist)
		});
	}
	return out;
}

/** Index a manifest list by identifier for O(1) lookup from the running cards (UI convenience). */
export function manifestByIdentifier(
	manifest: readonly LoopManifestRow[]
): Record<string, LoopManifestRow> {
	const map: Record<string, LoopManifestRow> = {};
	for (const m of manifest) map[m.identifier] = m;
	return map;
}
