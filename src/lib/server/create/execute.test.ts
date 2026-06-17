import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createRole, createGauntletFixture, createGauntletKey } from '../workforce/repo';
import { newSentinelUlid } from '../workforce/activation';
import { getProject } from '../projects/repo';
import { listTasksByProject } from '../tasks/repo';
import { listTargets } from '../adapters/registry';
import { getCapabilityNeeds } from '../workforce/capability-match';
import { getPm } from '../projects/pm-repo';
import {
	generateCreationProposal,
	type CreateBrief,
	type ProposalGenerator,
	StaleProposalError
} from './plan';
import {
	executeCreation,
	ProjectExistsError,
	UnstableSlugError,
	ScaffoldPathError,
	ScaffoldSecretError,
	ScaffoldFailedError,
	type ExecuteCreationOptions
} from './execute';
import { slugify } from '../scanner/detect';
import type { CommandRunner } from '../orchestrator/post-task';

// CA-2 (CREATE-SPEC §2.4-2.5, §3 rails) — the EXECUTE half. Run vs a REAL throwaway SurrealDB +
// a REAL temp CODE_ROOT (real git init / real scaffold / real scanProject ingest — NO agent spend:
// the proposal comes from generateCreationProposal with a STUBBED generator). Covers the happy
// path (PM + no-PM), the honest partial-failure path, idempotent same-slug fail-closed, and the
// red-team invariants (D-018 path escape, D-026 secret-in-content, F-008 row-reflects-disk).

let tdb: TestDb;
let db: Db;
let codeRoot: string;

async function seedDefectClass(cls: string): Promise<void> {
	const role = await createRole(db, { slug: `ca2-${cls}`, name: `Role ${cls}`, purpose: 'CA-2 vocab seed' });
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: `ca2-fx-${cls}`,
		kind: 'planted_defect',
		work: { 'a.ts': 'l1\nl2\nx();\n' },
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		author: 'operator',
		plants: [{ id: 'p1', class: cls, detection: { file: 'a.ts', lines: [3, 3] } }]
	});
}

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	await seedDefectClass('null-deref');
	// A REAL temp CODE_ROOT. realpath so the confinement compare (symlink-stable) matches on macOS
	// /var → /private/var and Windows short-name resolution.
	codeRoot = realpathSync(await mkdtemp(join(tmpdir(), 'ca2-root-')));
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (codeRoot) await rm(codeRoot, { recursive: true, force: true }).catch(() => {});
});

const stubGen = (raw: unknown): ProposalGenerator => async () => raw;

/** A well-formed raw proposal (the agent's structured output) for a unique-named project. */
function goodRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dirLayout: ['src/', 'src/index.ts', 'tests/', 'package.json'],
		stack: ['TypeScript', 'Node'],
		planMacro: {
			purpose: 'A small CLI that prints the survival difficulty curve.',
			vision: 'A tool reached for when tuning a run.',
			role: 'Solo maintainer with periodic playtests.',
			definition_of_done: 'CLI runs, curve is configurable, no crash across 10 inputs.'
		},
		foundingTasks: [
			{ objective: 'Scaffold the CLI entry point', purpose: 'Nothing runs until the entry exists.' },
			{ objective: 'Implement the curve', purpose: 'The curve is the whole point of the tool.' },
			{ objective: 'Add a config surface', purpose: 'Users tune without code edits.' }
		],
		targetDrafts: [
			{ kind: 'publish', adapterId: 'npm', config: { tokenEnv: 'NPM_TOKEN' } }
		],
		capabilityNeeds: { languages: ['typescript'], frameworks: [], defect_classes: ['null-deref'] },
		pmCharterDraft: 'Own the difficulty-curve roadmap; ship a configurable v1.',
		clarifiers: [],
		...over
	};
}

async function makeEnvelope(name: string, over: Record<string, unknown> = {}) {
	const brief: CreateBrief = { name, description: `${name} — a generated CLI.` };
	return generateCreationProposal(db, brief, stubGen(goodRaw(over)));
}

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

describe('executeCreation — happy path (PM requested, fork 3)', () => {
	it('scaffolds real files, git-commits, ingests from DISK, writes plan/needs/tasks/targets, hires PM', async () => {
		const env = await makeEnvelope('ca2 happy pm');
		const res = await executeCreation(db, env, {
			codeRoot,
			pm: { name: 'Ada', answers: [] }
		});

		expect(res.projectId).toBe('project:ca2_happy_pm');
		expect(res.taskStatus).toBe('proposed'); // PM requested → tasks born proposed (D-039 panel).
		expect(res.taskIds.length).toBe(3);
		expect(res.targetIds.length).toBe(1);
		expect(res.commitSha).toBeTruthy();

		// Real scaffold on disk under CODE_ROOT/<slug>.
		const root = join(codeRoot, 'ca2_happy_pm');
		expect(await exists(join(root, 'src', 'index.ts'))).toBe(true);
		expect(await exists(join(root, 'package.json'))).toBe(true);
		expect(await exists(join(root, '.gitignore'))).toBe(true);
		expect(await exists(join(root, 'README.md'))).toBe(true);
		expect(await exists(join(root, '.git'))).toBe(true);
		// .gitignore covers .env from commit 0 (D-026).
		const gi = await readFile(join(root, '.gitignore'), 'utf8');
		expect(gi).toMatch(/^\.env$/m);

		// F-008: the registered row reflects DISK (ecosystem detected from the real scaffold), and the
		// root_path is the on-disk root, not a proposal echo.
		const row = await getProject(db, res.projectId);
		expect(row).not.toBeNull();
		expect(row!.root_path).toBe(realpathSync(root));
		expect(row!.plan?.purpose).toBe('A small CLI that prints the survival difficulty curve.');

		// Founding tasks born 'proposed', origin 'pm', objective+purpose set (D-039).
		const tasks = await listTasksByProject(db, res.projectId);
		expect(tasks.length).toBe(3);
		for (const t of tasks) {
			expect(t.status).toBe('proposed');
			expect(t.origin).toBe('pm');
			expect(t.objective).toBeTruthy();
			expect(t.purpose).toBeTruthy();
		}

		// Targets declared.
		const targets = await listTargets(db, res.projectId);
		expect(targets.length).toBe(1);
		expect(targets[0].adapter_id).toBe('npm');

		// Capability needs set (defect class enum-validated upstream).
		const needs = await getCapabilityNeeds(db, res.projectId);
		expect(needs.defect_classes).toContain('null-deref');

		// PM hired with the charter pre-filled from the proposal.
		expect(res.pm?.pm.name).toBe('Ada');
		const pm = await getPm(db, res.projectId);
		expect(pm).not.toBeNull();
		expect(pm!.charter).toBe('Own the difficulty-curve roadmap; ship a configurable v1.');
	}, 60_000);
});

describe('executeCreation — happy path (no PM)', () => {
	it('founding tasks are born READY when no PM is requested (fork 3)', async () => {
		const env = await makeEnvelope('ca2 no pm');
		const res = await executeCreation(db, env, { codeRoot });
		expect(res.taskStatus).toBe('ready');
		expect(res.pm).toBeUndefined();
		const tasks = await listTasksByProject(db, res.projectId);
		expect(tasks.every((t) => t.status === 'ready')).toBe(true);
		expect(await getPm(db, res.projectId)).toBeNull();
	}, 60_000);
});

describe('executeCreation — idempotent fail-closed (§2.4 (1))', () => {
	it('a second create with the same slug throws ProjectExistsError, never overwrites', async () => {
		const first = await makeEnvelope('ca2 dup');
		await executeCreation(db, first, { codeRoot });
		const second = await makeEnvelope('ca2 dup'); // same name → same slug.
		await expect(executeCreation(db, second, { codeRoot })).rejects.toBeInstanceOf(ProjectExistsError);
	}, 60_000);
});

describe('executeCreation — gate (D-010 stale token)', () => {
	it('a tampered proposal (token no longer matches) is rejected before any disk touch', async () => {
		const env = await makeEnvelope('ca2 stale');
		// Tamper AFTER the token was minted — the executor re-validates freshness (assertProposalFresh).
		const tampered = { ...env, proposal: { ...env.proposal, stack: ['Rust'] } };
		await expect(executeCreation(db, tampered, { codeRoot })).rejects.toBeInstanceOf(StaleProposalError);
		// No project, no dir.
		expect(await getProject(db, 'project:ca2_stale')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_stale'))).toBe(false);
	}, 60_000);
});

describe('executeCreation — red-team D-018 path escape', () => {
	it('a dirLayout entry that escapes the project root fails closed (ScaffoldPathError), no row, no escape', async () => {
		const env = await makeEnvelope('ca2 escape', {
			dirLayout: ['src/', '../../etc/pwned.txt']
		});
		await expect(executeCreation(db, env, { codeRoot })).rejects.toBeInstanceOf(ScaffoldPathError);
		// No phantom row, and the partial dir was removed (cleanup) — nothing escaped.
		expect(await getProject(db, 'project:ca2_escape')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_escape'))).toBe(false);
		expect(await exists(join(codeRoot, '..', '..', 'etc', 'pwned.txt'))).toBe(false);
	}, 60_000);
});

describe('executeCreation — red-team D-026 secret in scaffold content', () => {
	it('a literal secret in a field that reaches a written file fails closed (ScaffoldSecretError), no row', async () => {
		// purpose flows into README content; CA-1 screens TARGET CONFIGS for secrets but not the macro
		// — so a planted key here is caught at the scaffold-write boundary (defense in depth, D-026).
		const env = await makeEnvelope('ca2 secret', {
			planMacro: {
				purpose: 'Use the key sk-ant-deadbeefdeadbeef for auth.',
				vision: 'A tool reached for when tuning a run.',
				role: 'Solo maintainer.',
				definition_of_done: 'Runs without crash.'
			}
		});
		await expect(executeCreation(db, env, { codeRoot })).rejects.toBeInstanceOf(ScaffoldSecretError);
		expect(await getProject(db, 'project:ca2_secret')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_secret'))).toBe(false);
	}, 60_000);
});

describe('executeCreation — honest partial failure (F-008)', () => {
	it('a git failure mid-scaffold → ScaffoldFailedError + incident logged + NO phantom row + dir removed', async () => {
		const env = await makeEnvelope('ca2 partial');
		// A runner that makes `git commit` fail (non-zero) — the scaffold dies after the file write.
		const failingRun: CommandRunner = async (file, args) => {
			if (file === 'git' && args.includes('commit')) {
				return { code: 1, stdout: '', stderr: 'simulated commit failure' };
			}
			return { code: 0, stdout: '', stderr: '' };
		};
		const beforeIncidents = await countIncidents();
		const opts: ExecuteCreationOptions = { codeRoot, run: failingRun };
		await expect(executeCreation(db, env, opts)).rejects.toBeInstanceOf(ScaffoldFailedError);

		// No phantom project row (F-008 — the row reflects disk, and there is no completed scaffold).
		expect(await getProject(db, 'project:ca2_partial')).toBeNull();
		// No tasks were created (the writers never ran).
		expect((await listTasksByProject(db, 'project:ca2_partial')).length).toBe(0);
		// The partial dir was removed so a re-run starts clean (interrupt contract).
		expect(await exists(join(codeRoot, 'ca2_partial'))).toBe(false);
		// An incident was logged (NEVER silent).
		expect(await countIncidents()).toBe(beforeIncidents + 1);
	}, 60_000);
});

describe('executeCreation — re-run after a partial failure (interrupt contract)', () => {
	it('after a cleaned partial failure, a fresh execute with the same slug SUCCEEDS (no half-state)', async () => {
		const failingRun: CommandRunner = async (file, args) => {
			if (file === 'git' && args.includes('commit')) return { code: 1, stdout: '', stderr: 'fail' };
			return { code: 0, stdout: '', stderr: '' };
		};
		const env1 = await makeEnvelope('ca2 rerun');
		await expect(executeCreation(db, env1, { codeRoot, run: failingRun })).rejects.toBeInstanceOf(
			ScaffoldFailedError
		);
		// Re-run with a working runner — the slug is free (no half-state wedged it).
		const env2 = await makeEnvelope('ca2 rerun');
		const res = await executeCreation(db, env2, { codeRoot });
		expect(res.projectId).toBe('project:ca2_rerun');
		expect(await getProject(db, res.projectId)).not.toBeNull();
	}, 60_000);
});

describe('executeCreation — slug-stability gate (D-016/F-008 regression)', () => {
	// Regression for the CA-2 review FAIL: slugify is NOT idempotent for symbol-only names
	// ('!!!','??? ','__' → 'p_', but re-slugifying 'p_' → 'p'). Before the fix, the gate validated
	// project:p_ while scanProject registered project:p; a SECOND same-name create checked the wrong
	// id, did NOT fail closed, re-entered the existing scaffold, and its failed first commit rm -rf'd
	// the live project's dir → an F-008 phantom row pointing at a deleted dir. The fix fails CLOSED
	// at the gate (UnstableSlugError) before any disk touch, so the corruption chain is unreachable.

	it('a name whose slug is non-idempotent fails closed (UnstableSlugError), no row, no dir', async () => {
		// Precondition: this name is genuinely non-idempotent (the bug's trigger), else the test is moot.
		expect(slugify(slugify('!!!'))).not.toBe(slugify('!!!'));

		const env = await makeEnvelope('!!!');
		await expect(executeCreation(db, env, { codeRoot })).rejects.toBeInstanceOf(UnstableSlugError);

		// Neither the gate id ('project:p_') nor the would-be registered id ('project:p') exists, and
		// nothing was scaffolded under either basename — the failure was before any disk touch.
		expect(await getProject(db, 'project:p_')).toBeNull();
		expect(await getProject(db, 'project:p')).toBeNull();
		expect(await exists(join(codeRoot, 'p_'))).toBe(false);
		expect(await exists(join(codeRoot, 'p'))).toBe(false);
	}, 60_000);

	it('the gate fires BEFORE registering, so a real project is never corrupted by a degenerate re-create', async () => {
		// Stand up a real, valid project first.
		const real = await makeEnvelope('ca2 stable');
		const realRes = await executeCreation(db, real, { codeRoot });
		expect(realRes.projectId).toBe('project:ca2_stable');

		// A degenerate-name create (twice) must NOT touch disk or the DB — the live project survives
		// intact (the pre-fix bug deleted an existing project's scaffold on the second degenerate run).
		for (let attempt = 0; attempt < 2; attempt++) {
			const bad = await makeEnvelope('___');
			await expect(executeCreation(db, bad, { codeRoot })).rejects.toBeInstanceOf(UnstableSlugError);
		}

		const survivor = await getProject(db, 'project:ca2_stable');
		expect(survivor).not.toBeNull();
		expect(await exists(join(codeRoot, 'ca2_stable', '.git'))).toBe(true);
		expect(await exists(join(codeRoot, 'ca2_stable', 'src', 'index.ts'))).toBe(true);
	}, 60_000);
});

/** Count `incident` rows (the honest-failure signal). */
async function countIncidents(): Promise<number> {
	const [rows] = await db.query<[Array<{ n: number }>]>(
		`SELECT count() AS n FROM incident GROUP ALL;`
	);
	return rows.length ? rows[0].n : 0;
}
