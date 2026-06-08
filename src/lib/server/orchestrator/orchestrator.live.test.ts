// LIVE PROOF 2.2 — drive the BUILT orchestrator end-to-end with the REAL runtime.
//
// Unlike orchestrator.test.ts (a gated MOCK backend), THIS wires the SAME built
// Orchestrator (event mode, degenerate route) to the REAL ClaudeCodeRuntime + the REAL
// credentialed ClaudeCliBackend (isolated config, D-002), against a REAL throwaway
// SurrealDB. It then drives the FULL production trigger path exactly as production wires
// it (ARCHITECTURE §2.2/§2.11; D-004; DATA-MODEL §4.12):
//
//   task-created → setStatus('ready') → events/watchTable live query → events BUS →
//   Orchestrator.#onTrigger → enqueueTask (work_item claim queue) → drain →
//   claimNext (atomic SELECT-then-claim-by-id) → launchSession → REAL `claude` spawn →
//   a real cc_session_id bridged onto the session row.
//
// ASSERTIONS (the 2.2 contract under the REAL runtime):
//   • EXACTLY ONE spawn — orch.spawnCount === 1, one work_item claimed/done, no extra.
//   • NO double-fire — the orchestrator subscribes the BUS only (§2.11); after settle,
//     still exactly one spawn / one done work_item / zero pending.
//   • The interactive semaphore CAP is respected — never more than maxConcurrent in use
//     (peak observed === 1 with maxConcurrent=1 while the single live run is in flight).
//   • A REAL cc_session_id was recorded on the session row + is queryable by index (D-011).
//
// F-008 discipline: nothing is fabricated. Every assertion reads a row the LIVE runtime
// stream actually wrote, or a counter the real drain actually incremented. If no token is
// present (Anthropic unreachable / no creds) the suite is SKIPPED — an honest deferral,
// not a faked artifact. The session runs cwd-confined in an OS temp dir; it never touches
// other projects and never pushes.

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
import { createTask, setStatus } from '../tasks/repo';
import { EventBus } from '../events/bus';
import { watchTable } from '../events/db-source';
import { ClaudeCodeRuntime } from '../runtime/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';
import { Orchestrator, type StubRoute } from './index';
import { countByStatus } from './workqueue';

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

/** The DEGENERATE stub route (2.2): a cheap single bounded haiku turn, Read-only. */
function stubRoute(): StubRoute['agentId'] extends never ? never : (t: string, p: string) => StubRoute {
	return () => ({
		agentId: 'agent_coder_live_2_2',
		model: { provider: 'claude', modelId: 'haiku', tier: 'haiku' },
		intent: 'simple-question',
		budgets: { thinking: 'low', toolCalls: 1, concurrency: 1 },
		toolPolicy: { allow: ['Read'] }
	});
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 200_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
		await new Promise((r) => setTimeout(r, 100));
	}
}

let tdb: TestDb;
let db: Db;
let projectId: string;
let workDir: string;
let harnessRoot: string;

beforeAll(async () => {
	if (!TOKEN) return;
	workDir = mkdtempSync(join(tmpdir(), 'live-orch-proj-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'live-orch-harness-'));
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
		slug: 'live_orch_2_2',
		name: 'Live Orchestrator 2.2',
		root_path: workDir.replace(/\\/g, '/')
	});
	projectId = p.id;
}, 120_000);

afterAll(async () => {
	if (!TOKEN) return;
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	if (harnessRoot) rmSync(harnessRoot, { recursive: true, force: true });
});

live('LIVE 2.2 — orchestrator drives EXACTLY ONE real spawn end-to-end (D-004, §2.11)', () => {
	it(
		'task→ready → bus → claim queue → REAL launchSession spawn → one cc_session_id; one spawn, no double-fire, cap respected',
		async () => {
			const backend = new ClaudeCliBackend({ oauthToken: TOKEN!, maxTurns: 1, timeoutMs: 180_000 });
			const runtime = new ClaudeCodeRuntime({
				backend,
				harnessConfigRoot: harnessRoot.replace(/\\/g, '/')
			});

			const bus = new EventBus();
			// maxConcurrent = 1: with a single ready task the interactive cap must hold the
			// peak in-flight count at exactly 1; a double-fire would breach it.
			const orch = new Orchestrator({
				db,
				bus,
				runtime,
				maxConcurrent: 1,
				mode: 'event',
				route: stubRoute()
			});
			orch.start();
			// The ONLY live query is events/watchTable — the orchestrator never opens its own (§2.11).
			const watch = await watchTable(db, bus, 'task');

			// Sample the interactive semaphore while the live run is in flight: it must NEVER
			// exceed the cap. A background sampler records the peak `inUse` count.
			let semPeak = 0;
			const sampler = setInterval(() => {
				semPeak = Math.max(semPeak, orch.semaphore.inUse);
			}, 25);

			try {
				const task = await createTask(db, {
					project: projectId,
					title: 'Live 2.2 orchestrated proof',
					description:
						'Reply with exactly the single word PONG and nothing else. Do not use any tools.'
				});
				// backlog → ready: the live-query trigger seed fans this onto the bus, which the
				// orchestrator consumes → enqueue → claim → REAL spawn. This is the sole trigger.
				await setStatus(db, task.id, 'ready');

				// The REAL session ran to completion (one real `claude` subprocess).
				await waitFor(() => orch.spawnCount >= 1);

				// Settle generously: give any erroneous extra trigger/spawn a chance to surface
				// (a double-fire would enqueue/claim/spawn a SECOND real session).
				await new Promise((r) => setTimeout(r, 1500));
				clearInterval(sampler);

				// ── EXACTLY ONE spawn — no double-fire (bus-only subscription, §2.11) ───────
				expect(orch.spawnCount).toBe(1);
				expect(await countByStatus(db, 'done')).toBe(1);
				expect(await countByStatus(db, 'pending')).toBe(0);
				expect(await countByStatus(db, 'processing')).toBe(0);

				// ── The interactive semaphore CAP was respected throughout ─────────────────
				expect(semPeak).toBeLessThanOrEqual(1);
				expect(orch.semaphore.inUse).toBe(0); // permit released after the run ended

				// ── A REAL session persisted for OUR task, with the cc_session_id bridge ────
				const [srows] = await db.query<[Array<Record<string, unknown>>]>(
					`SELECT * FROM session WHERE task = $tid;`,
					{ tid: new StringRecordId(task.id) }
				);
				expect(srows.length).toBe(1); // EXACTLY ONE session — confirms exactly one spawn
				const sess = srows[0];
				expect(String(sess.project)).toBe(projectId);
				expect(sess.runtime).toBe('claude-code');
				expect(sess.status).toBe('done');
				expect(sess.ended_at).toBeTruthy();

				// The CLI reported a REAL session id, bridged onto the session row (D-011) and
				// queryable by the cc index — the live transcript is findable by its real id.
				const ccSessionId = sess.cc_session_id;
				expect(ccSessionId).toBeTruthy();
				expect(String(ccSessionId)).toMatch(/[0-9a-f-]{8,}/i);
				const [byCc] = await db.query<[Array<Record<string, unknown>>]>(
					`SELECT id FROM session WHERE cc_session_id = $cc;`,
					{ cc: ccSessionId }
				);
				expect(byCc.length).toBe(1);
				expect(String(byCc[0].id)).toBe(String(sess.id));

				// ── The real turn was transcribed; the model actually replied ──────────────
				const sid = new StringRecordId(String(sess.id));
				const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
					`SELECT * FROM message WHERE session = $sid;`,
					{ sid }
				);
				const reply = msgs
					.filter((m) => m.role === 'assistant')
					.map((m) => String(m.content))
					.join('\n');
				expect(reply.toUpperCase()).toContain('PONG');

				// ── Analytics first-class: spawn + completion agent_events with real totals ─
				const [evs] = await db.query<[Array<Record<string, unknown>>]>(
					`SELECT * FROM agent_event WHERE session = $sid;`,
					{ sid }
				);
				const types = evs.map((e) => e.type);
				expect(types).toContain('spawn');
				expect(types).toContain('completion');
				const completion = evs.find((e) => e.type === 'completion')!;
				expect(Number(completion.tokens_out)).toBeGreaterThan(0);
				expect(Number(completion.duration_ms)).toBeGreaterThan(0);
			} finally {
				clearInterval(sampler);
				orch.stop();
				await watch.stop();
			}
		},
		240_000
	);
});
