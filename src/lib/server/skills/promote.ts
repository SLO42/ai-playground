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

import { resolve, join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
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
 * D-026 — an un-redactable secret survived into the proposal body at the promote (disk-write) boundary.
 * A SKILL.md is about to land on disk, so we re-screen here (defense in depth — the proposal was screened
 * at draft time, but disk is the final boundary). A quarantined block REJECTS rather than writing a
 * half-redacted secret to a file (F-008). NAMED + carries the field.
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

/** D-026 re-screen of the body at the disk-write boundary; quarantined → REJECT (named). */
function screenBody(body: string): string {
	const res = screen(body);
	if (res.status === 'quarantined') {
		throw new SkillPromoteSecretEchoError(
			`skill_proposal body carries an un-redactable secret (D-026, quarantined) — refusing to write ` +
				`SKILL.md to disk; screen reasons: [${res.reasons.join(', ')}]`,
			'body'
		);
	}
	return res.text;
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
 */
function atomicWriteFile(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, 'utf8');
	renameSync(tmp, filePath);
}

/**
 * Build the AllowedScope set for the harvest scope so resolveConfigTargetFromCatalog can confine the
 * SKILL.md path against the SERVER-SIDE harvest dir (never a request value). The harvest scope is
 * `global`-kind (no owning project) — exactly how ensureHarvestScope registers it.
 */
function harvestAllowedScopes(claudeDir: string): AllowedScope[] {
	return [{ kind: 'global', path: resolve(claudeDir) }];
}

// ── promoteSkill — the single operator-gated disk+catalog write chokepoint ────────────────────────────

/**
 * Promote an operator-approved skill_proposal to disk + the cc_skill catalog. Steps, in order:
 *   1. LOAD — fetch the proposal by id; absent → SkillPromoteNotFoundError (honest, named).
 *   2. APPROVAL GATE (G2/D-039) — require a non-empty `approver`; a 'rejected' proposal is non-promotable
 *      → SkillPromoteNotApprovedError. The approval is recorded by THIS operator-driven call (step 6);
 *      proposeSkill cannot set approved_by, so no agent path reaches cc_skill.
 *   3. CONFINE (D-018) — resolve `<harvestDir>/skills/<name>/SKILL.md` through the confined resolver; a
 *      traversal/absolute name fails closed → SkillPromoteConfinementError.
 *   4. COLLISION (no catalog poisoning) — if the name is already in cc_skill AND is NOT this proposal's
 *      own SKILL.md, reject (SkillPromoteCollisionError) unless `update:true`.
 *   5. DISK FIRST (D-010) — re-screen the body (D-026), render frontmatter+body, atomically write SKILL.md
 *      (no-op skip if an identical file is already present — idempotent re-promote).
 *   6. SYNC — re-sync the harvest scope so cc_skill carries the new name (the disk→mirror direction).
 *   7. RECORD — flip status='approved' + persist approved_by/approved_at (skipped if already recorded —
 *      idempotent). dedup_key recomputes to the row id on the status change, freeing the normalized key.
 *
 * Shadow paths: nil/empty approver → step-2 named throw; unknown proposalId → step-1 named throw;
 * `../escape` name (were it ever to slip past the proposal contract) → step-3 named throw; a colliding
 * name → step-4 named throw; an un-redactable secret in the body → step-5 named throw; an upstream DB
 * fault → propagates (never silenced, F-008). A re-run after a partial prior promote absorbs the on-disk
 * file (step 5 skip) and completes sync+record.
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

	// 3. CONFINE (D-018) — resolve the SKILL.md path through the SAME confined seam the config editor uses.
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

	// 4. COLLISION — never silently overwrite an existing catalog id with a different file's content.
	const catalog = await catalogIds(db);
	const nameInCatalog = catalog.skills.has(name);
	const ourFileExists = existsSync(filePath);
	if (nameInCatalog && !ourFileExists && !input.update) {
		// The name is live in cc_skill but NOT backed by this proposal's SKILL.md → a different owner.
		throw new SkillPromoteCollisionError(
			`skill name ${JSON.stringify(name)} already exists in the catalog under a different file — ` +
				`refusing to overwrite (no catalog poisoning). Pass update:true to promote an update.`
		);
	}

	// 5. DISK FIRST (D-010 disk-is-truth). Re-screen the body at the disk boundary (D-026), render, and
	//    write atomically. Skip the write when an IDENTICAL file is already present (idempotent re-promote
	//    — also the absorb-partial-prior-run path: the file may exist from a promote that died before sync).
	const screenedBody = screenBody(proposal.body);
	const content = renderSkillMd(name, proposal.description, screenedBody);
	let wroteFile = false;
	const alreadyIdentical = ourFileExists && safeRead(filePath) === content;
	if (!alreadyIdentical) {
		atomicWriteFile(filePath, content);
		wroteFile = true;
	}

	// 6. SYNC — disk → mirror. Only NOW can cc_skill carry the name (D-010: no row without the file). The
	//    harvest scope is global-kind (no owning project); deterministic scope id ⇒ idempotent re-sync.
	const scope: SyncScope = { kind: 'global', claudeDir: resolve(claudeDir) };
	await syncScope(db, scope);
	const scopeId = scopeIdOf('global', claudeDir);

	// 7. RECORD the approval. Idempotent: if already approved_by THIS approver with the same status, skip
	//    the write (no status thrash). A different/absent approver on an approved row records the operator.
	let recordedApproval = false;
	if (!(proposal.status === 'approved' && proposal.approved_by === approver)) {
		await db.query(
			`UPDATE $rid SET status = "approved", approved_by = $by, approved_at = time::now(), updated_at = time::now();`,
			{ rid: link(proposal.id), by: approver }
		);
		recordedApproval = true;
	}

	// Re-read the canonical row so the result reflects the persisted approved state (F-008 — return the
	// real persisted row, never the pre-update value).
	const finalRow = (await getSkillProposal(db, proposal.id)) ?? proposal;

	return { proposal: finalRow, name, filePath, scopeId, wroteFile, recordedApproval };
}

/** Read a file or return undefined (a missing/unreadable file is an honest absent, not a throw). */
function safeRead(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, 'utf8');
	} catch {
		return undefined;
	}
}
