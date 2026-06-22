import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from './repo';
import { createTask, setStatus } from '../tasks/repo';
import { enqueue, claimNext, complete, countByStatus } from '../orchestrator/workqueue';
import {
	continueReadyTasks,
	restartSessionTask,
	OrchestratorUnavailableError,
	SessionControlError,
	type OrchestratorControl
} from './project-controls';

// CC-CONTROLS — the operator command-center CONTROL seam, against a LIVE throwaway SurrealDB with the
// real schema. Proves the integrity invariants the operator pain + red-team demand:
//   • CONTINUE re-enqueues ONLY this project's READY tasks (cross-project leakage guard; ready-only).
//   • CONTINUE/RESTART cannot DOUBLE-SPAWN — the work_item dedup_key collapses a concurrent re-enqueue
//     of an in-flight task (a double-click is a benign no-op, not a second task_run).
//   • RESTART re-runs a FAILED session's task once; refuses a cross-project session, a non-restartable
//     status (done/running), and a session with no task — each a NAMED error (EVERY ERROR HAS A NAME).
//   • A nil orchestrator (degraded boot) is a NAMED honest error, never a fake "started".
//
// The orchestrator is mocked with a REAL enqueue (so the dedup is the production dedup) + a drain that
// claims+completes real items — so the dedup no-double-spawn is proven against the live UNIQUE index,
// not a stubbed counter. SHADOW PATHS covered: no ready tasks; nil orchestrator; foreign/absent project.

let tdb: TestDb;
let db: Db;

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
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query(`DELETE work_item; DELETE task; DELETE session; DELETE project;`);
});

/**
 * A mock orchestrator that exercises the REAL workqueue (so the dedup_key no-double-spawn guard is the
 * production guard, not a stub). enqueueTask records each (taskId) it was asked to enqueue AND delegates
 * to the real enqueue (idempotent via dedup_key). drain claims every pending item once + completes it
 * (mirroring the orchestrator's claim→spawn→complete, minus the real Claude spawn), recording spawns.
 */
function mockOrchestrator(database: Db): OrchestratorControl & {
	enqueueCalls: string[];
	drainCalls: number;
} {
	const enqueueCalls: string[] = [];
	let drainCalls = 0;
	return {
		enqueueCalls,
		get drainCalls() {
			return drainCalls;
		},
		async enqueueTask(taskId: string, projectId: string): Promise<boolean> {
			enqueueCalls.push(taskId);
			const { enqueued } = await enqueue(database, {
				workType: 'task_run',
				payload: { taskId, projectId },
				projectId,
				dedupScope: taskId
			});
			return enqueued;
		},
		async drain(): Promise<{ claimed: number; spawned: number }> {
			drainCalls += 1;
			let claimed = 0;
			for (;;) {
				const item = await claimNext(database, `test_${claimed}_${Date.now()}`);
				if (!item) break;
				claimed += 1;
				await complete(database, item.id, item.claimToken, 'done');
			}
			return { claimed, spawned: claimed };
		}
	};
}

async function seedProject(slug: string): Promise<string> {
	const p = await createProject(db, { name: slug, slug, root_path: `F:/code/${slug}` });
	return p.id;
}

/** Create a task already in `ready` (born backlog → moved ready so the state machine is honored). */
async function seedReadyTask(projectId: string, title: string): Promise<string> {
	const t = await createTask(db, { project: projectId, title, description: title, origin: 'manual' });
	await setStatus(db, t.id, 'ready');
	return t.id;
}

/** Create a minimal session row directly (the loader reads these; we only need project/status/task). */
async function seedSession(opts: {
	projectId?: string;
	taskId?: string;
	status: string;
}): Promise<string> {
	// session.project / session.task are option<record<...>> — bind the ids as record links (a plain
	// string is rejected by the typed field). type::thing turns the bound id-part into a real link.
	const projParts = opts.projectId ? opts.projectId.split(':') : null;
	const taskParts = opts.taskId ? opts.taskId.split(':') : null;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
			project: ${projParts ? `type::thing($ptbl, $pid)` : 'NONE'},
			task: ${taskParts ? `type::thing($ttbl, $tid)` : 'NONE'},
			status: $status,
			kind: 'task',
			model: { provider: 'anthropic', model_id: 'claude-opus-4-8' }
		 } RETURN AFTER;`,
		{
			...(projParts ? { ptbl: projParts[0], pid: projParts[1] } : {}),
			...(taskParts ? { ttbl: taskParts[0], tid: taskParts[1] } : {}),
			status: opts.status
		}
	);
	return String(rows[0].id);
}

describe('continueReadyTasks', () => {
	it('enqueues ONLY this project’s ready tasks (cross-project leakage guard + ready-only)', async () => {
		const pA = await seedProject('proj_a');
		const pB = await seedProject('proj_b');
		const a1 = await seedReadyTask(pA, 'A ready 1');
		const a2 = await seedReadyTask(pA, 'A ready 2');
		// A backlog task in A (NOT ready) must be ignored; a ready task in B must NOT leak in.
		const aBacklog = await createTask(db, { project: pA, title: 'A backlog', description: 'x' });
		const b1 = await seedReadyTask(pB, 'B ready');

		const orch = mockOrchestrator(db);
		const res = await continueReadyTasks(orch, db, pA);

		expect(res.readyCount).toBe(2);
		expect(res.enqueued).toBe(2);
		expect(res.spawned).toBe(2);
		// Exactly A's two ready tasks were enqueued — never the backlog task, never B's task.
		expect(orch.enqueueCalls.sort()).toEqual([a1, a2].sort());
		expect(orch.enqueueCalls).not.toContain(aBacklog.id);
		expect(orch.enqueueCalls).not.toContain(b1);
	});

	it('no ready tasks → honest no-op (readyCount 0, nothing enqueued) — SHADOW: empty', async () => {
		const p = await seedProject('proj_empty');
		await createTask(db, { project: p, title: 'backlog only', description: 'x' }); // stays backlog
		const orch = mockOrchestrator(db);
		const res = await continueReadyTasks(orch, db, p);
		expect(res.readyCount).toBe(0);
		expect(res.enqueued).toBe(0);
		expect(res.spawned).toBe(0);
		expect(orch.enqueueCalls).toEqual([]);
		// drain still ran (honest — it drains whatever is claimable, which is nothing).
		expect(orch.drainCalls).toBe(1);
	});

	it('double CONTINUE does NOT double-spawn — the dedup_key collapses the second enqueue', async () => {
		const p = await seedProject('proj_dedup');
		const t1 = await seedReadyTask(p, 'ready');
		const orch = mockOrchestrator(db);

		// First continue: enqueues + drains (the item is claimed→done in drain). Second continue, run
		// BEFORE any new ready task appears, re-enqueues — but if we DON'T drain between, the first
		// item is still pending and the second enqueue is a dedup no-op. Simulate the concurrent
		// double-click by enqueuing twice with NO drain in between via a drain-suppressed orchestrator.
		const enqOnly: OrchestratorControl = {
			enqueueTask: orch.enqueueTask,
			drain: async () => ({ claimed: 0, spawned: 0 }) // suppress drain to hold the item pending
		};
		const r1 = await continueReadyTasks(enqOnly, db, p);
		const r2 = await continueReadyTasks(enqOnly, db, p);

		expect(r1.enqueued).toBe(1); // first created a pending task_run
		expect(r2.enqueued).toBe(0); // second collapsed via the dedup_key (no second item)
		expect(r2.alreadyQueued).toBe(1);
		// Exactly ONE pending task_run exists for the task — the double-spawn guard held.
		const pending = await countByStatus(db, 'pending');
		expect(pending).toBe(1);
		expect(t1).toBeTruthy();
	});

	it('nil orchestrator (degraded boot) → NAMED OrchestratorUnavailableError, nothing enqueued', async () => {
		const p = await seedProject('proj_noorch');
		await seedReadyTask(p, 'ready');
		await expect(continueReadyTasks(null, db, p)).rejects.toBeInstanceOf(OrchestratorUnavailableError);
		// Nothing was enqueued (the error is raised before any enqueue).
		expect(await countByStatus(db, 'pending')).toBe(0);
	});
});

describe('restartSessionTask', () => {
	it('re-runs a FAILED session’s task once', async () => {
		const p = await seedProject('proj_restart');
		const tid = await seedReadyTask(p, 'failed task');
		const s = await seedSession({ projectId: p, taskId: tid, status: 'failed' });
		const orch = mockOrchestrator(db);

		const res = await restartSessionTask(orch, db, p, {
			id: s,
			status: 'failed',
			project: p,
			taskId: tid
		});
		expect(res.taskId).toBe(tid);
		expect(res.enqueued).toBe(true);
		expect(res.spawned).toBe(1);
		expect(orch.enqueueCalls).toEqual([tid]);
	});

	it('double RESTART does NOT double-spawn — the dedup_key guards the re-run', async () => {
		const p = await seedProject('proj_restart2');
		const tid = await seedReadyTask(p, 'failed task');
		const s = await seedSession({ projectId: p, taskId: tid, status: 'failed' });
		const orch = mockOrchestrator(db);
		const enqOnly: OrchestratorControl = {
			enqueueTask: orch.enqueueTask,
			drain: async () => ({ claimed: 0, spawned: 0 })
		};
		const r1 = await restartSessionTask(enqOnly, db, p, { id: s, status: 'failed', project: p, taskId: tid });
		const r2 = await restartSessionTask(enqOnly, db, p, { id: s, status: 'failed', project: p, taskId: tid });
		expect(r1.enqueued).toBe(true);
		expect(r2.enqueued).toBe(false); // dedup no-op — the benign double-click guard
		expect(await countByStatus(db, 'pending')).toBe(1);
	});

	it('refuses a CROSS-PROJECT session (named SessionControlError) — leakage guard', async () => {
		const pA = await seedProject('proj_xa');
		const pB = await seedProject('proj_xb');
		const t = await createTask(db, { project: pB, title: 'b task', description: 'x' });
		const s = await seedSession({ projectId: pB, taskId: t.id, status: 'failed' });
		const orch = mockOrchestrator(db);
		// Try to restart B's session FROM project A → refused.
		await expect(
			restartSessionTask(orch, db, pA, { id: s, status: 'failed', project: pB, taskId: t.id })
		).rejects.toBeInstanceOf(SessionControlError);
		expect(orch.enqueueCalls).toEqual([]);
	});

	it('refuses a non-restartable status (done / running) — never duplicates live/clean work', async () => {
		const p = await seedProject('proj_status');
		const t = await createTask(db, { project: p, title: 't', description: 'x' });
		const orch = mockOrchestrator(db);
		for (const status of ['done', 'running']) {
			await expect(
				restartSessionTask(orch, db, p, { id: 'session:x', status, project: p, taskId: t.id })
			).rejects.toBeInstanceOf(SessionControlError);
		}
		expect(orch.enqueueCalls).toEqual([]);
	});

	it('refuses a session with NO task (a chat/discussion) — named error', async () => {
		const p = await seedProject('proj_notask');
		const orch = mockOrchestrator(db);
		await expect(
			restartSessionTask(orch, db, p, { id: 'session:y', status: 'failed', project: p, taskId: null })
		).rejects.toBeInstanceOf(SessionControlError);
		expect(orch.enqueueCalls).toEqual([]);
	});

	it('nil orchestrator → NAMED OrchestratorUnavailableError', async () => {
		const p = await seedProject('proj_restart_noorch');
		await expect(
			restartSessionTask(null, db, p, { id: 'session:z', status: 'failed', project: p, taskId: 'task:1' })
		).rejects.toBeInstanceOf(OrchestratorUnavailableError);
	});

	// REGRESSION (red-team second-pass MEDIUM): a FAILED session whose TASK has since ADVANCED past
	// spawn-ready must be refused — RESTART used to re-spawn it (fabricated rework on a non-runnable task),
	// the exact failure the done-SESSION guard claims to prevent, reached via a stale failed session.
	it('refuses a FAILED session whose task has ADVANCED past ready (done/review/withdrawn/in_progress)', async () => {
		const advanced: Array<[string, (tid: string) => Promise<void>]> = [
			['done', async (tid) => { await setStatus(db, tid, 'in_progress'); await setStatus(db, tid, 'done'); }],
			['review', async (tid) => { await setStatus(db, tid, 'in_progress'); await setStatus(db, tid, 'review'); }],
			['in_progress', async (tid) => { await setStatus(db, tid, 'in_progress'); }],
			['blocked', async (tid) => { await setStatus(db, tid, 'blocked'); }]
		];
		for (const [label, advance] of advanced) {
			const p = await seedProject(`proj_adv_${label}`);
			const tid = await seedReadyTask(p, `task ${label}`); // born ready (the session's run target)
			const s = await seedSession({ projectId: p, taskId: tid, status: 'failed' });
			await advance(tid); // a successful retry / PM-review / operator moved it on AFTER the session failed
			const orch = mockOrchestrator(db);
			await expect(
				restartSessionTask(orch, db, p, { id: s, status: 'failed', project: p, taskId: tid })
			).rejects.toBeInstanceOf(SessionControlError);
			// NOTHING was enqueued — the asymmetry with CONTINUE (which re-reads ready) is closed.
			expect(orch.enqueueCalls).toEqual([]);
			expect(await countByStatus(db, 'pending')).toBe(0);
		}
	});

	// REGRESSION: a backlog task (never readied) behind a failed session is also refused (spawn-ready set
	// is `ready` only — mirrors CONTINUE; the operator re-readies before restarting).
	it('refuses a FAILED session whose task is still backlog (never readied)', async () => {
		const p = await seedProject('proj_backlog_restart');
		const t = await createTask(db, { project: p, title: 'backlog', description: 'x' }); // stays backlog
		const s = await seedSession({ projectId: p, taskId: t.id, status: 'failed' });
		const orch = mockOrchestrator(db);
		await expect(
			restartSessionTask(orch, db, p, { id: s, status: 'failed', project: p, taskId: t.id })
		).rejects.toBeInstanceOf(SessionControlError);
		expect(orch.enqueueCalls).toEqual([]);
	});

	// REGRESSION: a failed session whose task was DELETED is refused (named), not a crash.
	it('refuses a FAILED session whose task no longer exists', async () => {
		const p = await seedProject('proj_gone_restart');
		const orch = mockOrchestrator(db);
		await expect(
			restartSessionTask(orch, db, p, { id: 'session:gone', status: 'failed', project: p, taskId: `task:nonexistent_${Date.now()}` })
		).rejects.toBeInstanceOf(SessionControlError);
		expect(orch.enqueueCalls).toEqual([]);
	});
});
