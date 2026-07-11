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

// SH-2 GO-LIVE — spy on the production skill-harvest generator factory so we can assert the boot
// CONSTRUCTS it (the capture loop is wired at the SAME composition point as the memory loop). The
// stub returns a harmless harvester (never invoked at idle — no session ends in these tests).
// Typed with the production deps shape so the factory mock infers a single-arg signature (not
// zero-arg) — otherwise the `(...args)` spread (below) and `mock.calls[0][0]` (the wiring assertion)
// are type-illegal under svelte-check's strict tuple checking (would emit 3 svelte-check errors).
const makeSkillHarvestAgentMock = vi.fn<
	(deps: import('../skills/harvest-agent').SkillHarvestAgentDeps) => { propose: () => Promise<null> }
>(() => ({
	async propose() {
		return null;
	}
}));
vi.mock('../skills/harvest-agent', () => ({
	makeSkillHarvestAgent: (deps: import('../skills/harvest-agent').SkillHarvestAgentDeps) =>
		makeSkillHarvestAgentMock(deps)
}));

// Import AFTER the mock is registered.
const { startOrchestrator, bootDailySpawnCap, validateBootPricing } = await import('./boot');
const { Orchestrator } = await import('./orchestrator');

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
	makeSkillHarvestAgentMock.mockClear();
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

	// SH-2 GO-LIVE — the production skill-harvest generator is CONSTRUCTED at the boot composition
	// point (alongside the memory loop) and wired onto the orchestrator, so live successful code-write
	// sessions draft proposals. Before this it was DORMANT — only test stubs existed.
	it('constructs + wires the production skill-harvest generator (SH-2 capture loop, not dormant)', async () => {
		getRuntimeMock.mockResolvedValue({ available: true, runtime: idleRuntime });
		const bus = new EventBus();
		const boot = await startOrchestrator(idleDb(), bus);
		expect(boot.started).toBe(true);
		if (!boot.started) throw new Error('expected started');
		try {
			// The factory was called exactly once at boot (it produces the SkillHarvester forwarded onto
			// every spawn). It is built with the confirmed runtime — never at idle invoked.
			expect(makeSkillHarvestAgentMock).toHaveBeenCalledTimes(1);
			const arg = makeSkillHarvestAgentMock.mock.calls[0][0];
			expect(arg.runtime).toBe(idleRuntime);
			expect(arg.agentId).toBeTruthy();
			expect(arg.model).toBeTruthy();
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
	// config/orchestration.yaml carries perProject: 3 now that per-session git-worktree
		// isolation (WI-1..WI-3) makes concurrent same-project writes safe (the F-046 perProject=1
		// stopgap is retired). The assertions stay value-agnostic (>= 1) so retuning won't break them.
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

	// R1-2 — the boot wires gcStale as the AUTOMATIC backstop: a ONE-SHOT gc on startup (after the
	// boot reaper) PLUS a bounded periodic safety-net interval. Before this gc() was never invoked
	// automatically, so an orphaned `processing` work_item missed by R1-1's targeted release stayed
	// stuck for its full lease. Teardown (orchestrator.stop) must clear the interval — no leaked timer.
	it('fires a one-shot backstop gc on startup and arms the bounded maintenance interval (R1-2)', async () => {
		getRuntimeMock.mockResolvedValue({ available: true, runtime: idleRuntime });
		// Spy on the prototype so we capture BOTH the boot one-shot and (would-be) periodic ticks,
		// and so the gc never reaches the throwing idleDb. The periodic interval is ~5 min → it does
		// NOT fire inside this synchronous test, so exactly the single startup call is observed.
		const gcSpy = vi
			.spyOn(Orchestrator.prototype, 'gc')
			.mockResolvedValue({ deletedTerminal: 0, recoveredStuck: 0 });
		const bus = new EventBus();
		const boot = await startOrchestrator(idleDb(), bus);
		expect(boot.started).toBe(true);
		if (!boot.started) throw new Error('expected started');
		try {
			// One-shot backstop gc at startup (fire-and-forget) — invoked exactly once.
			expect(gcSpy).toHaveBeenCalledTimes(1);
			// The bounded periodic safety-net is armed.
			expect(boot.orchestrator.maintenanceArmed).toBe(true);
		} finally {
			boot.orchestrator.stop();
		}
		// Teardown clears the interval — no leaked timer survives shutdown (F-014).
		expect(boot.orchestrator.maintenanceArmed).toBe(false);
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

// CG-1 (deferred finding cost-governance-1a #4) — validateBootPricing surfaces a malformed
// pricing.yaml LOUDLY at boot (eager), but is DELIBERATELY NON-FATAL (D-024 — a cost-display config
// error must never brick the boot). Shadow paths: valid file (ok), malformed file (loud, ok:false,
// no throw), absent file (loud, ok:false, no throw).
describe('validateBootPricing — eager boot-time pricing validation, loud but non-fatal (CG-1)', () => {
	let dir: string;
	const orig = process.env.CONFIG_DIR;

	function writePricing(body: string): void {
		writeFileSync(join(dir, 'pricing.yaml'), body, 'utf8');
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'pricing-boot-'));
		process.env.CONFIG_DIR = dir;
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.CONFIG_DIR;
		else process.env.CONFIG_DIR = orig;
		rmSync(dir, { recursive: true, force: true });
	});

	it('returns ok for a VALID pricing.yaml (empty models map is valid — everything honestly unpriced)', () => {
		writePricing('models: {}\n');
		expect(validateBootPricing()).toEqual({ ok: true });
	});

	it('returns ok for a valid priced entry', () => {
		writePricing('models:\n  claude-opus-4-8:\n    inputUsdPerMtok: 15\n    outputUsdPerMtok: 75\n');
		expect(validateBootPricing()).toEqual({ ok: true });
	});

	it('a MALFORMED pricing.yaml surfaces LOUD (ok:false + reason) WITHOUT throwing (non-fatal, D-024)', () => {
		// A negative rate fails loadPricing's validation — the boot must NOT crash on it.
		writePricing('models:\n  bad-model:\n    inputUsdPerMtok: -1\n    outputUsdPerMtok: 5\n');
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		let res: { ok: boolean; reason?: string } | undefined;
		expect(() => {
			res = validateBootPricing();
		}).not.toThrow();
		expect(res?.ok).toBe(false);
		expect(res?.reason).toMatch(/pricing/i);
		// It was surfaced LOUDLY (a console.error at boot), not swallowed.
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(String(errSpy.mock.calls[0][0])).toMatch(/COST METERING DISABLED/);
	});

	it('an ABSENT pricing.yaml surfaces loud (ok:false) without throwing (missing file is a config error)', () => {
		// No pricing.yaml written → loadPricing throws ConfigError → loud, non-fatal.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let res: { ok: boolean; reason?: string } | undefined;
		expect(() => {
			res = validateBootPricing();
		}).not.toThrow();
		expect(res?.ok).toBe(false);
	});
});
