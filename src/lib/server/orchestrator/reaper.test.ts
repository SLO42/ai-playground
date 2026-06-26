import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createWorkflow } from '../workflows/repo';
import { createTask, resetStuckTaskToReady, resetStuckTaskToFailed } from '../tasks/repo';
import { releaseSessionWork } from './workqueue';
import { reapStaleRuns, processBootTime, REAPED_NOTE } from './reaper';

// TASK 13.2 VERIFY — the boot-time reaper (FINDING 13.2c). A hard server death writes no
// terminal status, so session/workflow_run rows from a previous boot stay 'running'
// forever (phantom running agents; work_item had a reaper — these tables had none).
// reapStaleRuns must mark every pre-boot 'running' row 'failed' with the honest note
// (F-008) + ended_at, write an `error` agent_event per reaped session, and leave fresh
// 'running' rows + already-terminal rows untouched. All rows are created in and read
// back from a REAL throwaway SurrealDB.

let tdb: TestDb;
let db: Db;
let projectId: string;
let workflowId: string;

/** model object in the session row's persisted shape (model.provider / model.model_id). */
const MODEL = { provider: 'claude', model_id: 'claude-opus-4-8', tier: 'opus' };

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
	const p = await createProject(db, { slug: 'reap', name: 'Reaper Host', root_path: 'F:/code/reap' });
	projectId = p.id;
	const wf = await createWorkflow(db, {
		name: 'reaper-wf',
		project: projectId,
		steps: [
			{ id: 'a', prompt: 'do a', agent: 'agent_a', model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' }, cwd: 'F:/code/reap' }
		]
	});
	workflowId = wf.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** Insert a session row directly (the wedged-state simulation — no launch path). */
async function makeSession(over: Record<string, unknown>): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT $content RETURN AFTER;`,
		{
			content: {
				project: new StringRecordId(projectId),
				kind: 'task',
				model: MODEL,
				runtime: 'claude-code',
				...over
			}
		}
	);
	return String(rows[0].id);
}

/** Insert a workflow_run row directly (the wedged-state simulation). */
async function makeRun(over: Record<string, unknown>): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE workflow_run CONTENT $content RETURN AFTER;`,
		{
			content: {
				workflow: new StringRecordId(workflowId),
				status: 'running',
				step_state: {},
				...over
			}
		}
	);
	return String(rows[0].id);
}

async function readRow(id: string): Promise<Record<string, unknown>> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
		rid: new StringRecordId(id)
	});
	return rows[0];
}

describe('reapStaleRuns — boot-time recovery of wedged running rows (13.2)', () => {
	it("reaps pre-boot 'running' session + workflow_run rows to 'failed' with the honest note; fresh + terminal rows untouched; idempotent", async () => {
		const past = new Date(Date.now() - 60_000);

		// The wedged state a previous boot left behind (started BEFORE this "boot").
		const stuckSession = await makeSession({ status: 'running', started_at: past });
		const stuckRun = await makeRun({ started_at: past });
		// A session THIS boot started (started_at defaults to time::now() — after the cutoff).
		const freshSession = await makeSession({ status: 'running' });
		// An already-terminal pre-boot row — never touched.
		const doneSession = await makeSession({ status: 'done', started_at: past, ended_at: past });

		const bootTime = new Date(Date.now() - 5_000); // after the stuck rows, before fresh
		const res = await reapStaleRuns(db, bootTime);
		// The stuck session carries no task and no claimed work_items → recovery counts are 0.
		expect(res).toEqual({ sessions: 1, workflowRuns: 1, releasedWorkItems: 0, resetTasks: 0 });

		// The stuck session is honestly failed (F-008): terminal status + ended_at + note.
		const s = await readRow(stuckSession);
		expect(s.status).toBe('failed');
		expect(s.ended_at).toBeTruthy();
		expect(s.note).toBe(REAPED_NOTE);

		// The reap is recorded as an `error` agent_event (analytics first-class).
		const [evs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT * FROM agent_event WHERE session = $sid AND type = "error";`,
			{ sid: new StringRecordId(stuckSession) }
		);
		expect(evs.length).toBe(1);
		const detail = evs[0].detail as Record<string, unknown>;
		expect(detail.error).toBe(REAPED_NOTE);
		expect(detail.by).toBe('reaper');

		// The stuck workflow_run is failed + stamped too.
		const r = await readRow(stuckRun);
		expect(r.status).toBe('failed');
		expect(r.ended_at).toBeTruthy();
		expect(r.note).toBe(REAPED_NOTE);

		// A run THIS boot started is untouched (still running, no note).
		const fresh = await readRow(freshSession);
		expect(fresh.status).toBe('running');
		expect(fresh.note ?? null).toBeNull();

		// An already-terminal row is untouched (status + absence of note preserved).
		const done = await readRow(doneSession);
		expect(done.status).toBe('done');
		expect(done.note ?? null).toBeNull();

		// Idempotent: a second sweep finds nothing 'running' pre-boot and reaps zero.
		expect(await reapStaleRuns(db, bootTime)).toEqual({
			sessions: 0,
			workflowRuns: 0,
			releasedWorkItems: 0,
			resetTasks: 0
		});

		// Cleanup the fresh row so it can't leak into other assertions.
		await db.query(`UPDATE $rid SET status = 'cancelled', ended_at = time::now();`, {
			rid: new StringRecordId(freshSession)
		});
	});

	it('processBootTime is the process boot instant — never in the future', () => {
		const boot = processBootTime();
		expect(boot.getTime()).toBeLessThanOrEqual(Date.now());
		// uptime > 0 ⇒ strictly before "now" by at least the process's age.
		expect(boot.getTime()).toBeLessThan(Date.now() + 1);
	});
});

// ── F-048 follow-on — a reaped session's claimed work freed + its task reset to ready ──
// The go-live symptom (hand-recovered via DB): a reaped session leaves its `memory_review` fork
// twin wedged `processing` and its task stranded `in_progress`, so the orchestrator drain starves
// on the orphaned twin until gcStale's 1h age window. reapStaleRuns must now release the twin AND
// reset the task IMMEDIATELY, while never freeing a LIVE session's work. Real throwaway SurrealDB.

/** Seed a `processing` work_item claimed by a session (the orphaned-twin simulation). */
async function makeWorkItem(sessionId: string, workType = 'memory_review'): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE work_item CONTENT $content RETURN AFTER;`,
		{
			content: {
				work_type: workType,
				payload: { kind: 'memory', turnText: 'orphaned twin' },
				status: 'processing',
				session: new StringRecordId(sessionId),
				project: new StringRecordId(projectId),
				claim_token: `tok-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				claimed_at: new Date()
			}
		}
	);
	return String(rows[0].id);
}

describe('reapStaleRuns — F-048 follow-on (release claimed work + reset orphaned task)', () => {
	it('reaping a session frees its processing work_item (lease cleared) and resets its in_progress task to ready', async () => {
		const past = new Date(Date.now() - 60_000);
		const task = await createTask(db, {
			project: projectId,
			title: 'orphaned task',
			description: 'wedged in_progress by a dead session',
			status: 'in_progress'
		});
		const session = await makeSession({ status: 'running', started_at: past, task: new StringRecordId(task.id) });
		const wi = await makeWorkItem(session);

		const bootTime = new Date(Date.now() - 5_000); // session predates boot → reaped
		const res = await reapStaleRuns(db, bootTime);
		// Exactly one running pre-boot session exists at this point (earlier test rows are terminal).
		expect(res.sessions).toBe(1);
		expect(res.releasedWorkItems).toBe(1);
		expect(res.resetTasks).toBe(1);

		// The session is honestly failed.
		expect((await readRow(session)).status).toBe('failed');

		// The orphaned twin is back to pending with the lease fully cleared (re-claimable).
		const item = await readRow(wi);
		expect(item.status).toBe('pending');
		expect(item.claim_token ?? null).toBeNull();
		expect(item.claimed_at ?? null).toBeNull();

		// The stranded task is back to ready so the drain can re-drive it.
		expect((await readRow(task.id)).status).toBe('ready');

		// Idempotent: re-running the recovery primitives directly is a no-op (no double-effect, no throw).
		expect(await releaseSessionWork(db, session)).toEqual({ released: 0 });
		expect(await resetStuckTaskToReady(db, task.id)).toBe(false);
		expect((await readRow(wi)).status).toBe('pending');
		expect((await readRow(task.id)).status).toBe('ready');
	});

	it('NEVER releases a LIVE (running) session’s work — the caller-contract guard holds', async () => {
		const liveSession = await makeSession({ status: 'running' }); // started_at = now (live)
		const wi = await makeWorkItem(liveSession);

		// Direct call against a still-running session: the session.status != "running" guard frees nothing.
		expect(await releaseSessionWork(db, liveSession)).toEqual({ released: 0 });
		const item = await readRow(wi);
		expect(item.status).toBe('processing');
		expect(item.claim_token).toBeTruthy();

		// Cleanup so the live row can't leak into other assertions.
		await db.query(`UPDATE $rid SET status = 'cancelled', ended_at = time::now();`, {
			rid: new StringRecordId(liveSession)
		});
	});

	it('resetStuckTaskToReady only moves in_progress/review tasks — done/ready/backlog are untouched', async () => {
		const doneTask = await createTask(db, { project: projectId, title: 'done', description: 'd', status: 'done' });
		const readyTask = await createTask(db, { project: projectId, title: 'ready', description: 'r', status: 'ready' });
		const reviewTask = await createTask(db, { project: projectId, title: 'review', description: 'v', status: 'review' });

		expect(await resetStuckTaskToReady(db, doneTask.id)).toBe(false);
		expect(await resetStuckTaskToReady(db, readyTask.id)).toBe(false);
		expect(await resetStuckTaskToReady(db, reviewTask.id)).toBe(true); // review → ready (recovery)

		expect((await readRow(doneTask.id)).status).toBe('done');
		expect((await readRow(readyTask.id)).status).toBe('ready');
		expect((await readRow(reviewTask.id)).status).toBe('ready');
	});

	// BL-R2 — the failed-task_run terminal primitive. Mirrors the resetStuckTaskToReady guard test:
	// only in_progress/review are driven to `failed`; every other status is left untouched; idempotent.
	it('resetStuckTaskToFailed only moves in_progress/review tasks — done/ready/backlog/failed are untouched', async () => {
		const inProg = await createTask(db, { project: projectId, title: 'inprog', description: 'i', status: 'in_progress' });
		const reviewTask = await createTask(db, { project: projectId, title: 'review2', description: 'v', status: 'review' });
		const doneTask = await createTask(db, { project: projectId, title: 'done2', description: 'd', status: 'done' });
		const readyTask = await createTask(db, { project: projectId, title: 'ready2', description: 'r', status: 'ready' });
		const backlogTask = await createTask(db, { project: projectId, title: 'backlog2', description: 'b', status: 'backlog' });

		expect(await resetStuckTaskToFailed(db, inProg.id)).toBe(true); // in_progress → failed (spawn/route failure)
		expect(await resetStuckTaskToFailed(db, reviewTask.id)).toBe(true); // review → failed
		expect(await resetStuckTaskToFailed(db, doneTask.id)).toBe(false); // terminal — untouched
		expect(await resetStuckTaskToFailed(db, readyTask.id)).toBe(false); // never-started — untouched
		expect(await resetStuckTaskToFailed(db, backlogTask.id)).toBe(false); // never-started — untouched

		expect((await readRow(inProg.id)).status).toBe('failed');
		expect((await readRow(reviewTask.id)).status).toBe('failed');
		expect((await readRow(doneTask.id)).status).toBe('done');
		expect((await readRow(readyTask.id)).status).toBe('ready');
		expect((await readRow(backlogTask.id)).status).toBe('backlog');

		// Idempotent: a second call once `failed` matches nothing and moves zero rows (no throw).
		expect(await resetStuckTaskToFailed(db, inProg.id)).toBe(false);
		expect((await readRow(inProg.id)).status).toBe('failed');
	});
});
