// LIVE PROOF 2.11 (config read-back) — proves PRODUCT §7 v0.2's read-back round-trip.
//
// IMPLEMENTATION-PLAN 2.11 verify: "launch a real Claude Code session after a dashboard
// config edit; assert the session's behavior reflects the edit (e.g. a newly-added
// permission/hook is active) — proves PRODUCT §7 v0.2's read-back round-trip, not just the
// file write."
//
// Unlike write.test.ts (the file round-trip + watcher against disk + the mirror, no model),
// THIS launches a REAL credentialed Claude Code session via the SAME built path the product
// uses — launchSession + ClaudeCodeRuntime + the REAL ClaudeCliBackend under the S1 isolated
// config (D-002) — and proves the edit the config MANAGER (applyEdit, the D-010 plan→confirm→
// write→re-sync contract) made to a throwaway project's `.claude/settings.json` is ACTIVE in
// the launched session.
//
// The proof is a CONTROLLED A/B against the SAME task, so the only variable is the edit:
//   A (baseline) — project `.claude/settings.json` ALLOWS Bash → the agent RUNS Bash and the
//                  transcript carries the command's output (HELLO_FROM_BASH).
//   B (after edit) — applyEdit adds `permissions.deny: ["Bash"]` to that same file (validate →
//                  diff + confirm token → write → re-sync the cc_* mirror). A second real
//                  session on the SAME task is DENIED Bash and cannot produce that output.
// The flip from "ran Bash" to "denied" is caused SOLELY by the dashboard config edit — that is
// the read-back. The isolated `--settings` bundle ALLOWS Bash in both runs, so the deny can
// only come from the project file the manager wrote: `permissions.deny` unions across sources.
//
// F-008 discipline: nothing is fabricated. Every assertion reads rows the live runtime stream
// actually produced (messages persisted by launchSession) or the live mirror applyEdit re-synced.
// If no token is present (Anthropic unreachable / no creds) the suite is SKIPPED — the deferral
// is honest, not a faked artifact. Sessions run cwd-confined in an OS temp dir; they never touch
// other projects and never push. The OAuth token is read at runtime and NEVER logged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { EventBus } from '../events/bus';
import { ClaudeCodeRuntime } from '../runtime/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';
import { launchSession } from '../sessions/launch';
import { planEdit, applyEdit } from './write';
import { syncState, type SyncScope } from './sync';

/** Read CLAUDE_CODE_OAUTH_TOKEN from process env or the worktree .env (never logged). */
function readToken(): string | undefined {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	const p = join(process.cwd(), '.env');
	if (!existsSync(p)) return undefined;
	const line = readFileSync(p, 'utf8')
		.split(/\r?\n/)
		.find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
	if (!line) return undefined;
	return line.slice('CLAUDE_CODE_OAUTH_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
}

const TOKEN = readToken();
const live = TOKEN ? describe : describe.skip;

let tdb: TestDb;
let db: Db;
let projectId: string;
let taskId: string;
let workDir: string;
let harnessRoot: string;
let claudeDir: string;
let settingsPath: string;
let scope: SyncScope;

// The SAME task drives both runs — the only variable across A/B is the config edit. The task
// asks the agent to run a bash command, and to reply with exactly DENIED if it cannot. The
// marker is unique so the transcript assertion is unambiguous.
const BASH_MARKER = 'HELLO_FROM_BASH_2_11';
const TASK_DESC =
	`Run the bash command: echo ${BASH_MARKER}. ` +
	`If you are not permitted to run Bash, reply with exactly the single word DENIED and do nothing else.`;

// Run one real session on the throwaway project+task and return the joined transcript text.
async function runSessionTranscript(): Promise<string> {
	const backend = new ClaudeCliBackend({ oauthToken: TOKEN!, maxTurns: 3, timeoutMs: 180_000 });
	const runtime = new ClaudeCodeRuntime({
		backend,
		harnessConfigRoot: harnessRoot.replace(/\\/g, '/')
	});
	const bus = new EventBus();
	const res = await launchSession({
		db,
		bus,
		runtime,
		input: {
			projectId,
			taskId,
			agentId: 'agent_readback_211',
			model: { provider: 'claude', modelId: 'haiku', tier: 'haiku' },
			intent: 'code-write',
			budgets: { thinking: 'low', toolCalls: 3, concurrency: 1 },
			// The HARNESS tool policy permits Bash — so a refusal can ONLY come from the project
			// `.claude/settings.json` the config manager wrote, never from our own allow-list.
			toolPolicy: { allow: ['Bash', 'Read'] }
		}
	});
	expect(res.status).toBe('done');
	const sid = new StringRecordId(res.sessionId);
	const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM message WHERE session = $sid ORDER BY at ASC;`,
		{ sid }
	);
	return msgs.map((m) => String(m.content ?? '')).join('\n');
}

beforeAll(async () => {
	if (!TOKEN) return;
	workDir = mkdtempSync(join(tmpdir(), 'rb-proj-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'rb-harness-'));
	claudeDir = join(workDir, '.claude');
	mkdirSync(claudeDir, { recursive: true });
	settingsPath = join(claudeDir, 'settings.json');
	// Baseline (A): the project config ALLOWS Bash explicitly. This is the file the config
	// manager will later edit to add a deny — proving the read-back.
	writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2), 'utf8');
	scope = { kind: 'project', claudeDir };

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
		slug: 'rb_readback',
		name: 'Readback Proof',
		root_path: workDir.replace(/\\/g, '/')
	});
	projectId = p.id;
	const t = await createTask(db, { project: projectId, title: 'Config read-back', description: TASK_DESC });
	taskId = t.id;
}, 120_000);

afterAll(async () => {
	if (!TOKEN) return;
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	if (harnessRoot) rmSync(harnessRoot, { recursive: true, force: true });
});

live('LIVE 2.11 — a dashboard config edit is ACTIVE in a real launched session (read-back, D-010)', () => {
	it(
		'baseline ALLOWS Bash → applyEdit adds deny → the SAME task is then DENIED in a real session',
		async () => {
			// ── A: baseline — project config allows Bash; the real session RUNS Bash ──────────
			const before = await runSessionTranscript();
			expect(before).toContain(BASH_MARKER); // the bash command actually ran

			// ── The dashboard edit, through the BUILT config MANAGER (D-010 contract) ─────────
			// validate → diff + confirm token → write file → re-sync the cc_* mirror.
			const edited = JSON.stringify({ permissions: { allow: [], deny: ['Bash'] } }, null, 2);
			const plan = planEdit({ kind: 'settings', filePath: settingsPath, content: edited });
			expect(plan.validation.ok).toBe(true); // valid settings — never write garbage
			expect(plan.diff.unchanged).toBe(false); // it is a real change
			// The diff adds the `deny` rule the read-back hinges on.
			expect(plan.diff.hunks.some((h) => h.op === '+' && /"deny"/.test(h.line))).toBe(true);

			const applied = await applyEdit(db, {
				kind: 'settings',
				filePath: settingsPath,
				content: edited,
				confirmToken: plan.confirmToken, // mandatory confirm (never silently clobber)
				scope
			});
			expect(applied.bytesWritten).toBeGreaterThan(0);
			// The mirror re-synced lock-step with the new file (D-010): disk-vs-mirror is synced
			// and the cc_settings row now carries the new deny rule.
			const state = await syncState(db, scope);
			expect(state.status).toBe('synced');
			const [settingsRows] = await db.query<[Array<{ permissions: unknown }>]>(
				`SELECT permissions FROM cc_settings WHERE scope = $scope;`,
				{ scope: new StringRecordId(applied.sync.scopeId) }
			);
			const mirroredDeny = (settingsRows[0]?.permissions as { deny?: string[] })?.deny ?? [];
			expect(mirroredDeny).toContain('Bash');
			// And disk carries exactly what the manager wrote.
			expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.deny).toEqual(['Bash']);

			// ── B: after the edit — the SAME task in a fresh real session is DENIED Bash ───────
			const after = await runSessionTranscript();
			// The read-back: the newly-added deny is ACTIVE — the marker can no longer appear
			// (the command was blocked) and the agent reports the denial.
			expect(after).not.toContain(BASH_MARKER);
			expect(after.toUpperCase()).toContain('DENIED');
		},
		400_000
	);
});
