// SH-3 (SKILL-HARVEST-SPEC §3) — the PROMOTE stage: an operator-approved skill_proposal becomes a real
// `.claude/skills/<name>/SKILL.md` on disk AND a `cc_skill` catalog row, closing the F-045 dead-end so a
// promoted name can be referenced as a capability id without a fail-closed throw.
//
// G2 / D-039 — agents PROPOSE, the OPERATOR promotes. This module NEVER lets an agent/session reach
// cc_skill: promoteSkill REQUIRES an `approver` (the operator id, supplied by the operator action route),
// and it writes the proposal's `approved_by` itself. proposeSkill (SH-1) can ONLY create status='open'
// rows — it has no path to set approved_by — so the only route from a draft to the live catalog is THIS
// function, gated on a recorded operator approval. An agent calling promote without an approver fails
// closed (named). The operator route is the sole caller that supplies a real operator id.
//
// ORDER IS LOAD-BEARING (D-010 disk-is-truth): the SKILL.md file is written to DISK *first*, then the
// harvest scope is re-synced into cc_skill. A cc_skill row must NEVER exist without its SKILL.md — the
// sync reads disk, so a row can only appear once the file is present. A failed/partial disk write means
// no sync runs and no phantom catalog id is created.
//
// Confinement (D-018): the disk path is resolved through the SAME confined resolver the /claude-code
// config editor uses (resolveConfigTargetFromCatalog → resolveConfinedTarget). A name carrying `..`, a
// path separator, or an absolute prefix can never escape the harvest scope tree (fail closed). The
// proposal's `name` is already a validated kebab id (SH-1 reqKebabName), but we re-resolve through the
// confined seam so promote is safe even if a name were ever crafted to slip past the proposal contract.
//
// Idempotent + interrupt-safe (F-015 / atomic-write discipline): re-promoting an already-approved
// proposal whose SKILL.md is on disk and whose name is in cc_skill is a NO-OP — it does not double-write
// the file, does not duplicate the catalog row (syncScope UPSERTs deterministic ids), and does not
// re-flip the status. If a prior promote died after the disk write but before the status flip, a re-run
// detects the on-disk file, finishes the sync, and records the approval (absorbing the partial work).
//
// No catalog poisoning: a promoted name that COLLIDES with an existing catalog id owned by a DIFFERENT
// scope/file is REJECTED (named) — never silently overwritten — unless the caller explicitly passes
// `update: true` (a same-name re-promote within the harvest scope is the legitimate update path).

import { resolve, join, dirname, basename } from 'node:path';
import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	renameSync,
	readdirSync,
	unlinkSync
} from 'node:fs';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen } from '../memory/screen';
import {
	harvestScopeDir,
	scopeIdOf,
	syncScope,
	catalogIds,
	type SyncScope
} from '../cc-config';
import {
	resolveConfigTargetFromCatalog,
	ConfigTargetError,
	type AllowedScope
} from '../../../routes/claude-code/config-target';
import { getSkillProposal, type SkillProposalRow } from './proposal';

// ── Named errors (EVERY ERROR HAS A NAME) ───────────────────────────────────────────────────────────

/** The proposal id does not resolve to a row (honest absent → named, not a silent no-op). */
export class SkillPromoteNotFoundError extends Error {
	override readonly name = 'SkillPromoteNotFoundError';
}

/**
 * Promotion was attempted without a recorded operator approval — no `approver`, or the proposal is in a
 * non-promotable state (rejected). G2/D-039: agents propose, the operator promotes; an agent path can
 * never reach cc_skill. Fail closed (named).
 */
export class SkillPromoteNotApprovedError extends Error {
	override readonly name = 'SkillPromoteNotApprovedError';
}

/**
 * D-026 — an un-redactable secret survived into a proposal field (body OR description) at the promote
 * (disk-write) boundary. A SKILL.md is about to land on disk, so we re-screen EVERY agent-authored field
 * that lands in the file here (defense in depth — the proposal was screened at draft time, but the disk
 * boundary must be self-consistent: the code's own rationale is "disk is the final boundary"). A
 * quarantined block REJECTS rather than writing a half-redacted secret to a file (F-008). NAMED + carries
 * the offending field. NOTE: a REDACTED span in the description is rewritten to its safe [REDACTED:*] text
 * and written (parity with the proposal-entry screen); only an UN-redactable quarantine throws.
 */
export class SkillPromoteSecretEchoError extends Error {
	constructor(
		message: string,
		readonly field: string
	) {
		super(message);
		this.name = 'SkillPromoteSecretEchoError';
	}
}

/**
 * The proposal `name` is not a clean kebab skill id at the disk-write boundary (defense in depth — a
 * proposal-boundary reqKebabName already validates it, but the disk boundary re-validates so a row that
 * somehow carries a malformed name — e.g. a directly-planted row — can never name a `.claude/skills/<name>/`
 * dir). Distinct from {@link SkillPromoteConfinementError} (a traversal/escape): this catches a name that
 * is in-tree but not a valid lower-kebab id. Fail closed (named).
 */
export class SkillPromoteBadNameError extends Error {
	override readonly name = 'SkillPromoteBadNameError';
}

/**
 * The promoted name COLLIDES with an existing catalog id that is NOT this proposal's own SKILL.md — a
 * silent overwrite would poison the catalog. Fail closed (named) unless the caller passes `update: true`.
 */
export class SkillPromoteCollisionError extends Error {
	override readonly name = 'SkillPromoteCollisionError';
}

/** A confinement / disk-path resolution failed (re-thrown as a named promote error, fail closed D-018). */
export class SkillPromoteConfinementError extends Error {
	override readonly name = 'SkillPromoteConfinementError';
}

/**
 * A DIFFERENT (already-)approved skill_proposal already owns this `name` (same SKILL.md path, last-writer-
 * wins). `skill_proposal` has no UNIQUE on `name` (only the open-scoped dedup_key on name+trigger), so two
 * same-name / different-trigger proposals could both flip approved and both write the SAME
 * `<scope>/skills/<name>/SKILL.md` — the second silently clobbering the first while BOTH read 'approved'.
 * A name must map to exactly one durable skill: a same-name promote of a SECOND proposal fails closed
 * (named) unless the caller passes `update:true` (the legitimate "this IS the update to that skill" path).
 * Fail closed (named).
 */
export class SkillPromoteNameOwnedError extends Error {
	override readonly name = 'SkillPromoteNameOwnedError';
}

// ── Input / result shapes ────────────────────────────────────────────────────────────────────────────

export interface PromoteSkillInput {
	/** The `skill_proposal:…` record id to promote. */
	proposalId: string;
	/** The OPERATOR id recording the approval (operator action only — never an agent). Required, non-empty. */
	approver: string;
	/**
	 * Allow promoting a name that already exists in the catalog (the legitimate same-skill UPDATE path).
	 * Default false — a colliding name fails closed (no silent overwrite / catalog poisoning).
	 */
	update?: boolean;
	/** Injectable env for the harvest-scope path resolution (tests). Defaults to process.env. */
	env?: NodeJS.ProcessEnv;
}

export interface PromoteSkillResult {
	/** The promoted proposal row (status now 'approved', approved_by set). */
	proposal: SkillProposalRow;
	/** The kebab skill id that now exists in cc_skill. */
	name: string;
	/** Absolute path to the SKILL.md written on disk. */
	filePath: string;
	/** The harvest scope id that was re-synced. */
	scopeId: string;
	/** True when this call wrote the file (false when an idempotent re-promote found it already present). */
	wroteFile: boolean;
	/** True when this call flipped the proposal status to 'approved' (false on an idempotent re-promote). */
	recordedApproval: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** The kebab skill-id contract (a SKILL.md dir name), re-checked at the disk boundary (mirrors proposal.ts). */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * D-026 re-screen of one agent-authored field at the disk-write boundary (defense in depth — disk is the
 * final boundary). quarantined → REJECT (named, carries the field); clean/redacted → the SAFE screen().text
 * (a redactable span is rewritten to its [REDACTED:*] form, exactly as at proposal entry). Symmetric across
 * BODY and DESCRIPTION — both land in the SKILL.md, so both are re-screened here.
 */
function screenField(value: string, field: 'body' | 'description'): string {
	const res = screen(value);
	if (res.status === 'quarantined') {
		throw new SkillPromoteSecretEchoError(
			`skill_proposal ${field} carries an un-redactable secret (D-026, quarantined) — refusing to write ` +
				`SKILL.md to disk; screen reasons: [${res.reasons.join(', ')}]`,
			field
		);
	}
	return res.text;
}

/**
 * Re-validate the proposal `name` is a clean lower-kebab skill id at the disk boundary (defense in depth —
 * reqKebabName already enforced this at proposal entry, but a directly-planted row could carry anything;
 * the disk boundary must be self-consistent). A malformed in-tree name fails closed (named) — never coerced.
 * This is BEFORE confinement; a traversal name (`../x`) is also non-kebab and is caught here first, but the
 * confined resolver remains the authoritative escape guard (D-018).
 */
function reValidateName(name: string): void {
	if (!KEBAB_RE.test(name)) {
		throw new SkillPromoteBadNameError(
			`skill_proposal name ${JSON.stringify(name)} is not a valid lower-kebab skill id at the disk-write ` +
				`boundary — refusing to name a SKILL.md dir with it (D-026 symmetry; fail closed, never coerced)`
		);
	}
}

/**
 * Render the SKILL.md content: YAML frontmatter (name + description) + the screened body. The frontmatter
 * shape is exactly what parseSkillFile reads back (name/description), so the round-trip into cc_skill
 * carries the right id + description. Description is single-line-flattened + quoted to keep the YAML valid
 * even if it contains a colon/`#`; the body follows verbatim after the closing fence.
 */
function renderSkillMd(name: string, description: string, body: string): string {
	// Flatten the description to one line and JSON-quote it — a robust YAML scalar that survives colons,
	// hashes, quotes. parseYaml accepts a JSON-style double-quoted scalar.
	const descOneLine = description.replace(/\r?\n/g, ' ').trim();
	const descYaml = JSON.stringify(descOneLine);
	const trimmedBody = body.replace(/^\n+/, '');
	return `---\nname: ${name}\ndescription: ${descYaml}\n---\n\n${trimmedBody}\n`;
}

/**
 * Atomically write `content` to `filePath` (stage → fsync-less rename): write a sibling temp file, then
 * rename over the target. rename is atomic on the same filesystem, so a reader (or the cc-config scan)
 * never observes a half-written SKILL.md (interrupt-safe — F-015 atomic-write discipline). The parent dir
 * is created first (idempotent).
 *
 * Stale-temp sweep (interrupt discipline): a prior promote that DIED between writeFileSync and renameSync
 * leaves a `${basename}.tmp-*` sibling orphan in the dir. Before writing, sweep any such orphan in THIS
 * target's dir (matched by the exact `<name>.tmp-` prefix so only this file's temps are touched — never the
 * real SKILL.md or another skill's temp). Best-effort (D-019): a sweep failure (e.g. a racing concurrent
 * writer already unlinked it) is swallowed — it must never block the actual promote. The cc-config scan
 * only reads `SKILL.md`, so an orphan `.tmp-*` is invisible to the catalog; the sweep is hygiene, not
 * correctness, but it stops the dir accreting orphans across crash-then-re-promote cycles.
 */
function atomicWriteFile(filePath: string, content: string): void {
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true });
	sweepStaleTemps(dir, basename(filePath));
	const tmp = join(dir, `${basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(tmp, content, 'utf8');
	renameSync(tmp, filePath);
}

/**
 * Remove stale `<targetName>.tmp-*` orphans from `dir` left by an interrupted prior atomicWriteFile. Scoped
 * to the EXACT target prefix so a different skill's temp / the real file is never touched. Fully best-effort
 * (D-019): any fs error (dir gone, permission, racing unlink) is swallowed — hygiene must not block promote.
 */
function sweepStaleTemps(dir: string, targetName: string): void {
	const prefix = `${targetName}.tmp-`;
	try {
		for (const entry of readdirSync(dir)) {
			if (entry.startsWith(prefix)) {
				try {
					unlinkSync(join(dir, entry));
				} catch {
					/* a racing writer may have already removed it — best-effort (D-019) */
				}
			}
		}
	} catch {
		/* dir unreadable/absent — nothing to sweep (best-effort, D-019) */
	}
}

/**
 * Build the AllowedScope set for the harvest scope so resolveConfigTargetFromCatalog can confine the
 * SKILL.md path against the SERVER-SIDE harvest dir (never a request value). The harvest scope is
 * `global`-kind (no owning project) — exactly how ensureHarvestScope registers it.
 */
function harvestAllowedScopes(claudeDir: string): AllowedScope[] {
	return [{ kind: 'global', path: resolve(claudeDir) }];
}

/**
 * Does a cc_skill row with `name` exist OWNED BY our harvest scope? (item 2 — collision scope attribution).
 *
 * The old guard inferred ownership from `existsSync(filePath)` because catalogIds (sync.ts) is a flat name
 * set with NO scope attribution. That under-guards: a FOREIGN-owned catalog name (a `windows-pid-liveness`
 * cc_skill in some other scope) PLUS a stale/pre-existing harvest file at our path would make `existsSync`
 * true → the collision guard would treat the foreign name as "ours" and proceed, creating a duplicate-name
 * cc_skill row across two scopes. Attribute the name to OUR scope by querying cc_skill scoped to our
 * harvest scope id — disk presence alone is NOT ownership. Returns true only when WE own the catalog name.
 */
async function nameOwnedByHarvestScope(db: Db, scopeId: string, name: string): Promise<boolean> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM cc_skill WHERE scope = $scope AND name = $name LIMIT 1;`,
		{ scope: link(scopeId), name }
	);
	return (rows ?? []).length > 0;
}

/**
 * Is `name` already owned by a DIFFERENT approved skill_proposal (not `selfId`)? (item 3 — same-name
 * promote serialization). `skill_proposal` has no UNIQUE on `name`, so two same-name / different-trigger
 * proposals could both flip approved and clobber the same SKILL.md. Detect a prior approved owner so the
 * second same-name promote fails closed (a name → exactly one durable skill) unless `update:true`.
 */
async function approvedNameOwner(db: Db, name: string, selfId: string): Promise<string | null> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM skill_proposal WHERE name = $name AND status = "approved" AND id != $self LIMIT 1;`,
		{ name, self: link(selfId) }
	);
	const owner = (rows ?? [])[0]?.id;
	return owner != null ? String(owner) : null;
}

// ── promoteSkill — the single operator-gated disk+catalog write chokepoint ────────────────────────────

/**
 * Promote an operator-approved skill_proposal to disk + the cc_skill catalog. Steps, in order:
 *   1. LOAD — fetch the proposal by id; absent → SkillPromoteNotFoundError (honest, named).
 *   2. APPROVAL GATE (G2/D-039) — require a non-empty `approver`; a 'rejected' proposal is non-promotable
 *      → SkillPromoteNotApprovedError. The approval is recorded by THIS operator-driven call (step 7);
 *      proposeSkill cannot set approved_by, so no agent path reaches cc_skill.
 *   3. NAME (D-026 symmetry) — re-validate `name` is a clean lower-kebab id at the disk boundary →
 *      SkillPromoteBadNameError. Then CONFINE (D-018): resolve `<harvestDir>/skills/<name>/SKILL.md` through
 *      the confined resolver; a traversal/absolute name fails closed → SkillPromoteConfinementError.
 *   4. NAME OWNERSHIP (item 3, same-name serialization) — if a DIFFERENT already-approved proposal owns
 *      this name, reject (SkillPromoteNameOwnedError) unless `update:true` — a name maps to ONE durable
 *      skill, never last-writer-wins across two approved rows.
 *   5. CATALOG COLLISION (no poisoning; item 2, scope-attributed) — if the name is in cc_skill but NOT
 *      owned by OUR harvest scope (a foreign scope owns it), reject (SkillPromoteCollisionError) unless
 *      `update:true`. Ownership is the catalog SCOPE attribution, NOT bare disk presence (a stale harvest
 *      file must not let a foreign-owned name through).
 *   6. DISK FIRST (D-010) — re-screen BODY *and* DESCRIPTION (D-026 symmetric), re-validated name, render
 *      frontmatter+body, atomically write SKILL.md (sweeping any stale `.tmp-*` orphan; no-op skip if an
 *      identical file is already present — idempotent re-promote).
 *   7. SYNC — re-sync the harvest scope so cc_skill carries the new name (the disk→mirror direction).
 *   8. RECORD — flip status='approved' + persist approved_by/approved_at (skipped if already recorded —
 *      idempotent). dedup_key recomputes to the row id on the status change, freeing the normalized key.
 *
 * Shadow paths: nil/empty approver → step-2 named throw; unknown proposalId → step-1 named throw; a
 * non-kebab name → step-3 SkillPromoteBadNameError; `../escape` name (were it ever to slip past the
 * proposal contract) → step-3 SkillPromoteConfinementError; a second same-name approved proposal → step-4
 * named throw; a foreign-scope catalog name → step-5 named throw; an un-redactable secret in the body OR
 * description → step-6 named throw; an upstream DB fault → propagates (never silenced, F-008). A re-run
 * after a partial prior promote absorbs the on-disk file (step 6 skip) and completes sync+record.
 */
export async function promoteSkill(db: Db, input: PromoteSkillInput): Promise<PromoteSkillResult> {
	// 1. LOAD.
	const proposal = await getSkillProposal(db, input.proposalId);
	if (!proposal) {
		throw new SkillPromoteNotFoundError(
			`skill_proposal ${JSON.stringify(input.proposalId)} not found — nothing to promote (honest absent)`
		);
	}

	// 2. APPROVAL GATE (G2/D-039) — operator-only. No approver ⇒ no promotion; a rejected proposal is
	//    terminal. An already-approved proposal is re-promotable (idempotent finish of a partial run).
	if (typeof input.approver !== 'string' || input.approver.trim() === '') {
		throw new SkillPromoteNotApprovedError(
			`promoteSkill requires a recorded operator approver — refusing to promote ${proposal.id} ` +
				`without one (G2/D-039: agents propose, the operator promotes; fail closed)`
		);
	}
	const approver = input.approver.trim();
	if (proposal.status === 'rejected') {
		throw new SkillPromoteNotApprovedError(
			`skill_proposal ${proposal.id} is 'rejected' — a rejected proposal is not promotable (G2)`
		);
	}

	const name = proposal.name;

	// 3. NAME (D-026 symmetry) — re-validate the name is a clean lower-kebab id at the disk boundary BEFORE
	//    confinement. reqKebabName already enforced this at proposal entry, but a directly-planted row could
	//    carry anything; the disk boundary must be self-consistent. A non-kebab name fails closed here.
	reValidateName(name);

	//    CONFINE (D-018) — resolve the SKILL.md path through the SAME confined seam the config editor uses.
	//    The harvest dir is read server-side (never a request value); the submitted claudeDir is only a
	//    lookup key into the allow-list. A traversal/absolute name fails closed here.
	//    The confined resolver realpaths the ROOT first, so the harvest `.claude` tree must exist — create
	//    it idempotently (mirrors ensureHarvestScope; mkdir is a no-op when present, interrupt-safe).
	const claudeDir = harvestScopeDir(input.env);
	mkdirSync(resolve(claudeDir, 'skills'), { recursive: true });
	const explicitPath = join(resolve(claudeDir), 'skills', name, 'SKILL.md');
	let filePath: string;
	try {
		const resolved = resolveConfigTargetFromCatalog(harvestAllowedScopes(claudeDir), {
			kind: 'skill',
			claudeDir,
			explicitPath
		});
		filePath = resolved.filePath;
	} catch (err) {
		if (err instanceof ConfigTargetError) {
			throw new SkillPromoteConfinementError(
				`skill name ${JSON.stringify(name)} resolves outside the harvest scope — refusing (D-018): ${err.message}`
			);
		}
		throw err;
	}

	// The deterministic harvest scope id — computed up front so the ownership/collision guards can attribute
	// a catalog name to OUR scope (item 2) rather than inferring ownership from bare disk presence.
	const scopeId = scopeIdOf('global', claudeDir);

	// 4. NAME OWNERSHIP (item 3 — same-name promote serialization). `skill_proposal` has no UNIQUE on `name`
	//    (only the open-scoped dedup_key on name+trigger), so two same-name / different-trigger proposals
	//    could both flip approved and BOTH write the SAME SKILL.md path (last-writer-wins) while both read
	//    'approved'. A name must map to exactly ONE durable skill: if a DIFFERENT already-approved proposal
	//    owns this name, fail closed (named) unless `update:true` (the legitimate "this IS the update" path).
	//    Skipped when THIS proposal is already the approved owner (idempotent re-promote of itself).
	if (proposal.status !== 'approved') {
		const owner = await approvedNameOwner(db, name, proposal.id);
		if (owner && !input.update) {
			throw new SkillPromoteNameOwnedError(
				`skill name ${JSON.stringify(name)} is already owned by an approved skill_proposal (${owner}) — ` +
					`a name maps to ONE durable skill; refusing to promote a second same-name proposal ` +
					`(no last-writer-wins). Pass update:true to promote this AS the update to that skill.`
			);
		}
	}

	// 5. CATALOG COLLISION (no poisoning; item 2 — SCOPE-attributed, not bare existsSync). The name may be
	//    live in cc_skill under a DIFFERENT (foreign) scope. The old guard read `existsSync(filePath)` to
	//    infer ownership, but a stale harvest file at our path + a foreign-owned catalog name would slip the
	//    guard and create a duplicate-name cc_skill row across scopes. Attribute ownership to OUR harvest
	//    scope: the name is "ours" ONLY if a cc_skill row with it exists under our scope id.
	const catalog = await catalogIds(db);
	const nameInCatalog = catalog.skills.has(name);
	const ownedByUs = await nameOwnedByHarvestScope(db, scopeId, name);
	if (nameInCatalog && !ownedByUs && !input.update) {
		// The name is live in cc_skill but owned by a DIFFERENT scope (not our harvest scope) → foreign.
		throw new SkillPromoteCollisionError(
			`skill name ${JSON.stringify(name)} already exists in the catalog under a DIFFERENT scope — ` +
				`refusing to overwrite (no catalog poisoning). Pass update:true to promote an update.`
		);
	}

	// 6. DISK FIRST (D-010 disk-is-truth). Re-screen the body AND description at the disk boundary (D-026
	//    symmetric — both land in the SKILL.md), render, and write atomically. Skip the write when an
	//    IDENTICAL file is already present (idempotent re-promote — also the absorb-partial-prior-run path:
	//    the file may exist from a promote that died before sync).
	const screenedBody = screenField(proposal.body, 'body');
	const screenedDescription = screenField(proposal.description, 'description');
	const content = renderSkillMd(name, screenedDescription, screenedBody);
	const ourFileExists = existsSync(filePath);
	let wroteFile = false;
	const alreadyIdentical = ourFileExists && safeRead(filePath) === content;
	if (!alreadyIdentical) {
		atomicWriteFile(filePath, content);
		wroteFile = true;
	}

	// 7. SYNC — disk → mirror. Only NOW can cc_skill carry the name (D-010: no row without the file). The
	//    harvest scope is global-kind (no owning project); deterministic scope id ⇒ idempotent re-sync.
	const scope: SyncScope = { kind: 'global', claudeDir: resolve(claudeDir) };
	await syncScope(db, scope);

	// 8. RECORD the approval. Idempotent: if already approved_by THIS approver with the same status, skip
	//    the write (no status thrash). A different/absent approver on an approved row records the operator.
	//    The status→approved flip recomputes `approved_name_key` to the name (m0064 VALUE field); the UNIQUE
	//    index over it is the DB-level backstop for same-name serialization (item 3) — a concurrent racer
	//    that slipped past the step-4 JS guard (neither saw the other approved) collides HERE. Translate that
	//    collision to the named SkillPromoteNameOwnedError (never a raw DB error / never a duplicate-approved
	//    name). disk+sync (steps 6/7) already converged to ONE file + ONE cc_skill row (deterministic ids),
	//    so the loser leaves no half-state — only its status flip is refused.
	let recordedApproval = false;
	if (!(proposal.status === 'approved' && proposal.approved_by === approver)) {
		try {
			await db.query(
				`UPDATE $rid SET status = "approved", approved_by = $by, approved_at = time::now(), updated_at = time::now();`,
				{ rid: link(proposal.id), by: approver }
			);
		} catch (err) {
			if (isApprovedNameCollision(err)) {
				throw new SkillPromoteNameOwnedError(
					`skill name ${JSON.stringify(name)} is already owned by another approved skill_proposal ` +
						`(UNIQUE approved_name_key collision at record time) — a name maps to ONE durable skill; ` +
						`refusing a second same-name approval (no last-writer-wins). Pass update:true to update it.`
				);
			}
			throw err; // a non-collision DB fault — propagate verbatim (F-008).
		}
		recordedApproval = true;
	}

	// Re-read the canonical row so the result reflects the persisted approved state (F-008 — return the
	// real persisted row, never the pre-update value).
	const finalRow = (await getSkillProposal(db, proposal.id)) ?? proposal;

	return { proposal: finalRow, name, filePath, scopeId, wroteFile, recordedApproval };
}

/**
 * Is `err` a SurrealDB UNIQUE-index / commit-race collision on the skill_proposal_approved_name index?
 * Mirrors proposal.ts isDedupCollision — match ONLY the real unique-violation / write-conflict phrases so
 * an unrelated DB fault is never silently absorbed as a benign collision (F-008). Used to translate the
 * approved-name UNIQUE collision at the RECORD step into the named SkillPromoteNameOwnedError.
 */
function isApprovedNameCollision(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		/index `?[^`']*`? already contains/i.test(msg) ||
		/record `?[^`']*`? already exists/i.test(msg) ||
		/failed transaction|read or write conflict/i.test(msg)
	);
}

/** Read a file or return undefined (a missing/unreadable file is an honest absent, not a throw). */
function safeRead(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, 'utf8');
	} catch {
		return undefined;
	}
}
