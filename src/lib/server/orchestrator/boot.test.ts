// TASK 8.1 — UNIT proof of the live boot wire (startOrchestrator).
//
// Asserts the boot SEAM honors the D-004/§2.11 contract WITHOUT a live external (F-008 / the
// standing no-externals rule for unit tests): the live capstone is orchestrator.live.test.ts
// (REAL runtime, REAL DB, REAL spawn). Here we mock the harness runtime source so we can drive
// the availability gate + the event-mode/no-loop/idle-CPU invariants deterministically.
//
// What this locks:
//   1. BOOT WIRE — with a credentialed runtime, startOrchestrator builds + STARTS the
//      orchestrator in EVENT mode and returns started:true with the config caps.
//   2. NO LOOP — the started orchestrator arms NO periodic timer (the v1 60s loop is gone,
//      D-004); event mode is subscriptions-only.
//   3. IDLE-CHEAP — with nothing enqueued, the runtime.spawn is NEVER called and ~zero CPU is
//      burned over a quiescent window (no busy poller).
//   4. HONEST SKIP (F-008) — when the Claude Code credential is absent (getRuntime
//      unavailable), startOrchestrator returns started:false with the honest reason and does
//      NOT construct/start an orchestrator (it would claim work then fail every spawn).
//   5. BUS-ONLY (§2.11) — the orchestrator subscribes to the bus it is handed; a task→ready
//      bus event drives exactly one enqueue attempt (the no-double-fire trigger seam), and it
//      never opens its own DB live query.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../events/bus';
import type { Db } from '../db/client';
import type { AgentRuntime } from '../runtime/index';

// Mock the harness wiring so the availability gate is controllable + no real CLI backend is
// constructed. getBus is the real EventBus factory in production; here we always pass a bus in.
const getRuntimeMock = vi.fn();
vi.mock('../harness', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../harness')>();
	return {
		...actual,
		getRuntime: (...args: unknown[]) => getRuntimeMock(...args),
		getBus: () => new EventBus()
	};
});

// Import AFTER the mock is registered.
const { startOrchestrator, bootDailySpawnCap } = await import('./boot');

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A runtime that throws if spawned — proves the idle path never reaches it. */
const idleRuntime: AgentRuntime = {
	spawn: () => {
		throw new Error('runtime.spawn must not be called at idle');
	},
	health: async () => ({ runtime: 'mock', providers: [] }),
	tools: () => [],
	cancel: async () => {}
};

/** A db stub that records whether it was queried at idle (it must not be). */
function idleDb(): Db {
	return {
		query: vi.fn(async () => {
			throw new Error('db.query must not run at idle');
		})
	} as unknown as Db;
}

beforeEach(() => {
	getRuntimeMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('TASK 8.1 — startOrchestrator boot wire (D-004/§2.11/F-008)', () => {
	it('starts the orchestrator in EVENT mode with the config caps when a runtime is available', async () => {
		getRuntimeMock.mockResolvedValue({ available: true, runtime: idleRuntime });
		const bus = new EventBus();
		const boot = await startOrchestrator(idleDb(), bus);

		expect(boot.started).toBe(true);
		if (!boot.started) throw new Error('expected started');
		expect(boot.mode).toBe('event'); // config/orchestration.yaml default
		expect(boot.maxConcurrent).toBeGreaterThanOrEqual(1);
		try {
			// NO LOOP (D-004): event mode arms no periodic timer.
			expect(boot.orchestrator.periodicArmed).toBe(false);
			expect(boot.orchestrator.mode).toBe('event');
		} finally {
			boot.orchestrator.stop();
		}
	});

	it('is idle-cheap: nothing enqueued ⇒ runtime.spawn is NEVER called, ~zero CPU burned', async () => {
		getRuntimeMock.mockResolvedValue({ available: true, runtime: idleRuntime });
		const bus = new EventBus();
		const boot = await startOrchestrator(idleDb(), bus);
		expect(boot.started).toBe(true);
		if (!boot.started) throw new Error('expected started');

		const before = process.cpuUsage();
		const wallStart = Date.now();
		try {
			// Quiescent window: no task→ready events published, so the orchestrator does nothing.
			await new Promise((r) => setTimeout(r, 250));
			const wallMs = Date.now() - wallStart;
			const used = process.cpuUsage(before);
			const cpuMs = (used.user + used.system) / 1000;
			// A reawakening poller / busy-loop drain would blow past a small fraction of wall.
			expect(cpuMs).toBeLessThan(wallMs * 0.1);
			expect(boot.orchestrator.spawnCount).toBe(0);
		} finally {
			boot.orchestrator.stop();
		}
	});

	it('honestly SKIPS without starting when the Claude Code credential is absent (F-008)', async () => {
		getRuntimeMock.mockResolvedValue({
			available: false,
			reason: 'Claude Code credential not configured (set CLAUDE_CODE_OAUTH_TOKEN).'
		});
		const bus = new EventBus();
		// A spy on subscribe proves the orchestrator never subscribed (never constructed/started).
		const subscribeSpy = vi.spyOn(bus, 'subscribe');
		const boot = await startOrchestrator(idleDb(), bus);

		expect(boot.started).toBe(false);
		if (boot.started) throw new Error('expected skip');
		expect(boot.reason).toMatch(/credential/i);
		expect(subscribeSpy).not.toHaveBeenCalled();
	});

	// D-021 — the live boot wires the REAL daily spawn cap from config (BL-9-H1 found boot wired
	// NONE → genuinely uncapped). With the shipped config carrying a positive cap, the boot result
	// surfaces it AND it reaches the orchestrator (reported == enforced).
	it('wires the D-021 dailySpawnCap from config into the boot result + orchestrator', async () => {
		getRuntimeMock.mockResolvedValue({ available: true, runtime: idleRuntime });
		const bus = new EventBus();
		const boot = await startOrchestrator(idleDb(), bus);
		expect(boot.started).toBe(true);
		if (!boot.started) throw new Error('expected started');
		try {
			// The shipped config/orchestration.yaml ships a positive cap (the safety ceiling).
			expect(typeof boot.dailySpawnCap).toBe('number');
			expect(boot.dailySpawnCap as number).toBeGreaterThan(0);
		} finally {
			boot.orchestrator.stop();
		}
	});

	// concurrency.perProject — previously parsed + validated but NEVER wired into the orchestrator
	// (dead config: the live 19:43 ROUNDS batch ran 6 same-project sessions despite perProject:1).
	// The boot now threads it from config → orchestrator (reported == enforced); the shipped
	// config/orchestration.yaml carries perProject: 1 (the F-046 stopgap).
	it('wires concurrency.perProject from config into the boot result + orchestrator', async () => {
		getRuntimeMock.mockResolvedValue({ available: true, runtime: idleRuntime });
		const bus = new EventBus();
		const boot = await startOrchestrator(idleDb(), bus);
		expect(boot.started).toBe(true);
		if (!boot.started) throw new Error('expected started');
		try {
			// The shipped config ships a positive per-project cap (≥ 1, validated at the boundary).
			expect(typeof boot.perProject).toBe('number');
			expect(boot.perProject as number).toBeGreaterThanOrEqual(1);
			// Reported == enforced: the value on the boot result is the value the orchestrator holds.
			expect(boot.orchestrator.perProjectCap).toBe(boot.perProject);
		} finally {
			boot.orchestrator.stop();
		}
	});

	it('subscribes to the BUS it is handed (§2.11 — never its own live query)', async () => {
		getRuntimeMock.mockResolvedValue({ available: true, runtime: idleRuntime });
		const bus = new EventBus();
		const subscribeSpy = vi.spyOn(bus, 'subscribe');
		const boot = await startOrchestrator(idleDb(), bus);
		expect(boot.started).toBe(true);
		if (!boot.started) throw new Error('expected started');
		try {
			// Started in event mode ⇒ subscribed to exactly the bus we passed in.
			expect(subscribeSpy).toHaveBeenCalledTimes(1);
		} finally {
			boot.orchestrator.stop();
		}
	});
});

// D-021 — bootDailySpawnCap: the seam that keeps the REPORTED cap (the /atelier/queue monitor)
// == the ENFORCED cap (the orchestrator). It reads the SAME config the orchestrator reads and
// normalizes through the SAME `> 0` gate. Shadow paths: positive cap, 0/absent (uncapped),
// negative/malformed config, and an unreadable config dir — never a fabricated denominator.
describe('bootDailySpawnCap — reported cap == enforced cap (BL-9-H1 LOW)', () => {
	let dir: string;
	const orig = process.env.CONFIG_DIR;

	function writeOrch(body: string): void {
		writeFileSync(join(dir, 'orchestration.yaml'), body, 'utf8');
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'orch-cap-'));
		process.env.CONFIG_DIR = dir;
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.CONFIG_DIR;
		else process.env.CONFIG_DIR = orig;
		rmSync(dir, { recursive: true, force: true });
	});

	it('returns the positive cap when one is configured', () => {
		writeOrch('mode: event\nconcurrency:\n  maxAgents: 8\n  perProject: 3\n  dailySpawnCap: 150\n');
		expect(bootDailySpawnCap()).toBe(150);
	});

	it('returns undefined (uncapped) when the cap is 0 (explicit uncapped sentinel)', () => {
		writeOrch('mode: event\nconcurrency:\n  maxAgents: 8\n  perProject: 3\n  dailySpawnCap: 0\n');
		expect(bootDailySpawnCap()).toBeUndefined();
	});

	it('returns undefined (uncapped) when the cap key is absent', () => {
		writeOrch('mode: event\nconcurrency:\n  maxAgents: 8\n  perProject: 3\n');
		expect(bootDailySpawnCap()).toBeUndefined();
	});

	it('returns undefined (honest, no fabricated cap) when the config is malformed', () => {
		// A negative cap fails the config boundary; bootDailySpawnCap must NOT claim a cap is
		// enforced — it reports uncapped (the orchestrator likewise skips start on a bad config).
		writeOrch('mode: event\nconcurrency:\n  maxAgents: 8\n  perProject: 3\n  dailySpawnCap: -10\n');
		expect(bootDailySpawnCap()).toBeUndefined();
	});

	it('returns undefined (honest) when the config dir is unreadable', () => {
		// No orchestration.yaml written → read fails → uncapped (never a guessed denominator).
		expect(bootDailySpawnCap()).toBeUndefined();
	});
});
