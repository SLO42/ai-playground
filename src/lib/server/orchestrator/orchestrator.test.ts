import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus } from '../events/bus';
import { watchTable } from '../events/db-source';
import { createProject, deleteProject } from '../projects/repo';
import { createTask, getTask, setStatus } from '../tasks/repo';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { Orchestrator, type StubRoute } from './index';
import { claimNext, complete, countByStatus } from './workqueue';
import type { CommandRunner, CommandResult } from './post-task';

// TASK 2.2 VERIFY (ARCHITECTURE §2.2/§2.11; D-004; DATA-MODEL §4.12) against the
// MOCKED runtime (NO live API/creds/network — the 1.4 contract pattern):
//   • a task→spawn-ready event drives EXACTLY ONE spawn through the claim queue
//   • NO double-fire (the orchestrator subscribes the BUS only, never its own live query)
//   • the interactive semaphore CAP is respected (never more than maxConcurrent at once)
//   • periodic is PRESENT but OFF by default (D-004)
//
// The orchestrator subscribes to the SAME bus the events/watchTable live query
// republishes onto, so the live-query trigger seed (1.3) → bus → orchestrator path is
// exercised end to end, exactly as production wires it.

// ── A controllable mock backend: each run blocks until released, so we can hold N
//    spawns "in flight" simultaneously and observe the semaphore cap. ──────────────
interface Gate {
	release: () => void;
	started: Promise<void>;
}

function gatedBackend(): CcBackend & {
	plans: CcSpawnPlan[];
	gates: Gate[];
	concurrentPeak: number;
} {
	const plans: CcSpawnPlan[] = [];
	const gates: Gate[] = [];
	let live = 0;
	let concurrentPeak = 0;
	const self = {
		plans,
		gates,
		get concurrentPeak() {
			return concurrentPeak;
		},
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			let releaseFn!: () => void;
			let startedFn!: () => void;
			const released = new Promise<void>((r) => (releaseFn = r));
			const started = new Promise<void>((r) => (startedFn = r));
			gates.push({ release: releaseFn, started });
			// Globally-unique per run so the session dedup_key (cc_session_id OR id, §4.3)
			// never collides ACROSS test backends — a deterministic id would clash with
			// another test's session row and make the terminal cc_session_id UPDATE throw.
			const ccSessionId = `cc_${plan.agentId}_${plans.length}_${Math.random().toString(36).slice(2, 10)}`;
			return {
				ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					live++;
					concurrentPeak = Math.max(concurrentPeak, live);
					startedFn();
					yield { type: 'log', message: 'started' };
					await released; // hold the run "in flight" until the test releases it
					yield { type: 'token_usage', input: 10, output: 5 };
					yield { type: 'done', result: { ok: true, summary: 'done', ccSessionId } };
					live--;
				},
				async cancel() {}
			};
		},
		async resume(req: { ccSessionId: string }) {
			return {
				ccSessionId: req.ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'resumed' } };
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
	return self as unknown as CcBackend & {
		plans: CcSpawnPlan[];
		gates: Gate[];
		concurrentPeak: number;
	};
}

function stubRoute(agentId = 'agent_coder_1'): (t: string, p: string) => StubRoute {
	return () => ({
		agentId,
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] }
	});
}

async function waitFor(predicate: () => boolean, ms = 6000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
		await new Promise((r) => setTimeout(r, 20));
	}
}

let tdb: TestDb;
let db: Db;
let projectId: string;

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
	const p = await createProject(db, { slug: 'orch', name: 'Orch Host', root_path: 'F:/code/orch' });
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function clearQueue(): Promise<void> {
	await db.query(`DELETE work_item;`);
}

describe('Orchestrator (event mode, degenerate) — TASK 2.2 VERIFY', () => {
	it('a task→ready event drives EXACTLY ONE spawn through the claim queue', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/orch/.harness-cc' });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 4,
			mode: 'event',
			route: stubRoute()
		});
		orch.start();
		// The ONLY live query is events/watchTable — the orchestrator never opens its own.
		const watch = await watchTable(db, bus, 'task');

		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'spawn me',
				description: 'a ready task should drive exactly one spawn'
			});
			// Transition backlog→ready: the live-query trigger seed fans this onto the bus,
			// which the orchestrator consumes → enqueue → claim → spawn.
			await setStatus(db, task.id, 'ready');

			// Exactly one spawn started (one backend.run, one gate).
			await waitFor(() => backend.plans.length >= 1);
			await backend.gates[0].started;
			expect(backend.plans).toHaveLength(1);

			// The spawn ran for OUR task, at the project root, with the 1.4a isolated config.
			expect(backend.plans[0].cwd).toBe('F:/code/orch');
			expect(backend.plans[0].isolated.env.CLAUDE_CONFIG_DIR).toBeTruthy();

			// Exactly one work_item was claimed (now processing), then completes.
			expect(await countByStatus(db, 'processing')).toBe(1);

			backend.gates[0].release();
			await waitFor(() => orch.spawnCount >= 1);

			// Settle: give any erroneous extra trigger/spawn a chance to surface.
			await new Promise((r) => setTimeout(r, 300));
			// Still EXACTLY ONE spawn — no double-fire (bus-only subscription, §2.11).
			expect(backend.plans).toHaveLength(1);
			expect(orch.spawnCount).toBe(1);
			expect(await countByStatus(db, 'pending')).toBe(0);
			expect(await countByStatus(db, 'done')).toBe(1);
		} finally {
			orch.stop();
			await watch.stop();
		}
	}, 30_000);

	it('NO double-fire: the orchestrator subscribes the BUS only, never its own live query', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({ db, bus, runtime, maxConcurrent: 4, route: stubRoute() });
		orch.start();
		const watch = await watchTable(db, bus, 'task');
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'single',
				description: 'one transition, one spawn'
			});
			await setStatus(db, task.id, 'ready');
			await waitFor(() => backend.plans.length >= 1);
			await backend.gates[0].started;
			// Release and settle generously — a double-fire would enqueue/claim/spawn twice.
			backend.gates[0].release();
			await new Promise((r) => setTimeout(r, 400));
			expect(backend.plans).toHaveLength(1);
		} finally {
			orch.stop();
			await watch.stop();
		}
	}, 30_000);

	it('semaphore CAP respected: 5 ready tasks, cap=2 → never more than 2 in flight', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({ db, bus, runtime, maxConcurrent: 2, route: stubRoute() });
		orch.start();
		const watch = await watchTable(db, bus, 'task');
		try {
			const ids: string[] = [];
			for (let i = 0; i < 5; i++) {
				const t = await createTask(db, {
					project: projectId,
					title: `task ${i}`,
					description: 'capped spawn'
				});
				ids.push(t.id);
			}
			// Make all five ready.
			for (const id of ids) await setStatus(db, id, 'ready');

			// Only TWO spawns can be in flight at once (the cap). Wait until two have started.
			await waitFor(() => backend.gates.length >= 2);
			await Promise.all([backend.gates[0].started, backend.gates[1].started]);
			// Give the drain a beat — it must NOT start a third while two are gated.
			await new Promise((r) => setTimeout(r, 300));
			expect(backend.plans.length).toBe(2);
			expect(backend.concurrentPeak).toBeLessThanOrEqual(2);

			// Release everything, draining the rest two-at-a-time.
			let released = 0;
			while (released < 5) {
				await waitFor(() => backend.gates.length > released);
				for (; released < backend.gates.length; released++) {
					backend.gates[released].release();
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			// All five eventually reach the runtime (one backend.run per task), drained
			// two-at-a-time as permits free. The CAP invariant is what 2.2 verifies: the
			// peak number of concurrently in-flight spawns NEVER exceeds maxConcurrent.
			await waitFor(() => backend.plans.length >= 5, 15_000);
			expect(backend.plans.length).toBe(5);
			// The interactive cap was honoured throughout — never more than 2 in flight.
			expect(backend.concurrentPeak).toBeLessThanOrEqual(2);
			// The queue fully drains — no pending work_item is left behind.
			await waitFor(() => orch.semaphore.inUse === 0, 15_000);
			expect(await countByStatus(db, 'pending')).toBe(0);
		} finally {
			orch.stop();
			await watch.stop();
		}
	}, 60_000);

	it('periodic is PRESENT but OFF by default (D-004)', async () => {
		const bus = new EventBus();
		const runtime = new ClaudeCodeRuntime({ backend: gatedBackend() });
		// event mode: no timer armed.
		const ev = new Orchestrator({ db, bus, runtime, maxConcurrent: 1, route: stubRoute() });
		ev.start();
		expect(ev.mode).toBe('event');
		expect(ev.periodicArmed).toBe(false);
		ev.stop();

		// periodic mode WITHOUT an interval: still off (D-004 — present but off).
		const perNoInterval = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 1,
			mode: 'periodic',
			route: stubRoute()
		});
		perNoInterval.start();
		expect(perNoInterval.periodicArmed).toBe(false);
		perNoInterval.stop();

		// periodic mode WITH an interval: the timer is armed (explicit opt-in only).
		const perOn = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 1,
			mode: 'periodic',
			intervalMs: 60_000,
			route: stubRoute()
		});
		perOn.start();
		expect(perOn.periodicArmed).toBe(true);
		perOn.stop();
		expect(perOn.periodicArmed).toBe(false);
	});

	it('TASK 2.15 — daily spawn cap: drain stops claiming once the rolling cap is hit', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		// cap=2: at most TWO items may be claimed/spawned in the (wide) rolling window.
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8, // interactive cap is NOT the limiter here — the daily cap is
			mode: 'manual',
			route: stubRoute(),
			dailySpawnCap: 2
		});
		orch.start();
		try {
			// Enqueue FIVE distinct background items directly (manual: no auto-trigger).
			// Real task rows so launchSession resolves them (the cap, not a launch error,
			// must be what stops the drain at 2).
			for (let i = 0; i < 5; i++) {
				const t = await createTask(db, {
					project: projectId,
					title: `cap ${i}`,
					description: 'daily-cap parked'
				});
				await orch.enqueueTask(t.id, projectId);
			}
			await orch.drain();
			// Only TWO were claimed/spawned despite five queued + ample interactive permits.
			await waitFor(() => backend.plans.length >= 2);
			await new Promise((r) => setTimeout(r, 300));
			expect(backend.plans.length).toBe(2);
			// The other three remain parked as pending (cap, not lost).
			expect(await countByStatus(db, 'pending')).toBe(3);
			expect(await countByStatus(db, 'processing')).toBe(2);

			// Release the two in flight; even after they finish, the cap (anchored on
			// claimed_at) keeps the rest parked — the rolling window still holds 2 claims.
			for (const g of backend.gates) g.release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
			await new Promise((r) => setTimeout(r, 200));
			expect(backend.plans.length).toBe(2); // STILL capped at 2 in the window
			expect(await countByStatus(db, 'pending')).toBe(3);
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('TASK 2.15 — orch.gc() reaps aged terminal rows (fire-and-forget maintenance, D-017)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const runtime = new ClaudeCodeRuntime({ backend: gatedBackend() });
		const orch = new Orchestrator({ db, bus, runtime, maxConcurrent: 1, mode: 'manual', route: stubRoute() });
		try {
			// One terminal row aged past the window.
			const gt = await createTask(db, { project: projectId, title: 'gc', description: 'gc me' });
			await orch.enqueueTask(gt.id, projectId);
			const c = await claimNext(db, 'gc_tok');
			await complete(db, c!.id, 'gc_tok', 'done');
			const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
			await db.query(`UPDATE type::thing($a) SET completed_at = <datetime>$t;`, { a: c!.id, t: old });
			const res = await orch.gc();
			expect(res.deletedTerminal).toBe(1);
			expect(await countByStatus(db, 'done')).toBe(0);
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('manual mode: no bus subscription — a ready task does NOT auto-spawn; runOnce drains', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({ db, bus, runtime, maxConcurrent: 2, mode: 'manual', route: stubRoute() });
		orch.start();
		const watch = await watchTable(db, bus, 'task');
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'manual',
				description: 'manual mode does not auto-spawn'
			});
			await setStatus(db, task.id, 'ready');
			// Manual mode ignores the bus — nothing spawns on its own.
			await new Promise((r) => setTimeout(r, 400));
			expect(backend.plans).toHaveLength(0);

			// An explicit enqueue + drain DOES spawn (manual trigger path).
			await orch.enqueueTask(task.id, projectId);
			await orch.drain();
			await waitFor(() => backend.plans.length >= 1);
			await backend.gates[0].started;
			backend.gates[0].release();
			await waitFor(() => orch.spawnCount >= 1);
			expect(orch.spawnCount).toBe(1);
		} finally {
			orch.stop();
			await watch.stop();
		}
	}, 30_000);
});

// ── THE HEARTBEAT (operator direction 2026-06-23) — the post-task loop wired into the
//    orchestrator advances the TASK to a terminal status, the db_change the PM consumes. ──
//
// A backend whose `done` result `ok` is configurable, so we can drive a DONE session (ok:true →
// launchSession status 'done') AND a FAILED session (ok:false → status 'failed') deterministically
// against a real throwaway DB. A FAKE CommandRunner (NO live process/shell — the same mocked
// pattern post-task.test.ts uses; F-008 allows a mock in a TEST) records the git calls.
function outcomeBackend(ok: boolean): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	const self = {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			const ccSessionId = `cc_${plan.agentId}_${plans.length}_${Math.random().toString(36).slice(2, 10)}`;
			return {
				ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'log', message: 'started' };
					yield { type: 'token_usage', input: 10, output: 5 };
					yield { type: 'done', result: { ok, summary: ok ? 'work done' : 'run failed', ccSessionId } };
				},
				async cancel() {}
			};
		},
		async resume(req: { ccSessionId: string }) {
			return {
				ccSessionId: req.ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'resumed' } };
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
	return self as unknown as CcBackend & { plans: CcSpawnPlan[] };
}

/** A fake post-task runner: records calls, returns scripted results. NO live process/shell. */
function fakePostTaskRunner(): CommandRunner & { calls: { file: string; args: string[] }[] } {
	const calls: { file: string; args: string[] }[] = [];
	const fn: CommandRunner = async (file, args) => {
		calls.push({ file, args: [...args] });
		const res: CommandResult =
			file === 'git' && args[0] === 'rev-parse'
				? { code: 0, stdout: 'hb12345\n', stderr: '' }
				: { code: 0, stdout: '', stderr: '' };
		return res;
	};
	return Object.assign(fn, { calls });
}

/** Poll an ASYNC predicate until true or timeout (waitFor takes a sync predicate). */
async function waitForAsync(predicate: () => Promise<boolean>, ms = 10_000): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > ms) throw new Error('timeout waiting for async condition');
		await new Promise((r) => setTimeout(r, 30));
	}
}

describe('THE HEARTBEAT — post-task wiring advances the TASK to terminal (ready→in_progress→done|failed)', () => {
	it('a DONE session: task transitions ready→in_progress→done, work committed, completion event written', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = outcomeBackend(true);
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/orch/.harness-cc' });
		const runner = fakePostTaskRunner();
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 2,
			mode: 'event',
			route: stubRoute(),
			// The wiring under test: post-task enabled with the injected runner (NO live git).
			postTask: { enabled: true, runner, followUpOnTestFail: false }
		});
		orch.start();
		const watch = await watchTable(db, bus, 'task');
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'heartbeat done',
				description: 'a done session must advance its task to done'
			});
			await setStatus(db, task.id, 'ready');

			// The session runs and the post-task loop advances the task to terminal.
			await waitFor(() => backend.plans.length >= 1);
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'done');

			const finished = await getTask(db, task.id);
			expect(finished?.status).toBe('done'); // ready→in_progress→done (post-task terminal write)

			// F-007 — the work was committed via execFile arrays (git add / commit / rev-parse).
			const gitVerbs = runner.calls.filter((c) => c.file === 'git').map((c) => c.args[0]);
			expect(gitVerbs).toEqual(['add', 'commit', 'rev-parse']);

			// The completion agent_event carries the sha (the db_change the PM consumes is the
			// task→done above; this is the analytics trace of the commit).
			const [evs] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event WHERE type = 'completion' AND detail.reason = 'post-task loop';`
			);
			expect(evs.some((e) => e.detail.commit_sha === 'hb12345')).toBe(true);
		} finally {
			orch.stop();
			await watch.stop();
		}
	}, 30_000);

	it('a FAILED session: task transitions ready→in_progress→failed, NO commit (F-007)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = outcomeBackend(false); // done(ok:false) → launchSession status 'failed'
		const runtime = new ClaudeCodeRuntime({ backend });
		const runner = fakePostTaskRunner();
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 2,
			mode: 'event',
			route: stubRoute(),
			postTask: { enabled: true, runner, followUpOnTestFail: false }
		});
		orch.start();
		const watch = await watchTable(db, bus, 'task');
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'heartbeat failed',
				description: 'a failed session must advance its task to failed (visible to PM/operator)'
			});
			await setStatus(db, task.id, 'ready');

			await waitFor(() => backend.plans.length >= 1);
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'failed');

			const finished = await getTask(db, task.id);
			expect(finished?.status).toBe('failed'); // honest terminal status (not left ready)

			// F-007 — a failed run commits NOTHING (runPostTask skips the commit when runOk=false).
			expect(runner.calls.length).toBe(0);
		} finally {
			orch.stop();
			await watch.stop();
		}
	}, 30_000);

	it('the in_progress step is real but the terminal write needs post-task: without it a done session leaves the task in_progress (never done)', async () => {
		// The DEAD-LINK proof (negative control). The spawn path moves the task ready→in_progress
		// (so the run is visibly in flight), but WITHOUT the post-task wiring nothing advances it
		// to terminal — it stalls at `in_progress`, never `done`, and the terminal db_change the PM
		// consumes never fires. This is exactly the symptom this wave's post-task wiring fixes; it
		// also proves the in_progress transition is independent of (and prerequisite to) post-task.
		await clearQueue();
		const bus = new EventBus();
		const backend = outcomeBackend(true);
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 2,
			mode: 'event',
			route: stubRoute()
			// postTask intentionally omitted (the pre-fix boot state).
		});
		orch.start();
		const watch = await watchTable(db, bus, 'task');
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'no post-task',
				description: 'proves the wiring is load-bearing'
			});
			await setStatus(db, task.id, 'ready');
			await waitFor(() => orch.spawnCount >= 1, 10_000);
			await new Promise((r) => setTimeout(r, 200)); // let any stray transition settle
			// The spawn ran and moved the task ready→in_progress, but with NO post-task wiring the
			// task never reaches a terminal status — it is stuck at in_progress (the dead link).
			expect((await getTask(db, task.id))?.status).toBe('in_progress');
		} finally {
			orch.stop();
			await watch.stop();
		}
	}, 30_000);
});
