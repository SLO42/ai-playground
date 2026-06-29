import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus } from '../events/bus';
import { createProject, deleteProject } from '../projects/repo';
import { createPm, updatePmSchedule, setPmAutonomous, updatePmAuthority } from '../projects/pm-repo';
import { writeAgentEvent } from '../analytics/events';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type RuntimeEvent
} from '../runtime/index';
import { Orchestrator, setActiveOrchestrator, type StubRoute } from '../orchestrator';
import {
	AutonomousPmLoop,
	setActiveAutonomousLoop,
	DEFAULT_MAX_TICKS_PER_WINDOW,
	type AutonomousLoopOptions
} from '../projects/pm-autonomous';
import { getLoops } from './read';

// LOOPS read model VERIFY — the four REAL loops aggregated into one honest, typed view (F-008).
// DB-backed against the live throwaway SurrealDB so the run-history + cadence facts trace to real
// rows (no fabrication), and the D-026 display screen is proven on a host-path-bearing detail.

const SECRET_PATH = 'C:\\Users\\sam\\secret\\key.txt';

// A trivial backend just to CONSTRUCT a ClaudeCodeRuntime — these tests never drain, they only read
// the orchestrator's armed-state getters, so the backend's stream is never pulled.
function noopBackend(): CcBackend {
	const self = {
		kind: 'noop',
		run(): CcBackendRun {
			return {
				ccSessionId: 'noop',
				// eslint-disable-next-line require-yield
				async *stream(): AsyncGenerator<RuntimeEvent> {
					return;
				},
				async cancel() {}
			};
		},
		async resume(req: { ccSessionId: string }) {
			return {
				ccSessionId: req.ccSessionId,
				// eslint-disable-next-line require-yield
				async *stream(): AsyncGenerator<RuntimeEvent> {
					return;
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
	return self as unknown as CcBackend;
}

function stubRoute(): (t: string, p: string) => StubRoute {
	return () => ({
		agentId: 'agent_coder_1',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] }
	});
}

let tdb: TestDb;
let db: Db;
let projectA: string;
let projectB: string;
let pmAId: string;

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

	// Project A — an ARMED autonomous PM with a cadence + 'act' authority + seeded run history.
	const a = await createProject(db, { slug: 'loops_a', name: 'Loops Host A', root_path: 'F:/code/loops-a' });
	projectA = a.id;
	const pmA = await createPm(db, { project: projectA, name: 'PM Ada', authority: 'observe' });
	pmAId = pmA.id;
	await updatePmAuthority(db, projectA, 'act');
	await setPmAutonomous(db, projectA, true);
	await updatePmSchedule(db, projectA, { cadence: '*/10 * * * *', cadenceOffset: null });

	// Real run history (agent_event) for project A — a spawn, a clean completion, and a completion
	// whose detail.reason carries a Windows host path (the D-026 screening probe).
	await writeAgentEvent(db, { type: 'spawn', project: projectA });
	await writeAgentEvent(db, { type: 'completion', project: projectA, detail: { summary: 'built the thing' } });
	await writeAgentEvent(db, {
		type: 'completion',
		project: projectA,
		detail: { reason: `boot failed reading ${SECRET_PATH}` }
	});

	// Project B — NO PM (the honest empty per-project case).
	const b = await createProject(db, { slug: 'loops_b', name: 'Loops Host B', root_path: 'F:/code/loops-b' });
	projectB = b.id;
}, 90_000);

afterAll(async () => {
	setActiveOrchestrator(null);
	setActiveAutonomousLoop(null);
	await deleteProject(db, projectA).catch(() => {});
	await deleteProject(db, projectB).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('getLoops (global) — the four real loops, honest + typed', () => {
	it('surfaces the two GLOBAL orchestrator loops, the autonomous + cadence loops, and the memory loop', async () => {
		setActiveAutonomousLoop(null); // no active loop → honest "not yet run"
		const loops = await getLoops(db);
		const byId = new Map(loops.map((l) => [l.id, l]));

		// (1)+(2) orchestrator loops are GLOBAL.
		expect(byId.get('orch:drain')?.kind).toBe('orchestrator');
		expect(byId.get('orch:drain')?.scope).toBe('global');
		expect(byId.get('orch:gc')?.kind).toBe('orchestrator');
		expect(byId.get('orch:gc')?.scope).toBe('global');

		// (3) the per-project autonomous loop.
		const auto = byId.get(`pm-auto:${projectA}`);
		expect(auto?.kind).toBe('pm-autonomous');
		expect(auto?.scope).toBe('project');
		expect(auto?.projectId).toBe(projectA);
		expect(auto?.phase).toBe('L3');
		expect(auto?.cadenceLabel).toBe('tick-window 24/day');

		// (4) the per-PM cadence loop, keyed by the PM id.
		const cad = byId.get(`pm-cadence:${pmAId}`);
		expect(cad?.kind).toBe('pm-cadence');
		expect(cad?.scope).toBe('project');
		expect(cad?.phase).toBe('L2'); // authority 'act' ⇒ L2
		expect(cad?.cadenceLabel).toBe('cron */10 * * * *');

		// (5) the per-session memory loop (informational, global).
		const mem = byId.get('mem-review');
		expect(mem?.kind).toBe('memory-review');
		expect(mem?.cadenceLabel).toBe('every 5 turns · 10 tools');
	});

	it('reads lastRunAt from the seeded agent_event rows; a no-history loop is honest null', async () => {
		const loops = await getLoops(db);
		const auto = loops.find((l) => l.id === `pm-auto:${projectA}`)!;
		// project A has 3 seeded events → a real lastRunAt + recentRuns.
		expect(auto.lastRunAt).toBeTruthy();
		expect(typeof auto.lastRunAt).toBe('string');
		expect(auto.recentRuns.length).toBe(3);

		// The orchestrator GC loop writes no agent_event → honest null lastRun + empty history (NOT a fake).
		const gc = loops.find((l) => l.id === 'orch:gc')!;
		expect(gc.lastRunAt).toBeNull();
		expect(gc.recentRuns).toEqual([]);
	});

	it('SCREENS every surfaced agent_event detail (D-026): a host path is redacted, never leaked', async () => {
		const loops = await getLoops(db);
		const auto = loops.find((l) => l.id === `pm-auto:${projectA}`)!;
		const all = auto.recentRuns.map((r) => r.detailScreened).join('\n');
		expect(all).toContain('[REDACTED:home-path]');
		expect(all).not.toContain('C:\\Users\\sam');
		expect(all).not.toContain('sam\\secret');
	});

	it('reports a no-data autonomous loop as "not yet run" with null ticksUsed and the real cap', async () => {
		setActiveAutonomousLoop(null);
		const loops = await getLoops(db);
		const auto = loops.find((l) => l.id === `pm-auto:${projectA}`)!;
		expect(auto.stateLabel).toBe('not yet run');
		expect(auto.tone).toBe('idle');
		expect(auto.ticksUsed).toBeNull();
		expect(auto.ticksMax).toBe(DEFAULT_MAX_TICKS_PER_WINDOW); // 24 — a real constant, not fabricated
	});

	it('reflects the live autonomous loop state + ticksUsed when one is registered', async () => {
		const loop = new AutonomousPmLoop({} as unknown as AutonomousLoopOptions);
		loop.lastOutcome.set(projectA, {
			projectId: projectA,
			state: 'running',
			reason: 'driving the batch',
			lifecycle: null,
			ticksUsed: 3
		});
		setActiveAutonomousLoop(loop);
		try {
			const loops = await getLoops(db);
			const auto = loops.find((l) => l.id === `pm-auto:${projectA}`)!;
			expect(auto.tone).toBe('running');
			expect(auto.stateLabel).toBe('driving'); // loopBadge('running') ⇒ 'driving'
			expect(auto.ticksUsed).toBe(3);
			expect(auto.ticksMax).toBe(DEFAULT_MAX_TICKS_PER_WINDOW);
		} finally {
			setActiveAutonomousLoop(null);
		}
	});

	it('computes nextFireAt for the cron cadence loop (a real future fire, not now+gap)', async () => {
		const loops = await getLoops(db);
		const cad = loops.find((l) => l.id === `pm-cadence:${pmAId}`)!;
		expect(cad.nextFireAt).toBeTruthy();
		const next = new Date(cad.nextFireAt!).getTime();
		expect(Number.isFinite(next)).toBe(true);
		expect(next).toBeGreaterThan(Date.now() - 60_000);
	});
});

describe('getLoops (per-project filter) — the LP-3 per-project tab', () => {
	it('returns ONLY that project’s scoped loops; global loops are excluded', async () => {
		const loops = await getLoops(db, { projectId: projectA });
		expect(loops.every((l) => l.scope === 'project')).toBe(true);
		expect(loops.every((l) => l.projectId === projectA)).toBe(true);
		const kinds = new Set(loops.map((l) => l.kind));
		expect(kinds.has('orchestrator')).toBe(false);
		expect(kinds.has('memory-review')).toBe(false);
		expect(loops.map((l) => l.id).sort()).toEqual([`pm-auto:${projectA}`, `pm-cadence:${pmAId}`].sort());
	});

	it('returns an empty list for a project with no PM (honest empty, not a fabricated card)', async () => {
		const loops = await getLoops(db, { projectId: projectB });
		expect(loops).toEqual([]);
	});
});

describe('getLoops — live orchestrator armed state (read-only accessors)', () => {
	it('shows the drain + gc loops as armed with cadence labels when an orchestrator is registered', async () => {
		const runtime = new ClaudeCodeRuntime({ backend: noopBackend(), harnessConfigRoot: 'F:/code/loops-a/.harness-cc' });
		const orch = new Orchestrator({
			db,
			bus: new EventBus(),
			runtime,
			maxConcurrent: 4,
			mode: 'event',
			route: stubRoute()
		});
		setActiveOrchestrator(orch);
		try {
			const loops = await getLoops(db);
			const drain = loops.find((l) => l.id === 'orch:drain')!;
			expect(drain.tone).toBe('running');
			expect(drain.stateLabel).toBe('armed · event');
			expect(drain.cadenceLabel).toBe('event-driven');

			const gc = loops.find((l) => l.id === 'orch:gc')!;
			expect(gc.cadenceLabel).toBe('5m sweep'); // GC_MAINTENANCE_INTERVAL_MS default = 5 * 60_000
			expect(gc.stateLabel).toBe('not armed'); // startMaintenance() not called
		} finally {
			setActiveOrchestrator(null);
		}
	});

	it('honestly reports the drain loop as "not running" with unknown cadence when no orchestrator is live', async () => {
		setActiveOrchestrator(null);
		const loops = await getLoops(db);
		const drain = loops.find((l) => l.id === 'orch:drain')!;
		expect(drain.tone).toBe('idle');
		expect(drain.stateLabel).toBe('not running');
		expect(drain.cadenceLabel).toBe('unknown');
	});
});

describe('getLoops — orchestrator drain config vs running mode (LP-2 restartNeeded)', () => {
	function orchWithMode(mode: 'event' | 'periodic' | 'manual'): Orchestrator {
		const runtime = new ClaudeCodeRuntime({
			backend: noopBackend(),
			harnessConfigRoot: 'F:/code/loops-a/.harness-cc'
		});
		return new Orchestrator({ db, bus: new EventBus(), runtime, maxConcurrent: 4, mode, route: stubRoute() });
	}

	it('restartNeeded is TRUE when the running mode differs from the configured mode', async () => {
		setActiveOrchestrator(orchWithMode('event'));
		try {
			// Configured is periodic (injected), running booted as event → a restart is pending.
			const loops = await getLoops(db, { orchConfig: { mode: 'periodic', intervalMs: 60_000 } });
			const drain = loops.find((l) => l.id === 'orch:drain')!;
			expect(drain.configuredMode).toBe('periodic');
			expect(drain.runningMode).toBe('event');
			expect(drain.restartNeeded).toBe(true);
			expect(drain.intervalMs).toBe(60_000);
		} finally {
			setActiveOrchestrator(null);
		}
	});

	it('restartNeeded is FALSE when the running mode equals the configured mode', async () => {
		setActiveOrchestrator(orchWithMode('event'));
		try {
			const loops = await getLoops(db, { orchConfig: { mode: 'event', intervalMs: 60_000 } });
			const drain = loops.find((l) => l.id === 'orch:drain')!;
			expect(drain.configuredMode).toBe('event');
			expect(drain.runningMode).toBe('event');
			expect(drain.restartNeeded).toBe(false);
		} finally {
			setActiveOrchestrator(null);
		}
	});

	it('reports an honest null runningMode + FALSE restartNeeded when no orchestrator is running', async () => {
		setActiveOrchestrator(null);
		const loops = await getLoops(db, { orchConfig: { mode: 'event', intervalMs: 60_000 } });
		const drain = loops.find((l) => l.id === 'orch:drain')!;
		expect(drain.runningMode).toBeNull();
		expect(drain.configuredMode).toBe('event');
		// Nothing live to mis-imply a change for → no restart is "needed".
		expect(drain.restartNeeded).toBe(false);
	});

	it('reports an honest null configuredMode (no fabricated mode) + FALSE restartNeeded when config is unreadable', async () => {
		setActiveOrchestrator(orchWithMode('event'));
		try {
			const loops = await getLoops(db, { orchConfig: { mode: null, intervalMs: null } });
			const drain = loops.find((l) => l.id === 'orch:drain')!;
			expect(drain.configuredMode).toBeNull();
			expect(drain.runningMode).toBe('event');
			// We never claim a restart against a mode we could not read.
			expect(drain.restartNeeded).toBe(false);
			expect(drain.intervalMs).toBeNull();
		} finally {
			setActiveOrchestrator(null);
		}
	});

	it('leaves the GC backstop card free of drain-only config fields (no cross-bleed)', async () => {
		setActiveOrchestrator(orchWithMode('event'));
		try {
			const loops = await getLoops(db, { orchConfig: { mode: 'periodic', intervalMs: 60_000 } });
			const gc = loops.find((l) => l.id === 'orch:gc')!;
			expect(gc.configuredMode).toBeUndefined();
			expect(gc.runningMode).toBeUndefined();
			expect(gc.restartNeeded).toBeUndefined();
		} finally {
			setActiveOrchestrator(null);
		}
	});
});
