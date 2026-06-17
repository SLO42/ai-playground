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
	StaleProposalError,
	ProposalPathError
} from './plan';
import {
	executeCreation,
	ProjectExistsError,
	UnstableSlugError,
	ScaffoldPathError,
	ScaffoldSecretError,
	ScaffoldFailedError,
	ConcurrentCreateError,
	PostRegisterWriterError,
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
	// CA-H1: a `..`-traversal dirLayout entry is now rejected at the PLAN trust boundary
	// (ProposalPathError, in generateCreationProposal) BEFORE it can earn a confirmToken or reach
	// executeCreation — so the escape never gets near disk. The executor's resolveEntry remains the
	// second line of defense (its own unit covers it); here we prove the proposal can't even be built.
	it('a dirLayout entry that escapes the project root is rejected at proposal time (ProposalPathError), no envelope, no escape', async () => {
		await expect(makeEnvelope('ca2 escape', { dirLayout: ['src/', '../../etc/pwned.txt'] })).rejects.toBeInstanceOf(
			ProposalPathError
		);
		// No phantom row, no scaffold dir, nothing escaped — the escape never reached execute.
		expect(await getProject(db, 'project:ca2_escape')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_escape'))).toBe(false);
		expect(await exists(join(codeRoot, '..', '..', 'etc', 'pwned.txt'))).toBe(false);
	}, 60_000);

	// Defense in depth: if an escaping entry somehow bypassed the plan boundary and a fresh-token
	// envelope reached the executor directly, resolveEntry STILL fails closed (ScaffoldPathError).
	it('the executor still fails closed (ScaffoldPathError) if an escaping entry reaches it directly', async () => {
		const env = await makeEnvelope('ca2 escape2');
		// Inject the escape AND re-mint a matching confirmToken so the D-010 gate passes and the
		// dirLayout reaches resolveEntry — isolating the executor's own second-line check.
		const proposal = { ...env.proposal, dirLayout: ['src/', '../../etc/pwned2.txt'] };
		const { computeConfirmToken } = await import('./plan');
		const tampered = { ...env, proposal, confirmToken: computeConfirmToken(env.brief, proposal) };
		await expect(executeCreation(db, tampered, { codeRoot })).rejects.toBeInstanceOf(ScaffoldPathError);
		expect(await getProject(db, 'project:ca2_escape2')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_escape2'))).toBe(false);
		expect(await exists(join(codeRoot, '..', '..', 'etc', 'pwned2.txt'))).toBe(false);
	}, 60_000);
});

describe('executeCreation — red-team D-026 secret in scaffold content', () => {
	const SECRET_MACRO = {
		// Token assembled at runtime so the source carries no contiguous provider-token pattern
		// (GitHub push-protection) — runtime value is full-format so the scaffold-write screen fires.
		purpose: 'Use the key ' + ('sk-' + 'ant-' + 'deadbeefdeadbeef') + ' for auth.',
		vision: 'A tool reached for when tuning a run.',
		role: 'Solo maintainer.',
		definition_of_done: 'Runs without crash.'
	};

	// CA-H1 Gap-2: the plan macro (and every agent-authored free-text field) is now secret-screened at
	// the PLAN trust boundary, so a key planted in purpose is caught BEFORE the proposal earns a
	// confirmToken (SecretEchoError) — earlier than the old scaffold-write catch.
	it('a literal secret in the plan macro is rejected at proposal time (SecretEchoError), no envelope', async () => {
		const { SecretEchoError } = await import('./plan');
		await expect(makeEnvelope('ca2 secret', { planMacro: SECRET_MACRO })).rejects.toBeInstanceOf(SecretEchoError);
		expect(await getProject(db, 'project:ca2_secret')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_secret'))).toBe(false);
	}, 60_000);

	// Defense in depth: if a macro secret somehow bypassed the plan boundary and a fresh-token envelope
	// reached the executor directly, the scaffold-write screen STILL fails closed (ScaffoldSecretError).
	it('the executor still fails closed (ScaffoldSecretError) if a macro secret reaches it directly', async () => {
		const env = await makeEnvelope('ca2 secret2');
		const proposal = { ...env.proposal, planMacro: SECRET_MACRO };
		const { computeConfirmToken } = await import('./plan');
		const tampered = { ...env, proposal, confirmToken: computeConfirmToken(env.brief, proposal) };
		await expect(executeCreation(db, tampered, { codeRoot })).rejects.toBeInstanceOf(ScaffoldSecretError);
		expect(await getProject(db, 'project:ca2_secret2')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_secret2'))).toBe(false);
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

describe('executeCreation — CA-H2 post-register writer failure (F-008 honest, no wedge, no phantom)', () => {
	// A writer that throws AFTER the scanProject register (the PM hand-off is the LAST writer, step 5):
	// passing a blank PM name makes hirePm throw ('a PM name is required') only after plan/needs/tasks/
	// targets have landed. The project is real on disk + registered, so it must NOT be deleted — it is
	// MARKED honestly (create_status=incomplete) + an incident logged, and the slug is NOT wedged.
	it('a post-register writer throw → incident + create_status=incomplete + project survives (not deleted, not wedged)', async () => {
		const env = await makeEnvelope('ca2 postreg');
		const before = await countIncidents();
		await expect(
			executeCreation(db, env, { codeRoot, pm: { name: '   ' } }) // blank → hirePm throws post-register.
		).rejects.toBeInstanceOf(PostRegisterWriterError);

		// The project row SURVIVES (real on disk — deleting it would orphan a live scaffold dir).
		const row = await getProject(db, 'project:ca2_postreg');
		expect(row).not.toBeNull();
		// Marked HONESTLY incomplete (clearly-marked, never a silent half-built phantom).
		expect(row!.create_status).toBe('incomplete');
		// The scaffold dir + .git survive on disk (NOT rm -rf'd).
		expect(await exists(join(codeRoot, 'ca2_postreg', '.git'))).toBe(true);
		expect(await exists(join(codeRoot, 'ca2_postreg', 'src', 'index.ts'))).toBe(true);
		// The earlier writers DID land (plan persisted) — a real, partially-wired project.
		expect(row!.plan?.purpose).toBe('A small CLI that prints the survival difficulty curve.');
		const tasks = await listTasksByProject(db, 'project:ca2_postreg');
		expect(tasks.length).toBe(3); // tasks ran before the PM hand-off.
		// An incident was logged (NEVER silent).
		expect(await countIncidents()).toBe(before + 1);
		// The slug is NOT wedged: the create-lock was released, so the row can be inspected/handled.
		expect(await lockRowCount('ca2_postreg')).toBe(0);
	}, 60_000);

	it('a fully successful create is marked create_status=complete and holds no lingering lock', async () => {
		const env = await makeEnvelope('ca2 complete');
		const res = await executeCreation(db, env, { codeRoot });
		const row = await getProject(db, res.projectId);
		expect(row!.create_status).toBe('complete');
		expect(await lockRowCount('ca2_complete')).toBe(0); // lock released on success.
	}, 60_000);
});

describe('executeCreation — CA-H2 TOCTOU concurrent same-slug (fail-closed lock + ownership-gated cleanup)', () => {
	// Simulate the LOSER of a concurrent double-submit: stand up the WINNER's project, then hold the
	// slug-keyed create-lock (as the winner-in-flight would) and fire a SECOND same-slug create. It must
	// fail CLOSED (ConcurrentCreateError) and — critically — must NOT rm -rf the winner's live scaffold
	// (ownership-gated cleanup: the loser never created that dir, so it never deletes it).
	it('a second same-slug create while the lock is held fails closed and CANNOT delete the first scaffold', async () => {
		// Winner: a real, committed project.
		const winner = await makeEnvelope('ca2 toctou');
		const wres = await executeCreation(db, winner, { codeRoot });
		expect(wres.projectId).toBe('project:ca2_toctou');
		expect(await exists(join(codeRoot, 'ca2_toctou', '.git'))).toBe(true);

		// The winner already exists, so a same-slug create hits ProjectExistsError at the FIRST gate.
		// To exercise the LOCK path (the TOCTOU window where the row does not yet exist but a create is
		// in flight) we delete the row, re-hold the lock as an in-flight winner, then run the loser.
		await db.query(`DELETE project:ca2_toctou;`); // simulate "row not yet registered" (TOCTOU window).
		await db.query(
			`CREATE create_lock:ca2_toctou CONTENT { holder: $h } RETURN AFTER;`,
			{ h: 'winner-in-flight' }
		);

		const loser = await makeEnvelope('ca2 toctou');
		await expect(executeCreation(db, loser, { codeRoot })).rejects.toBeInstanceOf(ConcurrentCreateError);

		// The winner's live scaffold + .git SURVIVE — the loser's ownership-gated cleanup never touched
		// a dir it did not create this run (the exact corruption CA-H2 forbids).
		expect(await exists(join(codeRoot, 'ca2_toctou', '.git'))).toBe(true);
		expect(await exists(join(codeRoot, 'ca2_toctou', 'src', 'index.ts'))).toBe(true);

		// Cleanup the simulated in-flight lock so it does not wedge later tests.
		await db.query(`DELETE create_lock:ca2_toctou;`);
	}, 60_000);

	it('register-collision fails CLOSED (ProjectExistsError) — last-writer never wins at the gate', async () => {
		const first = await makeEnvelope('ca2 collide');
		await executeCreation(db, first, { codeRoot });
		const second = await makeEnvelope('ca2 collide');
		await expect(executeCreation(db, second, { codeRoot })).rejects.toBeInstanceOf(ProjectExistsError);
		// The first project's scaffold is untouched (no last-writer overwrite).
		expect(await exists(join(codeRoot, 'ca2_collide', '.git'))).toBe(true);
	}, 60_000);
});

/** Count `incident` rows (the honest-failure signal). */
async function countIncidents(): Promise<number> {
	const [rows] = await db.query<[Array<{ n: number }>]>(
		`SELECT count() AS n FROM incident GROUP ALL;`
	);
	return rows.length ? rows[0].n : 0;
}

/** Count create_lock rows for a slug (0 = released / never held). */
async function lockRowCount(slug: string): Promise<number> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM type::thing('create_lock', $slug);`,
		{ slug }
	);
	return rows.length;
}
