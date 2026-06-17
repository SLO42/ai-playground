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
import { execFileRunner, type CommandRunner } from '../orchestrator/post-task';
import {
	assertProposalFresh,
	type CreationProposalEnvelope,
	type CreationProposal
} from './plan';

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

/** A scaffold file's CONTENT echoed a literal secret (D-026 — env NAMES only). */
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

/**
 * Write the scaffold tree under `projectRoot` (already created + confined), screening every file's
 * content (D-026) before write. Always writes a .gitignore (covers .env) + README.md so commit 0 is
 * honest even if the proposal omitted them. Returns the list of relative file paths written.
 *
 * Atomic-ish (interrupt contract): each dir is mkdir-recursive (idempotent); each file is written
 * with writeFile (last-writer-wins on a re-run). The CALLER removes a partial dir on failure so a
 * re-run starts clean — there is never an observable half-scaffold registered (F-008 / interrupt).
 */
async function writeScaffold(
	projectRoot: string,
	proposal: CreationProposal,
	projectName: string
): Promise<string[]> {
	// Always-present commit-0 files (deduped against the proposal's own entries below).
	const required = ['.gitignore', 'README.md'];
	const entries: ResolvedEntry[] = [];
	const seen = new Set<string>();
	for (const e of [...proposal.dirLayout, ...required]) {
		const resolved = resolveEntry(e, projectRoot);
		const key = process.platform === 'win32' ? resolved.abs.toLowerCase() : resolved.abs;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push(resolved);
	}

	const written: string[] = [];
	for (const ent of entries) {
		if (ent.kind === 'dir') {
			await mkdir(ent.abs, { recursive: true });
			continue;
		}
		await mkdir(dirname(ent.abs), { recursive: true });
		const content = seedContent(ent.rel, proposal, projectName);
		// D-026: a literal secret must NEVER be written. screen() flags it; fail closed (named).
		const res = screen(content);
		if (res.status !== 'clean') {
			throw new ScaffoldSecretError(
				`scaffold file '${ent.rel}' would write a literal secret (D-026): [${res.reasons.join(', ')}]`,
				ent.rel
			);
		}
		await writeFile(ent.abs, content, 'utf8');
		written.push(ent.rel);
	}
	return written;
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

/** Record a global `incident` row (F-008 — a partial scaffold is NEVER silent). Best-effort. */
async function recordIncident(db: Db, title: string, detail: string): Promise<string | undefined> {
	try {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE incident CONTENT { title: $title, detail: $detail, severity: $severity } RETURN AFTER;`,
			{ title, detail: detail.slice(0, 4000), severity: 'error' }
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
	const run = opts.run ?? execFileRunner;

	// ── 1. GATE — D-010 token re-check, then D-016 slug-validate the target id. ──
	assertProposalFresh(brief, proposal, confirmToken);

	const slug = slugify(brief.name);
	// SLUG STABILITY (D-016 / F-008): slugify is NOT idempotent for degenerate symbol-only names
	// ('!!!','__','??? ' → 'p_', but re-slugifying 'p_' → 'p'). The scaffold dir is named `slug`
	// (below) and scanProject (step 3) RE-DERIVES the registered slug from that dir basename via
	// slugify — so unless slugify(slug) === slug, the gate-id (`project:${slug}`) and the
	// registered-id (`project:${slugify(slug)}`) DIVERGE. That divergence wedges the existence gate
	// (a second same-name create checks the wrong id, never fails closed, re-enters the existing
	// scaffold, and its failed first commit rm -rf's the live project's dir → F-008 phantom row
	// pointing at a deleted dir). Fail CLOSED here, before any disk touch, so gate-id, dir-basename,
	// and registered-id are guaranteed to be ONE source.
	const reSlug = slugify(slug);
	if (reSlug !== slug) throw new UnstableSlugError(brief.name, slug, reSlug);
	const projectId = assertRecordIdOfTable(`project:${slug}`, 'project'); // D-016 — named on failure.

	// Fail closed on an existing project (idempotent same-slug re-create — §2.4 (1)). This is the
	// FIRST half of the existence guard; the create-lock below closes its TOCTOU window (CA-H2).
	const existing = await getProject(db, projectId);
	if (existing) throw new ProjectExistsError(projectId);

	// ── 1b. CREATE-LOCK (CA-H2 TOCTOU guard) — acquire a slug-keyed lock with a FAIL-CLOSED CREATE. ──
	// Two parallel same-slug creates can BOTH pass the getProject null-gate above (TOCTOU); the lock's
	// `CREATE create_lock:<slug>` errors for all but ONE (SurrealDB does not last-writer-win on CREATE)
	// → the losers throw ConcurrentCreateError HERE, before any disk touch, so a loser can never
	// rm -rf the winner's live scaffold. The lock is RELEASED in `finally` on every exit path. The
	// nonce makes the release owner-scoped (a release can only delete a lock THIS run acquired).
	const lockNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	await acquireCreateLock(db, slug, lockNonce);

	try {
		// The scaffold root, confined under CODE_ROOT (D-018). resolve under codeRoot; the dir does not
		// exist yet, so confineToRoot is applied to the CODE_ROOT itself + we join the slug (a slug is
		// snake-case, no separators — it cannot escape). Re-confine the final root for defense in depth.
		const realRoot = confineToRoot(opts.codeRoot, opts.codeRoot); // canonical, symlink-stable root.
		const projectRoot = join(realRoot, slug);

		// OWNERSHIP GATE (CA-H2): we may ONLY rm -rf a scaffold dir THIS run created. Record whether the
		// dir existed BEFORE our mkdir; if it pre-existed (e.g. a leftover from another run/operator), we
		// NEVER delete it on cleanup — deleting someone else's live scaffold is the exact corruption
		// CA-H2 forbids. With the create-lock held this is belt-and-suspenders, but it is the durable
		// invariant: cleanup is gated on ownership, not just on the lock.
		let weCreatedRoot = false;

		// ── 2. SCAFFOLD — write tree, git init + first commit. Partial death → cleanup + incident. ──
		let commitSha: string | undefined;
		try {
			const rootExistedBefore = await pathExists(projectRoot);
			await mkdir(projectRoot, { recursive: true });
			weCreatedRoot = !rootExistedBefore;
			await writeScaffold(projectRoot, proposal, brief.name.trim());

			// git init + first commit via the execFile-ARRAY runner (D-008/F-002 — never a shell).
			const initRes = await run('git', ['init'], { cwd: projectRoot });
			if (initRes.code !== 0) {
				throw new Error(`git init failed (code ${initRes.code}): ${initRes.stderr.slice(0, 200)}`);
			}
			await run('git', ['add', '-A'], { cwd: projectRoot });
			const commitMsg = `chore: scaffold ${slug} via Atelier Create-with-AI`;
			// Inline identity (-c) so the first commit succeeds even when no global/local git identity is
			// configured (CI / a fresh repo). These are scoped to THIS commit invocation only.
			const committed = await run(
				'git',
				[
					'-c',
					'user.name=Atelier',
					'-c',
					'user.email=atelier@local',
					'commit',
					'-m',
					commitMsg
				],
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
			// phantom row. Clean up ONLY a dir THIS run created (ownership gate, CA-H2) — never another
			// run's live scaffold. Then decide what to re-throw:
			//   • a REJECTED INPUT (path escape D-018 / secret echo D-026) is the caller's bug, not a
			//     partial scaffold — re-throw the SPECIFIC named error verbatim, no incident;
			//   • an IO / git failure IS a partial scaffold — log an incident (NEVER silent) and wrap as
			//     ScaffoldFailedError (named) so the operator sees an honest failure, not a phantom row.
			if (weCreatedRoot) await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
			if (err instanceof ScaffoldPathError || err instanceof ScaffoldSecretError) {
				throw err;
			}
			const incidentId = await recordIncident(
				db,
				`Create-with-AI scaffold failed: ${slug}`,
				`Scaffold/commit failed for project:${slug} at ${projectRoot}. ${(err as Error).message}`
			);
			throw new ScaffoldFailedError(
				`scaffold failed for ${slug} — no project registered (incident logged). ${(err as Error).message}`,
				incidentId
			);
		}

		// ── 3. REGISTER HONESTLY — scanProject ingests the REAL on-disk scaffold (F-008). ──
		// The row derives from disk (detected ecosystem/build tool), NEVER the proposal text.
		const row = await scanProject(db, projectRoot, { codeRoot: opts.codeRoot });

		// Defense in depth (D-016 / F-008): the gate's slug-stability guard guarantees the registered id
		// equals the gate id, but assert it explicitly so any future slugify drift fails CLOSED here
		// (clean up the scaffold + log an incident) instead of silently registering a row the existence
		// gate can never find again. row.id is the single source the writers below all use.
		if (row.id !== projectId) {
			// Unreachable while the gate guard holds; if it ever fires, scanProject already UPSERTed a row
			// at the diverged id — delete that row AND the scaffold dir so no phantom survives (F-008),
			// then log an incident and fail closed. The id is validated through the D-016 chokepoint
			// before interpolation. Cleanup is still ownership-gated (CA-H2).
			await db
				.query(`DELETE ${assertRecordIdOfTable(row.id, 'project')};`)
				.catch(() => {});
			if (weCreatedRoot) await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
			const incidentId = await recordIncident(
				db,
				`Create-with-AI slug divergence: ${slug}`,
				`Gate id ${projectId} but scanProject registered ${row.id} for ${projectRoot}. ` +
					`Removed the row + scaffold to avoid an unfindable phantom (D-016/F-008).`
			);
			throw new ScaffoldFailedError(
				`registered id ${row.id} diverged from gate id ${projectId} — scaffold removed (incident logged).`,
				incidentId
			);
		}

		// ── 4-5. POST-REGISTER WRITERS (CA-H2) — plan · needs · tasks · targets · PM. ──
		// The project row + scaffold are now REAL and committed. A throw in ANY writer below CANNOT
		// unregister the project (the on-disk scaffold + commit are durable, and unwinding the row would
		// rm -rf a live dir — the exact corruption CA-H2 forbids). So on a post-register throw we do NOT
		// delete anything: we MARK the project honestly (`create_status='incomplete'`), log an incident
		// (NEVER silent, F-008), and surface a NAMED PostRegisterWriterError. The result is a real,
		// clearly-marked, NON-wedged project — not a silent half-built phantom, not a wedged slug.
		let taskIds: string[];
		let taskStatus: TaskStatus;
		let targetIds: string[];
		let pm: HirePmResult | undefined;
		try {
			await updateProjectPlan(db, row.id, {
				purpose: proposal.planMacro.purpose,
				long_term_vision: proposal.planMacro.vision,
				role: proposal.planMacro.role,
				definition_of_done: proposal.planMacro.definition_of_done
			});

			// Capability needs (defect_classes were enum-validated by CA-1; setCapabilityNeeds re-validates
			// + screens at its own boundary — the canonical chokepoint, D-026).
			const needs = proposal.capabilityNeeds;
			if (needs.languages.length || needs.frameworks.length || needs.defect_classes.length) {
				await setCapabilityNeeds(db, row.id, {
					languages: needs.languages,
					frameworks: needs.frameworks,
					defect_classes: needs.defect_classes
				});
			}

			// PM-presence fork (fork 3): a PM requested OR already present ⇒ tasks born 'proposed' for the
			// D-039 panel; otherwise born 'ready'. We check the persisted PM AFTER deciding the hand-off so
			// a requested PM (created in step 5) still gets 'proposed' tasks here.
			const wantPm = opts.pm !== undefined;
			const existingPm = await getPm(db, row.id);
			taskStatus = wantPm || existingPm ? 'proposed' : 'ready';

			taskIds = [];
			for (const t of proposal.foundingTasks) {
				const task = await createTask(db, {
					project: row.id,
					title: t.objective,
					// D-008: the description is the founding objective verbatim; purpose rides the field.
					description: t.objective,
					objective: t.objective,
					purpose: t.purpose,
					origin: 'pm',
					status: taskStatus
				});
				taskIds.push(task.id);
			}

			targetIds = [];
			for (const tg of proposal.targetDrafts) {
				const target = await declareTarget(db, {
					project: row.id,
					kind: tg.kind,
					adapterId: tg.adapterId,
					config: tg.config // env-NAMES only — declareTarget binds it as a $param blob (D-026).
				});
				targetIds.push(target.id);
			}

			// ── 5. HAND-OFF — hire the PM with the charter pre-filled from the proposal (fork 3). ──
			if (opts.pm) {
				pm = await hirePm(db, {
					project: row.id,
					name: opts.pm.name,
					...(proposal.pmCharterDraft ? { charter: proposal.pmCharterDraft } : {}),
					...(opts.pm.persona ? { persona: opts.pm.persona } : {}),
					answers: opts.pm.answers ?? []
				});
			}
		} catch (err) {
			// POST-REGISTER FAILURE (CA-H2): mark honestly, log an incident, surface a NAMED error.
			// Best-effort marking — if the marking write itself fails, the incident still records the
			// honest failure (we never silently report success).
			await setCreateStatus(db, row.id, 'incomplete').catch(() => {});
			const incidentId = await recordIncident(
				db,
				`Create-with-AI setup incomplete: ${slug}`,
				`Project ${row.id} registered + scaffolded at ${projectRoot} but a post-register writer ` +
					`threw; marked create_status=incomplete (not wedged, not a phantom). ${(err as Error).message}`
			);
			throw new PostRegisterWriterError(row.id, (err as Error).message, incidentId);
		}

		// ── 6. MARK COMPLETE (CA-H2) — all writers succeeded; the project is fully, honestly wired. ──
		await setCreateStatus(db, row.id, 'complete');

		return {
			projectId: row.id,
			rootPath: row.root_path,
			taskIds,
			taskStatus,
			targetIds,
			...(pm ? { pm } : {}),
			...(commitSha ? { commitSha } : {})
		};
	} finally {
		// Release the create-lock on EVERY exit (success or throw) so the slug is never wedged. Owner-
		// scoped (nonce) + best-effort — a release failure must not mask the result we are returning.
		await releaseCreateLock(db, slug, lockNonce);
	}
}
