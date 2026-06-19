// server/create/execute.ts — the EXECUTE half of Create-with-AI (CREATE-SPEC §2.4-2.5, §3 rails).
//
// On an operator-CONFIRMED proposal (a valid confirmToken from CA-1, plan.ts), this materializes
// the project FOR REAL and registers it HONESTLY. Sequence (CREATE-SPEC §2.4-2.5):
//
//   1. GATE — re-validate the confirmToken (assertProposalFresh, D-010 shape) and slug-validate the
//      target id (assertRecordIdOfTable for `project:<slug>`). FAIL CLOSED if the project already
//      exists ("project exists — open it"), idempotent same-slug re-create never overwrites.
//   2. SCAFFOLD — deterministically write the proposal's dirLayout under CODE_ROOT/<slug>
//      (confineToRoot, D-018 — every path re-confined under the new project dir, NO writes outside),
//      with a D-026-safe .gitignore (covers .env from commit 0) + a README; `git init` + first commit
//      via the execFile-ARRAY runner seam (D-008/F-002, never a shell). The file CONTENTS are
//      re-screened (D-026) so a literal secret can never be written even if it slipped CA-1.
//   3. REGISTER HONESTLY (F-008) — scanProject ingests the REAL on-disk scaffold (re-scan; the row
//      derives from disk, NEVER the proposal text). A scaffold that DIED mid-way yields an honest
//      `incident` row + NO phantom project row (the create throws; nothing partial is registered).
//   4. WRITERS — updateProjectPlan(planMacro) · setCapabilityNeeds(needs) · createTask per founding
//      task (PM-on per fork 3 → born 'proposed' for panel validation; no PM → born 'ready') ·
//      declareTarget per target draft.
//   5. HAND-OFF — when a PM was requested, hirePm() with the charter PRE-FILLED from the proposal.
//
// Scope/secret rails: D-018 (scaffold strictly under CODE_ROOT, escapes fail closed); D-026 (no
// secret bytes written — env NAMES only); D-016 (slug-validated record id); F-008 (row reflects
// disk, partial = incident + no phantom row); D-010 (confirm-gated — token re-checked here).

import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordIdOfTable } from '../db/validate';
import { confineToRoot, scanProject } from '../scanner/registry';
import { slugify } from '../scanner/detect';
import { getProject, updateProjectPlan } from '../projects/repo';
import { createTask, type TaskStatus } from '../tasks/repo';
import { declareTarget } from '../adapters/registry';
import { setCapabilityNeeds } from '../workforce/capability-match';
import { getPm } from '../projects/pm-repo';
import { hirePm, type HireAnswer, type HirePmResult } from '../projects/pm-hire';
import { screen } from '../memory/screen';
import { captureSnapshotSafe } from '../memory/file-snapshot-capture';
import { execFileRunner, type CommandRunner } from '../orchestrator/post-task';
import {
	assertProposalFresh,
	type CreationProposalEnvelope,
	type CreationProposal
} from './plan';
import { getTemplate, type ProjectTemplate } from './templates';

// ── Errors (EVERY ERROR HAS A NAME) ────────────────────────────────────────────────

/** The target slug already maps to an existing project (idempotent fail-closed — §2.4 (1)). */
export class ProjectExistsError extends Error {
	readonly projectId: string;
	constructor(projectId: string) {
		super(`project exists — open it (${projectId})`);
		this.name = 'ProjectExistsError';
		this.projectId = projectId;
	}
}

/**
 * The brief name does not yield a STABLE slug — `slugify(slugify(name)) !== slugify(name)`
 * (D-016 / F-008). slugify is not idempotent for degenerate, symbol-only names ('!!!','__','??? '):
 * the gate would validate `project:p_` while scanProject (which re-derives the slug from the dir
 * basename) registers `project:p`. That divergence breaks the existence gate (a second same-name
 * create would not fail closed, would re-enter the existing scaffold, and its failed `git commit`
 * would `rm -rf` the live project's dir — F-008 phantom). We fail CLOSED at the gate, before any
 * disk touch: a name with no stable slug is rejected with a clear message instead of corrupting.
 */
export class UnstableSlugError extends Error {
	readonly name = 'UnstableSlugError';
	readonly slug: string;
	readonly reSlug: string;
	constructor(briefName: string, slug: string, reSlug: string) {
		super(
			`project name ${JSON.stringify(briefName)} has no stable slug ` +
				`(slugify→${JSON.stringify(slug)}→${JSON.stringify(reSlug)}); ` +
				`give it a name with at least one letter or digit (D-016).`
		);
		this.slug = slug;
		this.reSlug = reSlug;
	}
}

/** A dirLayout entry tried to escape the new project dir (D-018, fail closed). */
export class ScaffoldPathError extends Error {
	readonly entry: string;
	constructor(message: string, entry: string) {
		super(message);
		this.name = 'ScaffoldPathError';
		this.entry = entry;
	}
}

/**
 * A scaffold file's CONTENT carried an UN-REDACTABLE secret (D-026 — env NAMES only). HARD-reject:
 * `screen()` returned status 'quarantined' (e.g. a private-key PEM block) — the offending span could
 * NOT be safely redacted in isolation, so the file is refused rather than written. The message names
 * the FILE and the concrete reason (the screen rule ids), never a generic "literal secret".
 *
 * NOTE (the create-with-email live bug): a 'redacted' status is NOT this error — a redactable span
 * (a benign email, a home path, a known-prefix token) is written as the SAFE screen().text version
 * with an honest redaction note, never aborted. Only 'quarantined' (un-redactable) reaches here.
 */
export class ScaffoldSecretError extends Error {
	readonly path: string;
	constructor(message: string, path: string) {
		super(message);
		this.name = 'ScaffoldSecretError';
		this.path = path;
	}
}

/** The scaffold (write / git init / first commit) failed mid-way — recorded as an incident (F-008). */
export class ScaffoldFailedError extends Error {
	readonly incidentId?: string;
	constructor(message: string, incidentId?: string) {
		super(message);
		this.name = 'ScaffoldFailedError';
		this.incidentId = incidentId;
	}
}

/**
 * Another create for this slug is already in flight — the slug-keyed create-lock was held when we
 * tried to acquire it (CA-H2 TOCTOU guard, fail closed). Two parallel same-slug creates both pass
 * the getProject null-gate; the lock's fail-closed `CREATE` lets exactly ONE proceed and rejects
 * the rest HERE, before any disk touch — so the loser can never `rm -rf` the winner's live scaffold.
 */
export class ConcurrentCreateError extends Error {
	readonly slug: string;
	constructor(slug: string) {
		super(`a create for '${slug}' is already in progress — try again once it completes (CA-H2).`);
		this.name = 'ConcurrentCreateError';
		this.slug = slug;
	}
}

/**
 * The scaffold + register SUCCEEDED but a POST-register writer (plan / needs / tasks / targets / PM)
 * threw (CA-H2). The project row is REAL on disk and registered, but only partially wired — so it is
 * marked HONESTLY (`create_status='incomplete'`) and an incident is logged, NEVER left as a silent
 * half-built phantom and NEVER a wedged slug. The id is carried so the operator can inspect/retry.
 */
export class PostRegisterWriterError extends Error {
	readonly projectId: string;
	readonly incidentId?: string;
	constructor(projectId: string, cause: string, incidentId?: string) {
		super(
			`project ${projectId} was registered but setup did not finish (marked incomplete, ` +
				`incident logged): ${cause}`
		);
		this.name = 'PostRegisterWriterError';
		this.projectId = projectId;
		this.incidentId = incidentId;
	}
}

/** The requested template id does not exist in the registry (honest named error — CT-1). */
export class TemplateNotFoundError extends Error {
	readonly templateId: string;
	constructor(templateId: string) {
		super(`unknown template '${templateId}' — pick one from the template registry (CT-1).`);
		this.name = 'TemplateNotFoundError';
		this.templateId = templateId;
	}
}

// ── Inputs / result ─────────────────────────────────────────────────────────────────

export interface ExecuteCreationOptions {
	/** The confinement root (CODE_ROOT). The scaffold lives at `<codeRoot>/<slug>` (D-018). */
	codeRoot: string;
	/**
	 * The PM hand-off (fork 3, default ON). Present ⇒ hirePm runs with the charter pre-filled from
	 * the proposal (pmCharterDraft). Absent ⇒ no PM is hired; founding tasks are born 'ready'.
	 * The interview `answers` carry the operator's words (may be empty — an honest clean hire).
	 */
	pm?: {
		/** The PM's name (required when a PM is requested). */
		name: string;
		/** Interview answers in the operator's words; empty ⇒ a clean-slate hire (honest). */
		answers?: HireAnswer[];
		persona?: string;
	};
	/** Injectable command runner (test seam) — defaults to {@link execFileRunner}. */
	run?: CommandRunner;
	/**
	 * Optional clock override for the README/scaffold (determinism in tests). Production omits it.
	 */
	now?: () => Date;
}

export interface ExecuteCreationResult {
	/** The new `project:<slug>` id — the caller lands on its workspace (§2.5). */
	projectId: string;
	/** The scaffold's absolute root path (confined under CODE_ROOT). */
	rootPath: string;
	/** The founding task ids created (in proposal order). */
	taskIds: string[];
	/** The status the founding tasks were born in ('proposed' with a PM, else 'ready'). */
	taskStatus: TaskStatus;
	/** The declared target ids (in proposal order). */
	targetIds: string[];
	/** The PM hand-off result when a PM was requested; undefined otherwise. */
	pm?: HirePmResult;
	/** The first commit sha, when git reported one. */
	commitSha?: string;
}

// ── Scaffold materialization (deterministic, D-018/D-026) ─────────────────────────────

/** A scaffold entry resolved to (kind, absolute path) under the project root, re-confined. */
interface ResolvedEntry {
	kind: 'dir' | 'file';
	abs: string;
	rel: string;
}

/**
 * Resolve a dirLayout entry to an absolute path UNDER `projectRoot`, failing closed on any escape
 * (absolute paths, `..` that climbs out, drive-letter switches). An entry ending in `/` is a dir;
 * otherwise a file. The check resolves `..` BEFORE the prefix compare (the same discipline as
 * confineToRoot) so `a/../../etc` cannot slip through. Windows: case-insensitive prefix compare.
 */
function resolveEntry(entry: string, projectRoot: string): ResolvedEntry {
	const trimmed = entry.trim();
	if (trimmed === '' || trimmed === '.' || trimmed === './') {
		throw new ScaffoldPathError(`scaffold entry is empty`, entry);
	}
	if (isAbsolute(trimmed)) {
		throw new ScaffoldPathError(`scaffold entry must be relative (D-018): ${entry}`, entry);
	}
	const isDir = trimmed.endsWith('/') || trimmed.endsWith('\\');
	const abs = resolve(projectRoot, trimmed);
	const rootWithSep = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
	const cmpAbs = process.platform === 'win32' ? abs.toLowerCase() : abs;
	const cmpRoot = process.platform === 'win32' ? rootWithSep.toLowerCase() : rootWithSep;
	const cmpRootExact = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
	if (cmpAbs !== cmpRootExact && !cmpAbs.startsWith(cmpRoot)) {
		throw new ScaffoldPathError(
			`scaffold entry ${abs} escapes the project root ${projectRoot} (D-018, fail closed)`,
			entry
		);
	}
	return { kind: isDir ? 'dir' : 'file', abs, rel: relative(projectRoot, abs) };
}

/**
 * The honest seed content for a generated FILE. We do NOT fabricate functional code (F-008 — the
 * scaffold is a real, minimal greenfield skeleton, fleshed out by the founding tasks). Every file
 * is created so the layout is REAL on disk for the re-scan; known config files get a minimal honest
 * stub, everything else gets a one-line placeholder naming the founding work. The content is
 * screened (D-026) by the caller before it is written.
 */
function seedContent(rel: string, proposal: CreationProposal, projectName: string): string {
	const base = rel.split(/[\\/]/).pop() ?? rel;
	if (base === '.gitignore') {
		// D-026: .env is gitignored from commit 0 so a secret can never be committed.
		return ['.env', '.env.*', '!.env.example', 'node_modules/', 'dist/', 'build/', ''].join('\n');
	}
	if (base.toLowerCase() === 'readme.md') {
		const stack = proposal.stack.map((s) => `- ${s}`).join('\n');
		return (
			`# ${projectName}\n\n` +
			`${proposal.planMacro.purpose}\n\n` +
			`## Stack\n\n${stack}\n\n` +
			`> Scaffolded by Atelier Create-with-AI. Founding tasks track the build-out.\n`
		);
	}
	if (base === '.env.example') {
		// Only NAMES, never values (D-026). The proposal's target configs reference env names.
		return `# Environment variable NAMES only — never commit real values.\n`;
	}
	// A generic placeholder for any other declared file. Names the project; no fabricated logic.
	return `// ${rel} — scaffolded by Atelier Create-with-AI for ${projectName}. Founding tasks flesh this out.\n`;
}

/** An honest record of a file whose content was redacted-in-place before write (D-026, F-008). */
interface ScaffoldRedaction {
	/** The project-relative path of the redacted file. */
	path: string;
	/** The screen rule ids that fired (e.g. ['email'], ['home-path-win']) — honest, not generic. */
	reasons: string[];
}

/** A file actually written to disk: its project-relative path + the SAFE bytes written (FS-2). */
interface WrittenFile {
	/** Project-relative path written. */
	rel: string;
	/** The SAFE content written to disk (clean===original, redacted===screen().text — never raw). */
	content: string;
}

/** The outcome of materializing a scaffold file-map: the files written + any in-place redactions. */
interface WriteFileMapResult {
	/** Relative paths actually written to disk. */
	written: string[];
	/** The written files + their SAFE content — the FS-2 scaffold capture source (no disk re-read). */
	writtenFiles: WrittenFile[];
	/** Files whose content carried a redactable span — written as the SAFE redacted text (F-008). */
	redactions: ScaffoldRedaction[];
}

/**
 * Write a relative-path → file-content MAP under `projectRoot` (already created + confined),
 * confining + screening every entry before write. Each KEY is re-confined under the project root
 * via resolveEntry (D-018, fail closed on absolute/`..` escape — ScaffoldPathError); a directory
 * key (trailing `/`) is mkdir-only; a file key's CONTENT is screened (D-026) before it is written.
 *
 * D-026 screen disposition (the three statuses, NO raw secret bytes ever reach disk):
 *   • 'clean'        → write the content verbatim.
 *   • 'redacted'     → the sensitive span was ALREADY replaced in screen().text (a benign email, a
 *                      home path, a known-prefix token). Write that SAFE redacted text and record an
 *                      honest redaction note (count + reasons). Do NOT abort — the prior hard-abort
 *                      on 'redacted' was the bug that failed a normal description containing an email.
 *   • 'quarantined'  → the span could NOT be safely redacted (e.g. a private-key PEM block). HARD-
 *                      reject ScaffoldSecretError naming the FILE + the concrete screen reasons.
 * In every case the bytes written are screen().text (clean===original, redacted===safe), so a raw
 * secret is NEVER written — D-026 preserved (redacted text has none; quarantined is refused).
 *
 * This is the SINGLE scaffold writer shared by BOTH create paths: the AI path passes a map built
 * from dirLayout + seedContent (honest stubs), the TEMPLATE path passes the REAL generated content
 * (the key difference — template files are materialized verbatim, not placeholder stubs). The map's
 * iteration order is insertion order; a dir entry and a deeper file entry both mkdir their parents.
 *
 * Atomic-ish (interrupt contract): each dir is mkdir-recursive (idempotent); each file is written
 * with writeFile (last-writer-wins on a re-run). The CALLER removes a partial dir on failure so a
 * re-run starts clean — there is never an observable half-scaffold registered (F-008 / interrupt).
 */
async function writeFileMap(
	projectRoot: string,
	fileMap: Record<string, string>
): Promise<WriteFileMapResult> {
	const written: string[] = [];
	const writtenFiles: WrittenFile[] = [];
	const redactions: ScaffoldRedaction[] = [];
	const seen = new Set<string>();
	for (const [entry, content] of Object.entries(fileMap)) {
		const resolved = resolveEntry(entry, projectRoot); // D-018 — absolute/`..` escape fails closed.
		const key = process.platform === 'win32' ? resolved.abs.toLowerCase() : resolved.abs;
		if (seen.has(key)) continue; // dedupe (a `.gitignore` declared twice writes once).
		seen.add(key);
		if (resolved.kind === 'dir') {
			await mkdir(resolved.abs, { recursive: true });
			continue;
		}
		await mkdir(dirname(resolved.abs), { recursive: true });
		// D-026: screen the content. quarantined → HARD-reject (named, file + reason). redacted →
		// write the SAFE redacted text + record the note. clean → write verbatim. screen().text is
		// always the safe payload, so a raw secret never reaches disk on any branch.
		const res = screen(content);
		if (res.status === 'quarantined') {
			throw new ScaffoldSecretError(
				`scaffold file '${resolved.rel}' carries an un-redactable secret and was refused ` +
					`(D-026, quarantined): [${res.reasons.join(', ')}]`,
				resolved.rel
			);
		}
		if (res.status === 'redacted') {
			redactions.push({ path: resolved.rel, reasons: res.reasons });
		}
		// res.text === content for 'clean'; the safe redacted version for 'redacted'. Never raw secret.
		await writeFile(resolved.abs, res.text, 'utf8');
		written.push(resolved.rel);
		// FS-2 scaffold capture source: the SAFE bytes written (res.text), so the snapshot reuses the
		// SAME screened content the disk got — no double-screen of the raw, no disk re-read (§3 a).
		writtenFiles.push({ rel: resolved.rel, content: res.text });
	}
	return { written, writtenFiles, redactions };
}

/**
 * Build the AI path's scaffold file-map: the proposal's dirLayout (dirs → '', files → an honest
 * seedContent stub, F-008) plus the always-present commit-0 files (.gitignore covers .env, README).
 * The required files are appended LAST so an explicit dirLayout `.gitignore`/`README.md` (with its
 * own seeded content) wins the dedupe in writeFileMap (first key wins). Pure; no I/O.
 */
function aiScaffoldFileMap(
	proposal: CreationProposal,
	projectName: string
): Record<string, string> {
	const map: Record<string, string> = {};
	for (const entry of proposal.dirLayout) {
		const isDir = entry.trim().endsWith('/') || entry.trim().endsWith('\\');
		// The content for a dir key is ignored by writeFileMap; for a file key it is the honest stub.
		map[entry] = isDir ? '' : seedContent(entry, proposal, projectName);
	}
	for (const req of ['.gitignore', 'README.md']) {
		if (!(req in map)) map[req] = seedContent(req, proposal, projectName);
	}
	return map;
}

/**
 * D-026 writer-boundary screen for an agent-authored DB-bound FREE-TEXT field (a plan-macro field or a
 * founding-task objective/purpose). These fields are persisted RAW by updateProjectPlan (repo.ts MERGE)
 * and createTask (tasks/repo.ts CREATE) — neither passes through writeFileMap/screen(), so the plan.ts
 * 'freetext' relaxation's "redacted at the scaffold-write disk boundary" safety net does NOT cover them
 * (only readme.md echoes purpose through the disk gate; the DB column gets the value verbatim). This is
 * the canonical chokepoint that makes the relaxation honest: a 'redacted' span (a benign email, a home
 * path, a known-prefix provider key like sk-ant-…) is stored as the SAFE screen().text — the SAME
 * disposition setCapabilityNeeds and the scaffold-write gate use ("write safe redacted text instead of
 * hard-aborting on benign PII"). A 'quarantined' (un-redactable) block is also reduced to its safe
 * screen().text. The collected `reasons` feed an honest, non-fatal redaction note (F-008, parity with
 * the fileMap redaction note) so a writer-boundary redaction is visible, never silent.
 */
function screenWriterText(value: string, field: string, into: ScaffoldRedaction[]): string {
	const res = screen(value);
	if (res.status !== 'clean') into.push({ path: field, reasons: res.reasons });
	return res.text;
}

/** True iff `p` exists on disk (used for the CA-H2 ownership gate — did THIS run create the dir?). */
async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Record a global `incident` row (F-008 — a scaffold event is NEVER silent). Best-effort. `severity`
 * defaults to 'error' (a real failure); an honest non-error signal (e.g. an in-place redaction note)
 * passes 'info' so the surface does not mislabel a benign redaction as a failure.
 */
async function recordIncident(
	db: Db,
	title: string,
	detail: string,
	severity: 'info' | 'warn' | 'error' | 'critical' = 'error'
): Promise<string | undefined> {
	try {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE incident CONTENT { title: $title, detail: $detail, severity: $severity } RETURN AFTER;`,
			{ title, detail: detail.slice(0, 4000), severity }
		);
		return rows.length ? String(rows[0].id) : undefined;
	} catch {
		// An incident-write failure must not mask the original scaffold failure — swallow, return none.
		return undefined;
	}
}

/**
 * Acquire the slug-keyed create-lock (CA-H2). FAIL CLOSED: `CREATE create_lock:<slug>` errors if the
 * record already exists (SurrealDB does NOT last-writer-win on CREATE — verified) → another create
 * for this slug is in flight, so we throw ConcurrentCreateError. The slug is snake-case (validated
 * upstream), so `create_lock:<slug>` is a well-formed id; we still route it through the D-016 chokepoint.
 * Returns the run nonce stored on the lock so only THIS run releases it.
 */
async function acquireCreateLock(db: Db, slug: string, nonce: string): Promise<void> {
	const rid = new StringRecordId(assertRecordIdOfTable(`create_lock:${slug}`, 'create_lock'));
	try {
		await db.query(`CREATE $rid CONTENT { holder: $holder } RETURN AFTER;`, {
			rid,
			holder: nonce
		});
	} catch (err) {
		// CREATE on an existing record throws "already exists" → another create holds the lock.
		const msg = String((err as Error)?.message ?? err);
		if (/already exists/i.test(msg)) throw new ConcurrentCreateError(slug);
		throw err; // an unexpected DB error must surface with its own name, never as a phantom success.
	}
}

/**
 * Release the create-lock — but ONLY if THIS run still holds it (nonce match), so a release can never
 * clobber a lock a different run acquired (ownership discipline mirrors the cleanup gate). Best-effort:
 * a release failure must not mask the outcome we are returning/throwing.
 */
async function releaseCreateLock(db: Db, slug: string, nonce: string): Promise<void> {
	try {
		const rid = new StringRecordId(assertRecordIdOfTable(`create_lock:${slug}`, 'create_lock'));
		await db.query(`DELETE $rid WHERE holder = $holder;`, { rid, holder: nonce });
	} catch {
		// swallow — the lock TTL/operator cleanup is the backstop; never mask the real result.
	}
}

/** Set the project's honest create_status (CA-H2). Bound value; id through the D-016 chokepoint. */
async function setCreateStatus(
	db: Db,
	projectId: string,
	status: 'complete' | 'incomplete'
): Promise<void> {
	const rid = new StringRecordId(assertRecordIdOfTable(projectId, 'project'));
	await db.query(`UPDATE $rid MERGE { create_status: $status, updated_at: $now } RETURN NONE;`, {
		rid,
		status,
		now: new Date()
	});
}

// ── The executor (CA-2 entry point) ──────────────────────────────────────────────────

/**
 * Execute a confirmed creation proposal (CREATE-SPEC §2.4-2.5). The `envelope` is the EXACT one
 * CA-1 returned (brief + proposal + confirmToken); the token is re-validated here (D-010) so a
 * proposal edited after confirm is rejected (StaleProposalError from assertProposalFresh).
 *
 * Returns the new project id + the rows it created. Throws (NAMED) and registers NO phantom row on:
 *   • a stale token (StaleProposalError) — gate, before any disk touch;
 *   • a name with no stable slug (UnstableSlugError) — gate, before any disk touch (D-016/F-008);
 *   • an existing slug (ProjectExistsError) — idempotent fail-closed;
 *   • a concurrent same-slug create in flight (ConcurrentCreateError) — fail-closed create-lock (CA-H2);
 *   • a path escape (ScaffoldPathError) / secret echo (ScaffoldSecretError) — before commit;
 *   • a mid-scaffold death (ScaffoldFailedError) — the partial dir is removed + an incident logged.
 *
 * Post-register (CA-H2): if a writer throws AFTER the scanProject register, the project is NOT
 * unregistered (its scaffold + commit are durable on disk; deleting the row would orphan a live dir).
 * Instead it is MARKED honestly (`create_status='incomplete'`), an incident is logged, and a NAMED
 * PostRegisterWriterError is thrown — a real, clearly-marked, non-wedged project (never a silent
 * phantom). On full success the row is marked `create_status='complete'`.
 *
 * Shadow paths: nil envelope fields → assertProposalFresh / slug validation throw (named); an empty
 * dirLayout cannot occur (CA-1 rejects it) but the required commit-0 files still scaffold a real dir;
 * an upstream DB error during the writers surfaces with its own name (never swallowed as success).
 */
export async function executeCreation(
	db: Db,
	envelope: CreationProposalEnvelope,
	opts: ExecuteCreationOptions
): Promise<ExecuteCreationResult> {
	const { brief, proposal, confirmToken } = envelope;

	// ── 1. GATE — D-010 token re-check (before any disk touch). ──
	assertProposalFresh(brief, proposal, confirmToken);

	// The AI path's scaffold file-map: dirLayout (honest seedContent stubs, F-008) + commit-0 files.
	const fileMap = aiScaffoldFileMap(proposal, brief.name.trim());

	return scaffoldRegisterAndWire(db, {
		briefName: brief.name,
		fileMap,
		wantPm: opts.pm !== undefined,
		run: opts.run,
		codeRoot: opts.codeRoot,
		// POST-REGISTER WRITERS (CA-H2) — plan · needs · tasks · targets · PM, all from the proposal.
		async postRegister(projectId, taskStatus): Promise<PostRegisterOutcome> {
			// D-026 writer boundary: planMacro + founding-task free text persist RAW (updateProjectPlan
			// MERGE / createTask CREATE — neither passes through writeFileMap/screen()). The plan.ts
			// 'freetext' relaxation lets a 'redacted'-status span (a benign email/home-path/provider-key
			// like sk-ant-…) PASS validation; screen it HERE so the DB stores the SAFE redacted text,
			// not the raw secret (the canonical chokepoint, mirroring setCapabilityNeeds).
			const writerRedactions: ScaffoldRedaction[] = [];
			await updateProjectPlan(db, projectId, {
				purpose: screenWriterText(proposal.planMacro.purpose, 'planMacro.purpose', writerRedactions),
				long_term_vision: screenWriterText(proposal.planMacro.vision, 'planMacro.vision', writerRedactions),
				role: screenWriterText(proposal.planMacro.role, 'planMacro.role', writerRedactions),
				definition_of_done: screenWriterText(
					proposal.planMacro.definition_of_done,
					'planMacro.definition_of_done',
					writerRedactions
				)
			});

			// Capability needs (defect_classes enum-validated by CA-1; setCapabilityNeeds re-validates
			// + screens at its own boundary — the canonical chokepoint, D-026).
			const needs = proposal.capabilityNeeds;
			if (
				needs.languages.length ||
				needs.frameworks.length ||
				needs.defect_classes.length ||
				needs.proposed_defect_classes.length
			) {
				await setCapabilityNeeds(db, projectId, {
					languages: needs.languages,
					frameworks: needs.frameworks,
					defect_classes: needs.defect_classes,
					// CAPTURED proposed classes persist SEPARATELY (hire signal, never matchable — D4).
					proposed_defect_classes: needs.proposed_defect_classes
				});
			}

			const taskIds: string[] = [];
			for (const [i, t] of proposal.foundingTasks.entries()) {
				// Same D-026 writer-boundary screen for the founding-task free text (createTask persists
				// title/description/objective/purpose RAW). objective backs title/description/objective.
				const objective = screenWriterText(t.objective, `foundingTasks[${i}].objective`, writerRedactions);
				const purpose = screenWriterText(t.purpose, `foundingTasks[${i}].purpose`, writerRedactions);
				const task = await createTask(db, {
					project: projectId,
					title: objective,
					// D-008: the description is the founding objective verbatim; purpose rides the field.
					description: objective,
					objective,
					purpose,
					origin: 'pm',
					status: taskStatus
				});
				taskIds.push(task.id);
			}

			// Honest, non-fatal redaction note (F-008, parity with the scaffold-write fileMap note): a
			// writer-boundary redaction is visible, never silent. Best-effort — a note failure must not
			// fail an otherwise-successful create.
			if (writerRedactions.length > 0) {
				const detail = writerRedactions.map((r) => `${r.path}: [${r.reasons.join(', ')}]`).join('; ');
				await recordIncident(
					db,
					`Create plan/task redactions: ${projectId}`,
					`Project ${projectId} stored ${writerRedactions.length} plan/task free-text field(s) ` +
						`redacted in place (D-026 — safe redacted text persisted, no raw secret; not an error). ${detail}`,
					'info'
				).catch(() => undefined);
			}

			const targetIds: string[] = [];
			for (const tg of proposal.targetDrafts) {
				const target = await declareTarget(db, {
					project: projectId,
					kind: tg.kind,
					adapterId: tg.adapterId,
					config: tg.config // env-NAMES only — declareTarget binds it as a $param blob (D-026).
				});
				targetIds.push(target.id);
			}

			// ── HAND-OFF — hire the PM with the charter pre-filled from the proposal (fork 3). ──
			let pm: HirePmResult | undefined;
			if (opts.pm) {
				pm = await hirePm(db, {
					project: projectId,
					name: opts.pm.name,
					...(proposal.pmCharterDraft ? { charter: proposal.pmCharterDraft } : {}),
					...(opts.pm.persona ? { persona: opts.pm.persona } : {}),
					answers: opts.pm.answers ?? []
				});
			}

			return { taskIds, targetIds, pm };
		}
	});
}

// ── Template executor (CT-3 entry point) ──────────────────────────────────────────────

/** The result of a template-driven creation (mirrors {@link ExecuteCreationResult}). */
export type ExecuteTemplateCreationResult = ExecuteCreationResult;

export interface ExecuteTemplateCreationOptions {
	/** The template id to materialize (CT-1 registry). Unknown ⇒ TemplateNotFoundError (honest). */
	templateId: string;
	/** The operator's project name (slug source) — the brief name analogue. */
	name: string;
	/** The operator's project description (rides into seed content / charter). May be empty. */
	description?: string;
	/** The template param values the UI collected (string/boolean) — passed verbatim to generate(). */
	params?: Record<string, string | boolean>;
	/** The confinement root (CODE_ROOT). The scaffold lives at `<codeRoot>/<slug>` (D-018). */
	codeRoot: string;
	/**
	 * The PM hand-off (fork 3, default ON when present). Present ⇒ hirePm runs with a charter derived
	 * from the template + brief; absent ⇒ no PM, founding tasks born 'ready'.
	 */
	pm?: {
		name: string;
		answers?: HireAnswer[];
		persona?: string;
	};
	/** Injectable command runner (test seam) — defaults to {@link execFileRunner}. */
	run?: CommandRunner;
	/** Optional clock override (determinism in tests). Production omits it. */
	now?: () => Date;
}

/**
 * Execute a TEMPLATE-driven creation (CT-3). Resolves the template (getTemplate — honest
 * TemplateNotFoundError when unknown), renders `template.generate(name, description, params)` into
 * the REAL relative-path → content file-map, then runs the EXACT SAME pipeline executeCreation uses
 * via the shared {@link scaffoldRegisterAndWire}: create_lock/F-040 acquire, slug + stability gate +
 * ProjectExistsError, per-entry confineToRoot (ScaffoldPathError on `..`/absolute), per-file D-026
 * screen (ScaffoldSecretError, HARD), mkdir + writeFile the REAL template content (NOT placeholder
 * stubs — the key difference from the AI path's dirLayout), git init + first commit, scanProject
 * ingest (row derives from DISK, F-008), register, then the post-register writers mapped from the
 * TEMPLATE metadata + brief (plan macro · capability needs from template.language+tags · NO founding
 * tasks unless the template provides them, which the current registry does not · optional hirePm).
 *
 * Same incident/rollback on a mid-scaffold failure (ScaffoldFailedError, NO phantom row). Same
 * post-register honesty (PostRegisterWriterError + create_status='incomplete', never a silent
 * half-state). Throws the same NAMED errors as executeCreation for the shared failure classes.
 *
 * Shadow paths: unknown templateId → TemplateNotFoundError (before any disk touch / lock); a param
 * injecting `../` into a generated path → ScaffoldPathError (fail closed); a param that becomes a
 * literal secret in a generated file → ScaffoldSecretError (HARD); an empty/whitespace name → the
 * slug gate (UnstableSlugError) throws before any disk touch; a generate() that returns no files is
 * impossible for the registry templates (every one emits at least a CLAUDE.md/.gitignore), but the
 * commit-0 .gitignore/README are NOT auto-injected here — the template owns its own tree.
 */
export async function executeTemplateCreation(
	db: Db,
	opts: ExecuteTemplateCreationOptions
): Promise<ExecuteTemplateCreationResult> {
	// ── 1. RESOLVE — honest named error before any disk touch / lock (CT-1). ──
	const template = getTemplate(opts.templateId);
	if (!template) throw new TemplateNotFoundError(opts.templateId);

	const name = opts.name;
	const description = opts.description ?? '';
	const params = opts.params ?? {};

	// ── 2. RENDER — the REAL file-map (relative path → content). Pure; depends only on its args. ──
	// A hostile param that injects `../` into a generated path key is NOT trusted here — the shared
	// pipeline's resolveEntry re-confines EVERY key under the project root (D-018, ScaffoldPathError),
	// and screen() re-checks EVERY file's content (D-026, ScaffoldSecretError) before any write.
	const fileMap = template.generate(name, description, params);

	return scaffoldRegisterAndWire(db, {
		briefName: name,
		fileMap,
		wantPm: opts.pm !== undefined,
		run: opts.run,
		codeRoot: opts.codeRoot,
		async postRegister(projectId, taskStatus): Promise<PostRegisterOutcome> {
			// PLAN MACRO — derived from the template + brief (honest, F-008: every field is grounded in
			// the template metadata + the operator's words, never fabricated boilerplate that pretends
			// to be more specific than it is).
			// D-026 writer boundary (parity with the AI path): the operator description rides into the
			// DB-bound `purpose` RAW via updateProjectPlan — screen it so a secret in the description is
			// stored as SAFE redacted text, never raw. The other plan fields are template-derived
			// constants (no operator/agent free text), so they need no screen.
			const writerRedactions: ScaffoldRedaction[] = [];
			const purpose = screenWriterText(
				description.trim() || `${template.name} project: ${template.description}`,
				'planMacro.purpose',
				writerRedactions
			);
			await updateProjectPlan(db, projectId, {
				purpose,
				long_term_vision: `Grow ${name} from the ${template.name} scaffold into a maintained ${template.language || 'project'}.`,
				role: 'Maintainer',
				definition_of_done:
					`The ${template.name} scaffold builds, its tests pass, and the founding work is complete.`
			});
			if (writerRedactions.length > 0) {
				const detail = writerRedactions.map((r) => `${r.path}: [${r.reasons.join(', ')}]`).join('; ');
				await recordIncident(
					db,
					`Create plan redactions: ${projectId}`,
					`Project ${projectId} stored ${writerRedactions.length} plan free-text field(s) redacted ` +
						`in place (D-026 — safe redacted text persisted, no raw secret; not an error). ${detail}`,
					'info'
				).catch(() => undefined);
			}

			// CAPABILITY NEEDS — mapped from the template's declared language + tags (where they map to
			// the workforce vocabulary). languages/frameworks are free text (screened at setCapabilityNeeds);
			// defect_classes is enum-closed there, so we send NONE (the template carries no defect classes —
			// sending an unvalidated guess would fail the enum gate, F-008: honest absence over a fabrication).
			const languages = template.language?.trim() ? [template.language.trim().toLowerCase()] : [];
			const frameworks = capabilityFrameworksFromTemplate(template);
			if (languages.length || frameworks.length) {
				await setCapabilityNeeds(db, projectId, { languages, frameworks, defect_classes: [] });
			}

			// FOUNDING TASKS — only when the template provides any (the current registry does not, so
			// this is honestly empty; DEFERRED: a template-authored founding-task list is a future CT-1
			// field, written down here rather than fabricated now). No fake tasks invented (F-008).
			const taskIds: string[] = [];
			for (const t of templateFoundingTasks(template)) {
				const task = await createTask(db, {
					project: projectId,
					title: t.objective,
					description: t.objective,
					objective: t.objective,
					purpose: t.purpose,
					origin: 'pm',
					status: taskStatus
				});
				taskIds.push(task.id);
			}

			// TARGETS — the template carries no deploy/publish targets (the operator adds them post-create,
			// D-037 + the operator gate). Honestly empty (F-008), never a fabricated default target.
			const targetIds: string[] = [];

			// HAND-OFF — hire the PM with a charter derived from the template + brief (fork 3).
			let pm: HirePmResult | undefined;
			if (opts.pm) {
				const charter =
					`Own the ${name} roadmap. ${description.trim() || template.description}`.trim();
				pm = await hirePm(db, {
					project: projectId,
					name: opts.pm.name,
					charter,
					...(opts.pm.persona ? { persona: opts.pm.persona } : {}),
					answers: opts.pm.answers ?? []
				});
			}

			return { taskIds, targetIds, pm };
		}
	});
}

// ── Template → metadata mappers (pure; F-008 honest) ──────────────────────────────────

/**
 * Map a template's tags to capability FRAMEWORK strings the workforce matcher understands. Only the
 * tags that genuinely name a framework/runtime are kept (honest, F-008 — an unmapped tag yields no
 * framework, never a fabricated one). Free text → screened at the setCapabilityNeeds boundary.
 */
function capabilityFrameworksFromTemplate(template: ProjectTemplate): string[] {
	const KNOWN_FRAMEWORK_TAGS = new Set([
		'sveltekit',
		'nextjs',
		'fastapi',
		'react',
		'unity',
		'fabric',
		'forge',
		'paper',
		'bepinex',
		'minecraft'
	]);
	const tags = (template.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
	return Array.from(new Set(tags.filter((t) => KNOWN_FRAMEWORK_TAGS.has(t))));
}

/**
 * The template's founding-task drafts, when it declares any. The current CT-1 registry templates do
 * NOT carry founding tasks, so this is honestly empty (F-008 — no fabricated tasks). Kept as a pure
 * seam so a future CT-1 `foundingTasks` field flows through the same post-register writer.
 */
function templateFoundingTasks(
	template: ProjectTemplate
): ReadonlyArray<{ objective: string; purpose: string }> {
	void template; // reserved seam — a future CT-1 `foundingTasks` field flows through here.
	return [];
}

// ── The shared scaffold/register/wire pipeline (CA-2 / CT-3) ───────────────────────────

/** What a post-register writer returns to the shared pipeline (the rows it created). */
interface PostRegisterOutcome {
	taskIds: string[];
	targetIds: string[];
	pm?: HirePmResult;
}

/** The per-path inputs the shared pipeline needs (the file-map + the post-register writer callback). */
interface ScaffoldPipelineInput {
	/** The operator's project name — the slug source + commit-identity context. */
	briefName: string;
	/** The REAL relative-path → content file-map to materialize (AI stubs OR template content). */
	fileMap: Record<string, string>;
	/** True ⇒ founding tasks born 'proposed' (a PM is requested) — fork 3. */
	wantPm: boolean;
	/** The confinement root (CODE_ROOT). */
	codeRoot: string;
	/** Injectable command runner (test seam) — defaults to execFileRunner. */
	run?: CommandRunner;
	/**
	 * The path-specific post-register writers. Receives the registered project id + the decided task
	 * status; returns the rows it created. A throw here surfaces as PostRegisterWriterError (the
	 * project survives, marked create_status='incomplete' — CA-H2).
	 */
	postRegister(projectId: string, taskStatus: TaskStatus): Promise<PostRegisterOutcome>;
}

/**
 * The SINGLE scaffold → git → register → wire pipeline shared by executeCreation (AI path) and
 * executeTemplateCreation (template path). It owns every cross-cutting rail so neither caller forks
 * the machinery: slug + stability gate (UnstableSlugError), existence fail-closed (ProjectExistsError),
 * the slug-keyed create-lock (ConcurrentCreateError / F-040), confineToRoot project root (D-018),
 * the ownership-gated scaffold write (writeFileMap — ScaffoldPathError / ScaffoldSecretError per
 * entry), git init + first commit, the mid-scaffold incident + rollback (ScaffoldFailedError, NO
 * phantom row), scanProject ingest (F-008 — row from DISK), the slug-divergence guard, and the
 * post-register honesty (PostRegisterWriterError + create_status, never a silent half-state). The
 * caller supplies ONLY the file-map + the post-register writers.
 */
async function scaffoldRegisterAndWire(
	db: Db,
	input: ScaffoldPipelineInput
): Promise<ExecuteCreationResult> {
	const run = input.run ?? execFileRunner;

	// ── GATE — D-016 slug-validate + stability (before any disk touch). ──
	const slug = slugify(input.briefName);
	// SLUG STABILITY (D-016 / F-008): slugify is NOT idempotent for degenerate symbol-only names
	// ('!!!','__','??? ' → 'p_', re-slugifying 'p_' → 'p'). The scaffold dir is named `slug` and
	// scanProject RE-DERIVES the registered slug from that dir basename — so unless slugify(slug) ===
	// slug, the gate-id and registered-id DIVERGE (wedging the existence gate → an F-008 phantom that
	// rm -rf's a live dir on the next degenerate create). Fail CLOSED here so gate-id, dir-basename,
	// and registered-id are guaranteed to be ONE source.
	const reSlug = slugify(slug);
	if (reSlug !== slug) throw new UnstableSlugError(input.briefName, slug, reSlug);
	const projectId = assertRecordIdOfTable(`project:${slug}`, 'project'); // D-016 — named on failure.

	// Fail closed on an existing project (idempotent same-slug re-create). First half of the existence
	// guard; the create-lock below closes its TOCTOU window (CA-H2 / F-040).
	const existing = await getProject(db, projectId);
	if (existing) throw new ProjectExistsError(projectId);

	// ── CREATE-LOCK (CA-H2 / F-040 TOCTOU guard) — slug-keyed lock with a FAIL-CLOSED CREATE. ──
	// Two parallel same-slug creates can BOTH pass the getProject null-gate (TOCTOU); the lock's CREATE
	// errors for all but ONE → the losers throw ConcurrentCreateError HERE, before any disk touch, so a
	// loser can never rm -rf the winner's live scaffold. RELEASED in `finally` on every exit. The nonce
	// makes the release owner-scoped (a release only deletes a lock THIS run acquired).
	const lockNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	await acquireCreateLock(db, slug, lockNonce);

	try {
		// The scaffold root, confined under CODE_ROOT (D-018). The slug is snake-case (no separators) so
		// the join cannot escape; confineToRoot canonicalizes the root (symlink-stable) for defense in depth.
		const realRoot = confineToRoot(input.codeRoot, input.codeRoot);
		const projectRoot = join(realRoot, slug);

		// OWNERSHIP GATE (CA-H2 / F-040): we may ONLY rm -rf a dir THIS run created. If the dir pre-existed
		// (a leftover from another run/operator), we NEVER delete it on cleanup — that is the exact
		// corruption F-040 forbids (the loser never rm's the winner's live scaffold).
		let weCreatedRoot = false;

		// ── SCAFFOLD — write tree, git init + first commit. Partial death → cleanup + incident. ──
		let commitSha: string | undefined;
		let scaffoldRedactions: ScaffoldRedaction[] = [];
		let scaffoldWrittenFiles: WrittenFile[] = [];
		try {
			const rootExistedBefore = await pathExists(projectRoot);
			await mkdir(projectRoot, { recursive: true });
			weCreatedRoot = !rootExistedBefore;
			const writeRes = await writeFileMap(projectRoot, input.fileMap);
			scaffoldRedactions = writeRes.redactions;
			scaffoldWrittenFiles = writeRes.writtenFiles;

			// git init + first commit via the execFile-ARRAY runner (D-008/F-002 — never a shell).
			const initRes = await run('git', ['init'], { cwd: projectRoot });
			if (initRes.code !== 0) {
				throw new Error(`git init failed (code ${initRes.code}): ${initRes.stderr.slice(0, 200)}`);
			}
			await run('git', ['add', '-A'], { cwd: projectRoot });
			const commitMsg = `chore: scaffold ${slug} via Atelier Create-with-AI`;
			// Inline identity (-c) so the first commit succeeds even with no global/local git identity
			// configured (CI / a fresh repo). Scoped to THIS commit invocation only.
			const committed = await run(
				'git',
				['-c', 'user.name=Atelier', '-c', 'user.email=atelier@local', 'commit', '-m', commitMsg],
				{ cwd: projectRoot }
			);
			if (committed.code !== 0) {
				throw new Error(
					`first commit failed (code ${committed.code}): ${(committed.stderr || committed.stdout).slice(0, 200)}`
				);
			}
			const rev = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot });
			commitSha = rev.code === 0 ? rev.stdout.trim() : undefined;
		} catch (err) {
			// Interrupt contract / F-008: remove the partial dir so a re-run starts clean, register NO
			// phantom row. Clean up ONLY a dir THIS run created (ownership gate, CA-H2). Then re-throw:
			//   • a REJECTED INPUT (path escape D-018 / secret echo D-026) is the caller's bug, not a
			//     partial scaffold — re-throw the SPECIFIC named error verbatim, no incident;
			//   • an IO / git failure IS a partial scaffold — log an incident (NEVER silent) + wrap as
			//     ScaffoldFailedError (named) so the operator sees an honest failure, not a phantom row.
			if (weCreatedRoot) await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
			if (err instanceof ScaffoldPathError || err instanceof ScaffoldSecretError) {
				throw err;
			}
			const incidentId = await recordIncident(
				db,
				`Create scaffold failed: ${slug}`,
				`Scaffold/commit failed for project:${slug} at ${projectRoot}. ${(err as Error).message}`
			);
			throw new ScaffoldFailedError(
				`scaffold failed for ${slug} — no project registered (incident logged). ${(err as Error).message}`,
				incidentId
			);
		}

		// ── REGISTER HONESTLY — scanProject ingests the REAL on-disk scaffold (F-008). ──
		// The row derives from disk (detected ecosystem/build tool), NEVER the input text.
		const row = await scanProject(db, projectRoot, { codeRoot: input.codeRoot });

		// Defense in depth (D-016 / F-008): the gate's slug-stability guard guarantees the registered id
		// equals the gate id, but assert it explicitly so any future slugify drift fails CLOSED here.
		if (row.id !== projectId) {
			await db.query(`DELETE ${assertRecordIdOfTable(row.id, 'project')};`).catch(() => {});
			if (weCreatedRoot) await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
			const incidentId = await recordIncident(
				db,
				`Create slug divergence: ${slug}`,
				`Gate id ${projectId} but scanProject registered ${row.id} for ${projectRoot}. ` +
					`Removed the row + scaffold to avoid an unfindable phantom (D-016/F-008).`
			);
			throw new ScaffoldFailedError(
				`registered id ${row.id} diverged from gate id ${projectId} — scaffold removed (incident logged).`,
				incidentId
			);
		}

		// ── HONEST REDACTION NOTE (D-026 / F-008) — if any scaffold file had a redactable span, the
		// SAFE redacted text was written (never aborted, never raw). Record an honest, non-fatal note
		// (count + per-file reasons) so the redaction is visible, never silent. Best-effort: a note
		// failure must not fail an otherwise-successful create.
		if (scaffoldRedactions.length > 0) {
			const detail = scaffoldRedactions
				.map((r) => `${r.path}: [${r.reasons.join(', ')}]`)
				.join('; ');
			await recordIncident(
				db,
				`Create scaffold redactions: ${slug}`,
				`Project ${row.id} scaffolded with ${scaffoldRedactions.length} file(s) redacted in place ` +
					`(D-026 — safe redacted text written, no raw secret; not an error). ${detail}`,
				'info'
			).catch(() => undefined);
		}

		// ── FS-2 (a) SCAFFOLD CAPTURE — each generated file → a file_snapshot, linked from the new
		// project (FILE-SNAPSHOT-SPEC §3 a). So a freshly-created project's files are readable in-app
		// immediately. The content is the SAFE text writeFileMap already screened+wrote (no double-
		// screen of the raw, no disk re-read); captureSnapshot re-screens cheaply for D-026 belt-and-
		// braces + content-addresses it (dedup). BEST-EFFORT (captureSnapshotSafe never throws): a
		// capture failure must NEVER fail an otherwise-successful create (additive, F-008/F-014). Runs
		// AFTER register so the project row exists for the captured_by link.
		for (const wf of scaffoldWrittenFiles) {
			await captureSnapshotSafe(db, {
				path: wf.rel,
				content: wf.content,
				capturedBy: row.id, // linked from the new project (project:<slug>).
				project: row.id
			});
		}

		// ── POST-REGISTER WRITERS (CA-H2) — path-specific, via the caller's callback. ──
		// The project row + scaffold are now REAL and committed. A throw in the writer CANNOT unregister
		// the project (the on-disk scaffold + commit are durable; unwinding the row would rm -rf a live
		// dir — the exact corruption CA-H2 forbids). On a post-register throw we MARK the project honestly
		// (create_status='incomplete'), log an incident (NEVER silent, F-008), and surface a NAMED
		// PostRegisterWriterError — a real, clearly-marked, NON-wedged project.
		const existingPm = await getPm(db, row.id);
		const taskStatus: TaskStatus = input.wantPm || existingPm ? 'proposed' : 'ready';
		let outcome: PostRegisterOutcome;
		try {
			outcome = await input.postRegister(row.id, taskStatus);
		} catch (err) {
			await setCreateStatus(db, row.id, 'incomplete').catch(() => {});
			const incidentId = await recordIncident(
				db,
				`Create setup incomplete: ${slug}`,
				`Project ${row.id} registered + scaffolded at ${projectRoot} but a post-register writer ` +
					`threw; marked create_status=incomplete (not wedged, not a phantom). ${(err as Error).message}`
			);
			throw new PostRegisterWriterError(row.id, (err as Error).message, incidentId);
		}

		// ── MARK COMPLETE (CA-H2) — all writers succeeded; the project is fully, honestly wired. ──
		await setCreateStatus(db, row.id, 'complete');

		return {
			projectId: row.id,
			rootPath: row.root_path,
			taskIds: outcome.taskIds,
			taskStatus,
			targetIds: outcome.targetIds,
			...(outcome.pm ? { pm: outcome.pm } : {}),
			...(commitSha ? { commitSha } : {})
		};
	} finally {
		// Release the create-lock on EVERY exit (success or throw) so the slug is never wedged. Owner-
		// scoped (nonce) + best-effort — a release failure must not mask the result we are returning.
		await releaseCreateLock(db, slug, lockNonce);
	}
}
