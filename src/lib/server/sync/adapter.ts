// TASK 9.4 — the SyncAdapter framework seam (D-037).
//
// This is the reference shape the v1.8 extensible deploy/publish/SYNC adapter framework
// generalizes. It mirrors the existing seam pattern in v2 (AgentRuntime providers D-002,
// the release pipeline's chosen-adapter posture D-037): a typed `SyncAdapter` interface +
// a `SyncRegistry` resolved per-project from config. The GitHub task↔issue adapter (9.4)
// is the FIRST and only built-in here; new external targets plug in WITHOUT touching the
// callers — they register an adapter id and a project declares it.
//
// Design rules carried from D-037 / the broader v2 envelope:
//   • Credentials are OPERATOR-SUPPLIED secrets, never committed (D-026): an adapter reads
//     them from `gh auth` / a token from `.env` at call time — they never enter the DB.
//   • HONEST degrade (F-008): an adapter advertises availability (`probe()`); when its
//     credential/CLI is absent it returns an honest "unavailable" reason, never a fake sync.
//   • Boundary validation: ids/values flow through the db/validate chokepoint downstream;
//     the adapter validates its OWN inputs (repo slug shape, direction enum) at ingress.
//   • Idempotency is the adapter's contract: a re-sync of an already-synced task UPDATES
//     the external counterpart, never re-creates it (dedup by the stored mapping).
//
// The registry holds NO state beyond the id→adapter map; an adapter instance is stateless
// (it takes a `Db` + per-call options), so one process-wide registry is safe.

import type { Db } from '../db/client';
// ADF-2: ONE UnknownAdapterError across the whole adapter framework. The canonical class lives in
// adapters/types.ts (the D-037 core, imported by the registry + the release surface); the sync
// family re-uses it so a catch/instanceof on the canonical class catches a sync-registry miss too
// (ADAPTER-FRAMEWORK-SPEC §8 ADF-2). types.ts's `export type { SyncAdapter … } from './adapter'`
// is TYPE-only (erased at runtime) so this is not a runtime import cycle.
import { UnknownAdapterError } from '../adapters/types';

/** Sync direction — which way changes flow. `both` reconciles in both directions. */
export type SyncDirection = 'push' | 'pull' | 'both';

/** The result of a probe: is the adapter usable right now, and if not, WHY (honest). */
export interface SyncProbe {
	/** True iff the adapter can perform a real sync (CLI present + authenticated + repo). */
	available: boolean;
	/** Human-readable reason when unavailable (shown in the UI; never a fabricated success). */
	reason?: string;
	/** The resolved external target (e.g. "owner/repo") when known — for the surface. */
	target?: string;
}

/** Options every sync call shares. Concrete adapters may narrow/extend via their own types. */
export interface SyncRunOptions {
	/** The Atelier project record id (`project:<id>`) whose tasks are being synced. */
	projectId: string;
	/** Working directory the external tool runs in (the project root) — for `gh` repo context. */
	cwd: string;
	/** Direction to reconcile. Default `both`. */
	direction?: SyncDirection;
	/**
	 * When true, compute the plan but perform NO external mutations (preview).
	 * REQUIRED (SYN-1): a missing value would fall back to false (a REAL mutation), so every call
	 * site must state intent explicitly — the compiler is the safety net, not a runtime flag flip.
	 */
	dryRun: boolean;
}

/** A per-task outcome of a sync run — what happened to one task↔counterpart pair. */
export interface SyncItemResult {
	taskId: string;
	/** What the reconcile did for this item. */
	action: 'created' | 'updated' | 'pulled' | 'linked' | 'skipped' | 'error';
	/** The external counterpart id (issue number) once known. */
	externalId?: string;
	externalUrl?: string;
	/** Error message when action === 'error'. */
	error?: string;
}

/**
 * TASK 16.2 (PM-SPEC §3 event ②) — one EXTERNAL arrival a sync run detected: an open
 * issue with no task mapping (born on GitHub, not pushed from here) or an open PR.
 * The PM trigger engine consumes these (deduped against prior review provenance).
 */
export interface SyncArrival {
	kind: 'issue' | 'pr';
	/** The external id (issue/PR number as a string). */
	externalId: string;
	title?: string;
	url?: string;
}

/** The aggregate result of one sync run. Honest counts — every number is a real action. */
export interface SyncResult {
	/** The external target the run reconciled against (e.g. "owner/repo"). */
	target: string;
	direction: SyncDirection;
	dryRun: boolean;
	created: number;
	updated: number;
	pulled: number;
	linked: number;
	skipped: number;
	/** Per-task outcomes, in processing order. */
	items: SyncItemResult[];
	/** Non-fatal per-item errors collected during the run (the run still completes). */
	errors: string[];
	/**
	 * External issue/PR arrivals detected during the run (TASK 16.2 — the PM trigger
	 * engine's event ② source). OPTIONAL: absent when an adapter performs no arrival
	 * detection (an honest absence, never a fabricated empty claim of "no arrivals").
	 */
	arrivals?: SyncArrival[];
}

/**
 * A pluggable external-sync adapter (D-037). One implementation per external system; the
 * GitHub task↔issue adapter is the reference. Stateless — every method takes the `Db` it
 * reads/writes the sync ledger through plus per-call options.
 */
export interface SyncAdapter {
	/** Stable adapter id used by the registry + the per-project config (e.g. "github"). */
	readonly id: string;
	/** Human label for the surface. */
	readonly label: string;

	/**
	 * Report whether this adapter can run a real sync RIGHT NOW (CLI installed + creds +
	 * a resolvable repo). Cheap, side-effect-free, NEVER throws — returns an honest
	 * `{ available:false, reason }` instead (F-008 / D-019 graceful degrade).
	 */
	probe(opts: { cwd: string }): Promise<SyncProbe>;

	/**
	 * Reconcile the project's tasks with the external system, idempotently (dedup by the
	 * stored mapping). MUST NOT create a duplicate counterpart for an already-mapped task.
	 * Returns honest counts; collects per-item errors without aborting the whole run.
	 */
	sync(db: Db, opts: SyncRunOptions): Promise<SyncResult>;
}

/**
 * Thrown when a requested adapter id is not registered (fail loud at the boundary). This is the
 * ONE canonical class (adapters/types.ts) re-exported so `import … from '../sync'` keeps surfacing
 * it AND a catch/instanceof on the canonical class catches a sync miss (ADF-2, spec §8).
 */
export { UnknownAdapterError } from '../adapters/types';

/**
 * The id→adapter registry (D-037). Built-in adapters register at module load; a project
 * resolves its adapter by the id it declares in config. The registry itself is tiny and
 * stateless beyond the map — one process-wide instance is the norm.
 */
export class SyncRegistry {
	#adapters = new Map<string, SyncAdapter>();

	/** Register an adapter. Throws on a duplicate id (a programming error, fail loud). */
	register(adapter: SyncAdapter): this {
		if (this.#adapters.has(adapter.id)) {
			throw new Error(`sync adapter id already registered: ${adapter.id}`);
		}
		this.#adapters.set(adapter.id, adapter);
		return this;
	}

	/** Resolve an adapter by id. @throws {UnknownAdapterError} if unregistered. */
	get(id: string): SyncAdapter {
		const a = this.#adapters.get(id);
		if (!a) throw new UnknownAdapterError(id, 'sync');
		return a;
	}

	/** True iff an adapter is registered for `id`. */
	has(id: string): boolean {
		return this.#adapters.has(id);
	}

	/** All registered adapters (for a "which targets are available" surface). */
	list(): SyncAdapter[] {
		return [...this.#adapters.values()];
	}
}
