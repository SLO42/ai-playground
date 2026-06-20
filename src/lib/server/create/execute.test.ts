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
import { normFileSnapshot } from '../memory/file-snapshot';
import { StringRecordId } from 'surrealdb';
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
	resumeCreation,
	ProjectExistsError,
	UnstableSlugError,
	ScaffoldPathError,
	ScaffoldSecretError,
	ScaffoldFailedError,
	ConcurrentCreateError,
	PostRegisterWriterError,
	ResumeProjectNotFoundError,
	ResumeNotIncompleteError,
	ResumeScaffoldMissingError,
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

describe('executeCreation — FS-2 (a) scaffold file-snapshot capture (FILE-SNAPSHOT-SPEC §3 a)', () => {
	it('each scaffolded file is captured + linked from the new project, readable in-app', async () => {
		const env = await makeEnvelope('ca2 fs2 snap');
		const res = await executeCreation(db, env, { codeRoot });

		// Snapshots are linked from the project (captured_by + project = project:<slug>).
		const [rows] = await db.query<[Record<string, unknown>[]]>(
			`SELECT * FROM file_snapshot WHERE project = $p;`,
			{ p: new StringRecordId(res.projectId) }
		);
		const snaps = rows.map(normFileSnapshot);
		expect(snaps.length).toBeGreaterThan(0);
		// Every scaffold snapshot is linked from the project + carries an as-of capture time (F-013).
		for (const s of snaps) {
			expect(s.captured_by).toBe(res.projectId);
			expect(s.project).toBe(res.projectId);
			expect(typeof s.captured_at).toBe('string');
			expect(s.captured_at).not.toBe('undefined');
		}
		// The README content is readable from the snapshot (the freshly-created project's files in-app).
		const readme = snaps.find((s) => s.path === 'README.md');
		expect(readme).toBeTruthy();
		expect(readme!.content).toContain('# ca2 fs2 snap');
		// The .gitignore snapshot mirrors what was written to disk (D-026 .env coverage from commit 0).
		const gi = snaps.find((s) => s.path === '.gitignore');
		expect(gi).toBeTruthy();
		expect(gi!.content).toMatch(/^\.env$/m);
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
	// A CREDENTIAL-PREFIX token (sk-ant-…) embedded in prose. screen() → 'redacted' (anthropic-key
	// rule, NOT quarantine-on-hit). In 'freetext' mode the value is redactable PII-class, so the
	// scaffold-write gate writes the SAFE [REDACTED:anthropic-key] text — never raw, never aborted.
	const CRED_MACRO = {
		// Token assembled at runtime so the source carries no contiguous provider-token pattern
		// (GitHub push-protection) — runtime value is full-format so the screen fires.
		purpose: 'Use the key ' + ('sk-' + 'ant-' + 'deadbeefdeadbeef') + ' for auth.',
		vision: 'A tool reached for when tuning a run.',
		role: 'Solo maintainer.',
		definition_of_done: 'Runs without crash.'
	};

	// A QUARANTINED secret — a private-key PEM block (screen() quarantineOnHit). Assembled at runtime
	// so the source file carries no contiguous key block. This is the case BOTH gates HARD-reject
	// (it cannot be safely redacted in isolation).
	const PRIVATE_KEY_BLOCK =
		'-----BEGIN ' +
		'RSA PRIVATE KEY-----\n' +
		'MIIBdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' +
		'-----END ' +
		'RSA PRIVATE KEY-----';

	// An UN-REDACTABLE (quarantined) private-key block in a free-text macro field is rejected at the
	// PLAN trust boundary (SecretEchoError) BEFORE the proposal earns a confirmToken — it cannot be
	// safely written, so it never reaches scaffold. (A REDACTABLE span like an email/known-prefix token
	// passes the boundary and is redacted at the disk gate — covered below.)
	it('an un-redactable secret in the plan macro is rejected at proposal time (SecretEchoError), no envelope', async () => {
		const { SecretEchoError } = await import('./plan');
		const QUARANTINE_MACRO = {
			purpose: `Bootstrap secret:\n${PRIVATE_KEY_BLOCK}`,
			vision: 'A tool reached for when tuning a run.',
			role: 'Solo maintainer.',
			definition_of_done: 'Runs without crash.'
		};
		await expect(makeEnvelope('ca2 secret', { planMacro: QUARANTINE_MACRO })).rejects.toBeInstanceOf(
			SecretEchoError
		);
		expect(await getProject(db, 'project:ca2_secret')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_secret'))).toBe(false);
	}, 60_000);

	// LIVE-BUG FIX (the create-with-email regression): a normal description containing a BENIGN email
	// is redactable PII, NOT a literal secret. It now PASSES the plan boundary AND the scaffold-write
	// gate writes the SAFE [REDACTED:email] text — the create SUCCEEDS, never aborts. No raw email on disk.
	it('a benign email in the plan macro → create SUCCEEDS, README written with [REDACTED:email], no raw email on disk', async () => {
		const EMAIL = 'jane.doe@rounds.example';
		const env = await makeEnvelope('ca2 email ok', {
			planMacro: {
				purpose: `A ROUNDS support tool. Contact ${EMAIL} for triage.`,
				vision: 'A tool reached for when tuning a run.',
				role: 'Solo maintainer.',
				definition_of_done: 'Runs without crash.'
			}
		});
		const res = await executeCreation(db, env, { codeRoot });
		expect(res.projectId).toBe('project:ca2_email_ok');
		// The README seeds from purpose → screen redacted the email at the disk boundary.
		const readme = await readFile(join(codeRoot, 'ca2_email_ok', 'README.md'), 'utf8');
		expect(readme).toContain('[REDACTED:email]');
		expect(readme).not.toContain(EMAIL); // NEVER the raw email on disk (D-026).
		// The project is real and complete (no abort, no incomplete marking).
		const row = await getProject(db, res.projectId);
		expect(row).not.toBeNull();
		expect(row!.create_status).toBe('complete');
	}, 60_000);

	// QUARANTINED: a private-key block in scaffold content → the executor HARD-rejects ScaffoldSecretError
	// NAMING the file (README.md, seeded from purpose) + the reason — not a generic 'literal secret'. The
	// plan boundary also rejects it (quarantined), so we re-mint a fresh token to reach the executor's gate.
	it('a private-key block in scaffold content → ScaffoldSecretError naming the file, no project, no raw key on disk', async () => {
		const env = await makeEnvelope('ca2 quarantine');
		const proposal = {
			...env.proposal,
			planMacro: {
				...env.proposal.planMacro,
				purpose: `Bootstrap secret:\n${PRIVATE_KEY_BLOCK}`
			}
		};
		const { computeConfirmToken } = await import('./plan');
		const tampered = { ...env, proposal, confirmToken: computeConfirmToken(env.brief, proposal) };
		let thrown: unknown;
		try {
			await executeCreation(db, tampered, { codeRoot });
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(ScaffoldSecretError);
		expect((thrown as ScaffoldSecretError).path).toMatch(/README\.md$/);
		expect((thrown as Error).message).toContain('README.md');
		expect((thrown as Error).message).toMatch(/quarantin/i);
		// No project, no dir, NO raw key bytes anywhere on disk (the partial dir was removed).
		expect(await getProject(db, 'project:ca2_quarantine')).toBeNull();
		expect(await exists(join(codeRoot, 'ca2_quarantine'))).toBe(false);
	}, 60_000);

	// Defense in depth: a credential-prefix token reaching the executor directly is 'redacted' (anthropic-
	// key), so the scaffold-write gate writes the SAFE [REDACTED:anthropic-key] text — the raw token is
	// NEVER written to disk, even though the create proceeds. (The plan boundary already rejects it; this
	// isolates the write gate by re-minting a token so the macro reaches writeFileMap directly.)
	it('a credential token reaching the write gate is written REDACTED, never raw, on disk', async () => {
		const env = await makeEnvelope('ca2 redact direct');
		const proposal = { ...env.proposal, planMacro: CRED_MACRO };
		const { computeConfirmToken } = await import('./plan');
		const tampered = { ...env, proposal, confirmToken: computeConfirmToken(env.brief, proposal) };
		const res = await executeCreation(db, tampered, { codeRoot });
		const readme = await readFile(join(codeRoot, 'ca2_redact_direct', 'README.md'), 'utf8');
		expect(readme).toContain('[REDACTED:anthropic-key]');
		expect(readme).not.toContain('sk-ant-'); // NEVER the raw token on disk (D-026 preserved).
		expect(res.projectId).toBe('project:ca2_redact_direct');
	}, 60_000);

	// WRITER-BOUNDARY REGRESSION (red-team pass-2 HIGH): a 'redacted'-status provider key (sk-ant-…) in
	// planMacro free text and a founding-task purpose PASSES the plan boundary ('freetext' rejects only
	// 'quarantined'). These fields persist to the DB RAW (updateProjectPlan MERGE / createTask CREATE) —
	// they NEVER pass through writeFileMap/screen(), so the disk-gate is not a backstop for them. The
	// fix screens them at the writer boundary (execute.ts postRegister). Assert the DB COLUMN holds the
	// SAFE redacted text, never the raw key. This is the assertion the green 107/107 was missing.
	it('a credential token in planMacro + founding-task free text is stored REDACTED in the DB plan/task rows, never raw', async () => {
		const KEY = 'sk-' + 'ant-' + 'deadbeefdeadbeef0123'; // assembled (GitHub push-protection)
		const env = await makeEnvelope('ca2 writer redact', {
			planMacro: {
				purpose: `Integrate the API using ${KEY} for now.`,
				vision: 'A tool reached for when tuning a run.',
				role: 'Solo maintainer.',
				definition_of_done: 'Runs without crash.'
			},
			foundingTasks: [
				{ objective: 'Wire the client', purpose: `Call the API with ${KEY} until env wiring lands.` },
				{ objective: 'Implement the curve', purpose: 'The curve is the whole point of the tool.' },
				{ objective: 'Add a config surface', purpose: 'Users tune without code edits.' }
			]
		});
		const res = await executeCreation(db, env, { codeRoot });
		expect(res.projectId).toBe('project:ca2_writer_redact');

		// The plan.purpose DB column holds the SAFE redacted text — NEVER the raw key (D-026).
		const row = await getProject(db, res.projectId);
		expect(row).not.toBeNull();
		expect(row!.plan?.purpose).toContain('[REDACTED:anthropic-key]');
		expect(row!.plan?.purpose).not.toContain('sk-ant-');
		expect(row!.create_status).toBe('complete'); // redacted-in-place, NOT aborted.

		// The founding-task purpose DB column is likewise redacted, never raw.
		const tasks = await listTasksByProject(db, res.projectId);
		const leaky = tasks.find((t) => t.objective === 'Wire the client');
		expect(leaky).toBeTruthy();
		expect(leaky!.purpose).toContain('[REDACTED:anthropic-key]');
		expect(leaky!.purpose).not.toContain('sk-ant-');
		// No DB column anywhere on the tasks carries the raw key.
		for (const t of tasks) {
			expect(t.purpose ?? '').not.toContain('sk-ant-');
			expect(t.objective ?? '').not.toContain('sk-ant-');
		}
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

describe('acquireCreateLock — CA-H4 LOW stale-takeover (a crashed holder never wedges the slug forever)', () => {
	/** Read the holder nonce persisted on the create_lock row, or undefined if no row. */
	async function lockHolder(slug: string): Promise<string | undefined> {
		const [rows] = await db.query<[Array<{ holder?: string }>]>(
			`SELECT holder FROM type::thing('create_lock', $slug);`,
			{ slug }
		);
		return rows.length ? rows[0].holder : undefined;
	}

	/** Plant a create_lock row with an explicit `at` so we can simulate a fresh OR a long-crashed holder. */
	async function plantLock(slug: string, holder: string, ageMs: number): Promise<void> {
		const at = new Date(Date.now() - ageMs).toISOString();
		await db.query(`CREATE type::thing('create_lock', $slug) CONTENT { holder: $holder, at: <datetime>$at };`, {
			slug,
			holder,
			at
		});
	}

	it('a STALE create_lock (crashed holder, no row registered) is SEIZED by a later create — slug not wedged', async () => {
		const slug = 'ca2_stale_takeover';
		// Simulate a SIGKILL'd prior create: a lock orphaned 20 min ago (> the 15-min TTL), TOCTOU window
		// (no project row yet). Without takeover this would wedge the slug until an operator hand-deletes it.
		await plantLock(slug, 'crashed-holder', 20 * 60 * 1000);
		expect(await lockHolder(slug)).toBe('crashed-holder'); // precondition: the orphan is present.

		// A fresh create for the same slug must SEIZE the stale lock and run to completion (F-008 honest).
		const env = await makeEnvelope('ca2 stale takeover');
		const res = await executeCreation(db, env, { codeRoot });
		expect(res.projectId).toBe(`project:${slug}`);
		expect((await getProject(db, res.projectId))!.create_status).toBe('complete');
		// The lock is released on success (the seized-then-finished create cleared its OWN nonce).
		expect(await lockRowCount(slug)).toBe(0);
		expect(await exists(join(codeRoot, slug, '.git'))).toBe(true);
	}, 60_000);

	it('a FRESH foreign create_lock (a live in-flight create) is NEVER stolen — fails CLOSED', async () => {
		const slug = 'ca2_fresh_notstolen';
		// A live create is in flight (lock planted 30s ago — well under the 15-min TTL).
		await plantLock(slug, 'live-in-flight', 30 * 1000);

		// To exercise the LOCK path (not the ProjectExistsError gate) the project row must not yet exist.
		const env = await makeEnvelope('ca2 fresh notstolen');
		await expect(executeCreation(db, env, { codeRoot })).rejects.toBeInstanceOf(ConcurrentCreateError);
		// The live holder STILL owns the lock — a slow-but-alive create was not stolen mid-flight.
		expect(await lockHolder(slug)).toBe('live-in-flight');
		// No phantom scaffold for the loser (it threw before any disk touch).
		expect(await exists(join(codeRoot, slug))).toBe(false);

		await db.query(`DELETE type::thing('create_lock', $slug);`, { slug }); // cleanup the simulated lock.
	}, 60_000);

	it('two parallel same-slug creates → EXACTLY ONE winner (one project, one scaffold), the other fails CLOSED', async () => {
		const env1 = await makeEnvelope('ca2 parallel race');
		const env2 = await makeEnvelope('ca2 parallel race');
		const slug = 'ca2_parallel_race';

		// Fire BOTH at once. The fail-closed CREATE + read-back-verify must elect exactly one holder; the
		// loser sees ConcurrentCreateError (or ProjectExistsError if the winner registered first). Assert
		// ownership via a COUNT, not merely "no throw".
		const results = await Promise.allSettled([
			executeCreation(db, env1, { codeRoot }),
			executeCreation(db, env2, { codeRoot })
		]);
		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
		expect(fulfilled).toHaveLength(1); // EXACTLY one winner — never two scaffolds of the same slug.
		expect(rejected).toHaveLength(1);
		expect(
			rejected[0].reason instanceof ConcurrentCreateError ||
				rejected[0].reason instanceof ProjectExistsError
		).toBe(true);

		// Exactly one project row, one scaffold, and the lock is released (no orphan).
		expect((await getProject(db, `project:${slug}`))!.create_status).toBe('complete');
		expect(await exists(join(codeRoot, slug, '.git'))).toBe(true);
		expect(await lockRowCount(slug)).toBe(0);
	}, 90_000);

	it('a stale takeover cannot DOUBLE-SEIZE: two parallel creates over one stale orphan elect one holder', async () => {
		const slug = 'ca2_stale_double';
		await plantLock(slug, 'crashed-holder', 20 * 60 * 1000); // one orphaned lock, both racers will see it.

		const env1 = await makeEnvelope('ca2 stale double');
		const env2 = await makeEnvelope('ca2 stale double');
		const results = await Promise.allSettled([
			executeCreation(db, env1, { codeRoot }),
			executeCreation(db, env2, { codeRoot })
		]);
		// The atomic CAS (UPDATE … WHERE at < cutoff) lets only ONE racer move `at` forward; the other's
		// WHERE no longer matches → its read-back is not its nonce → ConcurrentCreateError. Exactly one wins.
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
		expect((await getProject(db, `project:${slug}`))!.create_status).toBe('complete');
		expect(await lockRowCount(slug)).toBe(0);
	}, 90_000);
});

describe('resumeCreation — CAH4 recovery of an incomplete create (F-008 honest, idempotent, no re-scaffold)', () => {
	/**
	 * Stand up a REAL, fully-scaffolded project, then force it into the honestly-marked
	 * create_status='incomplete' state by failing the LAST post-register writer (a blank PM name makes
	 * hirePm throw after plan/needs/tasks/targets landed). Returns the project id + slug for the resume.
	 */
	async function makeIncomplete(name: string): Promise<{ projectId: string; slug: string }> {
		const env = await makeEnvelope(name);
		await expect(
			executeCreation(db, env, { codeRoot, pm: { name: '   ' } })
		).rejects.toBeInstanceOf(PostRegisterWriterError);
		const projectId = `project:${slugify(name)}`;
		const row = await getProject(db, projectId);
		expect(row!.create_status).toBe('incomplete'); // precondition: genuinely incomplete.
		return { projectId, slug: slugify(name) };
	}

	it('an incomplete project resumes → recoverable writers re-run → create_status=complete, no ProjectExistsError', async () => {
		const { projectId, slug } = await makeIncomplete('ca2 resume ok');
		// Resume WITH a PM (idempotent hirePm completes the step that failed) — must NOT throw
		// ProjectExistsError (the slug exists; resume operates on the existing row).
		const res = await resumeCreation(db, projectId, { codeRoot, pm: { name: 'Ada', answers: [] } });
		expect(res.projectId).toBe(projectId);
		expect(res.pm?.pm.name).toBe('Ada');
		// The row is now honestly complete; the PM landed; the lock is released.
		const row = await getProject(db, projectId);
		expect(row!.create_status).toBe('complete');
		expect(await getPm(db, projectId)).not.toBeNull();
		expect(await lockRowCount(slug)).toBe(0);
		// The scaffold + .git were NOT touched (resume never re-scaffolds).
		expect(await exists(join(codeRoot, slug, '.git'))).toBe(true);
		expect(await exists(join(codeRoot, slug, 'src', 'index.ts'))).toBe(true);
	}, 60_000);

	it('resume without a PM finishes the create (no PM fabricated) and flips to complete', async () => {
		const { projectId } = await makeIncomplete('ca2 resume nopm');
		const res = await resumeCreation(db, projectId, { codeRoot });
		expect(res.projectId).toBe(projectId);
		expect(res.pm).toBeUndefined();
		expect((await getProject(db, projectId))!.create_status).toBe('complete');
		expect(await getPm(db, projectId)).toBeNull(); // never a fabricated hire (F-008).
	}, 60_000);

	it('a resume whose writer THROWS stays incomplete + logs an incident + releases the lock', async () => {
		const { projectId, slug } = await makeIncomplete('ca2 resume fail');
		const before = await countIncidents();
		// A blank PM name makes the resume's idempotent hirePm throw — the SAME honest contract as create.
		await expect(
			resumeCreation(db, projectId, { codeRoot, pm: { name: '   ' } })
		).rejects.toBeInstanceOf(PostRegisterWriterError);
		// The row STAYS incomplete (never silently flipped), an incident was logged, the lock released.
		expect((await getProject(db, projectId))!.create_status).toBe('incomplete');
		expect(await countIncidents()).toBe(before + 1);
		expect(await lockRowCount(slug)).toBe(0);
		// The project still survives on disk (never unwound, F-040).
		expect(await exists(join(codeRoot, slug, '.git'))).toBe(true);
	}, 60_000);

	it('resume of an UNKNOWN project → ResumeProjectNotFoundError (nothing to resume)', async () => {
		await expect(
			resumeCreation(db, 'project:ca2_resume_ghost', { codeRoot })
		).rejects.toBeInstanceOf(ResumeProjectNotFoundError);
	}, 60_000);

	it('resume of a COMPLETE project → ResumeNotIncompleteError (no silent no-op success)', async () => {
		const env = await makeEnvelope('ca2 resume complete');
		const created = await executeCreation(db, env, { codeRoot });
		expect((await getProject(db, created.projectId))!.create_status).toBe('complete');
		await expect(
			resumeCreation(db, created.projectId, { codeRoot })
		).rejects.toBeInstanceOf(ResumeNotIncompleteError);
	}, 60_000);

	it('resume when the scaffold dir is GONE → ResumeScaffoldMissingError, row stays incomplete (never re-scaffolds)', async () => {
		const { projectId, slug } = await makeIncomplete('ca2 resume nodir');
		// Delete the on-disk scaffold out from under the row (a dir moved/removed by the operator).
		await rm(join(codeRoot, slug), { recursive: true, force: true });
		await expect(
			resumeCreation(db, projectId, { codeRoot })
		).rejects.toBeInstanceOf(ResumeScaffoldMissingError);
		// Resume NEVER re-creates the dir, and the row stays honestly incomplete + the lock is released.
		expect(await exists(join(codeRoot, slug))).toBe(false);
		expect((await getProject(db, projectId))!.create_status).toBe('incomplete');
		expect(await lockRowCount(slug)).toBe(0);
	}, 60_000);

	it('resume fails CLOSED (ConcurrentCreateError) when a same-slug create/resume holds the lock', async () => {
		const { projectId, slug } = await makeIncomplete('ca2 resume locked');
		// Simulate a concurrent create/resume in flight by holding the slug-keyed create-lock.
		await db.query(`CREATE create_lock:${slug} CONTENT { holder: $h } RETURN AFTER;`, {
			h: 'other-in-flight'
		});
		await expect(
			resumeCreation(db, projectId, { codeRoot })
		).rejects.toBeInstanceOf(ConcurrentCreateError);
		// The row is untouched (still incomplete) — the lock holder is the foreign run, not us.
		expect((await getProject(db, projectId))!.create_status).toBe('incomplete');
		await db.query(`DELETE create_lock:${slug};`); // cleanup the simulated in-flight lock.
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
