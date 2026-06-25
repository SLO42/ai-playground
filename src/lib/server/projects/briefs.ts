// TASK 16.4 — decision_brief repo (WORKFORCE-SPEC §8 canonical operator brief;
// PM-SPEC §4.7 references that format and defines no second one — G4).
//
// A brief is a QUESTION to the operator: the operator's answer IS the decision, and
// the briefed matter does not proceed while the brief is open. This module owns the
// `decision_brief` rows only (create/read/decide/supersede); the EFFECTS of a
// decision on the underlying artifact (task → ready/withdrawn, verdict outcome
// closure) live in pm-panel.ts applyBriefDecision — the brief row never encodes
// business policy, it records the ceremony.
//
// Boundary discipline (D-016): every VALUE binds via $param; the only interpolated
// tokens are record ids validated at the db/validate.ts chokepoint. Optional fields
// are OMITTED, never NULLed (option<T> rejects NULL — §6.1). Datetimes are
// ISO-coerced in the normalizer, absent → null → '—' (F-013).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

// ── Named errors ──────────────────────────────────────────────────────────────────

/** Bad caller input / illegal brief state at the briefs boundary. */
export class BriefError extends Error {
	override readonly name = 'BriefError';
}

// ── Shapes (mirror the 0032 DDL) ──────────────────────────────────────────────────

export type BriefClassification = 'operator_challenge' | 'taste' | 'proposal_gate' | 'confirm';
export type BriefStatus = 'open' | 'approved' | 'rejected' | 'deferred' | 'superseded';
// 'cert_hire' (HR-5) — the brief's artifact is a workforce interview_run (the candidate of
// record). Its decide-effect (cert flip + staffing feed, B4) lives in workforce/recruiter-hire.ts
// applyHireDecision, NOT pm-panel.ts applyBriefDecision (which is task-only) — the same
// brief-row-records-the-ceremony / effects-live-elsewhere split documented at the top of this file.
// 'repo_create' (RC-3) — the brief's artifact is the PROJECT row; the matter is "create this project's
// GitHub repo". Its decide-effect (the RC-2 outward gate) lives in repo-create-proposal.ts
// applyRepoCreateDecision, NOT pm-panel.ts applyBriefDecision (task-only) — the same brief-row-records-
// the-ceremony / effects-live-elsewhere split documented at the top of this file (cert_hire precedent).
export type BriefArtifactKind = 'task' | 'review_proposal' | 'fixture_proposal' | 'cert_hire' | 'repo_create';

/** One Approve/Reject/Defer option — each with its strongest pro AND con (§8). */
export interface BriefOption {
	id: 'approve' | 'reject' | 'defer';
	label: string;
	pro: string;
	con: string;
	/** Exactly ONE option carries this, with the reason (assembler-enforced). */
	recommended?: string;
}

/** Completeness from REAL panel rows — or the honest kind-differs statement (F-008). */
export type BriefCompleteness =
	| { validators: number; expected: number; approve: number; pushback: number }
	| { kind_differs: true; note: string };

/** §4.5 Operator-Challenge payload — the operator's direction is the DEFAULT. */
export interface BriefChallenge {
	operator_said: string;
	recommendation: string;
	why: string;
	context_we_might_be_missing: string;
	cost_if_wrong: string;
}

export interface DecisionBriefRow {
	id: string;
	project: string | null;
	artifact: string;
	artifact_kind: BriefArtifactKind;
	classification: BriefClassification;
	ask: string;
	issue: string;
	completeness: BriefCompleteness | null;
	/** Dual effort label (§8): cost-to-apply / cost-of-wrongness — '—' when no history. */
	effort: { apply: string; wrongness: string };
	evidence: string[];
	falsifier: string;
	options: BriefOption[];
	net_tradeoff?: string;
	challenge?: BriefChallenge;
	status: BriefStatus;
	fingerprint?: string;
	defer_until: string | null;
	decided_at: string | null;
	created_at: string | null;
}

export interface CreateBriefInput {
	project?: string;
	artifact: string;
	artifact_kind: BriefArtifactKind;
	classification: BriefClassification;
	ask: string;
	issue: string;
	completeness?: BriefCompleteness;
	effort: { apply: string; wrongness: string };
	evidence: string[];
	falsifier: string;
	options: BriefOption[];
	net_tradeoff?: string;
	challenge?: BriefChallenge;
	fingerprint?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────────

function str(v: unknown): string {
	return String(v);
}

/** F-013: SurrealDB 2.x datetime → ISO string; absent/garbage → null (never 'undefined'). */
function strDate(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
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

type Raw = Record<string, unknown>;

function normBrief(row: Raw): DecisionBriefRow {
	const effort = (row.effort ?? {}) as Record<string, unknown>;
	return {
		id: str(row.id),
		project: row.project != null ? str(row.project) : null,
		artifact: str(row.artifact),
		artifact_kind: row.artifact_kind as BriefArtifactKind,
		classification: row.classification as BriefClassification,
		ask: str(row.ask),
		issue: str(row.issue),
		completeness: row.completeness != null ? (row.completeness as BriefCompleteness) : null,
		// The dual label always renders both halves — '—' is the honest no-history cell.
		effort: {
			apply: typeof effort.apply === 'string' && effort.apply ? effort.apply : '—',
			wrongness: typeof effort.wrongness === 'string' && effort.wrongness ? effort.wrongness : '—'
		},
		evidence: (row.evidence ?? []) as string[],
		falsifier: str(row.falsifier),
		options: (row.options ?? []) as BriefOption[],
		...(row.net_tradeoff != null ? { net_tradeoff: str(row.net_tradeoff) } : {}),
		...(row.challenge != null ? { challenge: row.challenge as BriefChallenge } : {}),
		status: row.status as BriefStatus,
		...(row.fingerprint != null ? { fingerprint: str(row.fingerprint) } : {}),
		defer_until: strDate(row.defer_until),
		decided_at: strDate(row.decided_at),
		created_at: strDate(row.created_at)
	};
}

// ── CRUD + ceremony writes ────────────────────────────────────────────────────────

/**
 * Create a decision brief. WORKFORCE §8 format invariants are enforced HERE
 * (named errors, not prose convention): a non-empty one-sentence ask, an issue
 * statement, a falsifier, 2–4 evidence links, and EXACTLY ONE recommended option.
 * Interrupt contract: an OPEN brief already standing for the same artifact is
 * absorbed and returned (one open question per artifact — never a duplicate ask).
 */
export async function createDecisionBrief(db: Db, input: CreateBriefInput): Promise<DecisionBriefRow> {
	if (!input.ask?.trim()) throw new BriefError('decision brief: ask must be a non-empty sentence');
	if (!input.issue?.trim()) throw new BriefError('decision brief: issue statement is required');
	if (!input.falsifier?.trim()) {
		throw new BriefError('decision brief: falsifier is required (the strongest reason NOT to approve)');
	}
	if (!Array.isArray(input.evidence) || input.evidence.length < 2 || input.evidence.length > 4) {
		throw new BriefError(
			`decision brief: evidence must carry 2–4 real links (got ${input.evidence?.length ?? 0})`
		);
	}
	if (!Array.isArray(input.options) || input.options.length < 2) {
		throw new BriefError('decision brief: at least two options (a question needs alternatives)');
	}
	const recommended = input.options.filter((o) => o.recommended);
	if (recommended.length !== 1) {
		throw new BriefError(
			`decision brief: exactly ONE option must be recommended with its reason (got ${recommended.length})`
		);
	}

	const existing = await getOpenBriefForArtifact(db, input.artifact);
	if (existing) return existing;

	// PM-SPEC §4 (d) suppress-until-lapse (16.4 re-review DEFECT 4): a matter the
	// operator DEFERRED is not re-asked while the window stands — re-running the
	// ceremony that raised the brief (e.g. a panel re-run) absorbs the standing
	// deferred brief instead of opening a fresh ask inside the active window.
	if (input.fingerprint) {
		const deferred = await getActiveDeferredBriefForFingerprint(db, input.fingerprint);
		if (deferred) return deferred;
	}

	const content = omitUndefined({
		project: input.project ? link(input.project) : undefined,
		artifact: link(input.artifact),
		artifact_kind: input.artifact_kind,
		classification: input.classification,
		ask: input.ask.trim(),
		issue: input.issue.trim(),
		completeness: input.completeness,
		effort: input.effort,
		evidence: input.evidence,
		falsifier: input.falsifier.trim(),
		options: input.options,
		net_tradeoff: input.net_tradeoff,
		challenge: input.challenge,
		fingerprint: input.fingerprint
	});
	const [rows] = await db.query<[Raw[]]>(`CREATE decision_brief CONTENT $content RETURN AFTER;`, {
		content
	});
	return normBrief(rows[0]);
}

export async function getBrief(db: Db, briefId: string): Promise<DecisionBriefRow | null> {
	const rid = link(briefId);
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? normBrief(rows[0]) : null;
}

/** The single OPEN brief on an artifact, or null (one open question per artifact). */
export async function getOpenBriefForArtifact(
	db: Db,
	artifactId: string
): Promise<DecisionBriefRow | null> {
	const aid = link(artifactId);
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM decision_brief WHERE artifact = $aid AND status = "open" LIMIT 1;`,
		{ aid }
	);
	return rows.length ? normBrief(rows[0]) : null;
}

/** Open briefs for the RightTray decisions inbox, newest first (F-022 projection ok). */
export async function listOpenBriefs(db: Db, limit = 10): Promise<DecisionBriefRow[]> {
	const cap = Math.min(Math.max(limit, 1), 50);
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM decision_brief WHERE status = "open" ORDER BY created_at DESC LIMIT ${cap};`
	);
	return rows.map(normBrief);
}

/** A project's briefs (open + decided), newest first — the PM-tab history surface. */
export async function listBriefsForProject(
	db: Db,
	projectId: string,
	limit = 50
): Promise<DecisionBriefRow[]> {
	const project = link(projectId);
	const cap = Math.min(Math.max(limit, 1), 200);
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM decision_brief WHERE project = $project ORDER BY created_at DESC LIMIT ${cap};`,
		{ project }
	);
	return rows.map(normBrief);
}

/** The standing DEFERRED brief whose fingerprint sits inside an ACTIVE defer
 *  window, newest decision first, or null. (PM-SPEC §4 (d): the operator's defer
 *  is a structural decision on the MATTER — the row that recorded it.) */
export async function getActiveDeferredBriefForFingerprint(
	db: Db,
	fingerprint: string
): Promise<DecisionBriefRow | null> {
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM decision_brief
			WHERE fingerprint = $fp AND status = "deferred" AND defer_until != NONE AND defer_until > time::now()
			ORDER BY decided_at DESC LIMIT 1;`,
		{ fp: fingerprint }
	);
	return rows.length ? normBrief(rows[0]) : null;
}

/** Is a fingerprint inside an ACTIVE defer window? (Anti-spam, PM-SPEC §4 (d):
 *  structural fingerprints — a deferred matter is not re-asked until the window
 *  lapses; cosmetic re-wording cannot dodge it.) */
export async function isFingerprintDeferred(db: Db, fingerprint: string): Promise<boolean> {
	return (await getActiveDeferredBriefForFingerprint(db, fingerprint)) !== null;
}

/**
 * Record the operator's decision on an OPEN brief (status + decided_at; defer also
 * stamps defer_until). Idempotent absorb: re-deciding with the SAME terminal status
 * returns the row unchanged; a DIFFERENT decision on a decided brief is refused
 * (the ceremony record is append-once — relabeling history would corrupt it).
 */
export async function markBriefDecided(
	db: Db,
	briefId: string,
	status: Exclude<BriefStatus, 'open' | 'superseded'>,
	opts: { deferUntil?: Date } = {}
): Promise<DecisionBriefRow> {
	const brief = await getBrief(db, briefId);
	if (!brief) throw new BriefError(`decision brief not found: ${briefId}`);
	if (brief.status !== 'open') {
		if (brief.status === status) return brief; // interrupt-contract absorb
		throw new BriefError(
			`decision brief ${briefId} already '${brief.status}' — refusing relabel to '${status}'`
		);
	}
	if (status === 'deferred' && !opts.deferUntil) {
		throw new BriefError('deferring a brief requires a defer_until window (the defer is real, not a dismiss)');
	}
	const sets = ['status = $status', 'decided_at = time::now()'];
	const binds: Record<string, unknown> = { rid: link(brief.id), status };
	if (status === 'deferred' && opts.deferUntil) {
		sets.push('defer_until = $until');
		binds.until = opts.deferUntil;
	}
	// Status-GUARDED write (16.4 re-review gap 6): the read above can race a
	// concurrent decide, so the UPDATE itself re-checks 'open' — a decided row is
	// never relabeled by a lost race. An empty result means we lost: re-read and
	// absorb/refuse exactly like the pre-check above.
	const [rows] = await db.query<[Raw[]]>(
		`UPDATE $rid SET ${sets.join(', ')} WHERE status = "open" RETURN AFTER;`,
		binds
	);
	if (rows.length === 0) {
		const raced = await getBrief(db, brief.id);
		if (raced && raced.status === status) return raced; // interrupt-contract absorb
		throw new BriefError(
			`decision brief ${briefId} already '${raced?.status ?? '(missing)'}' — refusing relabel to '${status}' (a concurrent decide landed first)`
		);
	}
	return normBrief(rows[0]);
}

/** Mechanically close an artifact's OPEN brief as 'superseded' (the proposal was
 *  withdrawn/revised while the question stood). NEVER recorded as an operator
 *  decision — decided_at stays absent. No-op when no open brief exists. */
export async function supersedeOpenBrief(db: Db, artifactId: string): Promise<DecisionBriefRow | null> {
	const open = await getOpenBriefForArtifact(db, artifactId);
	if (!open) return null;
	const [rows] = await db.query<[Raw[]]>(
		`UPDATE $rid SET status = "superseded" RETURN AFTER;`,
		{ rid: link(open.id) }
	);
	return normBrief(rows[0]);
}
