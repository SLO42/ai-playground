// LIVE PROOF 1.6 (capstone) — closes v0.1 10/10.
//
// Unlike launch.test.ts (mocked backend), THIS launches a REAL credentialed Claude Code
// session via the built launchSession + the 1.4 ClaudeCodeRuntime + the REAL ClaudeCliBackend
// (isolated config, D-002), for a THROWAWAY project+task, against a REAL throwaway SurrealDB.
// It then reads BACK the persisted rows the live runtime stream actually produced:
//   • a `session` row with the cc_session_id bridge = the real CLI session_id (D-011),
//   • `message` rows transcribed from the real turn,
//   • `agent_event` rows (spawn + completion with real token totals).
//
// F-008 discipline: nothing is fabricated. Every assertion reads a row the live stream
// wrote. If no token is present (Anthropic unreachable / no creds) the suite is SKIPPED —
// the deferral is honest, not a faked artifact. The session runs cwd-confined in an OS temp
// dir; it never touches other projects and never pushes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { EventBus, type BusEvent } from '../events/bus';
import { ClaudeCodeRuntime } from '../runtime/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';
import { launchSession } from './launch';

/** Read CLAUDE_CODE_OAUTH_TOKEN from process env or the worktree .env (never logged). */
function readToken(): string | undefined {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	// repo root is two levels up from src/lib — resolve the worktree .env explicitly.
	const candidates = [join(process.cwd(), '.env')];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		const line = readFileSync(p, 'utf8')
			.split(/\r?\n/)
			.find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
		if (line) {
			return line
				.slice('CLAUDE_CODE_OAUTH_TOKEN='.length)
				.trim()
				.replace(/^["']|["']$/g, '');
		}
	}
	return undefined;
}

const TOKEN = readToken();
const live = TOKEN ? describe : describe.skip;

let tdb: TestDb;
let db: Db;
let projectId: string;
let taskId: string;
let workDir: string;
let harnessRoot: string;

beforeAll(async () => {
	if (!TOKEN) return;
	workDir = mkdtempSync(join(tmpdir(), 'live-proj-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'live-harness-'));
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
		slug: 'live_capstone',
		name: 'Live Capstone',
		root_path: workDir.replace(/\\/g, '/')
	});
	projectId = p.id;
	const t = await createTask(db, {
		project: projectId,
		title: 'Live capstone proof',
		description:
			'Reply with exactly the single word PONG and nothing else. Do not use any tools.'
	});
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

live('LIVE 1.6 capstone — real credentialed transcript persists + renders live (D-011)', () => {
	it(
		'launches a REAL session; session(+cc_session_id) + message + agent_event rows persist and are queryable',
		async () => {
			const backend = new ClaudeCliBackend({
				oauthToken: TOKEN!,
				maxTurns: 1,
				timeoutMs: 180_000
			});
			const runtime = new ClaudeCodeRuntime({
				backend,
				harnessConfigRoot: harnessRoot.replace(/\\/g, '/')
			});

			// Capture the live-render path: every transcript bus event the SSE fan-out consumes.
			const bus = new EventBus();
			const transcriptEvents: BusEvent[] = [];
			bus.subscribe(
				(e) => transcriptEvents.push(e),
				(e) => e.type === 'transcript'
			);

			const res = await launchSession({
				db,
				bus,
				runtime,
				input: {
					projectId,
					taskId,
					agentId: 'agent_coder_live',
					model: { provider: 'claude', modelId: 'haiku', tier: 'haiku' },
					intent: 'simple-question',
					budgets: { thinking: 'low', toolCalls: 1, concurrency: 1 },
					toolPolicy: { allow: ['Read'] }
				}
			});

			// ── The session ran and ended (a REAL run, not a mock) ──────────────────────
			expect(res.status).toBe('done');
			// The CLI reported a real session id, bridged onto the session row (D-011).
			expect(res.ccSessionId).toBeTruthy();
			expect(res.ccSessionId).toMatch(/[0-9a-f-]{8,}/i);

			// ── session row persisted with the cc_session_id bridge ─────────────────────
			const [srows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
				rid: new StringRecordId(res.sessionId)
			});
			const sess = srows[0];
			expect(sess).toBeTruthy();
			expect(sess.cc_session_id).toBe(res.ccSessionId);
			expect(String(sess.project)).toBe(projectId);
			expect(String(sess.task)).toBe(taskId);
			expect(sess.runtime).toBe('claude-code');
			expect(sess.status).toBe('done');
			expect(sess.ended_at).toBeTruthy();

			// The cc_session_id bridge is QUERYABLE by the index (session_cc) — the live
			// transcript is findable by its real Claude Code session id.
			const [byCc] = await db.query<[Array<Record<string, unknown>>]>(
				`SELECT id FROM session WHERE cc_session_id = $cc;`,
				{ cc: res.ccSessionId }
			);
			expect(byCc.length).toBe(1);
			expect(String(byCc[0].id)).toBe(res.sessionId);

			// ── message rows transcribed from the REAL turn ─────────────────────────────
			const sid = new StringRecordId(res.sessionId);
			const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
				`SELECT * FROM message WHERE session = $sid ORDER BY at ASC;`,
				{ sid }
			);
			expect(msgs.length).toBeGreaterThanOrEqual(1);
			// The model's text reply was transcribed as an assistant message.
			const assistant = msgs.filter((m) => m.role === 'assistant');
			expect(assistant.length).toBeGreaterThanOrEqual(1);
			const replyText = assistant.map((m) => String(m.content)).join('\n');
			expect(replyText.toUpperCase()).toContain('PONG');

			// ── agent_event rows: spawn + completion with REAL token totals ─────────────
			const [evs] = await db.query<[Array<Record<string, unknown>>]>(
				`SELECT * FROM agent_event WHERE session = $sid ORDER BY at ASC;`,
				{ sid }
			);
			const types = evs.map((e) => e.type);
			expect(types).toContain('spawn');
			expect(types).toContain('completion');
			const completion = evs.find((e) => e.type === 'completion')!;
			// Real, non-zero token accounting flowed from the live result event.
			expect(Number(completion.tokens_out)).toBeGreaterThan(0);
			expect(Number(completion.duration_ms)).toBeGreaterThan(0);
			expect(String(completion.project)).toBe(projectId);

			// ── render-live path: transcript bus events were emitted per stream event ───
			expect(transcriptEvents.length).toBeGreaterThanOrEqual(1);
			expect(transcriptEvents.every((e) => e.topic === res.sessionId)).toBe(true);
		},
		200_000
	);
});
