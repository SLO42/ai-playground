// TASK 8.1 — wire the orchestrator into the LIVE app (ARCHITECTURE §2.2/§2.11; D-004/D-017).
//
// The Orchestrator (orchestrator.ts) is built + unit/live tested but never STARTED in
// production. This is the single boot seam that constructs it once and calls start() from
// hooks.server.ts — so a task set to a spawn-ready status auto-drives a real Claude Code
// session with NO manual launch.
//
// CRITICAL INVARIANTS (the D-004/D-017 contract this seam must preserve):
//   • EVENT MODE, NO LOOP. We read `mode` from orchestration.yaml (default 'event'). In
//     event mode the orchestrator arms NO timer — it is subscriptions-only, ~zero idle CPU.
//     We do NOT pass an intervalMs unless the operator explicitly chose 'periodic' (so a
//     `periodic` config with no interval stays effectively off — D-004 off-by-default).
//   • BUS-ONLY TRIGGER (§2.11). The orchestrator subscribes to the SAME events bus the SSE
//     fan-out reads (getBus) and the watchTable live queries publish onto. It NEVER opens its
//     own DB live query — that is the no-double-fire guard: one task→ready row arrives once,
//     drives one enqueue, drives one spawn. We pass the bus in; we never create a source here.
//   • CAPS HOLD LIVE. maxConcurrent is the config concurrency.maxAgents — the interactive
//     semaphore cap the drain respects. The work_item claim queue (SELECT-then-claim-by-id)
//     gives exactly-one-spawn even across triggers.
//
// HONEST AVAILABILITY (F-008). A real spawn needs the Claude Code credential. When it is
// absent, getRuntime() is unavailable — we do NOT start the orchestrator (it would claim a
// work_item then fail every spawn). We log the honest reason and skip; the dashboard still
// boots and the queue waits for a credentialed boot. This mirrors the UI-action wiring seam.
//
// The production `route` seam: the Orchestrator's `route` is the DEGENERATE stub seam (2.2);
// real routing (resolveRoute, 2.3) wires in separately and is async + needs task content,
// which this synchronous seam can't host. Until that lands, the boot route uses the same
// harness defaults the manual UI launch uses (DEFAULT_MODEL/INTENT/BUDGETS/TOOL_POLICY/AGENT)
// — a real, valid spawn plan, not a fabricated one.

import type { Db } from '../db/client';
import type { EventBus } from '../events/bus';
import { getRuntime, getBus, DEFAULT_MODEL, DEFAULT_INTENT, DEFAULT_BUDGETS, DEFAULT_TOOL_POLICY, DEFAULT_AGENT } from '../harness';
import { loadOrchestration, type OrchMode } from '../config/index';
import { Orchestrator, type StubRoute } from './orchestrator';

/** What the boot wire did — so hooks.server.ts can log it and tests can assert it. */
export type OrchestratorBootResult =
	| { started: true; orchestrator: Orchestrator; mode: OrchMode; maxConcurrent: number }
	| { started: false; reason: string };

/** Load the orchestration config (mode + concurrency cap), degrading to safe defaults on a
 *  read/parse failure so a missing/edited config never blocks the live spawn path. */
function readOrchestrationConfig(): { mode: OrchMode; maxConcurrent: number; intervalMs?: number } {
	try {
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		const orch = loadOrchestration(`${dir}/orchestration.yaml`);
		return { mode: orch.mode, maxConcurrent: orch.concurrency.maxAgents, intervalMs: orch.intervalMs };
	} catch (err) {
		console.warn(
			`[startup] orchestration config unreadable — defaulting to event mode, maxConcurrent=4: ${(err as Error).message}`
		);
		return { mode: 'event', maxConcurrent: 4 };
	}
}

/** The production route seam (degenerate, 2.2): a real, valid spawn plan from the same
 *  harness defaults the manual UI launch uses. 2.3 swaps real routing in with no shape change. */
function bootRoute(): (taskId: string, projectId: string) => StubRoute {
	return () => ({
		agentId: DEFAULT_AGENT,
		model: DEFAULT_MODEL,
		intent: DEFAULT_INTENT,
		budgets: DEFAULT_BUDGETS,
		toolPolicy: DEFAULT_TOOL_POLICY
	});
}

/**
 * Build + start the live orchestrator (TASK 8.1). Called ONCE from hooks.server.ts after the
 * watchTable live queries are open, so the bus already carries task row changes. Idempotent in
 * effect: the caller starts it once per boot.
 *
 * Returns a skip result (started:false) WITHOUT throwing when the Claude Code credential is
 * absent — an honest degraded boot (F-008), never a crash. The orchestrator is event-driven and
 * idle-cheap: at idle it arms no timer and burns ~zero CPU (D-004).
 */
export async function startOrchestrator(db: Db, bus: EventBus = getBus()): Promise<OrchestratorBootResult> {
	// Honest availability gate (F-008): no credential ⇒ a started orchestrator would claim a
	// work_item then fail every spawn. Skip cleanly; the queue waits for a credentialed boot.
	const avail = await getRuntime(db);
	if (!avail.available) {
		return { started: false, reason: avail.reason };
	}

	const { mode, maxConcurrent, intervalMs } = readOrchestrationConfig();

	const orchestrator = new Orchestrator({
		db,
		bus,
		runtime: avail.runtime,
		maxConcurrent,
		mode,
		// intervalMs ONLY matters in 'periodic' mode (off by default, D-004). Passing it in
		// event mode is harmless (the timer is only armed when mode==='periodic'), but we keep
		// the orchestration.yaml intent faithful by forwarding it.
		intervalMs,
		route: bootRoute()
	});
	orchestrator.start();

	return { started: true, orchestrator, mode, maxConcurrent };
}
