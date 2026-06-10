import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createWorkflow } from '../workflows/repo';
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
		expect(res).toEqual({ sessions: 1, workflowRuns: 1 });

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
		expect(await reapStaleRuns(db, bootTime)).toEqual({ sessions: 0, workflowRuns: 0 });

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
