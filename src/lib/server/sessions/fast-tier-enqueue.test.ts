import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { EventBus } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import {
	MemoryService,
	FakeEmbedder,
	enqueueReview,
	type ExtractFn,
	type ReviewCadence
} from '../memory/index';
import { assertRecordId } from '../db/validate';
import { launchSession } from './launch';

// WI-2: these fast-tier tests launch code-write sessions against a non-git path fixture (their
// subject is the per-turn enqueue cadence, not git mechanics). A fake worktree acquirer exercises
// the persist path without a real repo; the worktree mechanics are proven in launch.test.ts.
const fakeWt = async (root: string, sid: string) => ({
	cwd: `${root}/.wt/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
	branch: `atelier/session/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
	cleanup: async () => {}
});

// BL-7 Part B (D-027 FAST tier ENQUEUE leg) — VERIFY the per-turn in-use writer fork is wired into
// the live session path (MEMORY-UTILIZATION-SPEC §5.2/§5.2a). The dead enqueue side (bumpCounters →
// dueReview → enqueueReview, loop.ts) had ZERO non-test callers; this proves launchSession now drives
// it against a REAL throwaway SurrealDB (FakeEmbedder for determinism — F-008: every row read back
// came from the real DB the stream produced). Proven here:
//   (1) a live session at CADENCE bumps the PERSISTED counters and enqueues ONE `memory_review` work_item;
//   (2) a session BELOW cadence enqueues NOTHING (no over-firing);
//   (3) rapid cadence turns COALESCE to ONE pending review per session (no per-turn storm — dedup);
//   (4) a planted SECRET in a turn is SCREENED before it is queued (never queued raw, D-026);
//   (5) the spawn verdict is UNCHANGED by the fast tier (best-effort, D-019).
// The interview-exclusion is proven structurally in loop.test.ts (enqueueReview returns null for
// kind='interview'); launchSession only ever creates kind='task' sessions, so an interview never
// reaches this seam — and even if it did, the engine-level guard refuses it.

/** A scripted backend that streams a fixed list of events then `done`. */
function scriptedBackend(events: RuntimeEvent[], ccSessionId: string): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId,
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return { ccSessionId: req.ccSessionId, async *stream() {}, async cancel() {} };
		},
		async interject() {}
	};
}

/** N assistant-text turns + a closing done — drives the "user turn" cadence axis. */
function nTextTurns(n: number, ccSessionId: string, body = 'working on it'): RuntimeEvent[] {
	const evs: RuntimeEvent[] = [];
	for (let i = 0; i < n; i++) evs.push({ type: 'log', message: `${body} ${i}` });
	evs.push({ type: 'done', result: { ok: true, summary: 'done', ccSessionId } });
	return evs;
}

let tdb: TestDb;
let db: Db;
let projectId: string;
let mem: MemoryService;

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
	const p = await createProject(db, { slug: 'fasttier', name: 'Fast Tier', root_path: 'F:/code/fasttier' });
	projectId = p.id;
	mem = new MemoryService({ db, embedder: new FakeEmbedder(), cache: false });
}, 90_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function makeTask(title: string, description: string): Promise<string> {
	const t = await createTask(db, { project: projectId, title, description });
	return t.id;
}

function runtimeFor(events: RuntimeEvent[], cc: string): ClaudeCodeRuntime {
	const backend = scriptedBackend(events, cc);
	return new ClaudeCodeRuntime({ backend, harnessConfigRoot: '.harness/claude-config' });
}

/** Count the memory_review work_items enqueued for a given session. */
async function reviewItemsFor(sessionId: string): Promise<Array<{ status: string; payload: { kind?: string; turnText?: string } }>> {
	const [rows] = await db.query<[Array<{ status: string; payload: { kind?: string; turnText?: string } }>]>(
		`SELECT status, payload FROM work_item WHERE work_type = 'memory_review' AND session = $sid;`,
		{ sid: new StringRecordId(assertRecordId(sessionId)) }
	);
	return rows;
}

/** A raw kind='interview' session row (the gauntlet shape) — for the exclusion red-team. */
async function makeInterviewSession(): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
		   kind: "interview", model: { provider: "claude", model_id: "claude-opus-4-8" }, runtime: "claude-code"
		 } RETURN AFTER;`
	);
	return String(rows[0].id);
}

/** A raw kind='task' session row (positive control for the exclusion test). */
async function makeTaskSessionRow(): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
		   kind: "task", model: { provider: "claude", model_id: "claude-opus-4-8" }, runtime: "claude-code"
		 } RETURN AFTER;`
	);
	return String(rows[0].id);
}

const noExtract: ExtractFn = async () => [];
// Memory-only cadence: fire every 2 user turns, never on tools (keeps the test deterministic + cheap).
const CADENCE_2: ReviewCadence = { memoryEveryNTurns: 2, skillEveryMTools: 1000 };

describe('BL-7 Part B — fast-tier enqueue wired into the live session path', () => {
	it('(1) a session AT cadence enqueues exactly one memory_review (counters persisted)', async () => {
		const taskId = await makeTask('Cadence task', 'Run enough turns to hit cadence.');
		// 3 text turns with memoryEveryNTurns=2 ⇒ due at turn 2 (one enqueue; the dedup coalesces turn≥2).
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtimeFor(nTextTurns(3, 'cc_cad_1'), 'cc_cad_1'),
			memory: { service: mem, extract: noExtract, cadence: CADENCE_2 },
			acquireWorktree: fakeWt,
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');

		const items = await reviewItemsFor(res.sessionId);
		expect(items).toHaveLength(1);
		expect(items[0].payload.kind).toBe('memory');
		expect(items[0].status).toBe('pending');

		// The PERSISTED counters advanced (3 text turns ⇒ user_turn_count 3).
		const [srow] = await db.query<[Array<{ user_turn_count: number; tool_iter_count: number }>]>(
			`SELECT user_turn_count, tool_iter_count FROM $sid;`,
			{ sid: new StringRecordId(assertRecordId(res.sessionId)) }
		);
		expect(srow[0].user_turn_count).toBe(3);
		expect(srow[0].tool_iter_count).toBe(0);
	});

	it('(2) a session BELOW cadence enqueues NOTHING (no over-firing)', async () => {
		const taskId = await makeTask('Sub-cadence task', 'Only one turn — below the cadence threshold.');
		// 1 text turn with cadence 2 ⇒ never due.
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtimeFor(nTextTurns(1, 'cc_sub_1'), 'cc_sub_1'),
			memory: { service: mem, extract: noExtract, cadence: CADENCE_2 },
			acquireWorktree: fakeWt,
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');
		expect(await reviewItemsFor(res.sessionId)).toHaveLength(0);
	});

	it('(3) rapid cadence turns COALESCE to ONE pending review (per-session dedup — no storm)', async () => {
		const taskId = await makeTask('Storm task', 'Many turns must still yield one pending review.');
		// 9 text turns, cadence 2 ⇒ due at turns 2,4,6,8 — but the per-session dedup_key coalesces
		// them while one is still pending → at most ONE pending memory_review.
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtimeFor(nTextTurns(9, 'cc_storm_1'), 'cc_storm_1'),
			memory: { service: mem, extract: noExtract, cadence: CADENCE_2 },
			acquireWorktree: fakeWt,
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');
		const items = await reviewItemsFor(res.sessionId);
		expect(items.filter((i) => i.status === 'pending')).toHaveLength(1);
	});

	it('(4) a planted SECRET in a turn is SCREENED before it is queued (never queued raw, D-026)', async () => {
		const SECRET = 'sk-ant-abcdefghij1234567890';
		const taskId = await makeTask('Leaky task', 'A turn echoes a secret; it must not be queued raw.');
		// Each turn echoes the secret; at cadence the queued payload.turnText must be redacted.
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtimeFor(nTextTurns(2, 'cc_leak_1', `use the key ${SECRET} now`), 'cc_leak_1'),
			memory: { service: mem, extract: noExtract, cadence: CADENCE_2 },
			acquireWorktree: fakeWt,
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');
		const items = await reviewItemsFor(res.sessionId);
		expect(items).toHaveLength(1);
		// The queued turnText carries NO raw secret — redacted by screen() before enqueue (and the
		// persisted transcript message rows are screened too by eventToMessage, defense in depth).
		expect(items[0].payload.turnText).not.toContain(SECRET);
		expect(items[0].payload.turnText).toContain('[REDACTED:anthropic-key]');
	});

	it('(5) fastTier:false disables the enqueue leg entirely (opt-out honoured)', async () => {
		const taskId = await makeTask('Opt-out task', 'fastTier disabled — no review even at cadence.');
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtimeFor(nTextTurns(4, 'cc_off_1'), 'cc_off_1'),
			memory: { service: mem, extract: noExtract, cadence: CADENCE_2, fastTier: false },
			acquireWorktree: fakeWt,
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');
		expect(await reviewItemsFor(res.sessionId)).toHaveLength(0);
	});

	it('(6) a quarantinable private-key turn is REDACTED in the queued payload (still enqueues, but never raw)', async () => {
		// A private-key PEM block quarantines but screen() still returns the REDACTED placeholder (not
		// the raw key) — so the queued turnText carries the placeholder, never the key material (D-026).
		const taskId = await makeTask('PEM turn', 'A turn pasting a private key must not queue it raw.');
		const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----';
		const evs: RuntimeEvent[] = [
			{ type: 'log', message: `here is a key ${KEY}` },
			{ type: 'log', message: `here is a key ${KEY}` },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_pem_1' } }
		];
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtimeFor(evs, 'cc_pem_1'),
			memory: { service: mem, extract: noExtract, cadence: CADENCE_2 },
			acquireWorktree: fakeWt,
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');
		const items = await reviewItemsFor(res.sessionId);
		expect(items).toHaveLength(1);
		expect(items[0].payload.turnText).not.toContain('MIIabc123');
		expect(items[0].payload.turnText).toContain('[REDACTED:private-key]');
	});

	it('(7) the spawn verdict is independent of the fast tier — best-effort, never blocking (D-019)', async () => {
		// A clean cadence run completes done; the fast-tier enqueue is fire-on-the-side observability,
		// never on the liveness path. (A thrown enqueue is caught + logged in launch.ts; the spawn loop
		// continues regardless — see the try/catch around the enqueue leg.)
		const taskId = await makeTask('Verdict-independent', 'Fast tier must never change the verdict.');
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtimeFor(nTextTurns(2, 'cc_res_1'), 'cc_res_1'),
			memory: { service: mem, extract: noExtract, cadence: CADENCE_2 },
			acquireWorktree: fakeWt,
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');
	});

	it('(RT) the interview-exclusion cannot be bypassed — an interview-kind session is NEVER enqueued', async () => {
		// The engine-level guard (loop.ts enqueueReview) reads the session row's kind from the DB and
		// REFUSES (null no-op) a kind='interview' session — so even a DIRECT enqueue with the same args
		// as the fast-tier hook cannot queue an interview transcript for mining. launchSession only ever
		// creates kind='task' sessions, so this seam is never reached for an interview; this proves the
		// structural backstop holds regardless of caller (gauntlet transcripts contain planted defects).
		const interviewSession = await makeInterviewSession();
		const taskSession = await makeTaskSessionRow();
		const refused = await enqueueReview(db, {
			session: interviewSession,
			kind: 'memory',
			project: projectId,
			turnText: 'an interview transcript with a planted defect'
		});
		expect(refused).toBeNull(); // refused — never enqueued
		// A normal task session with the same args DOES enqueue (positive control — the guard is
		// specific to interview, not a blanket refusal).
		const ok = await enqueueReview(db, {
			session: taskSession,
			kind: 'memory',
			project: projectId,
			turnText: 'a normal task turn'
		});
		expect(ok).not.toBeNull();
		// Zero work_items for the interview session; exactly one for the task session.
		expect(await reviewItemsFor(interviewSession)).toHaveLength(0);
		expect(await reviewItemsFor(taskSession)).toHaveLength(1);
	});
});
