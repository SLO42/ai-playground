// LIVE PROOF 8.4 — HOOK→agent_event END-TO-END through a REAL driven session.
//
// This is the capstone for TASK 8.4: it proves the WHOLE live hook path fires, not just the
// pieces. A REAL credentialed Claude Code session is launched with the SAME runtime wiring
// getRuntime() now produces — the isolated settings.json carries the D-019 hook block (built by
// buildDrivenHookSettings) that invokes the REAL scripts/hook-proxy.mjs. Claude Code runs those
// lifecycle hooks; each one POSTs the loopback ingest endpoint (the REAL authorize → ingest
// logic) which writes `agent_event type:'hook'` rows into a REAL throwaway SurrealDB. We then
// read those rows back — proof the live hook path lands per lifecycle step.
//
// F-008: nothing is fabricated. The HOOK rows asserted were written by hooks the real CC
// process actually fired, POSTing the real proxy → the real ingest → the real DB. If no
// credential is present the suite is SKIPPED (honest deferral, not a faked artifact). The
// session is cwd-confined to an OS temp dir; it never touches other projects and never pushes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { EventBus } from '../events/bus';
import { ClaudeCodeRuntime } from '../runtime/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';
import { buildDrivenHookSettings } from '../harness/hooks-wiring';
import { authorizeHookRequest, ingestHookEvent } from './ingest';
import { launchSession } from '../sessions/launch';

/** Read CLAUDE_CODE_OAUTH_TOKEN from process env or the worktree .env (never logged). */
function readToken(): string | undefined {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	const p = join(process.cwd(), '.env');
	if (existsSync(p)) {
		const line = readFileSync(p, 'utf8')
			.split(/\r?\n/)
			.find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
		if (line) {
			return line.slice('CLAUDE_CODE_OAUTH_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
		}
	}
	return undefined;
}

const TOKEN = readToken();
const live = TOKEN ? describe : describe.skip;
const HOOK_TOKEN = 'live-8-4-boot-token';

let tdb: TestDb;
let db: Db;
let projectId: string;
let taskId: string;
let workDir: string;
let harnessRoot: string;
let ingestServer: Server;
let ingestUrl: string;
/** Every hook event the live proxy actually delivered (recorded by the real ingest handler). */
const delivered: string[] = [];
/** Env we set on process so the CLI-spawned proxy (inherits process.env) POSTs OUR server. */
let prevHookUrl: string | undefined;
let prevHookToken: string | undefined;

/** Stand up the loopback ingest stub running the REAL authorize→ingest→DB-write pipeline. */
async function startIngest(): Promise<void> {
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', async () => {
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === 'string') headers.set(k, v);
			}
			const auth = authorizeHookRequest(headers, { HOOK_TOKEN });
			let payload: unknown = {};
			try {
				payload = JSON.parse(body);
			} catch {
				payload = {};
			}
			let result: Record<string, never> = {};
			if (auth.ok) {
				const event = (req.url ?? '').replace('/api/hooks/', '');
				result = await ingestHookEvent(event, payload, {
					// REAL write into the throwaway DB — the same CREATE the +server.ts seam runs.
					write: async (table, row) => {
						delivered.push(event);
						await db.query(`CREATE type::table($t) CONTENT $row;`, { t: table, row });
					}
				});
			}
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(result));
		});
	};
	ingestServer = createServer(handler);
	await new Promise<void>((r) => ingestServer.listen(0, '127.0.0.1', r));
	const addr = ingestServer.address();
	if (!addr || typeof addr === 'string') throw new Error('no ingest address');
	ingestUrl = `http://127.0.0.1:${addr.port}`;
}

beforeAll(async () => {
	if (!TOKEN) return;
	workDir = mkdtempSync(join(tmpdir(), 'live-hook-proj-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'live-hook-harness-'));
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	await startIngest();
	// The CLI backend spawns with ...process.env, so the inherited proxy reads these (D-025).
	prevHookUrl = process.env.HOOK_URL;
	prevHookToken = process.env.HOOK_TOKEN;
	process.env.HOOK_URL = ingestUrl;
	process.env.HOOK_TOKEN = HOOK_TOKEN;

	const p = await createProject(db, {
		slug: 'live_hook_84',
		name: 'Live Hook 8.4',
		root_path: workDir.replace(/\\/g, '/')
	});
	projectId = p.id;
	const t = await createTask(db, {
		project: projectId,
		title: 'Live hook proof',
		description: 'Reply with exactly the single word PONG and nothing else. Do not use any tools.'
	});
	taskId = t.id;
}, 120_000);

afterAll(async () => {
	if (!TOKEN) return;
	process.env.HOOK_URL = prevHookUrl;
	process.env.HOOK_TOKEN = prevHookToken;
	await new Promise<void>((r) => ingestServer?.close(() => r()));
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	if (harnessRoot) rmSync(harnessRoot, { recursive: true, force: true });
});

live('LIVE 8.4 — real driven session fires lifecycle hooks → agent_event rows land', () => {
	it(
		'the isolated settings carry the hook block; a real session POSTs the proxy → ingest → hook agent_event rows',
		async () => {
			// Build the runtime EXACTLY as getRuntime() does — WITH the D-019 hook block. projectRoot
			// is the worktree so the block references the REAL scripts/hook-proxy.mjs that ships here.
			const hooks = buildDrivenHookSettings({
				env: { HOOK_URL: ingestUrl, HOOK_TOKEN },
				projectRoot: process.cwd()
			});
			expect(hooks, 'hook block must be wired when coordinates are present').toBeTruthy();

			const backend = new ClaudeCliBackend({ oauthToken: TOKEN!, maxTurns: 1, timeoutMs: 180_000 });
			const runtime = new ClaudeCodeRuntime({
				backend,
				harnessConfigRoot: harnessRoot.replace(/\\/g, '/'),
				hooks
			});

			const bus = new EventBus();
			const res = await launchSession({
				db,
				bus,
				runtime,
				input: {
					projectId,
					taskId,
					agentId: 'agent_hook_live',
					model: { provider: 'claude', modelId: 'haiku', tier: 'haiku' },
					intent: 'simple-question',
					budgets: { thinking: 'low', toolCalls: 1, concurrency: 1 },
					toolPolicy: { allow: ['Read'] }
				}
			});
			expect(res.status).toBe('done');

			// Give the lifecycle hooks time to land. The hooks run as short-lived proxy subprocesses
			// around the session edges; their loopback POST can complete a few seconds after
			// launchSession returns (the proxy is fire-and-forget by design, D-019). Poll the DB for
			// up to ~15s rather than a fixed sleep so the test is robust, not flaky.
			const deadline = Date.now() + 15_000;
			let hookCount = 0;
			while (Date.now() < deadline) {
				const [c] = await db.query<[Array<{ c: number }>]>(
					`SELECT count() AS c FROM agent_event WHERE type = 'hook' GROUP ALL;`
				);
				hookCount = c?.[0]?.c ?? 0;
				if (hookCount >= 1 && delivered.includes('SessionStart')) break;
				await new Promise((r) => setTimeout(r, 750));
			}

			// ── HOOK agent_event rows landed from the REAL fired hooks ───────────────────
			const [hookRows] = await db.query<[Array<Record<string, unknown>>]>(
				`SELECT type, detail, at FROM agent_event WHERE type = 'hook' ORDER BY at ASC;`
			);
			expect(hookRows.length, 'at least one lifecycle hook fired and was recorded').toBeGreaterThanOrEqual(1);

			// The rows carry the how/why detail (the hook event name) — observability, not noise.
			const firedEvents = new Set(
				hookRows.map((r) => (r.detail as { hook_event?: string } | undefined)?.hook_event)
			);
			// Every recorded hook row carries a WIRED lifecycle event (D-019) — no garbage type.
			const WIRED = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
			for (const e of firedEvents) expect(WIRED.has(e as string)).toBe(true);
			// SessionStart fires first on every driven session — the proven floor. Assert it both
			// delivered end-to-end through the live proxy AND recorded as a hook agent_event row.
			expect(delivered).toContain('SessionStart');
			expect(firedEvents.has('SessionStart')).toBe(true);
		},
		200_000
	);
});
