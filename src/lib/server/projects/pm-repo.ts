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
import { screen } from '../memory/screen';
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
	created_at: string | null;
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
	created_at: string | null;
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

/**
 * TASK 16.2 (PM-SPEC §3) — WHAT woke the PM, recorded on the pm_review row itself
 * (migration 0030, FLEXIBLE option<object>). Every entry is REAL (F-008): `evidence`
 * carries the actual row ids / external refs that produced the fire; `authority` is
 * the pm row's authority at fire time. Absent on pre-16.2 rows and manual button
 * passes — an honest absence, never a fabricated provenance.
 */
export interface PmReviewProvenance {
	/** The trigger kind (periodic | session_failed | task_blocked | github_arrival | finding | release). */
	kind: string;
	/** The real evidence rows/refs the fire derived from (record ids, issue/PR refs). */
	evidence: string[];
	/** The pm.authority in force when the trigger fired (PM-SPEC §4). */
	authority?: string;
	/** Trigger-specific detail (counts, threshold, run status…). Free-form, honest. */
	detail?: Record<string, unknown>;
}

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
	/** Trigger provenance (TASK 16.2) — absent on manual/pre-16.2 rows. */
	provenance?: PmReviewProvenance;
	created_at: string | null;
}

export interface AddPmReviewInput {
	project: string;
	trigger: PmReviewTrigger;
	summary: string;
	tasks_examined: number;
	findings_examined: number;
	risks_open: number;
	memories_written: number;
	/** Trigger provenance (TASK 16.2) — omitted entirely when absent (option<object>). */
	provenance?: PmReviewProvenance;
}

// ── Helpers (mirror projects/repo.ts) ───────────────────────────────────────────

function str(v: unknown): string {
	return String(v);
}

/**
 * F-013 + F-008: coerce a SurrealDB datetime (a non-POJO in 2.x) to an ISO string,
 * but NEVER to the literal string 'undefined'/'null'. A field that is absent (e.g. a
 * row half-applied before its DEFAULT existed) or unparseable yields `null`, so the
 * surface renders an honest '—' (fmtTime('') / fmtTime(null) → '—') instead of the
 * literal text 'undefined'.
 */
function strDate(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	return s;
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

/**
 * D-026 — a NAMED reject for an un-redactable secret reaching a pm writer boundary. The
 * field is carried so the route surfaces WHICH field the operator must scrub (parity with
 * the create-flow SecretEchoError). EVERY ERROR HAS A NAME: this names the un-redactable
 * private-key-block case; benign redactable spans never throw (they are kept screened).
 */
export class PmSecretEchoError extends Error {
	constructor(
		message: string,
		readonly field: string
	) {
		super(message);
		this.name = 'PmSecretEchoError';
	}
}

/**
 * D-026 writer-boundary screen for an operator-/agent-authored FREE-TEXT pm field (charter,
 * persona). This is the SAME disposition the create flow uses (execute.ts screenWriterText +
 * plan.ts assertNoSecretEcho 'freetext' mode), made the pm row's only-write-path gate so a
 * secret can NEVER land raw via createPm OR the later operator-direct edit paths (updatePmCharter,
 * the persona field). Disposition:
 *   • clean / redacted  → keep `screen().text` (a SAFELY-redactable span — a benign email, a home
 *     path, a known-prefix provider key, an inline `secret: <val>` — is stored as the safe
 *     [REDACTED:*] text, NOT hard-aborted; mirrors createPm's prior charter behaviour + F-008).
 *   • quarantined       → REJECT (named) — an un-redactable private-key block cannot be made safe
 *     in isolation, so it is refused with the field named, consistent with the create flow's
 *     'freetext' gate which hard-rejects ONLY 'quarantined'.
 * `undefined` in → `undefined` out (an absent field is not screened, stays absent → '—').
 */
function screenPmField(value: string | undefined, field: string): string | undefined {
	if (value === undefined) return undefined;
	const res = screen(String(value));
	if (res.status === 'quarantined') {
		throw new PmSecretEchoError(
			`pm '${field}' carries an un-redactable secret (D-026, quarantined) — screen reasons: [${res.reasons.join(', ')}]`,
			field
		);
	}
	// clean → text is the original verbatim; redacted → the safe [REDACTED:*] text. Either is safe to store.
	return res.text;
}

function normPmMemory(row: PmMemoryRow & { id: unknown; project: unknown }): PmMemoryRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		created_at: strDate(row.created_at)
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
		created_at: strDate(row.created_at)
	};
}

function normPmReview(
	row: PmReviewRow & { id: unknown; project: unknown; created_at: unknown }
): PmReviewRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		// F-013 + F-008: coerce the SurrealDB 2.x datetime (non-POJO) to an ISO string, but
		// an absent/invalid created_at → null (honest '—' on the surface), never 'undefined'.
		created_at: strDate(row.created_at)
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

/** Does an ACTIVE pm_memory row already reference this related_to id (optionally
 *  from a given source)? The idempotency key for ceremony re-runs (16.4 re-review
 *  DEFECT 3): a re-entered closure absorbs its already-written learning rows. */
export async function hasPmMemoryRelatedTo(
	db: Db,
	relatedTo: string,
	source?: string
): Promise<boolean> {
	const sourceClause = source ? ' AND source = $source' : '';
	const [rows] = await db.query<[unknown[]]>(
		`SELECT id FROM pm_memory WHERE related_to = $rel AND status = "active"${sourceClause} LIMIT 1;`,
		source ? { rel: relatedTo, source } : { rel: relatedTo }
	);
	return rows.length > 0;
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
		memories_written: input.memories_written,
		// TASK 16.2: trigger provenance — OMITTED when absent (option<object> rejects NULL).
		...(input.provenance !== undefined ? { provenance: input.provenance } : {})
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

// ── PM identity (TASK 16.1 / PM-SPEC §1 — the PM is hired, not implicit) ─────────

/** The PM authority ladder (PM-SPEC §4 "Act with Purpose"; default "act"). */
export type PmAuthority = 'observe' | 'propose' | 'act';

export const PM_AUTHORITIES: readonly PmAuthority[] = ['observe', 'propose', 'act'];

/** A persisted `pm` row — one hired manager per project (migration 0029, UNIQUE project). */
export interface PmRow {
	id: string;
	project: string;
	name: string;
	/** Operator-written directives (priorities/tone/escalation). Absent until written. */
	charter?: string;
	persona?: string;
	/** Periodic-trigger cron expr (PM-SPEC §3; consumed by the trigger-engine task). */
	cadence?: string;
	/** Per-project stagger (duration, coerced to its string form for the surface). */
	cadence_offset?: string;
	authority: PmAuthority;
	/**
	 * PMA-1 — ARMED for UNSUPERVISED drive (continuous autonomous loop). false ⇒ supervised
	 * (the one-click tick runs once per operator click). Defaulted false at the schema DEFAULT
	 * (m0057), so every existing/new pm row reads back a concrete boolean (never NONE).
	 */
	autonomous: boolean;
	/**
	 * PMA — the operator's PRE-AUTHORIZATION to let the autonomous loop carry the release THROUGH the
	 * publish gate without a fresh tap. DEFAULT false (m0058): publish always needs an explicit confirm.
	 * A clearly-labelled opt-in surfaced behind the arming flow — NEVER auto-publishes silently. This is
	 * an operator consent record, not an agent authority: the loop still halts at 'awaiting-release-
	 * confirm' and has no publish authority of its own (D-037). Read back as a hard boolean (never NONE).
	 */
	auto_publish_preauthorized: boolean;
	/**
	 * RC-2 (REPO-CREATION-SPEC) — the operator's RECORDED consent that a GitHub repo MAY be created
	 * for this project (the repo-creation gate's D-037 consent leg, mirroring auto_publish_preauthorized).
	 * DEFAULT false (m0062): no repo is ever created without this opt-in PLUS a valid confirm-token. It is
	 * a consent record, NOT agent authority — a PM never sets it unilaterally (B4/D-039); operator-create
	 * sets it directly, a PM proposal routes through the §4.1 panel + operator 'act'. Read back as a hard
	 * boolean (never NONE).
	 */
	repo_create_preauthorized: boolean;
	created_at: string | null;
}

export interface CreatePmInput {
	project: string;
	name: string;
	charter?: string;
	persona?: string;
	authority?: PmAuthority;
}

function normPm(
	row: PmRow & {
		id: unknown;
		project: unknown;
		cadence_offset?: unknown;
		autonomous?: unknown;
		auto_publish_preauthorized?: unknown;
		repo_create_preauthorized?: unknown;
	}
): PmRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		// duration is a non-POJO in the 2.x SDK — coerce to its string form (F-013 class).
		...(row.cadence_offset != null ? { cadence_offset: str(row.cadence_offset) } : {}),
		// PMA-1 — coerce to a hard boolean. The schema DEFAULT is false, but a pre-m0057 row read
		// before the migration lands (or a malformed value) coerces to false, never undefined (F-008).
		autonomous: row.autonomous === true,
		// PMA — pre-authorize-auto-publish opt-in (m0058). Same coercion discipline: a pre-m0058 row
		// (or a malformed value) reads back false, never undefined — publish defaults to operator-gated.
		auto_publish_preauthorized: row.auto_publish_preauthorized === true,
		// RC-2 — pre-authorize-repo-create consent (m0062). Same coercion: a pre-m0062 row (or a
		// malformed value) reads back false, never undefined — repo-create defaults to operator-gated.
		repo_create_preauthorized: row.repo_create_preauthorized === true,
		created_at: strDate(row.created_at)
	};
}

/** The project's hired PM row, or null when no PM has been hired (the honest empty state). */
export async function getPm(db: Db, projectId: string): Promise<PmRow | null> {
	const project = link(projectId);
	const [rows] = await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
		`SELECT * FROM pm WHERE project = $project LIMIT 1;`,
		{ project }
	);
	return rows.length ? normPm(rows[0]) : null;
}

/**
 * TASK 16.2 (PM-SPEC §3) — every hired PM with a periodic cadence set. The trigger
 * engine's tick reads THIS list (live rows, F-008) and evaluates each cadence cron +
 * cadence_offset stagger. A PM without a cadence never appears here (honest: no
 * schedule means no periodic fires — not a default schedule).
 */
export async function listPmsWithCadence(db: Db): Promise<PmRow[]> {
	const [rows] = await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
		`SELECT * FROM pm WHERE cadence != NONE AND cadence != "";`
	);
	return rows.map(normPm);
}

/**
 * Create the project's `pm` row. ONE per project — the UNIQUE pm_by_project index makes a
 * concurrent double-hire collide rather than duplicate (D-008); callers absorb the existing
 * row via getPm first (interrupt-safe re-run). All values bind via $param (D-016).
 */
export async function createPm(db: Db, input: CreatePmInput): Promise<PmRow> {
	// D-026 — charter AND persona are agent-/operator-authored free text (the create-flow
	// pmCharterDraft / persona ride in here via hirePm). BOTH MUST be screened at this persistence
	// boundary because this is the row's only write path: the plan-time 'freetext' echo gate lets a
	// SAFELY-redactable span (e.g. `secret: <val>`, an email) PASS so the create won't hard-abort on
	// benign PII, on the contract that the DISK/persistence boundary redacts it. The pm row IS that
	// boundary — store the screened text (redactable → [REDACTED:*]); an un-redactable block REJECTS
	// (named, PmSecretEchoError). persona was previously persisted RAW — that gap is closed here.
	const charter = screenPmField(input.charter, 'charter');
	const persona = screenPmField(input.persona, 'persona');
	const content = omitUndefined({
		project: link(input.project),
		name: input.name,
		charter,
		persona,
		authority: input.authority
	});
	const [rows] = await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
		`CREATE pm CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normPm(rows[0]);
}

/**
 * Update the PM's charter (the D-010 diff+confirm editor's write path — the diff+confirm
 * ceremony renders client-side; this persists the confirmed text). An empty charter clears
 * the field to NONE (option<string> — absent, surfaced as the honest '—', never "").
 * MERGE preserves every untouched column. Returns null when the project has no PM.
 */
export async function updatePmCharter(
	db: Db,
	projectId: string,
	charter: string
): Promise<PmRow | null> {
	const existing = await getPm(db, projectId);
	if (!existing) return null;
	const rid = link(existing.id);
	// D-026 — screen the operator-direct charter edit at this persistence boundary (the SAME gate
	// createPm uses): a redactable span is stored as the safe [REDACTED:*] text, an un-redactable
	// block REJECTS (named). This path bypassed screen() entirely before — a secret could land raw.
	// Screen the trimmed text so the empty/clear path (NONE) is unaffected and the stored value is safe.
	const trimmed = screenPmField(charter.trim(), 'charter') ?? '';
	const [rows] = trimmed
		? await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
				`UPDATE $rid MERGE { charter: $charter } RETURN AFTER;`,
				{ rid, charter: trimmed }
			)
		: await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
				`UPDATE $rid SET charter = NONE RETURN AFTER;`,
				{ rid }
			);
	return rows.length ? normPm(rows[0]) : null;
}

/**
 * TASK 16.4 (PM-SPEC §4) — set the PM's authority rung (observe < propose < act).
 * Operator-set on the PM tab; validated at the boundary against the ladder. The rung
 * governs the Act-with-Purpose pipeline: 'observe' never proposes; 'propose' needs
 * the operator's proposal-gate brief to promote; 'act' promotes on panel approval.
 * Returns null when the project has no hired PM.
 */
export async function updatePmAuthority(
	db: Db,
	projectId: string,
	authority: PmAuthority
): Promise<PmRow | null> {
	if (!(PM_AUTHORITIES as readonly string[]).includes(authority)) {
		throw new Error(`invalid PM authority: ${String(authority)}`);
	}
	const existing = await getPm(db, projectId);
	if (!existing) return null;
	const [rows] = await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
		`UPDATE $rid MERGE { authority: $authority } RETURN AFTER;`,
		{ rid: link(existing.id), authority }
	);
	return rows.length ? normPm(rows[0]) : null;
}

/**
 * PMA-1 — ARM/DISARM the PM for UNSUPERVISED continuous drive (the autonomous loop). Operator-set on
 * the project Overview; this is a SAFETY toggle, NOT an authority grant — arming a PM never bypasses an
 * operator gate (the external publish stays D-037-gated, a capability hire stays D-039-gated; only the
 * EXISTING 'act' authority promotes). MERGE preserves every untouched column. The value is bound via
 * $param (D-016) and stored as a hard boolean. Returns null when the project has no hired PM (no row to
 * arm — the caller surfaces "hire a PM first"; arming NEVER auto-hires).
 */
export async function setPmAutonomous(
	db: Db,
	projectId: string,
	autonomous: boolean
): Promise<PmRow | null> {
	const existing = await getPm(db, projectId);
	if (!existing) return null;
	const [rows] = await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
		`UPDATE $rid MERGE { autonomous: $autonomous } RETURN AFTER;`,
		{ rid: link(existing.id), autonomous: autonomous === true }
	);
	return rows.length ? normPm(rows[0]) : null;
}

/**
 * PMA — record the operator's PRE-AUTHORIZE-AUTO-PUBLISH consent (true) or revoke it (false). This is a
 * SAFETY/consent toggle, NOT an authority grant: it records that the operator has pre-approved letting the
 * autonomous loop carry the release through the publish gate. It NEVER grants the agent publish authority
 * and NEVER bypasses D-037 by itself — the consuming release path reads this flag and a missing/false flag
 * keeps publish operator-gated. DEFAULT false (m0058): publish always needs a confirm unless the operator
 * explicitly opted in here. MERGE preserves every untouched column; the value binds via $param (D-016) and
 * stores a hard boolean. Returns null when the project has no hired PM (no row to set — never auto-hires).
 */
export async function setPmAutoPublishPreauthorized(
	db: Db,
	projectId: string,
	preauthorized: boolean
): Promise<PmRow | null> {
	const existing = await getPm(db, projectId);
	if (!existing) return null;
	const [rows] = await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
		`UPDATE $rid MERGE { auto_publish_preauthorized: $pre } RETURN AFTER;`,
		{ rid: link(existing.id), pre: preauthorized === true }
	);
	return rows.length ? normPm(rows[0]) : null;
}

/**
 * RC-2 (REPO-CREATION-SPEC) — record the operator's PRE-AUTHORIZE-REPO-CREATE consent (true) or revoke
 * it (false). This is the recorded-consent leg the repo-creation gate (repo-creation-gate.ts) re-asserts
 * before any real `gh repo create` (mirrors setPmAutoPublishPreauthorized). It records that the operator
 * has approved creating a GitHub repo for this project; it NEVER grants the PM authority to create one
 * unilaterally and NEVER bypasses the gate's confirm-token leg by itself (B4/D-039 — a PM-proposed create
 * still routes through the §4.1 panel + operator 'act'). DEFAULT false (m0062): no repo is created without
 * this opt-in. MERGE preserves every untouched column; the value binds via $param (D-016) and stores a
 * hard boolean. Returns null when the project has no hired PM (no row to set — never auto-hires).
 */
export async function setPmRepoCreatePreauthorized(
	db: Db,
	projectId: string,
	preauthorized: boolean
): Promise<PmRow | null> {
	const existing = await getPm(db, projectId);
	if (!existing) return null;
	const [rows] = await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
		`UPDATE $rid MERGE { repo_create_preauthorized: $pre } RETURN AFTER;`,
		{ rid: link(existing.id), pre: preauthorized === true }
	);
	return rows.length ? normPm(rows[0]) : null;
}

/**
 * TASK 16.2 (PM-SPEC §3) — set/clear the PM's periodic schedule: `cadence` (a 5-field
 * cron expression) + `cadence_offset` (a duration stagger). null/empty CLEARS a field
 * to NONE (option<T> — absent, surfaced as the honest '—'). The ROUTE action validates
 * the cron/duration shapes at the boundary (parseCron/parseDurationMs — pm-triggers);
 * this write path binds values via $param and casts the offset to a real duration.
 * Returns null when the project has no hired PM (no row to schedule).
 */
export async function updatePmSchedule(
	db: Db,
	projectId: string,
	input: { cadence: string | null; cadenceOffset: string | null }
): Promise<PmRow | null> {
	const existing = await getPm(db, projectId);
	if (!existing) return null;
	const rid = link(existing.id);
	const cadence = input.cadence?.trim() || null;
	const offset = input.cadenceOffset?.trim() || null;
	const sets: string[] = [];
	const binds: Record<string, unknown> = { rid };
	if (cadence) {
		sets.push('cadence = $cadence');
		binds.cadence = cadence;
	} else {
		sets.push('cadence = NONE');
	}
	if (offset) {
		// The column is TYPE option<duration> — cast the validated string to a duration.
		sets.push('cadence_offset = <duration>$offset');
		binds.offset = offset;
	} else {
		sets.push('cadence_offset = NONE');
	}
	const [rows] = await db.query<[(PmRow & { id: unknown; project: unknown })[]]>(
		`UPDATE $rid SET ${sets.join(', ')} RETURN AFTER;`,
		binds
	);
	return rows.length ? normPm(rows[0]) : null;
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

	// Seed via the single-add path (the only wired write path) — one round-trip per seed.
	const memories: PmMemoryRow[] = [];
	for (const seed of seeds) memories.push(await addPmMemory(db, seed));
	return { bootstrapped: true, alreadyBootstrapped: false, memories };
}
