// LIVE PROOF 2.17 — a multi-step workflow_run where EACH step is a REAL credentialed
// Claude Code session (the §4.11 "each executing step is a session" contract, D-013).
//
// Unlike runner.test.ts (scripted/mock backend), THIS drives the built runWorkflow + the
// 1.4 ClaudeCodeRuntime + the REAL ClaudeCliBackend (isolated config, D-002) against a
// REAL throwaway SurrealDB, for a THROWAWAY project whose steps each run in an OS temp dir.
// It then reads BACK the rows the live runtime actually produced:
//   • the workflow_run row reaches status "done" with every step "done" (the DAG ran),
//   • exactly one `session` row PER STEP, each linked to THIS workflow_run (§4.11),
//   • each step session carries a REAL cc_session_id bridge (D-011) and NO task link (§6.1),
//   • each step session has a REAL transcribed assistant `message` (a real per-step transcript),
//   • each step session has spawn + completion `agent_event` rows with real token totals.
//
// The DAG is a → {b, c}: `a` is a serialization gate; b and c fan out from it. Each step's
// prompt asks for a distinct deterministic single word so the real transcripts are verifiable
// and attributable to the right step.
//
// F-008 discipline: nothing is fabricated. Every assertion reads a row the live stream wrote.
// If no token is present (Anthropic unreachable / no creds) the suite is SKIPPED — the
// deferral is honest, not a faked artifact. Each step runs cwd-confined in an OS temp dir;
// it never touches other projects and never pushes.

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
import { EventBus, type BusEvent } from '../events/bus';
import { ClaudeCodeRuntime } from '../runtime/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';
import { createWorkflow, getWorkflowRun, type WorkflowStep } from './repo';
import { runWorkflow } from './runner';

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

const M = { provider: 'claude', modelId: 'haiku', tier: 'haiku' as const };

let tdb: TestDb;
let db: Db;
let projectId: string;
let workDir: string;
let harnessRoot: string;

/** A live step: a single bounded turn asking for one distinct deterministic word. */
function liveStep(over: Partial<WorkflowStep> & { id: string; word: string }): WorkflowStep {
	const { word, ...rest } = over;
	return {
		prompt: `Reply with exactly the single word ${word} and nothing else. Do not use any tools.`,
		agent: `agent_${over.id}_live`,
		model: M,
		cwd: workDir.replace(/\\/g, '/'),
		...rest
	};
}

beforeAll(async () => {
	if (!TOKEN) return;
	workDir = mkdtempSync(join(tmpdir(), 'live-wf-proj-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'live-wf-harness-'));
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
		slug: 'live_wf',
		name: 'Live Workflow Host',
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

live('LIVE 2.17 — multi-step workflow_run, each step a REAL credentialed CC session (§4.11)', () => {
	it(
		'a real 3-step DAG runs to "done"; per-step session records persist with real transcripts',
		async () => {
			const backend = new ClaudeCliBackend({ oauthToken: TOKEN!, maxTurns: 1, timeoutMs: 180_000 });
			const runtime = new ClaudeCodeRuntime({
				backend,
				harnessConfigRoot: harnessRoot.replace(/\\/g, '/')
			});

			// a → {b, c}. Distinct deterministic words per step so each real transcript is attributable.
			const words: Record<string, string> = { a: 'ALPHA', b: 'BRAVO', c: 'CHARLIE' };
			const wf = await createWorkflow(db, {
				name: 'live-three-step',
				project: projectId,
				steps: [
					liveStep({ id: 'a', word: words.a }),
					liveStep({ id: 'b', word: words.b, depends_on: ['a'] }),
					liveStep({ id: 'c', word: words.c, depends_on: ['a'] })
				]
			});

			// Capture the render-live path (transcript bus events the SSE fan-out consumes).
			const bus = new EventBus();
			const transcripts: BusEvent[] = [];
			bus.subscribe(
				(e) => transcripts.push(e),
				(e) => e.type === 'transcript'
			);

			const res = await runWorkflow({
				db,
				bus,
				runtime,
				workflow: wf.id,
				// haiku, one bounded turn, no tools — a fast, cheap, deterministic live step.
				intent: 'simple-question',
				budgets: { thinking: 'low', toolCalls: 1, concurrency: 2 },
				toolPolicy: { allow: ['Read'] }
			});

			// ── The DAG ran to completion under the REAL runtime ────────────────────────
			expect(res.status).toBe('done');
			expect(res.stepState).toEqual({ a: 'done', b: 'done', c: 'done' });
			expect(Object.keys(res.sessions).sort()).toEqual(['a', 'b', 'c']);

			// ── The workflow_run row is the durable tracked record ──────────────────────
			const run = await getWorkflowRun(db, res.runId);
			expect(run?.status).toBe('done');
			expect(run?.step_state).toEqual({ a: 'done', b: 'done', c: 'done' });
			expect(run?.workflow).toBe(wf.id);

			// ── Per-step session records: exactly one session per step, each linked to THIS
			// run (the §4.11 "each executing step is a session" contract). Read from the DB. ─
			const [sessRows] = await db.query<[Array<Record<string, unknown>>]>(
				`SELECT id, workflow_run, task, cc_session_id, runtime, status, ended_at FROM session WHERE workflow_run = $rid;`,
				{ rid: new StringRecordId(res.runId) }
			);
			expect(sessRows.length).toBe(3);
			expect(sessRows.every((s) => String(s.workflow_run) === res.runId)).toBe(true);
			// A workflow step has NO task row (option<record<task>> omitted, §6.1).
			expect(sessRows.every((s) => s.task == null)).toBe(true);
			// Every step ran the REAL runtime: real cc_session_id bridge + done + ended.
			expect(sessRows.every((s) => s.runtime === 'claude-code')).toBe(true);
			expect(sessRows.every((s) => s.status === 'done')).toBe(true);
			expect(sessRows.every((s) => Boolean(s.ended_at))).toBe(true);
			expect(
				sessRows.every((s) => typeof s.cc_session_id === 'string' && /[0-9a-f-]{8,}/i.test(String(s.cc_session_id)))
			).toBe(true);
			// All three reported step session ids exist as rows linked to the run.
			for (const sid of Object.values(res.sessions)) {
				expect(sessRows.some((s) => String(s.id) === sid)).toBe(true);
			}

			// ── Each step session has a REAL transcribed assistant transcript matching its
			// distinct prompt word (proves a real per-step Claude Code turn, not a mock). ───
			for (const [stepId, sessionId] of Object.entries(res.sessions)) {
				const sid = new StringRecordId(sessionId);
				const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
					`SELECT role, content FROM message WHERE session = $sid;`,
					{ sid }
				);
				const assistant = msgs.filter((m) => m.role === 'assistant');
				expect(assistant.length).toBeGreaterThanOrEqual(1);
				const reply = assistant.map((m) => String(m.content)).join('\n').toUpperCase();
				expect(reply).toContain(words[stepId]);

				// spawn + completion agent_events with real, non-zero token + duration accounting.
				const [evs] = await db.query<[Array<Record<string, unknown>>]>(
					`SELECT type, tokens_out, duration_ms FROM agent_event WHERE session = $sid;`,
					{ sid }
				);
				const types = evs.map((e) => e.type);
				expect(types).toContain('spawn');
				expect(types).toContain('completion');
				const completion = evs.find((e) => e.type === 'completion')!;
				expect(Number(completion.tokens_out)).toBeGreaterThan(0);
				expect(Number(completion.duration_ms)).toBeGreaterThan(0);
			}

			// ── render-live path: each step session republished its real stream onto the bus ─
			const topics = new Set(transcripts.map((e) => e.topic));
			for (const sessionId of Object.values(res.sessions)) {
				expect(topics.has(sessionId)).toBe(true);
			}
		},
		300_000
	);
});
