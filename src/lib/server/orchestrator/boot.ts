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
// The production `route` seam (TASK 2.3 — WIRE ROUTING): the Orchestrator's `route` is now the
// REAL router. `resolveRoute` (src/lib/server/routing) is async + task-content-dependent (it
// classifies intent → selects the cheapest capable tier → reads provider health → falls back),
// which the old SYNCHRONOUS stub seam could not host. TASK 8.1 left the seam degenerate (a
// constant DEFAULT_MODEL) because the seam was sync; TASK 2.3 widened the seam to async (see
// orchestrator.ts RouteResolver) and this boot wires resolveRoute in. On every spawn the route
// is resolved from the TASK's content and a `routing_event` carrying the rationale + intent is
// written (the trace) — so the engine picks the right-tier model per task AND the how/why is
// recorded (the operator's core requirement). No fabricated route: a routing failure throws and
// the work_item is marked failed (orchestrator #runItem), never silently downgraded to a constant.

import type { Db } from '../db/client';
import type { EventBus } from '../events/bus';
import { StringRecordId } from 'surrealdb';
import { assertRecordId } from '../db/validate';
import {
	getRuntime,
	getBus,
	getProviderHealth,
	getMemoryService,
	resolveCapabilitiesForIntent,
	DEFAULT_TOOL_POLICY,
	DEFAULT_AGENT
} from '../harness';
import { loadOrchestration, loadAgentPool, type OrchMode, type AgentPool, type Orchestration } from '../config/index';
import { resolveRoute, type RouteTask, type StaffRouteResolver } from '../routing/index';
import { resolveStaff, getProjectStaff, type Tier, type TierModelResolver } from '../workforce';
import { Orchestrator, type StubRoute, type RouteResolver } from './orchestrator';

/** What the boot wire did — so hooks.server.ts can log it and tests can assert it.
 *  `dailySpawnCap` is the D-021 rolling-24h CLAIM ceiling actually wired into the orchestrator
 *  (undefined ⇒ uncapped — the operator left it 0/unset). Surfaced so a test can assert the
 *  ENFORCED cap == the configured cap (the integrity check: reported == enforced). */
export type OrchestratorBootResult =
	| {
			started: true;
			orchestrator: Orchestrator;
			mode: OrchMode;
			maxConcurrent: number;
			/** The per-project in-flight cap actually wired into the orchestrator (concurrency.perProject). */
			perProject?: number;
			dailySpawnCap?: number;
	  }
	| { started: false; reason: string };

/** Load the orchestration config (mode + concurrency cap + the full bundle for routing),
 *  degrading to safe defaults on a read/parse failure so a missing/edited config never blocks
 *  the live boot. `orchestration` is null only on a read failure (routing then has no adaptive
 *  bundles — the route resolver surfaces that as a per-spawn failure, not a fabricated plan). */
function readOrchestrationConfig(): {
	mode: OrchMode;
	maxConcurrent: number;
	perProject?: number;
	intervalMs?: number;
	dailySpawnCap?: number;
	orchestration: Orchestration | null;
} {
	try {
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		const orch = loadOrchestration(`${dir}/orchestration.yaml`);
		return {
			mode: orch.mode,
			maxConcurrent: orch.concurrency.maxAgents,
			// The PER-PROJECT in-flight cap (concurrency.perProject) — validated as a positive
			// integer at the config boundary (loadOrchestration: load.ts), so a loaded config always
			// carries a value ≥ 1. Threaded into the orchestrator as the ADDITIONAL per-project gate
			// on top of maxConcurrent (the F-046 stopgap: perProject=1 serializes same-project
			// sessions so concurrent same-repo commits in the shared project.root_path can't race).
			perProject: orch.concurrency.perProject,
			intervalMs: orch.intervalMs,
			// D-021 — the rolling-24h background-claim ceiling. Normalize 0/absent → undefined
			// (uncapped) so the orchestrator's own `dailySpawnCap > 0` gate stays the single source
			// of truth; a positive value arms the safety ceiling. Validated as a non-negative
			// integer at the config boundary (loadOrchestration), so we trust the shape here.
			dailySpawnCap: normalizeCap(orch.concurrency.dailySpawnCap),
			orchestration: orch
		};
	} catch (err) {
		console.warn(
			`[startup] orchestration config unreadable — defaulting to event mode, maxConcurrent=4: ${(err as Error).message}`
		);
		// On an unreadable config we cannot read the operator's cap. We DO NOT fabricate one — the
		// orchestrator only starts further down when the FULL config loads (it skips on a null
		// orchestration), so this degraded branch never actually arms an uncapped spawner.
		return { mode: 'event', maxConcurrent: 4, orchestration: null };
	}
}

/** Coerce a configured daily cap to the orchestrator's contract: a positive finite integer arms
 *  the cap; 0 / undefined / negative / non-finite ⇒ undefined (uncapped). Mirrors the
 *  orchestrator's own `dailySpawnCap > 0` gate so the wired value and the enforced value agree. */
function normalizeCap(raw: number | undefined): number | undefined {
	return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * The D-021 daily spawn cap the LIVE boot would wire — read straight from the same config the
 * orchestrator reads, normalized through the same `> 0` gate. Exposed so a READ-ONLY consumer
 * (the /atelier/queue monitor loader) can report the REAL enforced cap rather than guessing or
 * showing 'no cap enforced' when one is in fact armed. Returns undefined (uncapped) on any
 * read/parse failure — never a fabricated denominator (F-008). This is the single seam that keeps
 * the REPORTED cap == the ENFORCED cap (the integrity requirement).
 */
export function bootDailySpawnCap(): number | undefined {
	try {
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		const orch = loadOrchestration(`${dir}/orchestration.yaml`);
		return normalizeCap(orch.concurrency.dailySpawnCap);
	} catch {
		// Unreadable config ⇒ we cannot claim a cap is enforced; report uncapped (honest, F-008).
		return undefined;
	}
}

/** Load the agent-pool tiers + slots (the routing ladder). Returns null on a read failure so
 *  the boot can decide to skip starting the orchestrator (a router with no tiers can't spawn). */
function readAgentPool(): AgentPool | null {
	try {
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		return loadAgentPool(`${dir}/agent-pool.yaml`);
	} catch (err) {
		console.warn(`[startup] agent-pool config unreadable: ${(err as Error).message}`);
		return null;
	}
}

/** Read the task's content (the input resolveRoute classifies). LIVE DB only (F-008) — the
 *  intent + tier come from the real title/description, never a constant. Throws if the task
 *  is gone (the route then fails honestly rather than spawning a fabricated plan). */
async function readRouteTask(db: Db, taskId: string, projectId: string): Promise<RouteTask> {
	const tid = new StringRecordId(assertRecordId(taskId));
	const [rows] = await db.query<[Array<{ id: unknown; title?: string; description?: string }>]>(
		`SELECT id, title, description FROM ONLY $tid;`,
		{ tid }
	);
	const row = (Array.isArray(rows) ? rows[0] : rows) as
		| { id: unknown; title?: string; description?: string }
		| undefined;
	if (!row) throw new Error(`routing: task not found: ${taskId}`);
	return {
		id: String(row.id),
		project: projectId,
		title: row.title ?? '',
		description: row.description ?? ''
	};
}

/** Pick the agent slot to run as for the resolved tier; fall back to DEFAULT_AGENT when no
 *  slot matches (the slot list is advisory — a missing tier slot must not block the spawn). */
function agentForTier(pool: AgentPool, tier: string | undefined): string {
	if (tier) {
		const slot = pool.slots.find((s) => s.tier === tier);
		if (slot) return slot.id;
	}
	return pool.slots[0]?.id ?? DEFAULT_AGENT;
}

/** Tier→model resolver from the loaded pool config (D-003: the map lives in config). Fail-closed:
 *  an unknown tier yields null so resolveStaff returns an honest null rather than a guessed model. */
function poolTierResolver(pool: AgentPool): TierModelResolver {
	return (tier: Tier) => {
		const spec = pool.tiers[tier];
		return spec ? { provider: spec.provider, model_id: spec.model } : null;
	};
}

/**
 * WORKFORCE-SPEC §7 — the boot STAFFING resolver injected into resolveRoute. For a role-bound
 * session (a task carrying a `role`), it resolves the staffed (version × model_id) via the
 * fail-closed resolveStaff (§6) and reads the project_staff row id for the §7 rationale chain.
 * FAIL-CLOSED: ANY error, an unstaffed/not-deployable (project, role), OR a missing staff row
 * yields null → resolveRoute falls through to the normal order (additive, byte-identical). It
 * never staffs/mutates — resolveStaff + getProjectStaff are pure reads.
 */
function bootStaffResolver(db: Db, pool: AgentPool): StaffRouteResolver {
	const resolveTierModel = poolTierResolver(pool);
	return async (projectId: string, roleId: string) => {
		try {
			const staffed = await resolveStaff(db, projectId, roleId, resolveTierModel);
			if (!staffed) return null; // unstaffed / not-deployable → fall through (fail-closed).
			const row = await getProjectStaff(db, projectId, roleId);
			if (!row) return null; // resolved but no row (shouldn't happen) → honest null.
			return {
				version: staffed.version,
				provider: staffed.provider,
				modelId: staffed.model_id,
				certifiedBy: staffed.certifiedBy,
				staffId: row.id
			};
		} catch (err) {
			// A staffing read failure must NEVER sink a spawn — it falls through to normal routing.
			console.warn(`[routing] staff resolve for (${projectId}, ${roleId}) failed (falling through): ${(err as Error).message}`);
			return null;
		}
	};
}

/**
 * The production route seam (TASK 2.3): the REAL router. For each triggering task it reads
 * the task content, runs `resolveRoute` (staffing→override→intent→tier→adaptive→health→fallback)
 * which PICKS the provider+model AND writes a `routing_event` with the rationale + intent (the
 * trace), then maps the ResolvedPlan onto the orchestrator's spawn-plan shape. The pool +
 * orchestration config are loaded ONCE per boot (the orchestrator is a per-boot singleton); a
 * config re-edit takes effect on the next boot. Provider health is read from the harness single
 * owner (getProviderHealth). The §7 staffResolver is wired so a role-bound session routes to its
 * staffed model (today no task carries a role → the seam is inert + additive). NO fabricated
 * route — a read/resolve failure rejects and the work_item is marked failed by the orchestrator.
 */
function bootRoute(db: Db, pool: AgentPool, orchestration: Orchestration): RouteResolver {
	const staffResolver = bootStaffResolver(db, pool);
	return async (taskId: string, projectId: string): Promise<StubRoute> => {
		const task = await readRouteTask(db, taskId, projectId);
		const plan = await resolveRoute({
			db,
			task,
			pool,
			orchestration,
			providerHealth: getProviderHealth,
			staffResolver
		});
		return {
			agentId: agentForTier(pool, plan.model.tier),
			model: plan.model,
			intent: plan.intent,
			budgets: plan.budgets,
			toolPolicy: DEFAULT_TOOL_POLICY,
			// D-036: the resolved intent's capability set from the live orchestration config.
			capabilities: resolveCapabilitiesForIntent(plan.intent)
		};
	};
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

	const { mode, maxConcurrent, perProject, intervalMs, dailySpawnCap, orchestration } =
		readOrchestrationConfig();

	// The router needs BOTH the tier ladder (agent-pool) and the adaptive bundles
	// (orchestration). Without them resolveRoute cannot pick a tier or apply D-020 — a started
	// orchestrator would claim work then fail every route. Skip honestly (F-008) so the queue
	// waits for a fixed config, rather than spawning on a fabricated constant.
	const pool = readAgentPool();
	if (!pool || pool.slots.length === 0 || Object.keys(pool.tiers).length === 0) {
		return { started: false, reason: 'agent-pool config missing or empty (no routing tiers/slots)' };
	}
	if (!orchestration) {
		return { started: false, reason: 'orchestration config unreadable (no adaptive bundles for routing)' };
	}

	// TASK 8.3 — wire the LIVE memory loop onto every orchestrator-driven spawn (recall on
	// spawn, extract on session-end). Honest availability (F-008): if local Ollama embeddings
	// are unreachable, getMemoryService is unavailable and the loop is simply OFF — the
	// orchestrator still starts and spawns run WITHOUT recall/extract rather than fabricating
	// a vector or a memory. The loop is best-effort (D-019) — it never blocks a spawn.
	const memAvail = await getMemoryService(db);
	const memory = memAvail.available ? { service: memAvail.memory, extract: memAvail.extract } : undefined;
	if (!memAvail.available) {
		console.warn(`[startup] memory loop OFF: ${memAvail.reason}`);
	}

	const orchestrator = new Orchestrator({
		db,
		bus,
		runtime: avail.runtime,
		maxConcurrent,
		// The per-project in-flight cap (concurrency.perProject) — the ADDITIONAL gate the drain
		// enforces on top of maxConcurrent. With perProject=1 (current config, the F-046 stopgap)
		// at most one session per project runs at a time, serializing same-repo commits in the
		// shared project.root_path (the F-007/F-046 git index.lock + file-stomp race) WITHOUT
		// needing per-session worktrees yet; two DIFFERENT projects still run concurrently up to
		// maxConcurrent. Previously parsed + validated but NEVER passed here — it was dead config.
		perProject,
		mode,
		memory,
		// intervalMs ONLY matters in 'periodic' mode (off by default, D-004). Passing it in
		// event mode is harmless (the timer is only armed when mode==='periodic'), but we keep
		// the orchestration.yaml intent faithful by forwarding it.
		intervalMs,
		// TASK 2.15 / D-021 — the REAL daily spawn cap (BL-9-H1 found this was OPT-IN and boot
		// wired NONE, leaving the live system genuinely UNCAPPED). Wiring it here is the hard
		// ceiling that makes 'full unsupervised' drive-to-release safe: the drain stops claiming
		// once the rolling-24h claim count hits the cap (orchestrator #drain checks spawnsSince
		// BEFORE each claim) and parks the rest. undefined ⇒ uncapped (operator left it 0/unset)
		// — existing behavior preserved.
		dailySpawnCap,
		// TASK 2.3 — the REAL router: resolveRoute picks the tier from task content + writes the
		// routing_event with rationale on every spawn (no constant DEFAULT_MODEL).
		route: bootRoute(db, pool, orchestration),
		// THE HEARTBEAT (operator direction 2026-06-23) — wire the post-task loop so a finished
		// orchestrator-driven session (a) git-commits the agent's work and (b) advances its TASK
		// to a terminal status (done/failed). That terminal task `db_change` is exactly what the
		// autonomous PM (pm-autonomous.ts) re-ticks on — making post-task advance the task to
		// terminal IS what informs the PM. Without this the work_item alone went terminal and the
		// 4 done ROUNDS sessions left their tasks `ready` with uncommitted deliverables (F-007).
		//
		// Default execFile-array runner (D-008/F-002 — post-task.ts defaults opts.run to the
		// safe execFileRunner; we pass NO shell runner). It is best-effort: the orchestrator's
		// #runItem try/catches it so a commit/test failure never crashes the drain nor flips the
		// spawn verdict (F-014).
		postTask: {
			enabled: true,
			// followUpOnTestFail OFF here: a project without a real test suite must not spawn an
			// endless 'tests failed' follow-up loop. HB-2 makes test resolution honest; until then
			// a non-zero/absent `test_command` outcome stays a recorded fact on the completion
			// event, never an auto-enqueued follow_up. (Default in post-task.ts is true — we
			// explicitly override to false.)
			followUpOnTestFail: false
		}
	});
	orchestrator.start();

	return { started: true, orchestrator, mode, maxConcurrent, perProject, dailySpawnCap };
}
