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

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
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

// ── The executor (CA-2 entry point) ──────────────────────────────────────────────────

/**
 * Execute a confirmed creation proposal (CREATE-SPEC §2.4-2.5). The `envelope` is the EXACT one
 * CA-1 returned (brief + proposal + confirmToken); the token is re-validated here (D-010) so a
 * proposal edited after confirm is rejected (StaleProposalError from assertProposalFresh).
 *
 * Returns the new project id + the rows it created. Throws (NAMED) and registers NO phantom row on:
 *   • a stale token (StaleProposalError) — gate, before any disk touch;
 *   • an existing slug (ProjectExistsError) — idempotent fail-closed;
 *   • a path escape (ScaffoldPathError) / secret echo (ScaffoldSecretError) — before commit;
 *   • a mid-scaffold death (ScaffoldFailedError) — the partial dir is removed + an incident logged.
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
	const projectId = assertRecordIdOfTable(`project:${slug}`, 'project'); // D-016 — named on failure.

	// Fail closed on an existing project (idempotent same-slug re-create — §2.4 (1)).
	const existing = await getProject(db, projectId);
	if (existing) throw new ProjectExistsError(projectId);

	// The scaffold root, confined under CODE_ROOT (D-018). resolve under codeRoot; the dir does not
	// exist yet, so confineToRoot is applied to the CODE_ROOT itself + we join the slug (a slug is
	// snake-case, no separators — it cannot escape). Re-confine the final root for defense in depth.
	const realRoot = confineToRoot(opts.codeRoot, opts.codeRoot); // canonical, symlink-stable root.
	const projectRoot = join(realRoot, slug);

	// ── 2. SCAFFOLD — write tree, git init + first commit. Partial death → cleanup + incident. ──
	let commitSha: string | undefined;
	try {
		await mkdir(projectRoot, { recursive: true });
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
		// phantom row. ALWAYS clean up; then decide what to re-throw:
		//   • a REJECTED INPUT (path escape D-018 / secret echo D-026) is the caller's bug, not a
		//     partial scaffold — re-throw the SPECIFIC named error verbatim, no incident;
		//   • an IO / git failure IS a partial scaffold — log an incident (NEVER silent) and wrap as
		//     ScaffoldFailedError (named) so the operator sees an honest failure, not a phantom row.
		await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
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

	// ── 4. WRITERS — plan macro · capability needs · founding tasks · targets. ──
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
	// D-039 panel; otherwise born 'ready'. We check the persisted PM AFTER deciding the hand-off so a
	// requested PM (created in step 5) still gets 'proposed' tasks here.
	const wantPm = opts.pm !== undefined;
	const existingPm = await getPm(db, row.id);
	const taskStatus: TaskStatus = wantPm || existingPm ? 'proposed' : 'ready';

	const taskIds: string[] = [];
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

	const targetIds: string[] = [];
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
	let pm: HirePmResult | undefined;
	if (opts.pm) {
		pm = await hirePm(db, {
			project: row.id,
			name: opts.pm.name,
			...(proposal.pmCharterDraft ? { charter: proposal.pmCharterDraft } : {}),
			...(opts.pm.persona ? { persona: opts.pm.persona } : {}),
			answers: opts.pm.answers ?? []
		});
	}

	return {
		projectId: row.id,
		rootPath: row.root_path,
		taskIds,
		taskStatus,
		targetIds,
		...(pm ? { pm } : {}),
		...(commitSha ? { commitSha } : {})
	};
}
