// COMPLETION-LEDGER Wave A — DRAIN LEDGER EMISSION: proves the ORCHESTRATOR actually records the
// named faults and queue holds, against a LIVE throwaway SurrealDB with the real schema.
//
// drain-events.test.ts proves the WRITER works in isolation; drain-ledger-read.test.ts proves the
// READER works. This suite closes the loop that matters: that the real drain, at its real swallow
// sites, actually calls them. Without it, the whole feature could be wired to nothing and every
// other suite would still be green — which is precisely the "adding a row that nothing renders"
// half-fix this wave exists to prevent.
//
// WHAT IS PROVEN (each maps to a swallow site the audit found):
//   • enqueue / DEDUP        — a task queued, and a re-queue of the same active unit, both recorded.
//   • PARK on concurrency    — a saturated semaphore records WHY work is waiting, with the depth.
//   • PARK on the daily cap  — the D-021 ceiling records itself instead of silently `break`ing.
//   • route/spawn FAULT      — a launchSession throw is recorded with the step, task and error
//                              (it previously set ok=false and wrote NOTHING).
//   • claim FAULT            — a DB fault in the claim step is named AND no longer escapes drain()
//                              as an unhandled rejection.
//   • FAULT INJECTION        — a ledger write that itself fails does NOT crash the drain: the task
//                              still runs and the work_item still reaches its terminal status.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus } from '../events/bus';
import { createProject, deleteProject } from '../projects/repo';
import { createTask, setStatus } from '../tasks/repo';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { Orchestrator, type StubRoute } from './orchestrator';
import { enqueue, countByStatus, claimNext } from './workqueue';
import { listDrainLedger, type DrainLedgerRow } from './queue-monitor';
import { __resetParkThrottle } from './drain-events';

let tdb: TestDb;
let db: Db;
let projectId: string;

/** A backend whose runs complete immediately (we are testing the LEDGER, not concurrency). */
function instantBackend(): CcBackend {
	let n = 0;
	return {
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			const ccSessionId = `cc_${plan.agentId}_${n++}_${Math.random().toString(36).slice(2, 10)}`;
			return {
				ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'ok', ccSessionId } };
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
	} as unknown as CcBackend;
}

/** A backend whose every run THROWS — drives the route/spawn fault path. */
function throwingBackend(message: string): CcBackend {
	return {
		kind: 'mock',
		run(): CcBackendRun {
			throw new Error(message);
		},
		async resume() {
			throw new Error(message);
		},
		async interject() {}
	} as unknown as CcBackend;
}

const fakeWt = async (root: string, sid: string) => ({
	cwd: `${root}/.wt/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
	branch: `atelier/session/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
	cleanup: async () => {}
});

function stubRoute(): () => StubRoute {
	return () => ({
		agentId: 'agent_coder_1',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] }
	});
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Every ledger row currently recorded (newest first). */
function ledger(): Promise<DrainLedgerRow[]> {
	return listDrainLedger(db, { limit: 200 });
}

async function holdsFor(reason: string): Promise<DrainLedgerRow[]> {
	return (await ledger()).filter((r) => r.entry === 'hold' && r.reason === reason);
}

async function faultsFor(stage: string): Promise<DrainLedgerRow[]> {
	return (await ledger()).filter((r) => r.entry === 'fault' && r.stage === stage);
}

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
	const p = await createProject(db, {
		slug: 'ledgeremit',
		name: 'Ledger Emission Host',
		root_path: 'F:/code/ledger-emit'
	});
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query(`DELETE work_item;`);
	await db.query(`DELETE agent_event;`);
	__resetParkThrottle();
});

function makeOrch(opts: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}): Orchestrator {
	return new Orchestrator({
		db,
		bus: new EventBus(),
		runtime: new ClaudeCodeRuntime({ backend: instantBackend() }),
		maxConcurrent: 4,
		mode: 'manual', // explicit drains only — no bus races inside an assertion
		route: stubRoute(),
		acquireWorktree: fakeWt,
		...opts
	});
}

// ── finding 4: enqueue / dedup are first-class ──────────────────────────────────────────

describe('enqueue + dedup are recorded (finding 4)', () => {
	it('a NEW work item records an `enqueued` hold naming the task', async () => {
		const orch = makeOrch();
		const task = await createTask(db, {
			project: projectId,
			title: 'queue me',
			description: 'd'
		});
		expect(await orch.enqueueTask(task.id, projectId)).toBe(true);

		const rows = await holdsFor('new_work');
		expect(rows).toHaveLength(1);
		expect(rows[0].phase).toBe('enqueued');
		expect(rows[0].taskId).toBe(task.id);
		expect(rows[0].workType).toBe('task_run');
		expect(rows[0].workItemId).toMatch(/^work_item:/);
		expect(rows[0].message).toContain(task.id);
	});

	it('a DEDUPED re-enqueue records the reason — "I hit Continue and nothing happened"', async () => {
		const orch = makeOrch();
		const task = await createTask(db, { project: projectId, title: 'twice', description: 'd' });
		await orch.enqueueTask(task.id, projectId);
		expect(await orch.enqueueTask(task.id, projectId)).toBe(false); // deduped

		const rows = await holdsFor('active_twin');
		expect(rows).toHaveLength(1);
		expect(rows[0].phase).toBe('deduped');
		expect(rows[0].taskId).toBe(task.id);
		// The sentence must ANSWER the question on its own, not just carry a code.
		expect(rows[0].message).toContain('already queued');
	});

	it('the enqueue hold is best-effort: a ledger fault never breaks the enqueue itself', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const orch = makeOrch();
		const task = await createTask(db, { project: projectId, title: 'be', description: 'd' });
		// Make ONLY the ledger's agent_event CREATE fail, leaving the work_item queries intact.
		const real = db.query.bind(db);
		const spy = vi
			.spyOn(db, 'query')
			.mockImplementation((async (q: string, b?: Record<string, unknown>) => {
				if (typeof q === 'string' && q.includes('CREATE agent_event')) {
					throw new Error('There was a problem with the database: injected ledger fault');
				}
				return real(q, b as never);
			}) as typeof db.query);
		try {
			await expect(orch.enqueueTask(task.id, projectId)).resolves.toBe(true);
		} finally {
			spy.mockRestore();
			warn.mockRestore();
			err.mockRestore();
		}
		// The real work landed even though the observability write did not.
		expect(await countByStatus(db, 'pending')).toBe(1);
	});
});

// ── finding 4: parks name the ceiling ───────────────────────────────────────────────────

describe('parks are recorded with the ceiling that caused them (finding 4)', () => {
	it('a SATURATED semaphore records a `concurrency` park with the pending depth', async () => {
		// maxConcurrent 1 + a gated run that never finishes ⇒ the 2nd claim finds no permit.
		let releaseRun!: () => void;
		const held = new Promise<void>((r) => (releaseRun = r));
		const gatedBackend = {
			kind: 'mock',
			run(plan: CcSpawnPlan): CcBackendRun {
				return {
					ccSessionId: `cc_${plan.agentId}_${Math.random().toString(36).slice(2, 10)}`,
					async *stream(): AsyncGenerator<RuntimeEvent> {
						yield { type: 'log', message: 'start' };
						await held;
						yield { type: 'done', result: { ok: true, summary: 'ok' } };
					},
					async cancel() {}
				};
			},
			async resume() {
				throw new Error('n/a');
			},
			async interject() {}
		} as unknown as CcBackend;

		const orch = makeOrch({
			maxConcurrent: 1,
			runtime: new ClaudeCodeRuntime({ backend: gatedBackend })
		});
		const t1 = await createTask(db, { project: projectId, title: 'p1', description: 'd' });
		const t2 = await createTask(db, { project: projectId, title: 'p2', description: 'd' });
		await orch.enqueueTask(t1.id, projectId);
		await orch.enqueueTask(t2.id, projectId);

		try {
			await orch.drain(); // claims t1 (holds the only permit), then parks on the 2nd pass
			await waitFor(async () => (await holdsFor('concurrency')).length > 0);
			const [park] = await holdsFor('concurrency');
			expect(park.phase).toBe('parked');
			expect(park.message).toContain('all agent slots are busy');
			// The depth is the ACTIONABLE part — "parked with N waiting", never a fabricated 0.
			expect(park.pendingDepth).toBeGreaterThanOrEqual(1);
			expect(park.context.maxConcurrent).toBe(1);
		} finally {
			releaseRun();
			orch.stop();
		}
	}, 30_000);

	it('the D-021 DAILY CAP records a `daily_cap` park instead of silently breaking', async () => {
		const orch = makeOrch({ dailySpawnCap: 1 });
		// Burn the cap with an already-claimed item, then try to drain another.
		await enqueue(db, { workType: 'review', payload: { n: 1 }, dedupScope: 'cap1' });
		const claimed = await claimNext(db, 'captok');
		expect(claimed).not.toBeNull();

		const t = await createTask(db, { project: projectId, title: 'capped', description: 'd' });
		await orch.enqueueTask(t.id, projectId);
		try {
			const res = await orch.drain();
			expect(res.claimed).toBe(0); // the cap held

			const [park] = await holdsFor('daily_cap');
			expect(park).toBeDefined();
			expect(park.phase).toBe('parked');
			expect(park.context.dailyCap).toBe(1);
			expect(park.message).toContain('daily spawn cap reached');
			expect(park.pendingDepth).toBeGreaterThanOrEqual(1);
		} finally {
			orch.stop();
		}
	}, 30_000);
});

// ── finding 3: named faults ─────────────────────────────────────────────────────────────

describe('drain faults are NAMED (finding 3)', () => {
	it('a spawn failure records a `route_spawn` fault with the step, the task and the real error', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const orch = makeOrch({
			runtime: new ClaudeCodeRuntime({ backend: throwingBackend('claude binary not found') })
		});
		const t = await createTask(db, { project: projectId, title: 'boom', description: 'd' });
		await orch.enqueueTask(t.id, projectId);
		try {
			await orch.drain();
			await waitFor(async () => (await faultsFor('route_spawn')).length > 0);
			const [fault] = await faultsFor('route_spawn');
			expect(fault.entry).toBe('fault');
			expect(fault.absorbed).toBe(false); // it CHANGED the verdict — not a survived hiccup
			expect(fault.taskId).toBe(t.id);
			expect(fault.workType).toBe('task_run');
			expect(fault.error).toContain('claude binary not found');
			// "drain failed" is not acceptable — the sentence must name the STEP.
			expect(fault.stageLabel).toBe('routing and spawning the agent');
			expect(fault.message).toContain('routing and spawning the agent');
			// …and it must be linked to the work item so the queue row and the reason join up.
			expect(fault.workItemId).toMatch(/^work_item:/);
		} finally {
			orch.stop();
			warn.mockRestore();
		}
	}, 30_000);

	it('a DB fault in the CLAIM step is named AND does not escape drain() as a rejection', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const orch = makeOrch();
		const t = await createTask(db, { project: projectId, title: 'claimfail', description: 'd' });
		await orch.enqueueTask(t.id, projectId);

		const real = db.query.bind(db);
		const spy = vi
			.spyOn(db, 'query')
			.mockImplementation((async (q: string, b?: Record<string, unknown>) => {
				// Break ONLY the claim batch (the LET $cand … UPDATE form), nothing else.
				if (typeof q === 'string' && q.includes('LET $cand')) {
					throw new Error('There was a problem with the database: injected claim fault');
				}
				return real(q, b as never);
			}) as typeof db.query);
		try {
			// The whole point: this RESOLVES. Before the fix it rejected, and drain() is invoked as
			// `void this.drain()` on the completion path — an unhandled rejection kills the process.
			await expect(orch.drain()).resolves.toEqual({ claimed: 0, spawned: 0 });
		} finally {
			spy.mockRestore();
		}

		const [fault] = await faultsFor('claim');
		expect(fault).toBeDefined();
		expect(fault.absorbed).toBe(true);
		expect(fault.error).toContain('injected claim fault');
		expect(fault.stageLabel).toBe('claiming the next work item');
		expect(fault.context.recovery).toBe('a later trigger re-drains the queue');
		orch.stop();
		warn.mockRestore();
	}, 30_000);

	it('a claim fault does NOT leak an interactive permit (the F-014 cap-wedge class)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const orch = makeOrch({ maxConcurrent: 2 });
		await enqueue(db, { workType: 'review', payload: {}, projectId, dedupScope: 'leak' });

		const real = db.query.bind(db);
		const spy = vi
			.spyOn(db, 'query')
			.mockImplementation((async (q: string, b?: Record<string, unknown>) => {
				if (typeof q === 'string' && q.includes('LET $cand')) {
					throw new Error('injected claim fault');
				}
				return real(q, b as never);
			}) as typeof db.query);
		try {
			await orch.drain();
		} finally {
			spy.mockRestore();
		}
		// The permit acquired just before the throwing claim was handed back on the fault path.
		expect(orch.semaphore.inUse).toBe(0);
		expect(orch.semaphore.available).toBe(2);
		orch.stop();
		warn.mockRestore();
	}, 30_000);
});

// ── the hard rule: the ledger can never crash the drain ─────────────────────────────────

describe('fault injection — a ledger write failure never crashes the drain (F-014/F-048)', () => {
	it('the task STILL runs and the work_item STILL reaches done when every ledger write fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const orch = makeOrch();
		const t = await createTask(db, { project: projectId, title: 'resilient', description: 'd' });
		await setStatus(db, t.id, 'ready');

		const real = db.query.bind(db);
		let ledgerWritesRefused = 0;
		const spy = vi
			.spyOn(db, 'query')
			.mockImplementation((async (q: string, b?: Record<string, unknown>) => {
				// Fail ONLY the LEDGER's agent_event writes (identified by detail.kind), leaving the
				// ordinary spawn/completion analytics — and every queue/session/task query — intact.
				// A blanket `CREATE agent_event` block would also break launchSession's own lifecycle
				// events and fail the spawn for an unrelated reason, proving nothing about the ledger.
				const kind = (
					(b?.content as { detail?: { kind?: unknown } } | undefined)?.detail?.kind ?? ''
				) as string;
				if (
					typeof q === 'string' &&
					q.includes('CREATE agent_event') &&
					(kind === 'drain_fault' || kind === 'queue_hold')
				) {
					ledgerWritesRefused++;
					throw new Error('There was a problem with the database: injected ledger fault');
				}
				return real(q, b as never);
			}) as typeof db.query);
		try {
			await orch.enqueueTask(t.id, projectId);
			const res = await orch.drain();
			expect(res.claimed).toBe(1);
			expect(res.spawned).toBe(1);
			await waitFor(async () => (await countByStatus(db, 'done')) >= 1, 10_000);
		} finally {
			spy.mockRestore();
		}
		// The ledger really was refused (the injection was live, not a no-op that trivially passes).
		expect(ledgerWritesRefused).toBeGreaterThan(0);
		// …and the real work completed anyway — observability failing did not take the engine with it.
		expect(await countByStatus(db, 'done')).toBe(1);
		expect(orch.spawnCount).toBe(1);
		orch.stop();
		warn.mockRestore();
		err.mockRestore();
	}, 30_000);
});
