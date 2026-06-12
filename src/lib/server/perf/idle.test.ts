import { describe, it, expect } from 'vitest';
import { EventBus } from '../events/bus';
import { Orchestrator, type StubRoute } from '../orchestrator/orchestrator';
import { recommendCaps, RESOURCE_TUNING } from '../orchestrator/resource-profile';
import { schemaMigrations } from '../db/schema';
import type { AgentRuntime } from '../runtime/index';
import type { Db } from '../db/client';

// TASK 4.2 — performance pass (IMPLEMENTATION-PLAN §4.2; v1.0 exit "idle CPU≈0 + RAM ≤
// target"; ARCHITECTURE §79 "Idle in event mode = subscriptions only, ~zero CPU").
//
// What this asserts (all WITHOUT a live external — F-008 / standing no-externals rule):
//   1. An event-mode orchestrator at idle arms NO timer and burns ~zero CPU over a
//      quiescent window (the v1 always-on 60s loop is gone). This is the measurable
//      "idle CPU≈0" claim — absolute, in-process.
//   2. The long-lived server's idle RSS sits under a FIXED target. This is the absolute
//      "idle RAM ≤ target" claim. The v1-RELATIVE comparison needs a running v1 app,
//      which is not available in the sandbox → deferred (deferredLiveProof), not failed.
//   3. The TUNED perf knobs are pinned at their reviewed values: the HNSW index params
//      (DIMENSION 1024 / EFC 150 / M 12 — never M0, D-014/MEMORY-SPEC §6) and the
//      resource-profile concurrency-cap ceiling (≤ the 6–8 coordination window).
//
// These are regression locks: they fail loudly if someone reintroduces an idle poller,
// bloats the baseline footprint, or detunes the HNSW/concurrency defaults.

/** A runtime stub that is NEVER invoked at idle (no spawn is triggered in these tests). */
const idleRuntime: AgentRuntime = {
	spawn: () => {
		throw new Error('runtime.spawn must not be called at idle');
	}
} as unknown as AgentRuntime;

/** A db stub that is NEVER queried at idle. */
const idleDb = {} as unknown as Db;

const idleRoute = (): StubRoute => {
	throw new Error('route must not be resolved at idle');
};

function makeIdleOrchestrator(mode: 'event' | 'manual' | 'periodic', intervalMs?: number) {
	return new Orchestrator({
		db: idleDb,
		bus: new EventBus(),
		runtime: idleRuntime,
		maxConcurrent: recommendCaps({ cpuCount: 8, totalMemBytes: 16 * 1024 * 1024 * 1024 }).maxAgents,
		mode,
		intervalMs,
		route: idleRoute
	});
}

describe('idle CPU≈0 — event mode is subscriptions-only, no always-on loop (ARCHITECTURE §79)', () => {
	it('event mode arms NO periodic timer (the v1 60s loop is gone)', () => {
		const orch = makeIdleOrchestrator('event');
		orch.start();
		try {
			expect(orch.periodicArmed).toBe(false);
		} finally {
			orch.stop();
		}
	});

	it('periodic mode with no interval is still effectively off (D-004 off-by-default)', () => {
		const orch = makeIdleOrchestrator('periodic'); // no intervalMs
		orch.start();
		try {
			expect(orch.periodicArmed).toBe(false);
		} finally {
			orch.stop();
		}
	});

	it('burns ~zero CPU over a quiescent idle window (no busy loop, no poller)', async () => {
		const orch = makeIdleOrchestrator('event');
		orch.start();
		const before = process.cpuUsage();
		const wallStart = Date.now();
		// Quiescent window: no triggers published, so the orchestrator should do nothing.
		// F-017 recurrence (2026-06-11): 300ms @ 5% (= 15ms CPU) failed 2/4 full-suite
		// runs (passed isolated) — process.cpuUsage() is WHOLE-process, so worker GC /
		// harness activity under 144-suite scheduler saturation alone exceeds 15ms.
		// Per F-017's prevention rule this TEST gets explicit headroom: a 1s window
		// (amortizes GC spikes) and a 20% ceiling — still 5x below what a busy-loop
		// drain (~100% of wall) or any real idle burn would register, and the
		// poller-reintroduction case is locked by the periodicArmed assertions above.
		await new Promise((r) => setTimeout(r, 1000));
		const wallMs = Date.now() - wallStart;
		const used = process.cpuUsage(before);
		orch.stop();

		const cpuMs = (used.user + used.system) / 1000; // microseconds → ms
		// Idle CPU≈0: the orchestrator must consume a negligible fraction of the wall
		// window. A reawakening 60s-style poller or a busy-loop drain would blow past this.
		expect(cpuMs).toBeLessThan(wallMs * 0.2);
		expect(orch.spawnCount).toBe(0); // nothing spawned at idle
	});
});

describe('idle RAM ≤ fixed target (absolute; v1-relative comparison deferred — no running v1)', () => {
	it('resident set stays under the fixed idle target after constructing the core engine', () => {
		// Hold a live event-mode orchestrator + the parsed schema so the measured RSS
		// reflects the long-lived server's core idle footprint (not a torn-down process).
		const orch = makeIdleOrchestrator('event');
		orch.start();
		try {
			expect(schemaMigrations.length).toBeGreaterThan(0); // schema is loaded/held
			const rssMb = process.memoryUsage().rss / (1024 * 1024);
			// Fixed absolute target for the v2 server's idle baseline. The Node + vitest +
			// SurrealDB-SDK + SvelteKit-server working set is the dominant term; 1024 MiB is
			// a deliberately roomy ceiling that still fails if a leak or an always-resident
			// cache balloons the baseline. The v1-RELATIVE assertion (v2 idle RSS < measured
			// v1 idle RSS) requires a running v1 app and is deferred (deferredLiveProof).
			const IDLE_RSS_TARGET_MB = 1024;
			expect(rssMb).toBeLessThan(IDLE_RSS_TARGET_MB);
		} finally {
			orch.stop();
		}
	});
});

describe('tuned perf knobs are pinned at their reviewed values', () => {
	it('HNSW indexes use the tuned 2.x params (1024-dim, EFC 150, M 12 — NEVER M0)', () => {
		// Scope to the actual DDL statement (DEFINE INDEX … HNSW … ;), NOT surrounding
		// comments — a code comment mentioning "M0" must not be matched.
		const hnswStmts = schemaMigrations
			.flatMap((m) => m.up.match(/DEFINE INDEX[^;]*HNSW[^;]*/g) ?? []);
		expect(hnswStmts.length).toBeGreaterThanOrEqual(2); // memory_vec + skill_vec
		for (const idx of hnswStmts) {
			expect(idx).toMatch(/DIMENSION 1024/);
			expect(idx).toMatch(/DIST COSINE/);
			expect(idx).toMatch(/TYPE F32/);
			expect(idx).toMatch(/EFC 150/);
			expect(idx).toMatch(/\bM 12\b/);
			expect(idx).not.toMatch(/\bM0\b/); // M0 is invalid in SurrealDB 2.x
		}
	});

	it('resource-profile concurrency ceiling stays within the tight-coordination window (≤8)', () => {
		expect(RESOURCE_TUNING.MAX_AGENTS).toBeLessThanOrEqual(8);
		expect(RESOURCE_TUNING.MIN_AGENTS).toBeGreaterThanOrEqual(1);
		// A big box recommends no more than the ceiling.
		const huge = recommendCaps({ cpuCount: 256, totalMemBytes: 1024 * 1024 * 1024 * 1024 });
		expect(huge.maxAgents).toBeLessThanOrEqual(RESOURCE_TUNING.MAX_AGENTS);
	});
});
