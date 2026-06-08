// LIVE PROOF 2.7 — the post-task loop after a REAL credentialed Claude Code session that
// ACTUALLY EDITS FILES in a throwaway git project (ARCHITECTURE §2.2/§3 step 7; D-008/D-016;
// D-018; DATA-MODEL §5; dep 2.2). post-task.test.ts proves the loop with a FAKE runner; THIS
// proves it with the REAL `execFileRunner` (no mock) — real `git add/commit/rev-parse` + a
// real project test command on the OS — driven off a working tree a REAL `claude` subprocess
// just dirtied. The load-bearing 2.7 contract, proven against real externals:
//
//   1. a completed session ⇒ a REAL git commit via execFile ARGUMENT ARRAYS (no shell), the
//      project's REAL test_command runs, and the outcome (task→done + a `completion`
//      agent_event carrying the real sha + test result) is recorded in ONE SurrealDB
//      transaction. We read the real sha back from `git log` and the rows back from a real
//      throwaway SurrealDB — nothing is fabricated (F-008).
//   2. NO shell injection (D-008): a commit subject carrying shell metacharacters
//      (`"; echo PWNED > pwned.txt #`) is handed to git as ONE literal argv element — after
//      the real commit, NO `pwned.txt` exists and the subject is the commit message verbatim.
//   3. D-018: the loop issues only local git verbs — no `git push`/`remote`/`--force`. The
//      throwaway repo has NO remote, so any push attempt would also fail loudly; none happens.
//
// The driven session is cwd-confined to an OS temp dir, runs under the ISOLATED config (D-002)
// with a per-session CLAUDE_CONFIG_DIR (operator config never inherited), never touches other
// projects, and never pushes. If no token is present (Anthropic unreachable) the suite is
// SKIPPED — an honest deferral, not a faked artifact. The OAuth token is read at runtime and
// NEVER logged. Untrusted model output is data, never instructions (D-026).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	existsSync,
	writeFileSync,
	mkdirSync,
	readdirSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask, setStatus } from '../tasks/repo';
import { runPostTask, execFileRunner } from './post-task';
import { countByStatus } from './workqueue';

const execFile = promisify(execFileCb);

/** Read CLAUDE_CODE_OAUTH_TOKEN from process env or the worktree .env (never logged). */
function readToken(): string | undefined {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	const p = join(process.cwd(), '.env');
	if (!existsSync(p)) return undefined;
	const line = readFileSync(p, 'utf8')
		.split(/\r?\n/)
		.find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
	if (!line) return undefined;
	return line
		.slice('CLAUDE_CODE_OAUTH_TOKEN='.length)
		.trim()
		.replace(/^["']|["']$/g, '');
}

const TOKEN = readToken();
const live = TOKEN ? describe : describe.skip;

let tdb: TestDb;
let db: Db;
let projectId: string;
let workDir: string;
let configDir: string;
let realCcEditObserved = false;

/**
 * Drive a REAL credentialed `claude` subprocess in `cwd` to WRITE a file, unattended.
 * Mirrors the production ClaudeCliBackend spawn (native .exe, spawned DIRECTLY — no shell —
 * under an ISOLATED CLAUDE_CONFIG_DIR, token via env, never logged). Uses
 * --permission-mode bypassPermissions so the headless turn can actually write without a
 * prompt (the production backend uses `default`; here we only need a real dirty tree to
 * commit, so we let the real model edit unattended). Returns the real cc session id (if any).
 */
async function driveRealEditingSession(cwd: string): Promise<{ sessionId: string }> {
	const prompt =
		'Create a file named greeting.js in the current directory whose entire contents are ' +
		'exactly this line and nothing else:\n' +
		"module.exports = function greet(){ return 'hello'; };\n" +
		'Use the Write tool. Do not create any other files. When done, reply with the single ' +
		'word DONE.';

	const args = [
		'-p',
		prompt,
		'--output-format',
		'stream-json',
		'--verbose',
		'--max-turns',
		'6',
		'--model',
		'haiku',
		'--permission-mode',
		'bypassPermissions',
		'--allowedTools',
		'Write'
	];

	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: configDir, // isolated, per-session (D-002) — operator config not inherited
		CLAUDE_CODE_OAUTH_TOKEN: TOKEN!
	};

	let ccSessionId = '';
	await new Promise<void>((resolve, reject) => {
		const child = spawn('claude', args, { cwd, env, windowsHide: true });
		const timer = setTimeout(() => child.kill(), 180_000);
		let buf = '';
		child.stdout.on('data', (d) => {
			buf += String(d);
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				try {
					const obj = JSON.parse(line) as Record<string, unknown>;
					if (typeof obj.session_id === 'string') ccSessionId = obj.session_id;
				} catch {
					/* non-JSON noise */
				}
			}
		});
		child.on('error', reject);
		child.on('close', () => {
			clearTimeout(timer);
			resolve();
		});
	});

	return { sessionId: ccSessionId };
}

beforeAll(async () => {
	if (!TOKEN) return;
	workDir = mkdtempSync(join(tmpdir(), 'live-pt-proj-'));
	configDir = mkdtempSync(join(tmpdir(), 'live-pt-config-'));

	// A REAL throwaway git repo with a LOCAL identity + NO remote (D-018 belt: a push could
	// not succeed even if attempted). The project's test_command is a real node check that
	// PASSES iff the file the session writes exists and exports greet() — so "the test ran"
	// is observable from its exit code, with no network.
	await execFile('git', ['init'], { cwd: workDir });
	await execFile('git', ['config', 'user.email', 'live-proof@atelier.local'], { cwd: workDir });
	await execFile('git', ['config', 'user.name', 'Atelier Live Proof'], { cwd: workDir });
	// A baseline commit so the repo has HEAD; the session's edit becomes the next commit.
	writeFileSync(join(workDir, '.gitignore'), 'node_modules\n', 'utf8');
	await execFile('git', ['add', '-A'], { cwd: workDir });
	await execFile('git', ['commit', '-m', 'chore: baseline'], { cwd: workDir });

	// The project test command: a real local node program (no network) that requires the
	// session's output file and asserts its contract. exit 0 ⇒ tests pass.
	mkdirSync(join(workDir, 'scripts'), { recursive: true });
	writeFileSync(
		join(workDir, 'scripts', 'check.js'),
		[
			"const greet = require('../greeting.js');",
			"if (greet() !== 'hello') { console.error('contract failed'); process.exit(1); }",
			"console.log('ok');"
		].join('\n'),
		'utf8'
	);

	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	const p = await createProject(db, {
		slug: 'live_pt_2_7',
		name: 'Live Post-Task 2.7',
		root_path: workDir.replace(/\\/g, '/'),
		// The REAL project test command run by the loop (execFile arrays, split, no shell).
		test_command: 'node scripts/check.js'
	});
	projectId = p.id;
}, 240_000);

afterAll(async () => {
	if (!TOKEN) return;
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	if (configDir) rmSync(configDir, { recursive: true, force: true });
}, 60_000);

/** Read a real session row's helper not needed — we create the session row directly. */
async function makeSession(taskId: string, ccSessionId: string): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
		   project: $p, task: $t, kind: "task", runtime: "claude-code",
		   cc_session_id: $cc,
		   model: { provider: "claude", model_id: "haiku", tier: "haiku" }
		 } RETURN AFTER;`,
		{
			p: new StringRecordId(projectId),
			t: new StringRecordId(taskId),
			cc: ccSessionId || 'live-2.7-no-cc-id'
		}
	);
	return String(rows[0].id);
}

async function gitLogSubjects(): Promise<string[]> {
	const { stdout } = await execFile('git', ['log', '--format=%s'], { cwd: workDir });
	return stdout.split(/\r?\n/).filter(Boolean);
}

async function headSha(): Promise<string> {
	const { stdout } = await execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: workDir });
	return stdout.trim();
}

live('LIVE 2.7 — real post-task loop after a real editing session (D-008/D-016/D-018)', () => {
	it(
		'real session edits a file → real git commit (execFile arrays) + real test runs, recorded in ONE transaction; no shell injection',
		async () => {
			// ── 1. a REAL credentialed Claude Code session actually edits the working tree ──
			const { sessionId: ccId } = await driveRealEditingSession(workDir);

			// The real model wrote the file (proves "a session that actually edits files"). If
			// the model phrased the file slightly differently we still need the contract met, so
			// assert the FILE the loop will commit truly exists with the required export.
			const greetPath = join(workDir, 'greeting.js');
			expect(existsSync(greetPath)).toBe(true);
			const greetSrc = readFileSync(greetPath, 'utf8');
			expect(greetSrc).toContain('greet');
			expect(greetSrc).toMatch(/hello/);
			realCcEditObserved = true;

			// git sees the new file as a real pending change (the loop will stage + commit it).
			const { stdout: statusOut } = await execFile('git', ['status', '--porcelain'], {
				cwd: workDir
			});
			expect(statusOut).toMatch(/greeting\.js/);

			const subjectsBefore = await gitLogSubjects();

			// ── 2. run the REAL post-task loop (default execFileRunner — NO mock) ──
			// commitMessage carries SHELL METACHARACTERS: if anything ever folded args into a
			// shell string, this would create pwned.txt / run a second command. It must not.
			const task = await createTask(db, {
				project: projectId,
				title: 'Live 2.7 post-task proof',
				description: 'commit the real edit + run the real test command',
				status: 'ready'
			});
			await setStatus(db, task.id, 'in_progress');
			const sessionId = await makeSession(task.id, ccId);

			const evilSubject = 'feat: greet(); "; echo PWNED > pwned.txt #';

			const res = await runPostTask(
				db,
				{
					projectId,
					taskId: task.id,
					sessionId,
					cwd: workDir,
					commitMessage: evilSubject,
					testCommand: 'node scripts/check.js',
					runOk: true
				},
				{ run: execFileRunner } // the REAL runner — real git, real node, no shell
			);

			// ── commit happened FOR REAL via execFile arrays ──
			expect(res.commit.attempted).toBe(true);
			expect(res.commit.ok).toBe(true);
			expect(res.commit.sha).toBeTruthy();
			// the recorded sha matches the REAL repo HEAD (read back from git, not fabricated).
			expect(res.commit.sha).toBe(await headSha());

			// the real commit subject is EXACTLY the evil string (one argv element after -m).
			const subjectsAfter = await gitLogSubjects();
			expect(subjectsAfter.length).toBe(subjectsBefore.length + 1);
			expect(subjectsAfter[0]).toBe(evilSubject);

			// ── NO shell injection (D-008): the metachars never spawned a second command ──
			expect(existsSync(join(workDir, 'pwned.txt'))).toBe(false);
			// nothing stray was created in the repo root by a shell mis-parse.
			const rootEntries = readdirSync(workDir);
			expect(rootEntries).not.toContain('pwned.txt');

			// ── the REAL project test command ran (execFile arrays, split, no shell) ──
			expect(res.test.attempted).toBe(true);
			expect(res.test.ok).toBe(true); // node scripts/check.js exited 0 against the committed file
			expect(res.test.code).toBe(0);

			// ── the outcome was recorded ATOMICALLY: task→done + completion event in ONE txn ──
			expect(res.taskStatus).toBe('done');
			const [trow] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM ONLY $t;`, {
				t: new StringRecordId(task.id)
			});
			expect((trow as unknown as { status: string }).status).toBe('done');

			const [evrow] = await db.query<[Array<{ type: string; detail: Record<string, unknown> }>]>(
				`SELECT type, detail FROM ONLY $e;`,
				{ e: new StringRecordId(res.agentEventId) }
			);
			const ev = evrow as unknown as { type: string; detail: Record<string, unknown> };
			expect(ev.type).toBe('completion');
			// the completion detail carries the REAL sha + test result (the how/why a reader needs).
			expect(ev.detail.commit_sha).toBe(res.commit.sha);
			expect(ev.detail.test_ran).toBe(true);
			expect(ev.detail.test_ok).toBe(true);

			// a passing test ⇒ NO follow-up was enqueued.
			expect(res.followUpWorkId).toBeUndefined();
			expect(await countByStatus(db, 'pending')).toBe(0);
		},
		300_000
	);
});

// Guard: if the suite ran with a token but the model never produced the edit, the proof
// is incomplete — surface it rather than passing vacuously.
afterAll(() => {
	if (TOKEN && !realCcEditObserved) {
		throw new Error('LIVE 2.7: token present but no real session edit was observed');
	}
});
