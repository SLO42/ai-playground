// TASK 9.1 — Project Manager: typed PM memory + decisions + bootstrap (the
// operator-flagged #1 v1→v2 parity gap; GAP-ANALYSIS §1.1). Rebuilt LEAN on the
// SurrealDB spine (NO per-feature SQLite — lighter-advocate principle): the v1
// pm-memory-db.ts was a dedicated SQLite file; here PM memory + decisions are
// first-class SurrealDB tables (migration 0023_pm) sharing the §4 boundary/option<T>
// discipline and the shared FTS analyzer.
//
// This is the strategic layer ABOVE task execution: the PM accumulates typed memory
// (observation / learning / risk / pattern / decision), records architectural
// decisions, and is bootstrapped from a live scan of the project (F-008 — every
// seeded observation comes from the real detected ecosystem / git / plan state, never
// a fabricated row).
//
// Boundary discipline (D-016): every VALUE binds via $param — never interpolated. The
// ONLY interpolated tokens are record ids / table names, validated at the
// db/validate.ts chokepoint FIRST. Optional fields are OMITTED, never NULLed (option<T>
// rejects NULL — MEMORY-SPEC §6.1); MERGE preserves untouched columns on update.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { getProject, type SprintRow } from './repo';

// ── PM memory taxonomy (the v1 type set, minus v1's SQLite "decision-context"
//    rename — here it is simply "decision", consistent with the decision table). ──
export type PmMemoryKind = 'observation' | 'learning' | 'risk' | 'pattern' | 'decision';

export const PM_MEMORY_KINDS: readonly PmMemoryKind[] = [
	'observation',
	'learning',
	'risk',
	'pattern',
	'decision'
];

/** A persisted `pm_memory` row (DATA-MODEL §4.1b / migration 0023_pm). */
export interface PmMemoryRow {
	id: string;
	project: string;
	kind: PmMemoryKind;
	content: string;
	source: string;
	confidence: number;
	importance: number;
	status: string;
	related_to?: string;
	created_at: string;
}

export interface AddPmMemoryInput {
	project: string;
	kind: PmMemoryKind;
	content: string;
	source?: string;
	confidence?: number;
	importance?: number;
	related_to?: string;
}

/** A persisted `decision` row — the architectural-decisions surface. */
export interface DecisionRow {
	id: string;
	project: string;
	sprint?: string;
	title: string;
	context?: string;
	rationale?: string;
	status: string;
	created_at: string;
}

export interface AddDecisionInput {
	project: string;
	title: string;
	context?: string;
	rationale?: string;
	status?: string;
	sprint?: string;
}

/** Per-kind counts for the PM surface header (honest — real counts, F-008). */
export type PmMemoryStats = Record<PmMemoryKind, number> & { total: number };

/** What kicked off a PM review pass (D-004 honors the orchestration mode). */
export type PmReviewTrigger = 'manual' | 'periodic' | 'event';

/** A persisted `pm_review` row — one PM review pass, surfaced in the PM tab (migration 0025). */
export interface PmReviewRow {
	id: string;
	project: string;
	trigger: PmReviewTrigger;
	summary: string;
	tasks_examined: number;
	findings_examined: number;
	risks_open: number;
	memories_written: number;
	created_at: string;
}

export interface AddPmReviewInput {
	project: string;
	trigger: PmReviewTrigger;
	summary: string;
	tasks_examined: number;
	findings_examined: number;
	risks_open: number;
	memories_written: number;
}

// ── Helpers (mirror projects/repo.ts) ───────────────────────────────────────────

function str(v: unknown): string {
	return String(v);
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

function normPmMemory(row: PmMemoryRow & { id: unknown; project: unknown }): PmMemoryRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		created_at: str(row.created_at)
	};
}

function normDecision(
	row: DecisionRow & { id: unknown; project: unknown; sprint?: unknown }
): DecisionRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		sprint: row.sprint != null ? str(row.sprint) : undefined,
		created_at: str(row.created_at)
	};
}

function normPmReview(
	row: PmReviewRow & { id: unknown; project: unknown; created_at: unknown }
): PmReviewRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		// F-013: SurrealDB 2.x datetime is a non-POJO — coerce to an ISO string for the loader.
		created_at: str(row.created_at)
	};
}

// ── PM memory CRUD ───────────────────────────────────────────────────────────────

/** Add one typed PM memory row. All values bound via $param; the project is a record link. */
export async function addPmMemory(db: Db, input: AddPmMemoryInput): Promise<PmMemoryRow> {
	const content = omitUndefined({
		project: link(input.project),
		kind: input.kind,
		content: input.content,
		source: input.source,
		confidence: input.confidence,
		importance: input.importance,
		related_to: input.related_to
	});
	const [rows] = await db.query<[(PmMemoryRow & { id: unknown; project: unknown })[]]>(
		`CREATE pm_memory CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normPmMemory(rows[0]);
}

/** Add several PM memories in one round-trip (bootstrap seeding). */
export async function addPmMemories(
	db: Db,
	inputs: AddPmMemoryInput[]
): Promise<PmMemoryRow[]> {
	const out: PmMemoryRow[] = [];
	for (const input of inputs) out.push(await addPmMemory(db, input));
	return out;
}

/**
 * List a project's active PM memories, newest first. Optionally filtered by kind
 * (validated against the taxonomy — never interpolated; bound as $param).
 */
export async function listPmMemory(
	db: Db,
	projectId: string,
	opts: { kind?: PmMemoryKind; limit?: number } = {}
): Promise<PmMemoryRow[]> {
	const project = link(projectId);
	const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
	const kindClause = opts.kind ? ` AND kind = $kind` : '';
	const [rows] = await db.query<[(PmMemoryRow & { id: unknown; project: unknown })[]]>(
		`SELECT * FROM pm_memory WHERE project = $project AND status = "active"${kindClause}
			ORDER BY created_at DESC LIMIT ${limit};`,
		opts.kind ? { project, kind: opts.kind } : { project }
	);
	return rows.map(normPmMemory);
}

/** Per-kind + total counts for a project's active PM memory (honest real counts). */
export async function pmMemoryStats(db: Db, projectId: string): Promise<PmMemoryStats> {
	const project = link(projectId);
	const [rows] = await db.query<[{ kind: string; c: number }[]]>(
		`SELECT kind, count() AS c FROM pm_memory
			WHERE project = $project AND status = "active" GROUP BY kind;`,
		{ project }
	);
	const stats = {
		observation: 0,
		learning: 0,
		risk: 0,
		pattern: 0,
		decision: 0,
		total: 0
	} as PmMemoryStats;
	for (const r of rows) {
		if ((PM_MEMORY_KINDS as readonly string[]).includes(r.kind)) {
			stats[r.kind as PmMemoryKind] = r.c;
			stats.total += r.c;
		}
	}
	return stats;
}

/** Soft-archive a PM memory (append-only spirit — never a hard delete of learning). */
export async function archivePmMemory(db: Db, id: string): Promise<boolean> {
	const rid = link(id);
	const [rows] = await db.query<[unknown[]]>(
		`UPDATE $rid SET status = "archived" RETURN AFTER;`,
		{ rid }
	);
	return rows.length > 0;
}

// ── Decisions ────────────────────────────────────────────────────────────────────

export async function addDecision(db: Db, input: AddDecisionInput): Promise<DecisionRow> {
	const content = omitUndefined({
		project: link(input.project),
		sprint: input.sprint ? link(input.sprint) : undefined,
		title: input.title,
		context: input.context,
		rationale: input.rationale,
		status: input.status
	});
	const [rows] = await db.query<[(DecisionRow & { id: unknown; project: unknown })[]]>(
		`CREATE decision CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normDecision(rows[0]);
}

export async function listDecisions(db: Db, projectId: string): Promise<DecisionRow[]> {
	const project = link(projectId);
	const [rows] = await db.query<[(DecisionRow & { id: unknown; project: unknown })[]]>(
		`SELECT * FROM decision WHERE project = $project ORDER BY created_at DESC;`,
		{ project }
	);
	return rows.map(normDecision);
}

// ── PM review history (TASK 11.4) ────────────────────────────────────────────────

/** Persist one PM review summary row. All values bind via $param; project is a record link. */
export async function addPmReview(db: Db, input: AddPmReviewInput): Promise<PmReviewRow> {
	const content = {
		project: link(input.project),
		trigger: input.trigger,
		summary: input.summary,
		tasks_examined: input.tasks_examined,
		findings_examined: input.findings_examined,
		risks_open: input.risks_open,
		memories_written: input.memories_written
	};
	const [rows] = await db.query<
		[(PmReviewRow & { id: unknown; project: unknown; created_at: unknown })[]]
	>(`CREATE pm_review CONTENT $content RETURN AFTER;`, { content });
	return normPmReview(rows[0]);
}

/** A project's PM review passes, newest first (the PM-tab review history surface). */
export async function listPmReviews(
	db: Db,
	projectId: string,
	limit = 50
): Promise<PmReviewRow[]> {
	const project = link(projectId);
	const cap = Math.min(Math.max(limit, 1), 200);
	const [rows] = await db.query<
		[(PmReviewRow & { id: unknown; project: unknown; created_at: unknown })[]]
	>(
		`SELECT * FROM pm_review WHERE project = $project ORDER BY created_at DESC LIMIT ${cap};`,
		{ project }
	);
	return rows.map(normPmReview);
}

// ── Sprint lifecycle (create lives in repo.ts; complete is a PM action) ──────────

/** Mark a sprint completed (status + completed_at). MERGE preserves other columns. */
export async function completeSprint(db: Db, id: string): Promise<SprintRow | null> {
	const rid = link(id);
	const [rows] = await db.query<[(SprintRow & { id: unknown; project: unknown })[]]>(
		`UPDATE $rid MERGE { status: "completed", completed_at: $now } RETURN AFTER;`,
		{ rid, now: new Date() }
	);
	if (!rows.length) return null;
	const row = rows[0];
	return {
		...row,
		id: str(row.id),
		project: str(row.project)
	} as SprintRow;
}

// ── PM bootstrap ───────────────────────────────────────────────────────────────

export interface PmBootstrapResult {
	/** Whether a PM was newly bootstrapped (false ⇒ already had memory; no-op). */
	bootstrapped: boolean;
	/** The seeded (or pre-existing) memory rows. */
	memories: PmMemoryRow[];
	/** Whether the project already had PM memory before this call. */
	alreadyBootstrapped: boolean;
}

/**
 * Bootstrap a per-project PM from LIVE project state (F-008): read the real project
 * row (ecosystem / build tool / test command / repo / plan) and seed typed initial
 * observations + risks from what is actually detected — never a fabricated row.
 * Idempotent: if the project already has active PM memory, this is a no-op that
 * returns the existing rows (the PM is not re-seeded on every click).
 *
 * The seeding mirrors v1 bootstrapProjectManager's intent (observations about the
 * detected stack + risks for missing tests/CI) but reads from the SurrealDB project
 * row rather than re-scanning the filesystem — the registration scan already wrote
 * the detected facts to the row (scanner/registry.ts), so this stays DB-only + fast.
 */
export async function bootstrapPm(db: Db, projectId: string): Promise<PmBootstrapResult> {
	const project = await getProject(db, projectId);
	if (!project) throw new Error(`project not found: ${projectId}`);

	const existing = await listPmMemory(db, projectId, { limit: 1 });
	if (existing.length > 0) {
		const all = await listPmMemory(db, projectId);
		return { bootstrapped: false, alreadyBootstrapped: true, memories: all };
	}

	const seeds: AddPmMemoryInput[] = [];
	const eco = (project.ecosystem ?? []).filter(Boolean);
	seeds.push({
		project: projectId,
		kind: 'observation',
		content:
			`Project "${project.name}" — ` +
			(eco.length ? `ecosystem: ${eco.join(', ')}.` : 'ecosystem not detected.') +
			(project.build_tool ? ` Build tool: ${project.build_tool}.` : ''),
		source: 'bootstrap-scan',
		confidence: 0.9
	});

	if (project.repo_url) {
		seeds.push({
			project: projectId,
			kind: 'observation',
			content: `Git remote configured: ${project.repo_url}.`,
			source: 'bootstrap-scan',
			confidence: 1.0
		});
	} else {
		seeds.push({
			project: projectId,
			kind: 'risk',
			content: 'No git remote detected — release/publish targets are unconfigured.',
			source: 'bootstrap-scan',
			confidence: 0.7
		});
	}

	if (!project.test_command) {
		seeds.push({
			project: projectId,
			kind: 'risk',
			content: 'No test command detected — the "tested" Definition-of-Done gate cannot run.',
			source: 'bootstrap-scan',
			confidence: 0.8
		});
	} else {
		seeds.push({
			project: projectId,
			kind: 'observation',
			content: `Test command: \`${project.test_command}\`.`,
			source: 'bootstrap-scan',
			confidence: 1.0
		});
	}

	const plan = project.plan;
	if (plan?.purpose) {
		seeds.push({
			project: projectId,
			kind: 'observation',
			content: `Stated purpose: ${plan.purpose}`,
			source: 'bootstrap-scan',
			confidence: 0.85
		});
	} else {
		seeds.push({
			project: projectId,
			kind: 'pattern',
			content:
				'No plan macro (purpose/vision/role/DoD) set yet — define it in a talk-to-PM session to anchor the strategic layer.',
			source: 'bootstrap-scan',
			confidence: 0.6
		});
	}

	const memories = await addPmMemories(db, seeds);
	return { bootstrapped: true, alreadyBootstrapped: false, memories };
}
