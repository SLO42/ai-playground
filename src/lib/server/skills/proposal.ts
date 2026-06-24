// SH-1 (SKILL-HARVEST-SPEC §1/§2) — the skill_proposal model + store.
//
// A session that established a reusable procedure may DRAFT a skill_proposal. A proposal is DATA — it
// is NEVER a disk write and NEVER a cc_skill row. It is born status='open' and can ONLY reach the live
// catalog through a recorded operator approval (SH-3 promote). This module enforces three integrity
// invariants at the single write boundary:
//
//   1. BORN OPEN — proposeSkill always creates status='open' (no caller may inject 'approved'); no
//      self-promotion (G2 / D-039). Approval/promotion lives elsewhere and demands approved_by.
//   2. D-026 SCREEN — every agent-authored freetext field (name / description / body / trigger_context
//      / each evidence ref) is run through screen() HERE, before persist, mirroring pm-propose.ts. A
//      redactable span (email / home-path / known-prefix token) persists as its SAFE [REDACTED:*] text;
//      an un-redactable 'quarantined' block REJECTS the whole proposal (named — a half-redacted secret
//      is never persisted, F-008).
//   3. NORMALIZED DEDUP (SKILL-HARVEST-SPEC §2 RECUR/RANK) — a new draft whose NORMALIZED (name +
//      trigger_context) matches an OPEN proposal BUMPS its `occurrences` count and returns the bumped
//      row, instead of inserting a duplicate. Normalization is case- AND whitespace-insensitive so a
//      cosmetic re-wording cannot dodge the dedup. A non-open (approved/rejected) proposal of the same
//      key does NOT absorb — it is retained for audit (G2 mark-don't-delete) and a fresh open draft starts.
//
// Boundary discipline (D-016): every VALUE binds via $param — the ONLY interpolated tokens are record
// ids, validated at db/validate.ts FIRST. Option fields are OMITTED, never NULLed (option<T> rejects
// NULL — §6.1). Datetimes are coerced to ISO strings in the normalizer (F-013); absent → null → '—'.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen } from '../memory/screen';

// ── Bounds (bounded capture — a runaway draft cannot bloat a row) ───────────────────────────────────

/** Max length of a freetext field (name is bounded separately, tighter). */
const MAX_FREETEXT_CHARS = 20_000;
/** Max length of the kebab name (a skill id, not a paragraph). */
const MAX_NAME_CHARS = 80;
/** Max length of one evidence ref (a ref, not a paragraph). */
const MAX_EVIDENCE_REF_CHARS = 128;
/** Max number of evidence refs on one proposal (bounded capture). */
const MAX_EVIDENCE_REFS = 32;

// ── Named errors (EVERY ERROR HAS A NAME) ───────────────────────────────────────────────────────────

/** A skill_proposal field violated its shape contract (empty / wrong type / over a bound / bad name). */
export class SkillProposalContractError extends Error {
	override readonly name = 'SkillProposalContractError';
}

/**
 * D-026 — an un-redactable secret (a quarantined private-key block) reached a freetext field at the
 * writer boundary. NAMED + carries the field so the caller surfaces WHICH field to scrub (parity with
 * pm-repo's PmSecretEchoError). A benign redactable span never throws (it persists screened).
 */
export class SkillSecretEchoError extends Error {
	constructor(
		message: string,
		readonly field: string
	) {
		super(message);
		this.name = 'SkillSecretEchoError';
	}
}

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────────

export type SkillProposalStatus = 'open' | 'approved' | 'rejected';
export type SkillProposalSource = 'session-harvest';

/** A persisted `skill_proposal` row (DATA-MODEL / migration 0060_skill_proposal). */
export interface SkillProposalRow {
	id: string;
	/** kebab-case skill id (the eventual `.claude/skills/<name>/` dir). */
	name: string;
	description: string;
	/** The SKILL.md markdown body the operator would promote. */
	body: string;
	/** When this skill applies (the harvested trigger description). */
	trigger_context: string;
	source: SkillProposalSource;
	/** The session that drafted it — absent when harvested out-of-session. */
	session?: string;
	/** The project context — absent for a global/cross-project pattern. */
	project?: string;
	/** Shape-constrained, D-026-screened evidence refs grounding the proposal. */
	evidence: string[];
	/** How many sessions surfaced this (normalized name+trigger) pattern. */
	occurrences: number;
	status: SkillProposalStatus;
	/** Set ONLY by the operator promote/reject path — never by proposeSkill. */
	approved_by?: string;
	approved_at?: string | null;
	created_at: string | null;
	updated_at: string | null;
}

/** Input to {@link proposeSkill} — what a harvester drafts. status is NEVER an input (born 'open'). */
export interface ProposeSkillInput {
	name: string;
	description: string;
	body: string;
	trigger_context: string;
	/** Real evidence rows/refs grounding the proposal (≥0; shape-constrained + screened). */
	evidence?: string[];
	/** The drafting session id (`session:…`) — omitted when absent. */
	session?: string;
	/** The project context id (`project:…`) — omitted when absent. */
	project?: string;
}

// ── Helpers (mirror pm-repo.ts) ──────────────────────────────────────────────────────────────────────

function str(v: unknown): string {
	return String(v);
}

/**
 * F-013 + F-008: coerce a SurrealDB 2.x datetime (a non-POJO) to an ISO string, but NEVER to the
 * literal 'undefined'/'null'. An absent/unparseable value → null, so the surface renders an honest '—'.
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

/** Require a non-empty trimmed string, bounded; throw (named) on violation. */
function reqStr(v: unknown, field: string, max = MAX_FREETEXT_CHARS): string {
	if (typeof v !== 'string' || v.trim() === '') {
		throw new SkillProposalContractError(`skill_proposal field '${field}' must be a non-empty string`);
	}
	const t = v.trim();
	if (t.length > max) {
		throw new SkillProposalContractError(
			`skill_proposal field '${field}' is ${t.length} chars — exceeds the ${max}-char cap (bounded capture)`
		);
	}
	return t;
}

// ── kebab name (a skill id — disk dir name) ──────────────────────────────────────────────────────────

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate the skill name into a kebab-case id (the eventual `.claude/skills/<name>/` dir). Rejected
 * (named, no silent rewrite — a poisoned/traversal name must fail closed, not be coerced into a
 * neighbour id): empty, over the bound, or not strictly `lower-kebab` (no spaces, slashes, dots,
 * uppercase, leading/trailing/double hyphens). This is the catalog-poisoning + D-018-confinement guard
 * at the proposal boundary (the promote path re-confines the disk write; this keeps a bad name out of
 * the row in the first place).
 */
function reqKebabName(v: unknown): string {
	const t = reqStr(v, 'name', MAX_NAME_CHARS);
	if (!KEBAB_RE.test(t)) {
		throw new SkillProposalContractError(
			`skill_proposal field 'name' = ${JSON.stringify(t)} is not a valid kebab-case skill id — ` +
				`it must be lowercase a-z/0-9 segments joined by single hyphens (no spaces, slashes, dots, ` +
				`uppercase, or leading/trailing/double hyphens). A malformed name is refused, never coerced.`
		);
	}
	return t;
}

/** Validate one evidence ref: non-empty trimmed string, bounded. (Shape is intentionally permissive
 *  vs pm-propose's structural-ref rule — a harvested skill's evidence may be a path/transcript ref —
 *  but it is still bounded + screened.) */
function reqEvidenceRef(v: unknown, idx: number): string {
	if (typeof v !== 'string' || v.trim() === '') {
		throw new SkillProposalContractError(`skill_proposal evidence[${idx}] must be a non-empty string`);
	}
	const t = v.trim();
	if (t.length > MAX_EVIDENCE_REF_CHARS) {
		throw new SkillProposalContractError(
			`skill_proposal evidence[${idx}] is ${t.length} chars — exceeds the ${MAX_EVIDENCE_REF_CHARS}-char ref cap`
		);
	}
	return t;
}

// ── Normalized dedup identity (case- + whitespace-insensitive) ──────────────────────────────────────

/**
 * Is this a SurrealDB 2.x UNIQUE-index / primary-key / commit-race collision on the skill_proposal_dedup
 * index? Two concurrent drafts of the SAME normalized key BOTH pass the SELECT-then-INSERT dedup read (a
 * TOCTOU race — neither sees the other's not-yet-committed row) and BOTH attempt the CREATE; the loser
 * collides on the dedup UNIQUE index. Match ONLY the real unique-violation phrases (parity with
 * workforce/staff.isDedupCollision, peer/repo, memory/loop) — re-raise everything else (F-008: an
 * unrelated DB error must NEVER be silently absorbed as a benign duplicate).
 */
function isDedupCollision(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		/index `?[^`']*`? already contains/i.test(msg) ||
		/record `?[^`']*`? already exists/i.test(msg) ||
		/failed transaction|read or write conflict/i.test(msg)
	);
}

/**
 * The NORMALIZED dedup key over (name + trigger_context): each segment lowercased, every whitespace run
 * collapsed to a single space, trimmed; the two segments joined by a literal '|'. Case- AND
 * whitespace-insensitive so a cosmetic re-wording (extra spaces / capitalization) of the SAME pattern
 * still collapses onto one open proposal (SKILL-HARVEST-SPEC §2).
 *
 * The separator MUST be index-safe: this key is now persisted in the indexed `norm_key`/`dedup_key`
 * columns, and SurrealDB's index key encoding REJECTS a NUL byte ("Key encoding error: … contained a
 * null byte"). It uses '|' — the codebase dedup_key convention (memory/work_item use `namespace + '|' +
 * key`). norm() collapses whitespace, so a literal '|' inside a segment cannot forge a false match
 * (it only shifts the boundary, still a deterministic function of the inputs).
 */
export function normalizedDedupKey(name: string, triggerContext: string): string {
	const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
	return `${norm(name)}|${norm(triggerContext)}`;
}

// ── D-026 writer-boundary screen ─────────────────────────────────────────────────────────────────────

/**
 * D-026 screen for an agent-authored freetext value at the persistence boundary. clean/redacted → keep
 * the SAFE screen().text (a redactable span stored as [REDACTED:*]); quarantined → REJECT (named, the
 * field carried) — an un-redactable block cannot be made safe in isolation. Mirrors pm-repo.screenPmField.
 */
function screenField(value: string, field: string): string {
	const res = screen(value);
	if (res.status === 'quarantined') {
		throw new SkillSecretEchoError(
			`skill_proposal '${field}' carries an un-redactable secret (D-026, quarantined) — ` +
				`screen reasons: [${res.reasons.join(', ')}]`,
			field
		);
	}
	// clean → verbatim; redacted → the safe [REDACTED:*] text. Either is safe to store.
	return res.text;
}

// ── Normalizer (F-013 datetimes; F-008 honest absents) ──────────────────────────────────────────────

function normProposal(
	row: SkillProposalRow & {
		id: unknown;
		session?: unknown;
		project?: unknown;
		approved_at?: unknown;
		created_at?: unknown;
		updated_at?: unknown;
	}
): SkillProposalRow {
	// Strip the internal dedup machinery (norm_key / dedup_key are persistence-only — they index the
	// normalized identity and never belong in the public row the operator review surface renders).
	const { norm_key: _nk, dedup_key: _dk, ...rest } = row as unknown as Record<string, unknown>;
	void _nk;
	void _dk;
	return {
		...(rest as unknown as SkillProposalRow),
		id: str(row.id),
		// option<record> links → string id when present, OMITTED when absent (never a raw null).
		...(row.session != null ? { session: str(row.session) } : { session: undefined }),
		...(row.project != null ? { project: str(row.project) } : { project: undefined }),
		evidence: Array.isArray(row.evidence) ? row.evidence.map(str) : [],
		occurrences: typeof row.occurrences === 'number' ? row.occurrences : Number(row.occurrences) || 1,
		// approved_* are set only by the promote path — coerce honestly (absent → undefined / null).
		...(row.approved_by != null ? { approved_by: str(row.approved_by) } : { approved_by: undefined }),
		approved_at: strDate(row.approved_at),
		created_at: strDate(row.created_at),
		updated_at: strDate(row.updated_at)
	};
}

type RawProposalRow = SkillProposalRow & {
	id: unknown;
	session?: unknown;
	project?: unknown;
	approved_at?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
};

// ── proposeSkill — the single write chokepoint (dedup → bump, else insert born 'open') ──────────────

/**
 * Draft a skill proposal (or absorb a recurrence). Steps, in order:
 *   1. SHAPE — validate + bound every field (name → kebab id; freetext non-empty; evidence bounded).
 *   2. D-026 SCREEN — every agent-authored field through screen(); a quarantined block REJECTS (named).
 *   3. DEDUP — compute the normalized (name+trigger) key; if an OPEN proposal already matches, BUMP
 *      its occurrences (+1) and return the bumped row — no duplicate insert (SKILL-HARVEST-SPEC §2).
 *   4. INSERT — otherwise CREATE the row BORN status='open' (never 'approved' — no self-promotion).
 *
 * Shadow paths: nil input → caller-side (TS requires the object); empty/whitespace field → step-1 named
 * throw; quarantined secret → step-2 named throw; an upstream DB fault → propagates (never silenced).
 * Dedup compares the SCREENED name+trigger so a redacted draft still collapses onto its open peer.
 */
export async function proposeSkill(db: Db, input: ProposeSkillInput): Promise<SkillProposalRow> {
	// 1. SHAPE.
	const name = reqKebabName(input.name);
	const description = reqStr(input.description, 'description');
	const body = reqStr(input.body, 'body');
	const triggerContext = reqStr(input.trigger_context, 'trigger_context');
	const rawEvidence = input.evidence ?? [];
	if (!Array.isArray(rawEvidence)) {
		throw new SkillProposalContractError(`skill_proposal field 'evidence' must be an array`);
	}
	if (rawEvidence.length > MAX_EVIDENCE_REFS) {
		throw new SkillProposalContractError(
			`skill_proposal has ${rawEvidence.length} evidence refs — exceeds the ${MAX_EVIDENCE_REFS} cap (bounded capture)`
		);
	}
	const evidenceShaped = rawEvidence.map((e, i) => reqEvidenceRef(e, i));

	// 2. D-026 SCREEN — name/description/body/trigger + each evidence ref. A quarantined block REJECTS.
	const screenedName = screenField(name, 'name');
	// A kebab name cannot legitimately carry a secret, but if screen() ever rewrote it (a [REDACTED:*]
	// span) the result is no longer a valid kebab id — refuse rather than persist a poisoned name.
	if (screenedName !== name) {
		throw new SkillSecretEchoError(
			`skill_proposal 'name' was altered by the secret screen — a skill id must be a clean kebab token`,
			'name'
		);
	}
	const screenedDescription = screenField(description, 'description');
	const screenedBody = screenField(body, 'body');
	const screenedTrigger = screenField(triggerContext, 'trigger_context');
	const evidence = evidenceShaped.map((e, i) => screenField(e, `evidence[${i}]`));

	// 3/4. DEDUP-OR-INSERT, ATOMIC (the SH-1 red-team second-pass fix). The normalized (screened
	// name + trigger) key is the canonical identity, stored as `norm_key`; the schema's `dedup_key` VALUE
	// field resolves to it WHILE the row is open. The proposal is born status='open' — status is
	// INTENTIONALLY not a content key (no self-promotion; the schema DEFAULT 'open' guarantees the born
	// state). norm_key is set so dedup_key resolves to the normalized identity (NOT the row id).
	const dedupKey = normalizedDedupKey(screenedName, screenedTrigger);
	const content = omitUndefined({
		name: screenedName,
		description: screenedDescription,
		body: screenedBody,
		trigger_context: screenedTrigger,
		source: 'session-harvest',
		evidence,
		norm_key: dedupKey,
		session: input.session ? link(input.session) : undefined,
		project: input.project ? link(input.project) : undefined
	});

	// The SELECT-then-INSERT dedup was a TOCTOU race: N concurrent drafts of the SAME key BOTH saw 0 rows
	// and BOTH inserted → N rows occurrences=1, SPLITTING the recurrence signal the operator ranks on
	// (SKILL-HARVEST §2 RECUR/RANK). A JS-level retry is INSUFFICIENT — this SurrealDB build does NOT
	// reliably abort a second concurrent same-key insert at the UNIQUE index across separate transactions
	// (it can leave TWO open rows; observed empirically — the same "MERGES concurrent deltas" behaviour
	// peer/repo.ts documents). The fix is to do the read-or-bump-else-create as ONE server-side
	// transaction (BEGIN…COMMIT): inside a single tx, two racers serialize — the loser's CREATE collides
	// on the UNIQUE index and the WHOLE tx aborts as a RETRYABLE "read or write conflict"; on retry its
	// SELECT now sees the winner's row and BUMPS it. The bounded loop (F-014: HARD-CAPPED, never an
	// unbounded spin) retries ONLY that retryable class; any other DB error propagates verbatim (F-008).
	const upsertSql = `BEGIN;
		LET $existing = (SELECT id FROM skill_proposal WHERE dedup_key = $key AND status = "open" LIMIT 1);
		LET $row = IF count($existing) > 0
			THEN (UPDATE $existing[0].id SET occurrences += 1, updated_at = time::now() RETURN AFTER)
			ELSE (CREATE skill_proposal CONTENT $content RETURN AFTER) END;
		RETURN $row;
		COMMIT;`;
	const MAX_DEDUP_RETRIES = 16;
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await db.query<unknown[]>(upsertSql, { key: dedupKey, content });
			// RETURN $row is the last statement → its value is the last element of the response. UPDATE/
			// CREATE … RETURN AFTER yields an array; unwrap the single row.
			const last = res[res.length - 1];
			const row = (Array.isArray(last) ? last[0] : last) as RawProposalRow | undefined;
			if (!row) throw new SkillProposalContractError('proposeSkill: upsert returned no row');
			// HONESTY GUARD (F-008, mirroring peer/repo): the JS SDK can RESOLVE a transaction that
			// actually ABORTED on the index collision, returning the pre-abort CREATE value — a PHANTOM
			// row that never committed. Re-read the committed open row by its UNIQUE dedup_key (an index
			// scan reflects the committed table) and return THAT, so the returned id/occurrences are the
			// real persisted ones, never a phantom.
			const [committed] = await db.query<[RawProposalRow[]]>(
				`SELECT * FROM skill_proposal WHERE dedup_key = $key AND status = "open" LIMIT 1;`,
				{ key: dedupKey }
			);
			if (committed && committed.length) return normProposal(committed[0]);
			// The committed row is not visible yet (a racing abort): retry, bounded.
			if (attempt < MAX_DEDUP_RETRIES) continue;
			throw new SkillProposalContractError(
				`proposeSkill: upsert for key ${JSON.stringify(dedupKey)} committed no visible open row after ${MAX_DEDUP_RETRIES} retries — retry`
			);
		} catch (err) {
			// A retryable optimistic-concurrency conflict / UNIQUE collision inside the tx → re-loop (the
			// next pass's SELECT finds the winner and bumps). Bounded (F-014). Anything else propagates.
			if (isDedupCollision(err) && attempt < MAX_DEDUP_RETRIES) continue;
			if (isDedupCollision(err)) {
				throw new SkillProposalContractError(
					`proposeSkill: concurrent skill_proposal_dedup contention for key ${JSON.stringify(dedupKey)} exceeded ${MAX_DEDUP_RETRIES} retries — retry`
				);
			}
			throw err; // a non-retryable DB error — propagate verbatim (F-008).
		}
	}
}

// ── Reads (the operator review surface — SH-4) ──────────────────────────────────────────────────────

/**
 * List skill proposals, optionally filtered by status, ranked highest-occurrence first (RECUR/RANK,
 * §2) then newest. limit is bounded. Honest empty list when none (F-008). status is validated against
 * the ladder (never interpolated; bound as $param).
 */
export async function listSkillProposals(
	db: Db,
	opts: { status?: SkillProposalStatus; limit?: number } = {}
): Promise<SkillProposalRow[]> {
	if (opts.status && !['open', 'approved', 'rejected'].includes(opts.status)) {
		throw new SkillProposalContractError(`invalid skill_proposal status filter: ${String(opts.status)}`);
	}
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	const statusClause = opts.status ? ` WHERE status = $status` : '';
	const [rows] = await db.query<[RawProposalRow[]]>(
		`SELECT * FROM skill_proposal${statusClause}
			ORDER BY occurrences DESC, created_at DESC LIMIT ${limit};`,
		opts.status ? { status: opts.status } : {}
	);
	return (rows ?? []).map(normProposal);
}

/** One proposal by id, or null (honest absent). */
export async function getSkillProposal(db: Db, id: string): Promise<SkillProposalRow | null> {
	const [rows] = await db.query<[RawProposalRow[]]>(`SELECT * FROM $rid;`, { rid: link(id) });
	return rows.length ? normProposal(rows[0]) : null;
}
