// TASK 4.2 — resource-profile detection (optional perf knob from IMPLEMENTATION-PLAN §4.2
// "(optional) detect CPU/RAM at boot to set default concurrency caps"; ARCHITECTURE §388
// "Resource-profile detection: detect CPU/RAM at boot → adapt concurrency caps").
//
// This is a PURE recommender. It reads a host snapshot (CPU core count + total RAM) and
// derives DEFAULT concurrency caps the orchestrator can boot with when an operator has
// not pinned `concurrency.maxAgents` / `concurrency.perProject` in orchestration.yaml.
// The operator config ALWAYS wins (config is the boundary, ARCHITECTURE §6) — this only
// supplies a sane, machine-aware default so a small box does not over-spawn and a big box
// is not throttled to v1's fixed cap.
//
// Why a recommender (not a live `os` read inside the orchestrator): keeping detection a
// pure function of an injectable snapshot makes the caps DETERMINISTIC and unit-testable
// without faking runtime data (F-008) — the only impurity (`os.cpus()`/`os.totalmem()`)
// is isolated in detectHostSnapshot(), which the recommender takes as an argument.
//
// IDLE COST: this runs ONCE at boot. It arms no timer, opens no socket, and holds no
// state — it cannot contribute to idle CPU/RAM. The event-mode orchestrator stays
// subscriptions-only at idle (ARCHITECTURE §79 "Idle in event mode = subscriptions only,
// ~zero CPU"); nothing here changes that.

import os from 'node:os';

/** A host resource snapshot — the only input the recommender needs. */
export interface HostSnapshot {
	/** Logical CPU count (cores × threads), as reported by the OS. */
	cpuCount: number;
	/** Total physical RAM in bytes. */
	totalMemBytes: number;
}

/** The default concurrency caps derived from a host snapshot (shape mirrors Orchestration.concurrency). */
export interface ConcurrencyCaps {
	/** Interactive in-process semaphore cap (Semaphore max / orchestration.concurrency.maxAgents). */
	maxAgents: number;
	/** Per-project sub-cap (orchestration.concurrency.perProject). */
	perProject: number;
}

/** A resource profile bucket — coarse classification used for logging / diagnostics. */
export type ResourceTier = 'constrained' | 'standard' | 'ample';

/** The full detection result: the raw snapshot, a coarse tier, and the recommended caps. */
export interface ResourceProfile {
	snapshot: HostSnapshot;
	tier: ResourceTier;
	caps: ConcurrencyCaps;
}

/**
 * Tuning constants (TASK 4.2 perf pass). These are the v2 DEFAULTS — deliberately
 * conservative so an unconfigured box never thrashes. They are the "tuned concurrency
 * caps" the perf-pass verify asserts; an operator override in orchestration.yaml takes
 * precedence over every one of them.
 */
export const RESOURCE_TUNING = {
	/** One interactive agent per this many logical cores (interactive spawns are heavy). */
	CORES_PER_AGENT: 2,
	/** Never recommend fewer than this many interactive agents (even a 1-core box gets 1). */
	MIN_AGENTS: 1,
	/** Hard ceiling on the recommended interactive cap (matches the swarm tight-coordination
	 * guidance of 6–8; over-spawning past this hurts coordination more than it helps). */
	MAX_AGENTS: 8,
	/** RAM (GiB) we budget per concurrent interactive agent — caps agents on low-RAM boxes
	 * even when cores are plentiful (an agent's CC process + transcript dominate RSS). */
	GIB_PER_AGENT: 1.5,
	/** perProject is a fraction of maxAgents so one project cannot monopolise the pool. */
	PER_PROJECT_FRACTION: 0.5,
	/** Floor for perProject (always allow at least one spawn per project). */
	MIN_PER_PROJECT: 1
} as const;

/** GiB → bytes (binary). */
const GIB = 1024 * 1024 * 1024;

/** Read the live host snapshot. The ONLY impure entry point (isolates `os` for testability). */
export function detectHostSnapshot(): HostSnapshot {
	const cpus = os.cpus();
	return {
		// os.cpus() can (rarely) return [] in constrained containers — floor at 1 core.
		cpuCount: Array.isArray(cpus) && cpus.length > 0 ? cpus.length : 1,
		totalMemBytes: os.totalmem()
	};
}

/** Classify a snapshot into a coarse tier (diagnostics / logging only). */
export function classifyTier(snap: HostSnapshot): ResourceTier {
	const gib = snap.totalMemBytes / GIB;
	if (snap.cpuCount <= 2 || gib < 4) return 'constrained';
	if (snap.cpuCount >= 8 && gib >= 16) return 'ample';
	return 'standard';
}

/** Clamp helper. */
function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/**
 * Derive default concurrency caps from a host snapshot. PURE — same snapshot ⇒ same caps.
 *
 * maxAgents = min over (cores/CORES_PER_AGENT, RAM/GIB_PER_AGENT), clamped to
 *             [MIN_AGENTS, MAX_AGENTS]. Taking the MIN of the CPU-bound and RAM-bound
 *             estimate means whichever resource is scarcer governs the cap.
 * perProject = max(MIN_PER_PROJECT, floor(maxAgents × PER_PROJECT_FRACTION)).
 */
export function recommendCaps(snap: HostSnapshot): ConcurrencyCaps {
	const cores = Number.isFinite(snap.cpuCount) && snap.cpuCount > 0 ? snap.cpuCount : 1;
	const gib = Number.isFinite(snap.totalMemBytes) && snap.totalMemBytes > 0 ? snap.totalMemBytes / GIB : 0;

	const cpuBound = Math.floor(cores / RESOURCE_TUNING.CORES_PER_AGENT);
	const ramBound = Math.floor(gib / RESOURCE_TUNING.GIB_PER_AGENT);

	const maxAgents = clamp(
		Math.min(cpuBound, ramBound),
		RESOURCE_TUNING.MIN_AGENTS,
		RESOURCE_TUNING.MAX_AGENTS
	);

	const perProject = Math.max(
		RESOURCE_TUNING.MIN_PER_PROJECT,
		Math.floor(maxAgents * RESOURCE_TUNING.PER_PROJECT_FRACTION)
	);

	return { maxAgents, perProject };
}

/**
 * Detect the full resource profile. With no argument it reads the live host; tests pass an
 * explicit snapshot for determinism. Runs ONCE at boot — never on a timer (idle-safe).
 */
export function detectResourceProfile(snap: HostSnapshot = detectHostSnapshot()): ResourceProfile {
	return { snapshot: snap, tier: classifyTier(snap), caps: recommendCaps(snap) };
}

/**
 * Resolve the concurrency caps to boot with: an explicit operator config ALWAYS wins
 * (config is the trust boundary — ARCHITECTURE §6); the resource-profile default only
 * fills a cap the operator left unset. Returns the effective caps + whether each field
 * came from config or the auto-detected profile (for the boot log / diagnostics).
 */
export function resolveBootCaps(
	operator: Partial<ConcurrencyCaps> | undefined,
	profile: ResourceProfile = detectResourceProfile()
): { caps: ConcurrencyCaps; sources: Record<keyof ConcurrencyCaps, 'config' | 'auto'> } {
	const maxFromCfg = isPosInt(operator?.maxAgents);
	const ppFromCfg = isPosInt(operator?.perProject);
	return {
		caps: {
			maxAgents: maxFromCfg ? (operator!.maxAgents as number) : profile.caps.maxAgents,
			perProject: ppFromCfg ? (operator!.perProject as number) : profile.caps.perProject
		},
		sources: {
			maxAgents: maxFromCfg ? 'config' : 'auto',
			perProject: ppFromCfg ? 'config' : 'auto'
		}
	};
}

function isPosInt(v: unknown): boolean {
	return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}
