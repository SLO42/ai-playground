import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, clearTable, type TestDb } from '../db/testserver';
import { EventBus } from '../events/bus';
import { watchTable } from '../events/db-source';
import { createProject, deleteProject } from '../projects/repo';
import { createTask, getTask, setStatus, resetStuckTaskToFailed } from '../tasks/repo';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { Orchestrator, type StubRoute } from './index';
import type { GameVerifyRunner, GameVerifyVerdict } from './index';
import { claimNext, complete, countByStatus, enqueue } from './workqueue';
import { writeAgentEvent } from '../analytics/events';
import { __setBudgetForTest } from '../analytics/spend-budget';
import type { CommandRunner, CommandResult } from './post-task';
import { execFileRunner as gitExecFileRunner } from './post-task';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// WI-2: the orchestrator drains code-write tasks through launchSession; against a non-git path
// fixture the real acquirer would fail closed. This fake returns a deterministic per-session
// worktree cwd+branch so these queue/cap/concurrency tests exercise the WI-2 wiring (cwd is the
// worktree, persistence happens) without a real repo. Real worktree mechanics: launch.test.ts.
const fakeWt = async (root: string, sid: string) => ({
	cwd: `${root}/.wt/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
	branch: `atelier/session/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
	cleanup: async () => {}
});

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

// Bounded-retry clear: a bare DELETE here races the writers the previous case left in
// flight and loses on a conflict the DB labels retryable — the rotating-red class.
async function clearQueue(): Promise<void> {
	await clearTable(db, 'work_item');
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
			route: stubRoute(),
			acquireWorktree: fakeWt,
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

			// WI-2: a code-write spawn runs in the per-session WORKTREE (off the project root via the
			// injected fake acquirer), NOT the shared project root — with the 1.4a isolated config.
			expect(backend.plans[0].cwd).toContain('F:/code/orch/.wt/');
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
		const orch = new Orchestrator({ db, bus, runtime, maxConcurrent: 4, route: stubRoute(), acquireWorktree: fakeWt });
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
		const orch = new Orchestrator({ db, bus, runtime, maxConcurrent: 2, route: stubRoute(), acquireWorktree: fakeWt });
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
		const ev = new Orchestrator({ db, bus, runtime, maxConcurrent: 1, route: stubRoute(), acquireWorktree: fakeWt });
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
			route: stubRoute(),
			acquireWorktree: fakeWt,
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
			route: stubRoute(),
			acquireWorktree: fakeWt,
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
			acquireWorktree: fakeWt,
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

	// ── COST-GOVERNANCE-SPEC CG-2 — the GLOBAL rolling-24h TOKEN budget ──────────────────
	//
	// Two paths: (1) the DRAIN GATE parks BEFORE claiming (the efficient, spin-free park — the
	// production background behavior since drain-budget == launchSession-budget); (2) the
	// launchSession BACKSTOP for the narrow race where the budget is crossed after the drain gate
	// let a claim through — #runItem must PARK (release the work_item to pending), NOT burn the task.

	/** Seed one durable COMPLETION agent_event carrying spend (the counter's source rows). */
	async function seedSpend(tokensIn: number, tokensOut: number): Promise<void> {
		await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn,
			tokensOut,
			detail: { ok: true }
		});
	}

	it('CG-2 drain gate: over budget ⇒ the drain PARKS (never claims); work stays pending, task stays ready', async () => {
		await clearQueue();
		await db.query(`DELETE agent_event;`);
		await seedSpend(1500, 1500); // 3000 spent ≥ 500 budget
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8, // NOT the limiter — the token budget is
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
			dailyTokenBudget: 500
		});
		orch.start();
		try {
			const t = await createTask(db, { project: projectId, title: 'over-budget', description: 'parked by token budget' });
			const statusBefore = (await getTask(db, t.id))?.status;
			await orch.enqueueTask(t.id, projectId);
			await orch.drain();
			await new Promise((r) => setTimeout(r, 200));
			// Nothing claimed/spawned — the drain gate parked it BEFORE the claim.
			expect(backend.plans.length).toBe(0);
			expect(await countByStatus(db, 'pending')).toBe(1); // work parked, not lost
			expect(await countByStatus(db, 'processing')).toBe(0);
			// The task was never claimed/moved (the drain gate parked before the claim) — not burned.
			expect((await getTask(db, t.id))?.status).toBe(statusBefore);
			expect((await getTask(db, t.id))?.status).not.toBe('failed');
		} finally {
			orch.stop();
			await db.query(`DELETE agent_event;`);
		}
	}, 30_000);

	it('CG-2 launchSession backstop: a claimed item refused on budget is PARKED (released to pending), task NOT failed', async () => {
		await clearQueue();
		await db.query(`DELETE agent_event;`);
		await seedSpend(400, 400); // 800 spent ≥ 500 launchSession budget
		// Drain gate OFF (dailyTokenBudget undefined) so the item IS claimed; launchSession's own CG-2
		// gate (reads the injected budget) then refuses AFTER the claim — the race backstop.
		__setBudgetForTest(500);
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt
			// no dailyTokenBudget ⇒ no drain gate ⇒ the claim goes through to launchSession
		});
		orch.start();
		try {
			const t = await createTask(db, { project: projectId, title: 'race-backstop', description: 'refused after claim' });
			await orch.enqueueTask(t.id, projectId);
			await orch.drain();
			// STOP immediately: #stopped short-circuits the finally's re-drain, so the released item is
			// NOT re-claimed into a spin (in production the drain gate — same budget — parks it instead).
			orch.stop();
			// Wait for #runItem's async refuse→park→release to settle.
			await waitForAsync(async () => (await countByStatus(db, 'pending')) === 1, 8000).catch(() => {});
			await new Promise((r) => setTimeout(r, 100));
			// launchSession refused BEFORE spawning the backend (no plan), the work_item is RELEASED to
			// pending (park-not-crash, not marked failed/done), and the task is NOT burned to failed.
			expect(backend.plans.length).toBe(0);
			expect(await countByStatus(db, 'pending')).toBe(1);
			expect(await countByStatus(db, 'failed')).toBe(0);
			expect(await countByStatus(db, 'done')).toBe(0);
			expect((await getTask(db, t.id))?.status).not.toBe('failed');
		} finally {
			orch.stop();
			__setBudgetForTest(null);
			await db.query(`DELETE agent_event;`);
		}
	}, 30_000);

	it('TASK 2.15 — orch.gc() reaps aged terminal rows (fire-and-forget maintenance, D-017)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const runtime = new ClaudeCodeRuntime({ backend: gatedBackend() });
		const orch = new Orchestrator({ db, bus, runtime, maxConcurrent: 1, mode: 'manual', route: stubRoute(), acquireWorktree: fakeWt });
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

	// ── concurrency.perProject — the PER-PROJECT in-flight gate (F-046 / F-007) ──────────
	//
	// Proves the previously-dead `perProject` config is now ENFORCED: at most `perProject`
	// SESSIONS for the SAME project run concurrently (an ADDITIONAL cap on top of maxConcurrent),
	// two DIFFERENT projects still run concurrently, and a spawn that THROWS still decrements the
	// per-project counter (no permanent wedge — F-014). Manual mode + an explicit drain so the
	// daily/interactive caps are NOT the limiter under test — only the per-project gate is.
	it('perProject=1: 2 ready tasks in ONE project → only 1 in flight; the 2nd runs after the 1st completes', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8, // global cap is NOT the limiter — the per-project cap (1) is
			perProject: 1,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
		});
		orch.start();
		try {
			const a = await createTask(db, { project: projectId, title: 'pp A', description: 'same project' });
			const b = await createTask(db, { project: projectId, title: 'pp B', description: 'same project' });
			await orch.enqueueTask(a.id, projectId);
			await orch.enqueueTask(b.id, projectId);
			await orch.drain();

			// Only ONE spawn started despite two ready + 8 free interactive permits — the
			// per-project cap (1) parked the second. The 2nd is left pending (not lost).
			await waitFor(() => backend.plans.length >= 1);
			await backend.gates[0].started;
			await new Promise((r) => setTimeout(r, 300));
			expect(backend.plans.length).toBe(1);
			expect(orch.inFlightFor(projectId)).toBe(1);
			expect(await countByStatus(db, 'pending')).toBe(1); // the 2nd parked
			expect(await countByStatus(db, 'processing')).toBe(1);

			// Release the first — its completion finally drops the per-project count and re-drains,
			// so the SECOND same-project task now claims+spawns (event-driven, no busy poll).
			backend.gates[0].release();
			await waitFor(() => backend.plans.length >= 2, 10_000);
			await backend.gates[1].started;
			expect(backend.plans.length).toBe(2);
			expect(orch.inFlightFor(projectId)).toBe(1); // still only ONE at a time

			backend.gates[1].release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
			await waitFor(() => orch.inFlightFor(projectId) === 0, 5_000);
			expect(await countByStatus(db, 'pending')).toBe(0); // both eventually drained
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('perProject=1: 2 ready tasks in TWO different projects → BOTH run concurrently (global cap permitting)', async () => {
		await clearQueue();
		const other = await createProject(db, {
			slug: 'orch_pp2',
			name: 'Orch Host 2',
			root_path: 'F:/code/orch2'
		});
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8,
			perProject: 1,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
		});
		orch.start();
		try {
			const a = await createTask(db, { project: projectId, title: 'proj1', description: 'project one' });
			const b = await createTask(db, { project: other.id, title: 'proj2', description: 'project two' });
			await orch.enqueueTask(a.id, projectId);
			await orch.enqueueTask(b.id, other.id);
			await orch.drain();

			// BOTH spawn concurrently — the per-project cap is per-project, so two DIFFERENT
			// projects each get their one slot at once (global maxConcurrent=8 permits it).
			await waitFor(() => backend.plans.length >= 2);
			await Promise.all([backend.gates[0].started, backend.gates[1].started]);
			expect(backend.plans.length).toBe(2);
			expect(backend.concurrentPeak).toBe(2); // genuinely concurrent
			expect(orch.inFlightFor(projectId)).toBe(1);
			expect(orch.inFlightFor(other.id)).toBe(1);

			for (const g of backend.gates) g.release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
			await waitFor(() => orch.inFlightFor(projectId) === 0 && orch.inFlightFor(other.id) === 0, 5_000);
		} finally {
			orch.stop();
			await deleteProject(db, other.id).catch(() => {});
		}
	}, 30_000);

	it('perProject=1: a spawn that THROWS still decrements the per-project counter (no wedge — F-014)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		// A route resolver that THROWS on the FIRST call only (the spawn path then rejects into
		// #runItem's catch → ok=false → the work_item is marked failed). The decrement MUST still
		// happen in the finally, or the project would be permanently wedged at its cap.
		let calls = 0;
		const flakyRoute = (t: string, p: string): StubRoute => {
			calls++;
			if (calls === 1) throw new Error('route boom (simulated spawn failure)');
			return stubRoute()(t, p);
		};
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8,
			perProject: 1,
			mode: 'manual',
			route: flakyRoute,
			acquireWorktree: fakeWt,
		});
		orch.start();
		try {
			const a = await createTask(db, { project: projectId, title: 'throw A', description: 'spawn throws' });
			const b = await createTask(db, { project: projectId, title: 'then B', description: 'must still run' });
			await orch.enqueueTask(a.id, projectId);
			await orch.enqueueTask(b.id, projectId);
			await orch.drain();

			// The first claim bumped the project to 1, then the route threw → #runItem's catch +
			// finally marks it failed, DROPS the per-project count back to 0, and re-drains. The
			// counter did NOT leak: the project is claimable again, so the SECOND task spawns.
			await waitFor(() => backend.plans.length >= 1, 10_000);
			await backend.gates[0].started;
			// One item failed (the throw), one spawned (the recovery) — the count is back to 1
			// (the surviving in-flight session), never stuck at the cap with nothing running.
			expect(orch.inFlightFor(projectId)).toBe(1);
			expect(backend.plans.length).toBe(1);
			expect(await countByStatus(db, 'failed')).toBe(1); // the throwing item marked failed

			backend.gates[0].release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
			await waitFor(() => orch.inFlightFor(projectId) === 0, 5_000);
			// No wedge: the counter returned to 0 on the throw path AND the success path.
			expect(orch.inFlightFor(projectId)).toBe(0);
			expect(await countByStatus(db, 'pending')).toBe(0);
		} finally {
			orch.stop();
		}
	}, 30_000);

	// ── HB-H1 extension — the per-project gate on cwd-spawning work ─────────────────────────────
	//
	// Two spawning items for the SAME project would re-open the F-046/F-007 same-repo race. Proves
	// the per-project gate serializes them, never parks the in-process forks, and still lets two
	// DIFFERENT projects run concurrently.
	//
	// PCG-1 NOTE: this pair used to drive one of the two items as a `review` work_item, because
	// review.ts documented a review as running "through launchSession exactly like a task_run". That
	// is no longer true and MUST not be: a review item's payload.taskId is the REVIEWED task, so the
	// task-spawn path would re-spawn the very task under review. `review` is now intercepted by the
	// #runItem review fork (it escalates to the operator and spawns nothing) — covered by its own
	// test below, including that it still bumps + DROPS the per-project counter.
	it('perProject=1: two task_runs for ONE project → only 1 in flight; the 2nd runs after the 1st completes', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8, // global cap is NOT the limiter — the per-project cap (1) is
			perProject: 1,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
		});
		orch.start();
		try {
			const a = await createTask(db, { project: projectId, title: 'cwd A', description: 'task_run' });
			const b = await createTask(db, { project: projectId, title: 'cwd B', description: 'task_run' });
			// Two cwd-spawning items for the SAME project: both carry taskId+projectId so #runItem
			// runs each through launchSession in the shared cwd.
			await orch.enqueueTask(a.id, projectId);
			await orch.enqueueTask(b.id, projectId);
			await orch.drain();

			// Only ONE of the two cwd-spawning items started despite two ready + 8 free permits — the
			// per-project cap (1) parked the second.
			await waitFor(() => backend.plans.length >= 1);
			await backend.gates[0].started;
			await new Promise((r) => setTimeout(r, 300));
			expect(backend.plans.length).toBe(1);
			expect(orch.inFlightFor(projectId)).toBe(1);
			expect(await countByStatus(db, 'pending')).toBe(1); // the 2nd cwd-spawn parked
			expect(await countByStatus(db, 'processing')).toBe(1);

			// Release the first — its completion drops the per-project count + re-drains, so the SECOND
			// cwd-spawning item now claims + spawns.
			backend.gates[0].release();
			await waitFor(() => backend.plans.length >= 2, 10_000);
			await backend.gates[1].started;
			expect(backend.plans.length).toBe(2);
			expect(orch.inFlightFor(projectId)).toBe(1); // still only ONE at a time
			// Never two concurrent same-project cwd spawns — the F-046/F-007 race stays closed.
			expect(backend.concurrentPeak).toBe(1);

			backend.gates[1].release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
			await waitFor(() => orch.inFlightFor(projectId) === 0, 5_000);
			expect(await countByStatus(db, 'pending')).toBe(0); // both eventually drained
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('perProject=1: a memory_review fork is NEVER parked even when the project is at its cwd-spawn cap', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		// memory_review runs the in-process writer FORK (no cwd spawn). It must drain even while a
		// same-project task_run holds the project's only cwd-spawn slot — gating it would starve the
		// FAST-tier writer fork (the explicit HB-H1 deviation rationale). A memory dep is required for
		// the fork to run; inject a mock that records the run and writes nothing real (F-008: mock in test).
		let forkRan = false;
		const memory = {
			service: { db, embedder: { embed: async () => new Array(1024).fill(0) } },
			extract: async () => {
				forkRan = true;
				return [];
			},
			proposeSkills: async () => []
		} as unknown as ConstructorParameters<typeof Orchestrator>[0]['memory'];
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8,
			perProject: 1,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
			memory
		});
		orch.start();
		try {
			const a = await createTask(db, { project: projectId, title: 'holds slot', description: 'task_run' });
			await orch.enqueueTask(a.id, projectId);
			// A memory_review fork for the SAME project — it carries the project link but writes nothing
			// to the cwd, so the gate must NEVER park it even though the project is at its cwd-spawn cap.
			await enqueue(db, {
				workType: 'memory_review',
				payload: { kind: 'memory', turnText: 'note worth keeping' },
				projectId,
				sessionId: undefined,
				dedupScope: 'mr1'
			});
			await orch.drain();

			// The task_run is in flight (holding the project's 1 cwd-spawn slot). The memory_review fork
			// must STILL drain — it is never gated. It completes synchronously (no backend.run), so wait
			// for it to terminal-complete and confirm it actually ran.
			await waitFor(() => backend.plans.length >= 1);
			await backend.gates[0].started;
			await waitFor(() => forkRan, 5_000); // the fork drained despite the project being at cap
			expect(orch.inFlightFor(projectId)).toBe(1); // the fork did NOT bump the per-project counter
			// No memory_review row left pending — it was claimed + completed (forkRan), never parked.
			const [mrPending] = await db.query<[Array<{ c: number }>]>(
				`SELECT count() AS c FROM work_item WHERE work_type = "memory_review" AND status = "pending" GROUP ALL;`
			);
			expect(Number(mrPending?.[0]?.c ?? 0)).toBe(0);

			backend.gates[0].release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
			await waitFor(() => orch.inFlightFor(projectId) === 0, 5_000);
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('perProject=1: a task_run in project A + a task_run in project B → BOTH run concurrently', async () => {
		await clearQueue();
		const other = await createProject(db, {
			slug: 'orch_pp_cwd2',
			name: 'Orch Host CWD2',
			root_path: 'F:/code/orch-cwd2'
		});
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8,
			perProject: 1,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
		});
		orch.start();
		try {
			const a = await createTask(db, { project: projectId, title: 'A task', description: 'task_run' });
			const b = await createTask(db, { project: other.id, title: 'B task', description: 'task_run' });
			// One cwd-spawning item per project — DIFFERENT projects, so each gets its own cwd-spawn
			// slot and both run at once (global maxConcurrent=8 permits it).
			await orch.enqueueTask(a.id, projectId);
			await orch.enqueueTask(b.id, other.id);
			await orch.drain();

			await waitFor(() => backend.plans.length >= 2);
			await Promise.all([backend.gates[0].started, backend.gates[1].started]);
			expect(backend.plans.length).toBe(2);
			expect(backend.concurrentPeak).toBe(2); // genuinely concurrent across two projects
			expect(orch.inFlightFor(projectId)).toBe(1);
			expect(orch.inFlightFor(other.id)).toBe(1);

			for (const g of backend.gates) g.release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
			await waitFor(() => orch.inFlightFor(projectId) === 0 && orch.inFlightFor(other.id) === 0, 5_000);
		} finally {
			orch.stop();
			await deleteProject(db, other.id).catch(() => {});
		}
	}, 30_000);

	// ── PCG-1 — the `review` work_item fork ──────────────────────────────────────────────────────
	//
	// Wiring maybeEnqueueReview means real `review` items now hit the drain. A review item carries
	// `payload.taskId` = the REVIEWED task, so without a fork the task-spawn path would re-spawn the
	// very task under review — a full session, redoing the work. This proves the fork intercepts it:
	// nothing spawns, the operator gets an honest escalation, the item goes terminal (no re-drain
	// spin), and the per-project in-flight counter it bumped is DROPPED (a leak would wedge the
	// project at its cap forever — the F-014 class).
	it('PCG-1: a `review` work_item ESCALATES to the operator and spawns NOTHING (never re-spawns the reviewed task)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 4,
			perProject: 1,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt
		});
		orch.start();
		try {
			const reviewed = await createTask(db, {
				project: projectId,
				title: 'a big change',
				description: 'the task whose change is under review'
			});
			await enqueue(db, {
				workType: 'review',
				payload: {
					taskId: reviewed.id,
					projectId,
					sessionId: 'session:fake',
					changedFiles: 7,
					reason: 'change touched 7 files (>= 5)'
				},
				projectId,
				dedupScope: reviewed.id
			});
			await orch.drain();
			await waitForAsync(async () => (await countByStatus(db, 'done')) >= 1);

			// NOTHING was spawned — no session, no tokens, no re-run of the reviewed task.
			expect(backend.plans.length).toBe(0);
			// The item is terminal, so it never re-drains in a loop.
			expect(await countByStatus(db, 'pending')).toBe(0);
			expect(await countByStatus(db, 'processing')).toBe(0);
			// The per-project counter it bumped came back down (no wedge at the cap).
			await waitForAsync(async () => orch.inFlightFor(projectId) === 0);

			// The operator gets an HONEST escalation naming the task, the size and the fact that no
			// automated reviewer ran — never a silent `done` that reads like a review happened.
			const [events] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event
				   WHERE type = "escalation" AND detail.reason = $reason AND detail.taskId = $tid;`,
				{ reason: 'code-review-requested', tid: reviewed.id }
			);
			expect(events.length).toBe(1);
			expect(events[0].detail.changed_files).toBe(7);
			expect(String(events[0].detail.status)).toContain('no automated reviewer is armed');
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('manual mode: no bus subscription — a ready task does NOT auto-spawn; runOnce drains', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({ db, bus, runtime, maxConcurrent: 2, mode: 'manual', route: stubRoute(), acquireWorktree: fakeWt });
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

/**
 * HB-H3 — a backend whose stream runs an injected `onMidRun` hook AFTER the task has been
 * moved ready→in_progress (claim) but BEFORE the run completes (done). This simulates a
 * concurrent operator/PM status move landing DURING the session run — the mid-run window
 * the HB-H2 claim-time gate does NOT cover.
 */
function midRunMoveBackend(
	onMidRun: () => Promise<void>
): CcBackend & { plans: CcSpawnPlan[] } {
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
					// The concurrent move lands mid-run, before the session reports done.
					await onMidRun();
					yield { type: 'done', result: { ok: true, summary: 'work done', ccSessionId } };
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
			acquireWorktree: fakeWt,
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

			// F-007 — the work was committed via execFile arrays. The LEADING rev-parse reads the
			// pre-commit base sha (the review's diff base — 'HEAD' after a commit is an empty diff);
			// then git add / commit / rev-parse (the sha readback).
			const gitVerbs = runner.calls.filter((c) => c.file === 'git').map((c) => c.args[0]);
			expect(gitVerbs).toEqual(['rev-parse', 'add', 'commit', 'rev-parse']);

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
			acquireWorktree: fakeWt,
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

	it('BL-R3 success-side twin: a DONE session with post-task DISABLED advances the task to done (never stranded in_progress)', async () => {
		// The success-side strand close (BL-R3). The spawn path moves the task ready→in_progress; with
		// NO post-task wiring, post-task — the ONLY writer of a task's terminal `done` — never runs, so
		// the OLD behaviour stranded the task at `in_progress` forever (an invisible half-state, the
		// F-048 class, mirror of the BL-R2 failed-side strand). The orchestrator's success-side terminal
		// writer now drives an ok spawn with post-task off to the honest terminal `done`, so the PM's
		// terminal db_change fires. Production ALWAYS enables post-task, so this path is degenerate-only.
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
			route: stubRoute(),
			acquireWorktree: fakeWt
			// postTask intentionally omitted (the degenerate default-off path BL-R3 guards).
		});
		orch.start();
		const watch = await watchTable(db, bus, 'task');
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'no post-task',
				description: 'a successful spawn must not strand the task in_progress'
			});
			await setStatus(db, task.id, 'ready');
			await waitFor(() => orch.spawnCount >= 1, 10_000);
			// The spawn ran (ready→in_progress) and, with post-task off, the success-side writer advances
			// it to the honest terminal `done` — NOT left stranded at in_progress.
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'done');
			expect((await getTask(db, task.id))?.status).toBe('done');
		} finally {
			orch.stop();
			await watch.stop();
		}
	}, 30_000);

	it('HB-H2 — a STALE claim (task NOT in a legal pre-state, e.g. backlog) with post-task enabled never produces a silent {done work_item + ok event + non-terminal task}', async () => {
		// The RED-TEAM PROBE. A task_run is claimed whose task is `backlog` — the same class as a
		// concurrent operator/PM move between enqueue and claim, or a stale work_item (the daily-cap
		// test exercises backlog tasks). backlog→in_progress is an ILLEGAL transition, so the task
		// never lands in a post-task-eligible pre-state. Pre-fix: post-task still git-committed +
		// marked the work_item `done` + wrote an ok:true completion event WHILE post-task.ts silently
		// skipped the terminal task UPDATE → committed work under a non-terminal task the PM never saw.
		// We assert that exact divergence CANNOT occur: no commit, work_item failed, divergence event.
		await clearQueue();
		const bus = new EventBus();
		const backend = outcomeBackend(true); // the SESSION succeeds — the divergence is the STALE TASK
		const runtime = new ClaudeCodeRuntime({ backend });
		const runner = fakePostTaskRunner();
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 2,
			mode: 'manual', // drive the drain explicitly — no bus trigger needed for a hand-enqueued item
			route: stubRoute(),
			acquireWorktree: fakeWt,
			postTask: { enabled: true, runner, followUpOnTestFail: false }
		});
		try {
			// A task left on `backlog` (createTask default) — NEVER moved to ready. Then enqueue a
			// task_run for it directly (the stale-claim shape) and drain.
			const task = await createTask(db, {
				project: projectId,
				title: 'stale claim',
				description: 'claimed while not in a legal post-task pre-state'
			});
			expect((await getTask(db, task.id))?.status).toBe('backlog');
			await orch.enqueueTask(task.id, projectId);
			await orch.drain();

			// The session ran (the spawn is unconditional, HB-1 byte-unchanged)…
			await waitForAsync(async () => backend.plans.length >= 1);
			// …but the work_item must settle, and the divergence handling must have fired.
			await waitForAsync(async () => (await countByStatus(db, 'done')) + (await countByStatus(db, 'failed')) >= 1);

			// (1) The task is STILL backlog — it never (and could never) reach terminal. That is the
			//     honest state; the divergence is made observable elsewhere, NOT papered over here.
			expect((await getTask(db, task.id))?.status).toBe('backlog');

			// (2) NO commit happened — the post-task happy path was refused (the exact silent-commit close).
			const gitCalls = runner.calls.filter((c) => c.file === 'git');
			expect(gitCalls.length).toBe(0);

			// (3) The work_item is `failed`, NOT `done` — a false `done` is the divergence.
			expect(await countByStatus(db, 'done')).toBe(0);
			expect(await countByStatus(db, 'failed')).toBe(1);

			// (4) NO POST-TASK completion event was written for THIS run's session (a `post-task loop`
			//     completion carrying ok:true under a non-terminal task is precisely the lie that says
			//     "the task finished"). The SESSION's OWN lifecycle completion (launchSession) is honest
			//     and expected — the agent run did succeed; only the post-task terminal-claim is refused.
			//     Instead a divergence `error` event linked to that session names the cause so the PM/
			//     operator can SEE it. Scope by session (agent_event rows accumulate across tests on the
			//     shared DB — clearQueue only wipes work_item) so we assert THIS run's events.
			const [sessions] = await db.query<[Array<{ id: unknown }>]>(
				`SELECT id FROM session WHERE task = $tid;`,
				{ tid: new StringRecordId(task.id) }
			);
			expect(sessions.length).toBe(1);
			const sessionId = String(sessions[0].id);

			const [postTaskCompletions] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event WHERE type = 'completion' AND detail.reason = 'post-task loop' AND session = $sid;`,
				{ sid: new StringRecordId(sessionId) }
			);
			expect(postTaskCompletions.length).toBe(0);

			const [divergences] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event WHERE type = 'error' AND detail.reason = 'post-task-divergence' AND session = $sid;`,
				{ sid: new StringRecordId(sessionId) }
			);
			expect(divergences.length).toBe(1);
			expect(String(divergences[0].detail.taskId)).toBe(task.id);
			expect(String(divergences[0].detail.by)).toBe('orchestrator');
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('HB-H3 — a MID-RUN concurrent status move (task moved out of in_progress DURING the run) never produces a silent {commit + ok event + non-terminal task}', async () => {
		// The residual window HB-H2 did NOT close: the task IS in a legal pre-state at CLAIM
		// (preStateEligible=true), so it passes the claim-time gate. But an operator/PM moves it
		// out of in_progress DURING the session run, BEFORE the post-task transition. Pre-fix:
		// runPostTask still git-committed + wrote an ok:true completion event while the guarded
		// terminal UPDATE silently skipped → committed work under a non-terminal task. We assert
		// that exact mid-run divergence CANNOT occur: no commit, work_item failed, divergence event.
		await clearQueue();
		const bus = new EventBus();
		const runner = fakePostTaskRunner();

		// The mid-run move: capture the claimed task id from the spawn plan, then move it to
		// `blocked` (a legal, non-eligible status) before the run reports done.
		let claimedTaskId: string | null = null;
		const backend = midRunMoveBackend(async () => {
			if (claimedTaskId) {
				await setStatus(db, claimedTaskId, 'blocked');
			}
		});
		// claimedTaskId is the task we enqueue (one task in flight); set just below.
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 2,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
			postTask: { enabled: true, runner, followUpOnTestFail: false }
		});
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'mid-run move',
				description: 'moved out of in_progress during the run'
			});
			await setStatus(db, task.id, 'ready'); // legal pre-state at claim
			claimedTaskId = task.id;

			await orch.enqueueTask(task.id, projectId);
			await orch.drain();

			await waitForAsync(async () => backend.plans.length >= 1);
			await waitForAsync(
				async () => (await countByStatus(db, 'done')) + (await countByStatus(db, 'failed')) >= 1
			);

			// (1) the task is `blocked` (the concurrent mover owns it) — NOT silently 'done'.
			expect((await getTask(db, task.id))?.status).toBe('blocked');

			// (2) NO commit happened — the post-task happy path was refused at the transition gate.
			expect(runner.calls.filter((c) => c.file === 'git').length).toBe(0);

			// (3) the work_item is `failed`, NOT `done` (a false `done` is the divergence).
			expect(await countByStatus(db, 'done')).toBe(0);
			expect(await countByStatus(db, 'failed')).toBe(1);

			const [sessions] = await db.query<[Array<{ id: unknown }>]>(
				`SELECT id FROM session WHERE task = $tid;`,
				{ tid: new StringRecordId(task.id) }
			);
			expect(sessions.length).toBe(1);
			const sessionId = String(sessions[0].id);

			// (4) NO ok `post-task loop` completion event for this session.
			const [completions] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event WHERE type = 'completion' AND detail.reason = 'post-task loop' AND session = $sid;`,
				{ sid: new StringRecordId(sessionId) }
			);
			expect(completions.length).toBe(0);

			// (5) a divergence `error` event (mid-run) names the cause — the half-state is observable.
			const [divergences] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event WHERE type = 'error' AND detail.reason = 'post-task-divergence-midrun' AND session = $sid;`,
				{ sid: new StringRecordId(sessionId) }
			);
			expect(divergences.length).toBe(1);
			expect(String(divergences[0].detail.taskId)).toBe(task.id);
			expect(String(divergences[0].detail.actual_status)).toBe('blocked');
		} finally {
			orch.stop();
		}
	}, 30_000);
});

// ── WI-3 — merge-back + teardown composed with the heartbeat post-task, end to end ─────────
//
// These exercise the FULL #runItem path against a REAL temp git repo project: the real
// acquireSessionWorktree (WI-1/WI-2) puts the write session in an isolated worktree; a backend
// writes a file INTO that worktree; the REAL post-task git runner commits it on the session branch
// (HB-1); then the REAL merge-back FF-merges it into the project branch + tears the worktree down.
// Proves the composition AND no-lost-work for the done (merge) and failed (preserve) exits.

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function initGitRepo(): string {
	const base = mkdtempSync(join(tmpdir(), 'orch-mb-'));
	const repo = join(base, 'proj');
	execFileSync('git', ['init', '-b', 'main', repo]);
	git(repo, 'config', 'user.email', 'test@test.local');
	git(repo, 'config', 'user.name', 'Test');
	writeFileSync(join(repo, 'README.md'), '# seed\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-m', 'seed');
	return repo;
}

/** A backend that WRITES a file into the spawn cwd (the session worktree) before reporting its
 *  outcome — so the post-task `git add -A` + commit has a real change to commit on the branch. */
function fileWritingBackend(ok: boolean, fileName: string): CcBackend & { plans: CcSpawnPlan[] } {
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
					// Write the agent's "work" into the worktree cwd so there is something to commit.
					try {
						writeFileSync(join(plan.cwd, fileName), `agent work in ${fileName}\n`);
					} catch {
						/* the cwd is the real worktree; if it is missing the test will catch it downstream */
					}
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

describe('WI-3 — merge-back + teardown composed with post-task (real temp git repo)', () => {
	let repo: string;
	let mbProjectId: string;

	afterAll(async () => {
		if (mbProjectId) await deleteProject(db, mbProjectId).catch(() => {});
		if (repo) {
			try {
				rmSync(join(repo, '..'), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	});

	it('a DONE write session: post-task commits on the branch, merge-back FF-merges into the project branch + tears the worktree down', async () => {
		await clearQueue();
		repo = initGitRepo();
		const baseHead = git(repo, 'rev-parse', 'main');
		const proj = await createProject(db, { slug: 'mb_done', name: 'MB Done', root_path: repo });
		mbProjectId = proj.id;

		const bus = new EventBus();
		const backend = fileWritingBackend(true, 'feature.txt');
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo, '.harness-cc') });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 1,
			mode: 'manual',
			route: stubRoute(),
			// REAL worktree acquirer (the repo is a real git repo) + REAL git runners for both legs.
			postTask: { enabled: true, runner: gitExecFileRunner, followUpOnTestFail: false },
			mergeBack: { enabled: true, runner: gitExecFileRunner }
		});
		try {
			const task = await createTask(db, {
				project: mbProjectId,
				title: 'mb done',
				description: 'a done write session merges its branch back into the project branch'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, mbProjectId);
			await orch.drain();

			await waitForAsync(async () => backend.plans.length >= 1);
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'done');

			// the session ran in an isolated worktree (off the seed HEAD), on a session branch
			const [sessions] = await db.query<[Array<{ id: unknown; worktree_path?: unknown; worktree_branch?: unknown }>]>(
				`SELECT id, worktree_path, worktree_branch FROM session WHERE task = $tid;`,
				{ tid: new StringRecordId(task.id) }
			);
			expect(sessions.length).toBe(1);
			const branch = String(sessions[0].worktree_branch);
			const worktreePath = String(sessions[0].worktree_path);
			expect(branch).toContain('atelier/session/');

			// The merge-back is awaited inside #runItem but the drain returns before it. Its LAST
			// step is the BRANCH DELETE, not the teardown: merge-back.ts removes the worktree FIRST
			// (a branch checked out in a worktree cannot be deleted) and only then runs the safe
			// `git branch -d` (merge-back.ts:321-322). Waiting on the worktree alone therefore
			// proves the wrong thing — it returns inside the window between those two git calls,
			// and the branch assertion below then loses the race under load. Wait for the branch to
			// be gone: that is the true "whole success path completed" signal.
			const branchGone = () => {
				try {
					git(repo, 'rev-parse', '--verify', branch);
					return false;
				} catch {
					return true;
				}
			};
			await waitForAsync(async () => !existsSync(worktreePath) && branchGone());

			// NO LOST WORK: the session's commit is now on the project branch (main advanced).
			expect(git(repo, 'rev-parse', 'main')).not.toBe(baseHead);
			expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
			// teardown: the worktree is gone (no orphan) and the merged branch deleted.
			expect(existsSync(worktreePath)).toBe(false);
			expect(() => git(repo, 'rev-parse', '--verify', branch)).toThrow();
		} finally {
			orch.stop();
		}
	}, 40_000);

	it('a FAILED write session: branch + worktree PRESERVED (never lost), honest note stamped, project branch untouched', async () => {
		await clearQueue();
		const repo2 = initGitRepo();
		const baseHead = git(repo2, 'rev-parse', 'main');
		const proj = await createProject(db, { slug: 'mb_failed', name: 'MB Failed', root_path: repo2 });
		const failedProjectId = proj.id;

		const bus = new EventBus();
		const backend = fileWritingBackend(false, 'wip.txt'); // done(ok:false) → status 'failed'
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo2, '.harness-cc') });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 1,
			mode: 'manual',
			route: stubRoute(),
			postTask: { enabled: true, runner: gitExecFileRunner, followUpOnTestFail: false },
			mergeBack: { enabled: true, runner: gitExecFileRunner }
		});
		try {
			const task = await createTask(db, {
				project: failedProjectId,
				title: 'mb failed',
				description: 'a failed write session preserves its branch + worktree'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, failedProjectId);
			await orch.drain();

			await waitForAsync(async () => backend.plans.length >= 1);
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'failed');

			const [sessions] = await db.query<[Array<{ id: unknown; worktree_path?: unknown; worktree_branch?: unknown; note?: unknown }>]>(
				`SELECT id, worktree_path, worktree_branch, note FROM session WHERE task = $tid;`,
				{ tid: new StringRecordId(task.id) }
			);
			expect(sessions.length).toBe(1);
			const branch = String(sessions[0].worktree_branch);
			const worktreePath = String(sessions[0].worktree_path);

			// Wait for the PRESERVE advisory specifically — a failed session ALREADY carries
			// launchSession's failure note, so merge-back APPENDS "· work preserved …" to it; we must
			// not race-read the failure note alone before the append lands.
			await waitForAsync(async () => {
				const [rows] = await db.query<[Array<{ note?: unknown }>]>(
					`SELECT note FROM session WHERE id = $sid;`,
					{ sid: new StringRecordId(String(sessions[0].id)) }
				);
				return rows[0]?.note != null && String(rows[0].note).includes('preserved on branch');
			});

			// project branch NOT advanced (no merge of an incomplete session).
			expect(git(repo2, 'rev-parse', 'main')).toBe(baseHead);
			// the worktree is PRESERVED (a failed session keeps its tree for resume / inspection).
			expect(existsSync(worktreePath)).toBe(true);
			// honest preserve note on the session row (surfaces on the MC-4 surface).
			const [noteRows] = await db.query<[Array<{ note?: unknown }>]>(
				`SELECT note FROM session WHERE id = $sid;`,
				{ sid: new StringRecordId(String(sessions[0].id)) }
			);
			expect(String(noteRows[0].note)).toContain('preserved on branch');
			expect(String(noteRows[0].note)).toContain('merge needed');
			// the honest note names the ACTUAL session branch (so the operator can find the work).
			expect(String(noteRows[0].note)).toContain(branch);

			// the branch survives (a failed run does NOT commit, F-007, so it may equal HEAD); either
			// way NOTHING was lost or force-merged — the worktree registration is intact.
			expect(() => git(repo2, 'worktree', 'list')).not.toThrow();
		} finally {
			orch.stop();
			await deleteProject(db, failedProjectId).catch(() => {});
			try {
				rmSync(join(repo2, '..'), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}, 40_000);

	// ── PCG-1 — THE END-TO-END PROOF: a SUCCESSFUL session whose work fails the gate does NOT land ──
	//
	// This is the operator's finding, reproduced against a REAL git repo and a REAL SurrealDB: the
	// session ends `done`, its work is committed, and the project branch STILL does not advance,
	// because the pre-commit gate came back red. Git is driven by the real execFile runner (so the
	// merge decision is genuinely git's); only the GATE commands are scripted, so no build or test
	// suite is spawned.
	it('PCG-1: a DONE session whose PRE-COMMIT GATE fails is committed but NOT merged — task failed, branch preserved, fault visible', async () => {
		await clearQueue();
		const repo3 = initGitRepo();
		const baseHead = git(repo3, 'rev-parse', 'main');
		// A build_tool that resolves a real build step which the scripted runner below fails.
		//
		// NOT 'npm' — deliberately. The gate runs in the WI-2 WORKTREE, and a worktree is a bare
		// `git worktree add` checkout: no node_modules, and here not even a package.json. The gate
		// now REFUSES to spawn an npm step in a tree that cannot run one and records an honest skip
		// instead of a false RED (that false RED is what wedged every npm project). 'dotnet' has no
		// such environment precondition, so this test keeps exercising what it is actually about:
		// a genuinely RED gate is honored end-to-end. The npm/worktree case has its own coverage in
		// post-task-gate.test.ts and gate-review-real-runner.test.ts.
		const proj = await createProject(db, {
			slug: 'mb_gate_red',
			name: 'MB Gate Red',
			root_path: repo3,
			build_tool: 'dotnet'
		});
		const gateProjectId = proj.id;

		// Real git; every NON-git program (the gate's `dotnet build -c Release`) comes back RED.
		const gatedRunner: CommandRunner = async (file, args, opts) =>
			file === 'git'
				? gitExecFileRunner(file, args, opts)
				: { code: 1, stdout: '', stderr: 'src/broken.ts(1,1): error TS2304' };

		const bus = new EventBus();
		const backend = fileWritingBackend(true, 'gated.txt'); // the SESSION succeeds
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo3, '.harness-cc') });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 1,
			mode: 'manual',
			route: stubRoute(),
			postTask: {
				enabled: true,
				runner: gatedRunner,
				followUpOnTestFail: false,
				preCommitGate: true
			},
			mergeBack: { enabled: true, runner: gitExecFileRunner }
		});
		try {
			const task = await createTask(db, {
				project: gateProjectId,
				title: 'mb gate red',
				description: 'a done session whose work does not build must not reach the project branch'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, gateProjectId);
			await orch.drain();

			await waitForAsync(async () => backend.plans.length >= 1);
			// 1. THE TASK DOES NOT REPORT SUCCESS — the session was `done`, the gate says otherwise.
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'failed');

			const [sessions] = await db.query<[Array<{ id: unknown; worktree_path?: unknown; worktree_branch?: unknown }>]>(
				`SELECT id, worktree_path, worktree_branch FROM session WHERE task = $tid;`,
				{ tid: new StringRecordId(task.id) }
			);
			expect(sessions.length).toBe(1);
			const branch = String(sessions[0].worktree_branch);
			const worktreePath = String(sessions[0].worktree_path);

			// 2. THE WORK WAS PRESERVED, NOT MERGED. Wait for the preserve advisory so we do not
			//    race-read the note before merge-back stamps it.
			await waitForAsync(async () => {
				const [rows] = await db.query<[Array<{ note?: unknown }>]>(
					`SELECT note FROM session WHERE id = $sid;`,
					{ sid: new StringRecordId(String(sessions[0].id)) }
				);
				return rows[0]?.note != null && String(rows[0].note).includes('preserved on branch');
			});
			// THE HEADLINE ASSERTION: the project branch did not move. Unverified work did not land.
			expect(git(repo3, 'rev-parse', 'main')).toBe(baseHead);
			// …and the work is NOT lost — it is committed on the session branch, tree intact (F-007).
			expect(existsSync(worktreePath)).toBe(true);
			expect(() => git(repo3, 'rev-parse', '--verify', branch)).not.toThrow();
			expect(git(repo3, 'rev-parse', branch)).not.toBe(baseHead); // a real commit is sitting there

			// 3. THE FAILURE IS VISIBLE — the honest reason, not "session failed".
			const [noteRows] = await db.query<[Array<{ note?: unknown }>]>(
				`SELECT note FROM session WHERE id = $sid;`,
				{ sid: new StringRecordId(String(sessions[0].id)) }
			);
			expect(String(noteRows[0].note)).toContain('pre-commit gate FAILED');

			// …and in the drain ledger, with the full per-step record an operator can act on.
			const [faults] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event
				   WHERE type = "error" AND detail.stage = $stage AND detail.taskId = $tid;`,
				{ stage: 'pre_commit_gate', tid: task.id }
			);
			expect(faults.length).toBeGreaterThanOrEqual(1);
			// recordDrainFault SPREADS `context` into the detail, so the extra keys are top-level.
			const fault = faults[0].detail as {
				absorbed?: boolean;
				error?: string;
				consequence?: string;
				failed_at?: string;
				steps?: Array<{ name: string; ran: boolean; ok: boolean; detail: string }>;
			};
			expect(fault.absorbed).toBe(false); // it CHANGED the verdict — not a swallowed fault
			expect(String(fault.error)).toContain('TS2304'); // the compiler's own words survive
			expect(String(fault.consequence)).toContain('NOT merged');
			expect(fault.failed_at).toBe('build');
			// The full ordered step record is queryable — "which check failed, and what did it say".
			expect(fault.steps?.map((s) => s.name)).toEqual(['build', 'lint', 'typecheck', 'test']);
			expect(fault.steps?.find((s) => s.name === 'build')?.detail).toContain('TS2304');

			// 4. The work_item is terminal-failed, so nothing re-drains this forever.
			expect(await countByStatus(db, 'failed')).toBeGreaterThanOrEqual(1);
		} finally {
			orch.stop();
			await deleteProject(db, gateProjectId).catch(() => {});
			try {
				rmSync(join(repo3, '..'), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}, 40_000);

	// ── PCG-1 — THE OTHER HALF OF THE MERGE DECISION, AT THE DRAIN: the REVIEW HOLD ────────────
	//
	// WHY THIS TEST EXISTS. `shouldHoldMergeBack` is unit-tested pure, merge-back is tested with
	// 'review-held' handed to it directly, and post-task is tested for the review decision — but
	// NOTHING exercised the WIRE between them: the orchestrator reading ptRes.gate, applying the
	// policy, and turning the answer into an exitState merge-back honors. That wire is exactly
	// where the shipped defect lived (the hold keyed on gate.status alone), and each half being
	// green is precisely why it survived. So this drives the real drain, end to end.
	//
	// The HOLD case, by construction: a project with NO build_tool and NO test target ⇒ the gate is
	// 'skipped' with `unrunnable:false` — genuinely NOTHING to verify, which is the one case the
	// shipped 'unverified' policy is for — and a change big enough to trigger a review.
	it('PCG-1: a large change with NOTHING to verify is HELD — task done, branch preserved, review queued, project branch unmoved', async () => {
		await clearQueue();
		const repo4 = initGitRepo();
		const baseHead = git(repo4, 'rev-parse', 'main');
		// NO build_tool and NO test_command ⇒ every gate step resolves to nothing ⇒ 'skipped',
		// unrunnable:false. This is the "neither an automated gate NOR a review behind it" case.
		const proj = await createProject(db, {
			slug: 'mb_review_hold',
			name: 'MB Review Hold',
			root_path: repo4
		});
		const holdProjectId = proj.id;

		// Real git for every decision that matters (the merge, the branch, the commit) — only the
		// footprint MEASUREMENT is scripted, so the change reads as large without the backend having
		// to author six files. `git diff --name-only --no-renames <base>` is the review's one query.
		const holdRunner: CommandRunner = async (file, args, opts) => {
			if (file === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
				return { code: 0, stdout: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n', stderr: '' };
			}
			return gitExecFileRunner(file, args, opts);
		};

		const bus = new EventBus();
		const backend = fileWritingBackend(true, 'held.txt'); // the SESSION succeeds
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo4, '.harness-cc') });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 1,
			mode: 'manual',
			route: stubRoute(),
			postTask: {
				enabled: true,
				runner: holdRunner,
				followUpOnTestFail: false,
				preCommitGate: true,
				// The SHIPPED default, stated explicitly so the test pins the policy it claims to.
				review: { enabled: true, holdMergeBack: 'unverified' }
			},
			mergeBack: { enabled: true, runner: gitExecFileRunner }
		});
		try {
			const task = await createTask(db, {
				project: holdProjectId,
				title: 'mb review hold',
				description: 'a large change nothing could verify must not auto-merge'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, holdProjectId);
			await orch.drain();

			await waitForAsync(async () => backend.plans.length >= 1);
			// 1. THE TASK IS HONESTLY DONE — a hold is NOT a failure. The session worked; the change
			//    simply is not cleared to land. Reporting `failed` here would be the false-RED class.
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'done');

			const [sessions] = await db.query<[Array<{ id: unknown; worktree_branch?: unknown }>]>(
				`SELECT id, worktree_branch FROM session WHERE task = $tid;`,
				{ tid: new StringRecordId(task.id) }
			);
			expect(sessions.length).toBe(1);
			const branch = String(sessions[0].worktree_branch);

			// 2. THE HOLD IS VISIBLE where an operator looks, in its own words (not "session failed").
			await waitForAsync(async () => {
				const [rows] = await db.query<[Array<{ note?: unknown }>]>(
					`SELECT note FROM session WHERE id = $sid;`,
					{ sid: new StringRecordId(String(sessions[0].id)) }
				);
				return rows[0]?.note != null && String(rows[0].note).includes('held for code review');
			});

			// 3. THE HEADLINE: the project branch did NOT move, and the work is safe on its branch.
			expect(git(repo4, 'rev-parse', 'main')).toBe(baseHead);
			expect(() => git(repo4, 'rev-parse', '--verify', branch)).not.toThrow();
			expect(git(repo4, 'rev-parse', branch)).not.toBe(baseHead);

			// 4. The review the hold is waiting ON actually exists, and the completion event records
			//    the measured footprint + that it WAS measured (not an unmeasured 0 — F-008).
			const [reviews] = await db.query<[Array<{ id: unknown }>]>(
				`SELECT id FROM work_item WHERE work_type = "review" AND payload.taskId = $tid;`,
				{ tid: task.id }
			);
			expect(reviews.length).toBe(1);
			// Scoped to THIS session, not "the most recent N completions" — the whole suite shares one
			// SurrealDB, so a global recent-window query is a race against every other file writing
			// completion events (it passed alone and failed under the full suite).
			// F-020: every ORDER BY field is in the projection — `created_at` is selected, not only
			// sorted on (a missing order idiom is a parse error against real SurrealDB).
			const [events] = await db.query<[Array<{ detail: Record<string, unknown>; created_at: unknown }>]>(
				`SELECT detail, created_at FROM agent_event
				   WHERE session = $sid AND type = "completion" AND detail.reason = "post-task loop"
				   ORDER BY created_at DESC;`,
				{ sid: new StringRecordId(String(sessions[0].id)) }
			);
			const completion = events.find((e) => e.detail?.review_triggered === true);
			expect(completion).toBeTruthy();
			expect(completion!.detail.review_changed_files).toBe(6);
			expect(completion!.detail.review_measured).toBe(true);
			const gateDetail = completion!.detail.gate as { status?: string; unrunnable?: boolean };
			expect(gateDetail.status).toBe('skipped');
			// The distinction the whole 6878d14 fix turns on, asserted at the drain: this skip is
			// "nothing to verify", NOT "the environment could not verify".
			expect(gateDetail.unrunnable).toBe(false);
		} finally {
			orch.stop();
			await deleteProject(db, holdProjectId).catch(() => {});
			try {
				rmSync(join(repo4, '..'), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}, 40_000);

	// ── PCG-1 — THE GATE BYPASS (the follow-on review's finding, closed): a post-task FAULT must not
	//    become a merge. The post-task block is best-effort and its catch cannot flip the spawn
	//    verdict (F-014) — but `gateFailed`/`reviewHeld` then stayed false and merge-back computed
	//    'done', so an ARMED gate that never returned a verdict fast-forwarded the branch into the
	//    project branch anyway: the gated state change reached by a path around the gate (F-055).
	//    And because the fault lands BEFORE the commit, the branch carries no new commits, so the
	//    'done' path reads noop-empty and TEARS THE WORKTREE DOWN — deleting the work (F-007).
	it('PCG-1: a post-task FAULT with the gate armed does NOT merge and does NOT tear down the worktree', async () => {
		await clearQueue();
		const repo6 = initGitRepo();
		const baseHead = git(repo6, 'rev-parse', 'main');
		const proj = await createProject(db, {
			slug: 'mb_gate_unknown',
			name: 'MB Gate Unknown',
			root_path: repo6
		});
		const faultProjectId = proj.id;

		// The post-task loop's FIRST git call is `rev-parse --verify HEAD` (the review's diff base,
		// read before staging). Throwing there models any fault — DB, OS, or git — that aborts the
		// loop before a gate verdict exists. merge-back keeps its own REAL git runner, so the merge
		// decision below is genuinely git's.
		const faultingRunner: CommandRunner = async (file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') {
				throw new Error('injected post-task fault: git unavailable');
			}
			return { code: 0, stdout: '', stderr: '' };
		};

		const bus = new EventBus();
		const backend = fileWritingBackend(true, 'unverified.txt'); // the SESSION succeeds
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo6, '.harness-cc') });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 1,
			mode: 'manual',
			route: stubRoute(),
			postTask: {
				enabled: true,
				runner: faultingRunner,
				followUpOnTestFail: false,
				preCommitGate: true
			},
			mergeBack: { enabled: true, runner: gitExecFileRunner }
		});
		try {
			const task = await createTask(db, {
				project: faultProjectId,
				title: 'mb gate unknown',
				description: 'a gate that never answered must not let the work through'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, faultProjectId);
			await orch.drain();

			await waitForAsync(async () => backend.plans.length >= 1);

			const [sessions] = await db.query<[Array<{ id: unknown; worktree_path?: unknown; worktree_branch?: unknown }>]>(
				`SELECT id, worktree_path, worktree_branch FROM session WHERE task = $tid;`,
				{ tid: new StringRecordId(task.id) }
			);
			expect(sessions.length).toBe(1);
			const worktreePath = String(sessions[0].worktree_path);

			// THE HEADLINE: nothing unverified reached the project branch.
			await waitForAsync(async () => {
				const [rows] = await db.query<[Array<{ note?: unknown }>]>(
					`SELECT note FROM session WHERE id = $sid;`,
					{ sid: new StringRecordId(String(sessions[0].id)) }
				);
				return rows[0]?.note != null;
			});
			expect(git(repo6, 'rev-parse', 'main')).toBe(baseHead);

			// …and the agent's work was NOT destroyed: the worktree is still on disk. Under the old
			// behaviour this branch had no commits, so the 'done' merge path tore it down (F-007).
			expect(existsSync(worktreePath)).toBe(true);

			// THE REFUSAL IS VISIBLE, and says which kind of "unverified" this is.
			//
			// AND THIS IS THE FOLLOW-ON DoD-REVIEW'S FINDING #3, IN THE ONE TEST THAT COVERED IT. The
			// injected fault is on the FIRST git call, which the post-task loop makes AFTER the gate
			// (the gate is step 0). This project declares no build_tool and no test command, so the
			// gate really did answer here — 'skipped' — and the note this test used to assert,
			// "the pre-commit gate produced NO verdict", was FALSE for the very run it was asserting
			// on. It passed because nothing distinguished "no verdict" from "verdict, then a fault".
			// The headline guarantees above are unchanged; what changes is that the stamped reason is
			// now true.
			const [noteRows] = await db.query<[Array<{ note?: unknown }>]>(
				`SELECT note FROM session WHERE id = $sid;`,
				{ sid: new StringRecordId(String(sessions[0].id)) }
			);
			expect(String(noteRows[0].note)).toContain('FAULTED after the pre-commit gate');
			expect(String(noteRows[0].note)).not.toContain('produced NO verdict'); // it DID produce one
			expect(String(noteRows[0].note)).not.toContain('pre-commit gate FAILED'); // not a code verdict
			expect(String(noteRows[0].note)).toContain('not merged');

			// …and the drain ledger names the fault with the gate's REAL state at that moment.
			const [faults] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event
				   WHERE type = "error" AND detail.stage = $stage AND detail.taskId = $tid;`,
				{ stage: 'post_task', tid: task.id }
			);
			expect(faults.length).toBeGreaterThanOrEqual(1);
			const fault = faults[0].detail as {
				gate_armed?: boolean;
				consequence?: string;
				gate_verdict?: string;
			};
			expect(fault.gate_armed).toBe(true);
			expect(String(fault.consequence)).toContain('NOT merged');
			// The ledger row carries the verdict the gate actually produced, not a blanket 'none'.
			expect(String(fault.gate_verdict)).toContain('skipped');
			expect(String(fault.gate_verdict)).not.toContain('none —');
			expect(String(fault.consequence)).toContain('downstream of it');
		} finally {
			orch.stop();
			await deleteProject(db, faultProjectId).catch(() => {});
			try {
				rmSync(join(repo6, '..'), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}, 40_000);

	// The COMPLEMENT, and the regression that 6878d14 was: the SAME large change, but the gate
	// skipped because THIS ENVIRONMENT could not run the project's real checks. That must NOT hold —
	// it is every npm project on this platform, and no automated reviewer exists to release it. If
	// this ever goes red, the autonomous line is wedged again on every substantial task.
	it('PCG-1: a large change whose gate was skipped by the ENVIRONMENT is NOT held — it merges, review still queued', async () => {
		await clearQueue();
		const repo5 = initGitRepo();
		const baseHead = git(repo5, 'rev-parse', 'main');
		// An npm project: the WI-2 worktree has no node_modules, so every npm step is an environment
		// skip (`unrunnable:true`) rather than a false RED.
		const proj = await createProject(db, {
			slug: 'mb_env_skip',
			name: 'MB Env Skip',
			root_path: repo5,
			build_tool: 'npm'
		});
		const envProjectId = proj.id;

		const envRunner: CommandRunner = async (file, args, opts) => {
			if (file === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
				return { code: 0, stdout: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n', stderr: '' };
			}
			return gitExecFileRunner(file, args, opts);
		};

		const bus = new EventBus();
		const backend = fileWritingBackend(true, 'env.txt');
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo5, '.harness-cc') });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 1,
			mode: 'manual',
			route: stubRoute(),
			postTask: {
				enabled: true,
				runner: envRunner,
				followUpOnTestFail: false,
				preCommitGate: true,
				review: { enabled: true, holdMergeBack: 'unverified' }
			},
			mergeBack: { enabled: true, runner: gitExecFileRunner }
		});
		try {
			const task = await createTask(db, {
				project: envProjectId,
				title: 'mb env skip',
				description: 'an environment skip must not stall a healthy project'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, envProjectId);
			await orch.drain();

			await waitForAsync(async () => backend.plans.length >= 1);
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'done');

			// THE HEADLINE: the work LANDED. The project branch advanced past its base — no permanent
			// hold, no piled-up worktree, on a project this host simply cannot verify.
			await waitForAsync(async () => git(repo5, 'rev-parse', 'main') !== baseHead);
			expect(git(repo5, 'rev-parse', 'main')).not.toBe(baseHead);

			// …and the review is STILL queued: the policy changed what the merge WAITS on, never
			// whether the operator is told a large change went by unverified.
			const [reviews] = await db.query<[Array<{ id: unknown }>]>(
				`SELECT id FROM work_item WHERE work_type = "review" AND payload.taskId = $tid;`,
				{ tid: task.id }
			);
			expect(reviews.length).toBe(1);
		} finally {
			orch.stop();
			await deleteProject(db, envProjectId).catch(() => {});
			try {
				rmSync(join(repo5, '..'), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}, 40_000);
});

// R1-2 — the BACKSTOP maintenance gc. gcStale was built but never invoked automatically; this
// arms a bounded, unref'd interval that fires gc() so orphaned `processing` rows + aged terminal
// rows self-heal even when R1-1's targeted release is missed. Deterministic via fake timers (no
// real wall-clock sleep) and a stubbed gc (no DB hit), so we observe the scheduling contract:
// periodic firing, no overlap, and a clean teardown that leaks no timer.
describe('Orchestrator backstop maintenance gc (R1-2)', () => {
	function makeOrch(): Orchestrator {
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		return new Orchestrator({ db, bus: new EventBus(), runtime, maxConcurrent: 1, route: stubRoute() });
	}

	it('arms an unref’d interval that periodically runs gc; stop() clears it (no leaked timer)', async () => {
		vi.useFakeTimers();
		try {
			const orch = makeOrch();
			const gcSpy = vi
				.spyOn(orch, 'gc')
				.mockResolvedValue({ deletedTerminal: 0, recoveredStuck: 0 });

			expect(orch.maintenanceArmed).toBe(false);
			orch.startMaintenance({ intervalMs: 1000 });
			expect(orch.maintenanceArmed).toBe(true);
			// A second arm while already armed is a no-op (idempotent) — still one timer.
			orch.startMaintenance({ intervalMs: 1000 });

			await vi.advanceTimersByTimeAsync(1000);
			expect(gcSpy).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1000);
			expect(gcSpy).toHaveBeenCalledTimes(2);

			// Teardown clears the interval — and no further tick fires afterward (no leaked timer).
			orch.stop();
			expect(orch.maintenanceArmed).toBe(false);
			await vi.advanceTimersByTimeAsync(5000);
			expect(gcSpy).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not overlap runs: a still-in-flight gc makes the next tick a no-op', async () => {
		vi.useFakeTimers();
		try {
			const orch = makeOrch();
			let resolveFirst!: () => void;
			const gcSpy = vi.spyOn(orch, 'gc').mockImplementation(
				() =>
					new Promise((res) => {
						resolveFirst = () => res({ deletedTerminal: 0, recoveredStuck: 0 });
					})
			);

			orch.startMaintenance({ intervalMs: 1000 });
			// Tick 1 → gc starts and stays in flight (never resolves yet).
			await vi.advanceTimersByTimeAsync(1000);
			expect(gcSpy).toHaveBeenCalledTimes(1);
			// Tick 2 → SKIPPED because the prior gc is still in flight (#gcInFlight guard).
			await vi.advanceTimersByTimeAsync(1000);
			expect(gcSpy).toHaveBeenCalledTimes(1);

			// Let the first gc finish, flush the finally that clears the in-flight guard…
			resolveFirst();
			await Promise.resolve();
			await Promise.resolve();
			// …then the NEXT tick runs again (the backstop is not wedged by one slow run).
			await vi.advanceTimersByTimeAsync(1000);
			expect(gcSpy).toHaveBeenCalledTimes(2);

			orch.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('startMaintenance after stop() is a no-op (never arms a post-shutdown timer)', () => {
		const orch = makeOrch();
		orch.stop();
		orch.startMaintenance({ intervalMs: 1000 });
		expect(orch.maintenanceArmed).toBe(false);
	});
});

// ── BL-R2 (BL-R1 red-team named gap) — a FAILED task_run spawn/route must transition its TASK
//    off `in_progress`, never strand it until the next boot reaper. `task_run` work_items carry
//    no `session`, so BL-R1's releaseSessionWork can't reach the task; the orchestrator drain must
//    drive it to the honest terminal `failed` itself, after the work_item is marked failed. ──
describe('BL-R2 — a failed task_run spawn/route drives its TASK to failed (not stranded in_progress)', () => {
	// A route resolver that ALWAYS throws — simulates resolveRoute failing or the spawn path
	// rejecting BEFORE launchSession, the exact window where post-task (the only terminal-task
	// writer) never runs. The task was already moved ready→in_progress before the throw.
	const throwingRoute = (): StubRoute => {
		throw new Error('route boom (BL-R2 simulated route/spawn failure)');
	};

	it('route throws after ready→in_progress: task ends `failed`, work_item `failed`, no spawn, idempotent re-drive', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 4,
			mode: 'manual',
			route: throwingRoute,
			acquireWorktree: fakeWt
			// post-task INTENTIONALLY omitted — the DEFAULT boot state where the BL-R2 gap bites:
			// nothing on the success path writes the task terminal, and the failure path previously
			// left the task stranded `in_progress` until the next boot reaper (or forever, no restart).
		});
		orch.start();
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'route fails',
				description: 'a route/spawn failure must drive the task to failed, never strand it in_progress'
			});
			await setStatus(db, task.id, 'ready'); // backlog→ready so #runItem moves it ready→in_progress
			await orch.enqueueTask(task.id, projectId);
			await orch.drain();

			// The route threw → #runItem's catch (ok=false) → the work_item is marked failed AND the
			// task — left `in_progress` by the pre-spawn move — is driven to the honest terminal.
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'failed', 10_000);
			expect((await getTask(db, task.id))?.status).toBe('failed'); // honest terminal, NOT in_progress
			expect(await countByStatus(db, 'failed')).toBe(1); // the work_item marked failed
			expect(backend.plans.length).toBe(0); // route threw BEFORE any spawn — no fabricated route

			// Idempotent (interrupt contract): once the task is terminal, the guarded UPDATE matches
			// nothing — a re-run / concurrent terminal write moves zero rows and never throws.
			expect(await resetStuckTaskToFailed(db, task.id)).toBe(false);
			expect((await getTask(db, task.id))?.status).toBe('failed');
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('a SUCCESSFUL task_run still flows through post-task to `done` — the !ok-guarded failed-write never fires (no double-transition)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = outcomeBackend(true); // done(ok:true) → launchSession status 'done'
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/orch/.harness-cc' });
		const runner = fakePostTaskRunner();
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 2,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
			postTask: { enabled: true, runner, followUpOnTestFail: false }
		});
		orch.start();
		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'success path',
				description: 'a done session reaches done via post-task; the BL-R2 failed-write must NOT fire'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, projectId);
			await orch.drain();

			// post-task wrote the terminal `done`; because ok=true, the BL-R2 (!ok) failed-write is
			// skipped entirely — the task ends `done`, never clobbered to `failed`.
			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'done', 10_000);
			expect((await getTask(db, task.id))?.status).toBe('done');
			// No work_item left failed by a spurious double-transition (the success completed `done`).
			expect(await countByStatus(db, 'failed')).toBe(0);
		} finally {
			orch.stop();
		}
	}, 30_000);
});

// ── GAME-VERIFY wiring (docs/GAME-VERIFY-SPEC.md §"Orchestrator integration") ──────────────────
//
// Proves the orchestrator runs the game_verify step at the post-task seam: AFTER the build/test
// gate, on a CLEAN-done session, for projects that DECLARE a game_verify block — and NOT for a
// non-game project. The runner is INJECTED (a fake — NO real game launches, F-010/F-014); the
// step's own gate/persist/feed-back rails are unit-tested in game-verify-step.test.ts.
describe('GAME-VERIFY — the orchestrator runs the verify step after the post-task gate (gated by project config)', () => {
	const GAME_VERIFY = {
		launch_command: 'steam://rungameid/1557740',
		process_name: 'FakeGame.exe',
		log_path: 'C:/fake/BepInEx/LogOutput.log',
		ready_pattern: 'Chainloader startup complete'
	};
	const PASS_VERDICT: GameVerifyVerdict = {
		outcome: 'pass',
		ready: true,
		loaded: true,
		errorCount: 0,
		byPattern: {},
		stackTraces: [],
		logTail: 'startup complete'
	};

	/** A fake game-verify runner that records each invocation. NO real game. */
	function fakeGameRunner(
		verdict: GameVerifyVerdict
	): GameVerifyRunner & { calls: { processName: string; cwd: string }[] } {
		const calls: { processName: string; cwd: string }[] = [];
		const fn = (async (cfg, ctx) => {
			calls.push({ processName: cfg.process_name, cwd: ctx.cwd });
			return verdict;
		}) as GameVerifyRunner & { calls: typeof calls };
		fn.calls = calls;
		return fn;
	}

	it('a GAME project (game_verify declared): a clean-done task runs the verify step (verdict persisted), task stays done', async () => {
		await clearQueue();
		const gameProject = await createProject(db, {
			slug: 'orch_gv_game',
			name: 'orch-gv-game',
			root_path: 'F:/code/orch-gv-game',
			game_verify: GAME_VERIFY
		});
		const bus = new EventBus();
		const backend = outcomeBackend(true);
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/orch/.harness-cc' });
		const gameRunner = fakeGameRunner(PASS_VERDICT);
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 2,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
			postTask: { enabled: true, runner: fakePostTaskRunner(), followUpOnTestFail: false },
			gameVerify: { enabled: true, runner: gameRunner }
		});
		orch.start();
		try {
			const task = await createTask(db, {
				project: gameProject.id,
				title: 'build the mod',
				description: 'a clean-done mod task must trigger the game-verify step'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, gameProject.id);
			await orch.drain();

			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'done', 10_000);
			// The task reached done (a non-pass would not fail it either; here it's a pass).
			expect((await getTask(db, task.id))?.status).toBe('done');
			// The injected game-verify runner ran once, for the configured game, in the worktree cwd.
			expect(gameRunner.calls.length).toBe(1);
			expect(gameRunner.calls[0].processName).toBe('FakeGame.exe');
			// The verdict was persisted as a game-verify completion event.
			const [evs] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
				`SELECT detail FROM agent_event WHERE detail.reason = 'game-verify' AND project = $p;`,
				{ p: new StringRecordId(gameProject.id) }
			);
			expect(evs.length).toBe(1);
			expect(evs[0].detail.outcome).toBe('pass');
		} finally {
			orch.stop();
			await deleteProject(db, gameProject.id).catch(() => {});
		}
	}, 30_000);

	it('a NON-game project (no game_verify): the verify step runner is NEVER invoked', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = outcomeBackend(true);
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/orch/.harness-cc' });
		const gameRunner = fakeGameRunner(PASS_VERDICT);
		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 2,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt,
			postTask: { enabled: true, runner: fakePostTaskRunner(), followUpOnTestFail: false },
			gameVerify: { enabled: true, runner: gameRunner }
		});
		orch.start();
		try {
			const task = await createTask(db, {
				project: projectId, // the shared host project has NO game_verify block
				title: 'plain task',
				description: 'a non-game project must never launch the game-verify runner'
			});
			await setStatus(db, task.id, 'ready');
			await orch.enqueueTask(task.id, projectId);
			await orch.drain();

			await waitForAsync(async () => (await getTask(db, task.id))?.status === 'done', 10_000);
			expect((await getTask(db, task.id))?.status).toBe('done');
			expect(gameRunner.calls.length).toBe(0); // gated off — the runner stayed untouched
		} finally {
			orch.stop();
		}
	}, 30_000);
});

// ── ORH-1 — the ONE-SHOT boot drain (ORCHESTRATOR-SPEC §5) ───────────────────────────────────
//
// Real-surreal proof that startOrchestrator's boot drain closes the verified boot-recovery hole:
// a task already spawn-ready before boot, and a released/pre-existing PENDING work_item, are both
// drained at boot WITHOUT any bus event — because start() only SUBSCRIBES and the bus never
// replays the db_changes that predate the subscription. We call orch.bootDrain() directly (exactly
// what boot.ts fire-and-forgets after start()), with NO watchTable live query wired, so the ONLY
// thing that can move the queue is the boot drain itself. Also proves: manual mode is inert, the
// three drain gates (daily cap) still bind, and a re-boot enqueues no duplicates (deterministic-id).

/** Total work_item rows (all statuses) — the dedup assertion needs the raw count, not per-status. */
async function totalWorkItems(): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM work_item GROUP ALL;`
	);
	return Number(rows?.[0]?.c ?? 0);
}

/** Delete every task + work_item row — #listReadyTasks is GLOBAL (all projects), so a prior test's
 *  leftover `ready` task (e.g. the manual-mode / daily-cap-parked cases that never spawn to terminal)
 *  would otherwise be picked up by the next boot drain. Each ORH-1 test starts from a clean slate. */
async function resetBootDrainState(): Promise<void> {
	await db.query(`DELETE work_item; DELETE task;`);
}

describe('ORH-1 — boot drain (seed-before-boot recovery)', () => {
	beforeEach(resetBootDrainState);

	it('a ready task + a pre-existing pending work_item are BOTH drained at boot with NO bus event fired', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/orch/.harness-cc' });

		// Count any task-topic bus events — the boot drain must NOT rely on (or emit) one. No
		// watchTable live query is wired, so this MUST stay 0 (the "without any bus event" assertion).
		let taskBusEvents = 0;
		const unsub = bus.subscribe(
			() => (taskBusEvents += 1),
			(e) => e.type === 'db_change' && e.topic === 'task'
		);

		// (1) A task already spawn-ready BEFORE the orchestrator exists (predates any subscription).
		const ready = await createTask(db, {
			project: projectId,
			title: 'pre-boot ready',
			description: 'a task already ready at boot must drain without a live trigger'
		});
		await setStatus(db, ready.id, 'ready');
		// (2) A released/pre-existing PENDING work_item for a DIFFERENT task (the reaper-released case:
		// releaseSessionWork resets a dead session's twin → pending, but nothing drains it). Seeded
		// directly as a task_run so #runItem resolves it through launchSession like any claimed item.
		const orphan = await createTask(db, {
			project: projectId,
			title: 'pre-boot pending',
			description: 'a pending work_item with no self-trigger must drain at boot'
		});
		await enqueue(db, {
			workType: 'task_run',
			payload: { taskId: orphan.id, projectId },
			projectId,
			dedupScope: orphan.id
		});
		expect(await countByStatus(db, 'pending')).toBe(1); // only the orphan so far

		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8,
			mode: 'event',
			route: stubRoute(),
			acquireWorktree: fakeWt
		});
		orch.start(); // SUBSCRIBE only — no boot drain happens inside start()

		try {
			// Nothing has drained yet: start() only subscribed, and no bus event was fired.
			await new Promise((r) => setTimeout(r, 150));
			expect(backend.plans.length).toBe(0);
			expect(await countByStatus(db, 'processing')).toBe(0);

			// THE boot drain (what boot.ts fire-and-forgets after start()).
			const summary = await orch.bootDrain();
			// The ready task was enqueued (1 NEW row); the orphan was already pending (not re-counted).
			expect(summary.readyTasksEnqueued).toBe(1);
			// Both items were pending when the drain measured depth (ready's new row + the orphan).
			expect(summary.pendingItemsSeen).toBe(2);
			expect(summary.drain.claimed).toBe(2);
			expect(summary.drain.spawned).toBe(2);

			// Both spawns actually started through the runtime — the recovery is real, not just counters.
			await waitFor(() => backend.plans.length >= 2);
			await Promise.all([backend.gates[0].started, backend.gates[1].started]);
			expect(backend.plans.length).toBe(2);
			expect(await countByStatus(db, 'processing')).toBe(2);

			// The whole recovery happened with ZERO task bus events (no live query, no replay).
			expect(taskBusEvents).toBe(0);

			// Release both and settle: both work_items reach done, none left pending, still no bus event.
			for (const g of backend.gates) g.release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
			await new Promise((r) => setTimeout(r, 150));
			expect(await countByStatus(db, 'done')).toBe(2);
			expect(await countByStatus(db, 'pending')).toBe(0);
			expect(taskBusEvents).toBe(0);
		} finally {
			unsub();
			orch.stop();
		}
	}, 30_000);

	it('MANUAL mode: bootDrain is a no-op (no enqueue, no drain, no spawn)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });
		// A ready task exists — a manual-mode boot MUST leave it untouched (manual is trigger-free).
		const t = await createTask(db, {
			project: projectId,
			title: 'manual ready',
			description: 'manual mode must not auto-drain at boot'
		});
		await setStatus(db, t.id, 'ready');

		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8,
			mode: 'manual',
			route: stubRoute(),
			acquireWorktree: fakeWt
		});
		orch.start();
		try {
			const summary = await orch.bootDrain();
			expect(summary).toEqual({
				readyTasksEnqueued: 0,
				pendingItemsSeen: 0,
				drain: { claimed: 0, spawned: 0 }
			});
			await new Promise((r) => setTimeout(r, 150));
			expect(backend.plans.length).toBe(0);
			// Nothing was even enqueued — the queue is empty (the ready task was never touched).
			expect(await totalWorkItems()).toBe(0);
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('boot drain respects the DAILY CAP: cap already reached → the ready task is enqueued but PARKED (no spawn)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend });

		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8, // interactive cap is NOT the limiter — the daily cap is
			mode: 'event',
			route: stubRoute(),
			acquireWorktree: fakeWt,
			dailySpawnCap: 1
		});
		orch.start();
		try {
			// Pre-fill the rolling window to the cap WITHOUT going through the backend: create a task,
			// enqueue + claim it (claimed_at = now stamps the window) + complete. spawnsSince → 1 == cap.
			const filler = await createTask(db, { project: projectId, title: 'cap filler', description: 'fills the window' });
			await orch.enqueueTask(filler.id, projectId);
			const claimed = await claimNext(db, 'orh_cap_tok');
			expect(claimed).not.toBeNull();
			await complete(db, claimed!.id, 'orh_cap_tok', 'done');

			// A task already ready at boot — the boot drain enqueues it, but the cap gate parks it.
			const ready = await createTask(db, { project: projectId, title: 'capped ready', description: 'must be parked by the daily cap' });
			await setStatus(db, ready.id, 'ready');

			const summary = await orch.bootDrain();
			expect(summary.readyTasksEnqueued).toBe(1); // it WAS enqueued (idempotently)
			expect(summary.pendingItemsSeen).toBe(1); // the parked ready item is waiting
			// …but the cap (already reached) stopped the drain BEFORE any claim/spawn.
			expect(summary.drain.claimed).toBe(0);
			expect(summary.drain.spawned).toBe(0);
			await new Promise((r) => setTimeout(r, 150));
			expect(backend.plans.length).toBe(0); // nothing spawned through the runtime
			expect(await countByStatus(db, 'pending')).toBe(1); // the ready item stays parked (not lost)
		} finally {
			orch.stop();
		}
	}, 30_000);

	it('RE-BOOT idempotency: a second bootDrain over already-queued work enqueues NO duplicate (deterministic-id dedup)', async () => {
		await clearQueue();
		const bus = new EventBus();
		const backend = gatedBackend();
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/orch/.harness-cc' });

		const ready = await createTask(db, {
			project: projectId,
			title: 're-boot task',
			description: 'a re-boot must not double-enqueue an in-flight task'
		});
		await setStatus(db, ready.id, 'ready');

		const orch = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 8,
			mode: 'event',
			route: stubRoute(),
			acquireWorktree: fakeWt
		});
		orch.start();
		try {
			// First boot: enqueue + drain. The gated backend holds the spawn IN FLIGHT (processing).
			const first = await orch.bootDrain();
			expect(first.readyTasksEnqueued).toBe(1);
			await waitFor(() => backend.plans.length >= 1);
			await backend.gates[0].started;
			expect(await countByStatus(db, 'processing')).toBe(1);
			expect(await totalWorkItems()).toBe(1);

			// Second boot WHILE the first spawn is still processing (a crash-restart racing the in-flight
			// run): the deterministic primary id collapses the re-enqueue to a no-op — no duplicate row,
			// no second spawn of the same task.
			const second = await orch.bootDrain();
			expect(second.readyTasksEnqueued).toBe(0); // dedup no-op — nothing NEW enqueued
			expect(second.drain.spawned).toBe(0); // no pending work to claim (the twin is processing)
			await new Promise((r) => setTimeout(r, 150));
			expect(backend.plans.length).toBe(1); // STILL exactly one spawn
			expect(await totalWorkItems()).toBe(1); // STILL exactly one work_item (no duplicate)

			backend.gates[0].release();
			await waitFor(() => orch.semaphore.inUse === 0, 10_000);
		} finally {
			orch.stop();
		}
	}, 30_000);
});
