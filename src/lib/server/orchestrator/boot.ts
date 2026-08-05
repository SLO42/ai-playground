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
	DEFAULT_AGENT,
	DEFAULT_MODEL
} from '../harness';
import { makeSkillHarvestAgent } from '../skills/harvest-agent';
import { loadOrchestration, loadAgentPool, loadPricing, ConfigError, type OrchMode, type AgentPool, type AgentSlot, type Orchestration } from '../config/index';
import { resolveRoute, type RouteTask, type StaffRouteResolver } from '../routing/index';
import type { ModelSelection } from '../runtime/index';
import { resolveStaff, getProjectStaff, type Tier, type TierModelResolver } from '../workforce';
import { Orchestrator, setActiveOrchestrator, type StubRoute, type RouteResolver } from './orchestrator';

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
			/**
			 * COMPLETION-LEDGER Wave A — WHY the memory recall/extract loop is OFF this boot, or
			 * undefined when it is armed. It was previously a `console.warn` only: the orchestrator
			 * reports 'started' while every spawn silently runs WITHOUT recall, and nothing durable
			 * says so. Returned here so the caller records it in the m0086 boot ledger (F-008).
			 */
			memoryOffReason?: string;
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
	dailyTokenBudget?: number;
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
			// on top of maxConcurrent. Per-session git-worktree isolation (WI-1..WI-3) now makes >1
			// concurrent spawn per project safe — each WRITE session runs in its OWN worktree on the
			// session branch with FF-or-preserve merge-back — so the shipped config carries
			// perProject=3 (the F-046 perProject=1 stopgap is retired).
			perProject: orch.concurrency.perProject,
			intervalMs: orch.intervalMs,
			// D-021 — the rolling-24h background-claim ceiling. Normalize 0/absent → undefined
			// (uncapped) so the orchestrator's own `dailySpawnCap > 0` gate stays the single source
			// of truth; a positive value arms the safety ceiling. Validated as a non-negative
			// integer at the config boundary (loadOrchestration), so we trust the shape here.
			dailySpawnCap: normalizeCap(orch.concurrency.dailySpawnCap),
			// CG-2 (COST-GOVERNANCE-SPEC) — the GLOBAL rolling-24h TOKEN budget wired into the drain's
			// park gate. Same normalizeCap 0-sentinel: 0/absent ⇒ undefined (uncapped) so the
			// orchestrator's own `> 0` gate is the single source of truth; a positive value arms it.
			dailyTokenBudget: normalizeCap(orch.spend?.dailyTokenBudget),
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

/**
 * CG-1 (COST-GOVERNANCE-SPEC) — EAGERLY validate config/pricing.yaml at boot so a malformed pricing
 * file surfaces LOUDLY at startup, not lazily (and silently) at the first completion write. The
 * events.ts write chokepoint keeps its own resilient degrade (a bad config there → honest-NULL
 * cost_usd, never a crashed write path) — this is a SEPARATE, eager, boot-time surfacing that tells
 * the operator "cost metering is DISABLED until you fix pricing.yaml" the moment the server boots.
 *
 * DELIBERATELY NON-FATAL (D-024/F-053 — fail-closed is for SECURITY boundaries ONLY): a cost-display
 * config error must NEVER brick the whole boot (that would fail-closed on a soft governance/measurement
 * control). So we LOG the ConfigError prominently and continue; the orchestrator + dashboard still
 * boot, metering just records honest-NULL cost until pricing.yaml is fixed. "Fail loud" ≠ "fail closed".
 * Never throws. Returns whether pricing validated (surfaced in the boot log; useful to a test).
 */
export function validateBootPricing(): { ok: boolean; reason?: string } {
	const dir = process.env.CONFIG_DIR?.trim() || 'config';
	try {
		loadPricing(`${dir}/pricing.yaml`);
		return { ok: true };
	} catch (err) {
		const reason = err instanceof ConfigError ? err.message : (err as Error).message;
		console.error(
			`[startup] COST METERING DISABLED — config/pricing.yaml is invalid: ${reason}. ` +
				`cost_usd will record as NULL for every completion until this is fixed (token metering is ` +
				`unaffected). This is surfaced loudly at boot; the analytics write path degrades honestly, ` +
				`it does not crash (D-024 — pricing is a soft governance control, not a security boundary).`
		);
		return { ok: false, reason };
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
	// SPAWN-IDENTITY: `role` is selected so the WORKFORCE-SPEC §7 staffing short-circuit — and with
	// it the `session.role`/`role_version` stamp at CREATE — lights up the instant a task can carry
	// one. It reads NONE today: `task` is SCHEMAFULL (schema.ts `DEFINE TABLE OVERWRITE task
	// SCHEMAFULL`) with no `role` field, and the recurring-ceremony scheduler that would stamp it is
	// not built. Selecting a field a SCHEMAFULL table does not define is a safe NONE, not an error,
	// so this is inert until the migration lands — and then correct with no further edit. The
	// remaining blocker is exactly one named item: a migration adding `task.role`.
	const [rows] = await db.query<
		[Array<{ id: unknown; title?: string; description?: string; role?: unknown }>]
	>(`SELECT id, title, description, role FROM ONLY $tid;`, { tid });
	const row = (Array.isArray(rows) ? rows[0] : rows) as
		| { id: unknown; title?: string; description?: string; role?: unknown }
		| undefined;
	if (!row) throw new Error(`routing: task not found: ${taskId}`);
	// NONE/null ⇒ OMIT the key (never the string "undefined" — F-013): resolveRoute gates the
	// short-circuit on `task.role` being truthy, so an absent role falls through unchanged.
	const role = row.role == null ? undefined : String(row.role).trim() || undefined;
	return {
		id: String(row.id),
		project: projectId,
		title: row.title ?? '',
		description: row.description ?? '',
		...(role ? { role } : {})
	};
}

/** Pick the agent slot to run as for the resolved tier; fall back to the first slot when no
 *  slot matches (the slot list is advisory — a missing tier slot must not block the spawn).
 *  Returns undefined only for a slot-less pool (startOrchestrator refuses to boot on one, so
 *  this is the belt-and-braces branch that keeps resolveSlotIdentity's DEFAULT_AGENT fallback
 *  reachable — startOrchestrator refuses to boot a slot-less pool, so it never fires live). */
function slotForTier(pool: AgentPool, tier: string | undefined): AgentSlot | undefined {
	if (tier) {
		const match = pool.slots.find((s) => s.tier === tier);
		if (match) return match;
	}
	return pool.slots[0];
}

/** The spawn identity a resolved tier maps to: the runtime key plus whatever PURPOSE the
 *  operator configured on that slot. Only `agentId` is ever guaranteed. */
export interface SlotIdentity {
	/** The pool slot id — the runtime run-key / isolated-config key. Always present. */
	agentId: string;
	/** agent-pool `slots[].name` — the purposeful identity persisted as `session.agent`. */
	agentName?: string;
	/** agent-pool `slots[].purpose` — prose for the spawn analytics event. */
	agentPurpose?: string;
	/** agent-pool `slots[].specialist` — persisted as `session.specialist` (m0070). */
	specialist?: string;
}

/**
 * SPAWN-IDENTITY (LB-2 write half) — resolve a routed tier to the slot's FULL identity, normalized
 * for persistence. This is the one seam boot's route resolver uses, exported so a test exercises
 * the REAL mapping (against the real shipped agent-pool.yaml) rather than a mirror of it.
 *
 * Normalization: a blank/whitespace-only config value collapses to ABSENT so the launch path omits
 * the column rather than persisting "" (F-013/§6.1 — absent reads as 'not recorded', never a
 * fabricated empty identity). A pool whose slots carry none of the optional keys yields
 * `{ agentId }` alone, which spreads to nothing extra on the route — byte-identical to the
 * pre-change spawn (F-053: the additive branch engages only when wired).
 */
export function resolveSlotIdentity(pool: AgentPool, tier: string | undefined): SlotIdentity {
	const slot = slotForTier(pool, tier);
	const clean = (v: unknown): string | undefined =>
		typeof v === 'string' && v.trim() ? v.trim() : undefined;
	const name = clean(slot?.name);
	const purpose = clean(slot?.purpose);
	const specialist = clean(slot?.specialist);
	return {
		agentId: slot?.id ?? DEFAULT_AGENT,
		...(name ? { agentName: name } : {}),
		...(purpose ? { agentPurpose: purpose } : {}),
		...(specialist ? { specialist } : {})
	};
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
/**
 * MODEL-BENCHMARK-SPEC step 1 — map the operator's global default-provider toggle → a concrete
 * ModelSelection override (or undefined for 'auto'/absent = normal routing). The forced model id is
 * read from the LIVE pool tiers (never hardcoded): 'local' → the `local` tier; 'cloud' → a cloud
 * tier (preferring `sonnet` as a balanced always-on-brain default, else the first non-ollama tier
 * in the escalation order). Returns undefined (honest, F-008) when the needed tier is not configured
 * — the toggle then no-ops rather than forcing a provider the pool can't serve.
 */
function resolveProviderOverride(
	dp: Orchestration['defaultProvider'],
	pool: AgentPool
): ModelSelection | undefined {
	if (!dp || dp === 'auto') return undefined;
	let tierName: string | undefined;
	if (dp === 'local') {
		tierName = pool.tiers.local ? 'local' : undefined;
	} else {
		// 'cloud': prefer sonnet; else the first non-ollama tier in the escalation ladder.
		if (pool.tiers.sonnet && pool.tiers.sonnet.provider !== 'ollama') tierName = 'sonnet';
		else tierName = pool.escalation?.order?.find((t) => pool.tiers[t] && pool.tiers[t].provider !== 'ollama');
	}
	const tier = tierName ? pool.tiers[tierName] : undefined;
	if (!tier || !tierName) {
		console.warn(
			`[routing] defaultProvider='${dp}' set but no matching tier in agent-pool.yaml — override ignored (normal routing).`
		);
		return undefined;
	}
	return { provider: tier.provider, modelId: tier.model, tier: tierName };
}

function bootRoute(db: Db, pool: AgentPool, orchestration: Orchestration): RouteResolver {
	const staffResolver = bootStaffResolver(db, pool);
	// MODEL-BENCHMARK-SPEC step 1 — resolve the operator's GLOBAL default-provider override ONCE
	// (the orchestrator + its config are per-boot singletons). 'auto'/absent ⇒ undefined ⇒ normal
	// routing (no-regression). 'local'/'cloud' ⇒ a concrete ModelSelection forced via resolveRoute's
	// explicit-override seam (F-005) — it wins over classify/tier/staffing so the benchmark A/B is a
	// PURE per-provider sample. Read from the same boot config the orchestrator reads (restart to change).
	const providerOverride = resolveProviderOverride(orchestration.defaultProvider, pool);
	return async (taskId: string, projectId: string): Promise<StubRoute> => {
		const task = await readRouteTask(db, taskId, projectId);
		const plan = await resolveRoute({
			db,
			task,
			pool,
			orchestration,
			providerHealth: getProviderHealth,
			staffResolver,
			...(providerOverride ? { override: providerOverride } : {})
		});
		// SPAWN-IDENTITY (LB-2 write half) — resolve the picked slot ONCE so the runtime key
		// (slot id) and the purposeful identity (name/purpose/specialist) come from the SAME slot.
		const slot = resolveSlotIdentity(pool, plan.model.tier);
		return {
			model: plan.model,
			intent: plan.intent,
			budgets: plan.budgets,
			toolPolicy: DEFAULT_TOOL_POLICY,
			// D-036: the resolved intent's capability set from the live orchestration config.
			capabilities: resolveCapabilitiesForIntent(plan.intent),
			// The slot's id (runtime key) + purposeful identity (agent-pool.yaml
			// `slots[].name/purpose/specialist`). Every optional key is omitted when the operator
			// has not configured it — an un-named pool yields the pre-change route object exactly
			// (F-053), since `agentId` was and remains the only guaranteed member.
			...slot,
			// The HR identity, present ONLY when the §7 staffing path resolved one (a role-bound
			// task staffed to this project). Absent on every other route — an unstaffed spawn runs
			// as no role, and guessing one would be a fabricated identity (F-008).
			//
			// ⚠ DORMANT via THIS resolver today: `readRouteTask` above cannot set `RouteTask.role`
			// because the `task` table is SCHEMAFULL with no `role` field, so `plan.roleId` is
			// always undefined here and `session.role` stays NONE for every drained spawn. The
			// forwarding is built so the seam lights up the moment a migration adds `task.role` +
			// the recurring-ceremony scheduler stamps it — it is NOT a coverage claim today.
			...(plan.roleId ? { roleId: plan.roleId } : {}),
			...(plan.roleVersionId ? { roleVersionId: plan.roleVersionId } : {})
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
	// CG-1 — validate config/pricing.yaml EAGERLY, on EVERY boot (before the credential gate below so
	// it runs even on a no-credential boot). Loud-but-non-fatal: a malformed pricing file is logged
	// prominently here and never blocks the boot (see validateBootPricing — D-024 non-fatal rationale).
	validateBootPricing();

	// Honest availability gate (F-008): no credential ⇒ a started orchestrator would claim a
	// work_item then fail every spawn. Skip cleanly; the queue waits for a credentialed boot.
	const avail = await getRuntime(db);
	if (!avail.available) {
		return { started: false, reason: avail.reason };
	}

	const { mode, maxConcurrent, perProject, intervalMs, dailySpawnCap, dailyTokenBudget, orchestration } =
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
	// COMPLETION-LEDGER Wave A — keep the reason so it reaches the DURABLE boot ledger, not just the
	// terminal. "Orchestrator started, memory silently off" was invisible on every surface (F-008).
	const memoryOffReason = memAvail.available ? undefined : memAvail.reason;
	if (!memAvail.available) {
		console.warn(`[startup] memory loop OFF: ${memAvail.reason}`);
	}

	// SH-2 GO-LIVE (SKILL-HARVEST-SPEC §"CAPTURE") — wire the PRODUCTION skill-harvest generator onto
	// every orchestrator-driven spawn. At session-end, a SUCCESSFUL code-write session offers its
	// SCREENED (D-026) trajectory to this read-only cheap-tier generator, which may DRAFT a
	// skill_proposal — persisted born 'open' via SH-1 (G2/D-039: never self-promoted; the operator is
	// the only promote gate). The credential is already confirmed (avail.available above), so the
	// generator can run its bounded session. BEST-EFFORT (D-019 / F-014): launchSession's SH-2 seam
	// try/catches the whole propose() call, so a harvest fault NEVER blocks or fails the spawn. One
	// bounded read-only session per qualifying session-end (no new uncapped spend path — it shares the
	// orchestrator's daily spawn cap surface). Was BUILT (SH-1..5) but DORMANT — only test stubs
	// existed; this is the production wiring that makes live successful sessions draft proposals.
	const skillHarvester = makeSkillHarvestAgent({
		db,
		bus,
		runtime: avail.runtime,
		agentId: DEFAULT_AGENT,
		model: DEFAULT_MODEL
	});

	const orchestrator = new Orchestrator({
		db,
		bus,
		runtime: avail.runtime,
		maxConcurrent,
		// The per-project in-flight cap (concurrency.perProject) — the ADDITIONAL gate the drain
		// enforces on top of maxConcurrent. With the shipped config (perProject=3) up to 3 sessions
		// per project run concurrently: per-session git-worktree isolation (WI-1..WI-3) gives each
		// WRITE session its OWN worktree on the session branch, so concurrent same-repo work no
		// longer stomps the shared project.root_path (the F-007/F-046 git index.lock + file-stomp
		// race), and merge-back is FF-or-preserve. This supersedes the F-046 perProject=1 stopgap.
		// Two DIFFERENT projects still run concurrently up to maxConcurrent. Previously parsed +
		// validated but NEVER passed here — it was dead config.
		perProject,
		mode,
		memory,
		// SH-2 GO-LIVE — forward the production skill-harvest CAPTURE seam onto every spawn (see above).
		skillHarvester,
		// MODEL-BENCHMARK-SPEC class C — the OPT-IN thinking-capture toggle, read from the SAME boot
		// orchestration config (restart to change, F-029). Absent/false ⇒ OFF (no thinking_capture
		// rows; byte-identical no-regression). true ⇒ every orchestrator-driven spawn records its
		// screened, provider-tagged thinking to the Step-4 judged-eval corpus.
		captureThinking: orchestration.captureThinking,
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
		// CG-2 (COST-GOVERNANCE-SPEC) — the GLOBAL rolling-24h TOKEN budget. The drain checks
		// Σ(tokens) over the window BEFORE each claim and parks the queue once the budget is reached
		// (the SPEND analogue of dailySpawnCap's claim ceiling). undefined ⇒ uncapped (the shipped
		// default is 0/uncapped — no-regression). launchSession enforces the same budget INSIDE the
		// spawn primitive (F-055 — un-bypassable by interactive/ceremony/concierge call sites).
		dailyTokenBudget,
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
			followUpOnTestFail: false,
			// PCG-1 — THE PRE-COMMIT GATE, ARMED. This is the 2026-07-26 operator review's only
			// correctness finding: Atelier committed its autonomous sessions' work and then
			// fast-forwarded it into the project branch with NO gate — the studio held every managed
			// project to a Definition of Done it did not apply to itself. With this on, the project's
			// build/lint/typecheck/test run BEFORE the terminal transition — WHEN THIS HOST CAN RUN
			// THEM; a RED gate lands the task `failed`, and merge-back PRESERVES the branch instead of
			// merging it (the work is safe on the session branch — F-007 — and the full per-step record
			// is on the completion event and in the drain ledger, F-008). A project with no detectable
			// target is an honest 'skipped', never a false RED (HB-2), so this cannot wedge a
			// non-JS/.NET project.
			//
			// READ THIS BEFORE RELYING ON THE GATE (the state as SHIPPED, not as intended). An
			// npm-family step is ALSO 'skipped' — not run at all — whenever the working dir has no
			// installed dependency tree, or the program is only a `.cmd` shim the argv-only seam
			// refuses to spawn (D-008). A WI-2 session worktree has NO node_modules and Windows npm is
			// a `.cmd`, so TODAY every npm project — Atelier's own repo included (D-040) — gets an
			// UNVERIFIED gate here, and only dotnet/cargo/go projects are genuinely gated. That is
			// honest rather than false-RED (the alternative wedged every write task), but it is not
			// verification: making the gate really check a JS worktree needs dependency provisioning
			// or a vetted shell escape, both named as follow-up work in pre-commit-gate.ts. The same
			// pre-flight covers EVERY ecosystem, not just npm: a `cargo`/`go`/`dotnet` project on a
			// host without that SDK is an honest UNVERIFIED skip too, because the command seam reports
			// an unspawnable program as exit 1 with no output and that would otherwise read as a
			// broken change.
			//
			// AND IF THE GATE NEVER ANSWERS: a fault inside the post-task loop (DB/OS/git) leaves no
			// verdict at all. With the gate armed that is NOT a merge — the session exits
			// 'gate-unknown' and the branch + worktree are preserved with the fault in the drain
			// ledger. Unverified is unverified, however we got there; the alternative fast-forwarded
			// un-gated work precisely when something had already gone wrong. A fault that lands AFTER
			// the gate answered is withheld identically (the commit may not have happened either), but
			// exits 'post-task-faulted' and carries the real verdict — the same catch covers the whole
			// loop, so claiming "no verdict" for all of it was a false ledger row.
			preCommitGate: true,
			// PCG-1 — the review capability, WIRED. `maybeEnqueueReview` has been fully built and
			// tested since TASK 2.8 with ZERO production callers; it now runs after a gate-green
			// commit and before merge-back. `holdMergeBack:'unverified'` is the deliberate policy:
			// a large change withholds the merge ONLY when there was NOTHING TO VERIFY — the project
			// declares no build/lint/typecheck/test target, so the change has neither an automated
			// gate nor a review behind it. It does NOT fire on the environment skip described above
			// (`gate.unrunnable` — the project HAS checks, this host could not run them): that skip
			// covers every npm project here, and since the release from a hold is an OPERATOR action
			// (see the deferral below), holding on it would stop the autonomous line on every
			// substantial task and pile up preserved worktrees — including on Atelier's own repo.
			// The rule lives in ONE place, orchestrator.ts `shouldHoldMergeBack`; "it cannot stall a
			// healthy project" is enforced there rather than assumed here. Either way the review
			// work_item IS enqueued and escalated — the policy only decides whether the merge waits.
			//
			// The enqueued `review` work_item is drained by the PCG-1 `review` fork in #runItem, which
			// ESCALATES it to the operator and spawns nothing (without that fork the item would have
			// fallen through to the task-spawn path and re-spawned the very task under review).
			//
			// DEFERRED, NAMED (not built here): an AUTOMATED reviewer — a review session that reads
			// the diff, produces a verdict, and RELEASES a hold on a pass. That is a new spawn class,
			// which this task explicitly forbids arming. Until it exists, the release from a hold is
			// an operator action, which is why 'always' is opt-in and 'unverified' is the default.
			review: { enabled: true, holdMergeBack: 'unverified' }
		},
		// WI-3 (WORKSPACE-ISOLATION-SPEC) — merge-back + teardown for per-session WRITE worktrees.
		// A WRITE-class session runs in an isolated per-session worktree (WI-2) and the post-task loop
		// commits its work on the session branch (HB-1). With this enabled, AFTER that commit the
		// orchestrator FAST-FORWARD-merges a clean-done session's branch into the project branch + tears
		// the worktree down (cleanup, F-014); a divergent (non-FF) or failed/cancelled session has its
		// branch + worktree PRESERVED with an honest screened note (F-007). Default execFile-array git
		// runner (D-008/F-002 — no shell runner). Best-effort: the orchestrator catches it so a merge-back
		// fault never crashes the drain (committed work always stays on its branch).
		mergeBack: { enabled: true },
		// GAME-VERIFY (docs/GAME-VERIFY-SPEC.md) — wire the live game-mod verification step. After the
		// post-task build/test gate, a CLEAN-done session whose project DECLARES a `game_verify` harness
		// gets its built mod VERIFIED by running the game (deploy → launch → poll-log → screened verdict
		// → MANDATORY kill, serialized per game); the verdict is persisted and a non-pass is fed back as a
		// follow_up (the next iteration's fix signal — NOT a hard task failure, F-008). Enabling it is
		// SAFE-by-default: a project with NO `game_verify` block launches nothing (gated off, exactly like
		// test_command) — the capability is opt-in + operator-configured per project. Default runner
		// (runGameVerify): the game is ALWAYS killed, bounded poll, never throws out (F-014/F-048).
		gameVerify: { enabled: true }
	});
	orchestrator.start();
	// Register the live orchestrator so the loops read model (and other READ-ONLY consumers) can read
	// its armed-state getters without importing hooks.server.ts (circularity). Cleared on teardown
	// (hooks.server.ts stopOrchestrators) so a stale handle is never read after shutdown (F-014).
	setActiveOrchestrator(orchestrator);

	// R1-2 — wire gcStale as the AUTOMATIC backstop. It was built but NEVER invoked automatically,
	// so an orphaned `processing` work_item (a crashed/killed session whose R1-1 targeted release was
	// missed) stayed stuck for its full lease, and aged terminal rows never reaped. Two seams:
	//   (1) ONE-SHOT on boot — the boot reaper (hooks.server.ts reapStaleRuns) has already swept stale
	//       session/workflow_run rows by the time we get here; this immediately reconciles the work_item
	//       QUEUE the same way. Fire-and-forget with .catch — a gc fault must NEVER crash boot (F-014).
	//   (2) BOUNDED periodic safety-net — a coarse (~5 min) unref'd interval (startMaintenance) that keeps
	//       reconciling for the life of the process. It does NOT lower the 1h stuckMaxAgeMs default, so a
	//       legitimately long-running claim is never freed early; R1-1's prompt release stays primary. The
	//       interval is unref'd (never holds the process open) and torn down by orchestrator.stop() (the
	//       hooks.server.ts stopOrchestrators teardown path), so no timer outlives shutdown.
	// ORH-1 (ORCHESTRATOR-SPEC §5) — the ONE-SHOT boot drain, CHAINED after the boot gc so gc-recovered
	// `processing`→`pending` rows are swept into the SAME boot recovery pass. The hole it closes: start()
	// above only SUBSCRIBES; the bus never replays the task→ready `db_change`s that fired BEFORE the
	// subscription existed — tasks already ready at boot, and the boot reaper's ready-resets (reapStaleRuns
	// in hooks.server.ts, which runs BEFORE this seam) — and a released/pre-existing pending work_item has
	// no self-trigger. Without this nudge those sit until a later task event or an operator Continue. So
	// after subscribe we enqueue every currently-ready task + drain pending items, ONCE. Idempotent by
	// construction (deterministic-id dedup absorbs re-enqueues, so a re-boot double-drains nothing);
	// bounded (bootDrain calls drain() → all three gates, never a bypass); a ONE-SHOT, not a poller
	// (invariant §2.1 bus-only observation stands). EVENT/PERIODIC ONLY — manual mode subscribes to
	// nothing and must stay trigger-free (bootDrain ALSO self-guards on manual — defense in depth).
	// Fire-and-forget with a catch-all log+swallow: an unhandled rejection on the drain path would take
	// down the process (F-014; mirrors the orchestrator's #onTrigger).
	void orchestrator
		.gc()
		.catch((err) =>
			console.warn(`[startup] boot backstop gc failed (periodic net will retry): ${(err as Error).message}`)
		)
		.finally(() => {
			if (mode !== 'event' && mode !== 'periodic') return; // manual: no boot drain (trigger-free)
			void orchestrator
				.bootDrain()
				.then((r) =>
					console.log(
						`[startup] boot drain: ${r.readyTasksEnqueued} ready task(s) enqueued, ${r.pendingItemsSeen} pending item(s) seen, drained ${r.drain.claimed}/${r.drain.spawned}`
					)
				)
				.catch((err) =>
					console.warn(
						`[startup] boot drain failed (a later trigger/Continue re-checks): ${(err as Error).message}`
					)
				);
		});
	orchestrator.startMaintenance();

	return { started: true, orchestrator, mode, maxConcurrent, perProject, dailySpawnCap, memoryOffReason };
}
