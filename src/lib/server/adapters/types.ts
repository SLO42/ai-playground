// TASK 12.1 — the D-037 adapter framework CORE: typed interfaces for the THREE adapter
// families (publish / deploy / sync) + the credential-confinement contract.
//
// This is the strategic seam D-037 calls for. It GENERALIZES the reference `SyncAdapter`
// (TASK 9.4, sync/adapter.ts) to the full extensible deploy/publish/sync surface, modelled
// on the existing v2 seam pattern: `AgentRuntime` providers (D-002), `ServiceAdapter` (3.5),
// `UxInspectionSource` (3.3). The shape is deliberately uniform across the three families so
// the registry, the per-project config, the gating, and the contract harness are ONE machine.
//
// Design rules carried from D-037 / the broader v2 envelope:
//   • PROBE-then-act (F-008/D-019): every adapter advertises availability cheaply + honestly;
//     when its tool/credential is absent it returns `{ available:false, reason }`, never a
//     fabricated success. probe() NEVER throws.
//   • DRY-RUN is first-class: package + a publish/deploy compute the full plan with NO external
//     mutation when `dryRun` is set. This track NEVER performs a real external publish/deploy —
//     adapters are proven against the contract harness + dry-run; real creds land later (D-026).
//   • CREDENTIAL CONFINEMENT (D-026): an adapter NEVER receives a raw secret in its config. The
//     config stores the SECRET NAME (an env-var name); the framework resolves it from .env at
//     CALL TIME into a `SecretResolver` the adapter queries. The value never enters the DB, a
//     log, or any rendered surface — only presence (set/unset) is ever observable.
//   • GATED (D-018/D-024): a publish/deploy is a confirmable, gated action. The framework
//     produces a typed gate decision the caller MUST satisfy (a confirm token) before the
//     real (non-dry-run) action runs; a failure raises an incident, never silent (F-008).
//   • Boundary discipline (D-016): ids flow through db/validate downstream; an adapter
//     validates its OWN inputs at ingress.
//
// The registry holds only the id→adapter map (stateless beyond it); an adapter instance is
// stateless (per-call options + an injected SecretResolver), so one process-wide registry is safe.

// ── Credential confinement (D-026) ───────────────────────────────────────────────────
//
// An adapter declares the NAMED secrets it needs (by env-var name). The framework resolves
// each at call time and hands the adapter a `SecretResolver` — NOT the raw value map. The
// resolver lets the adapter read a value ONLY for a name it declared, and exposes presence
// without the value. The value is never persisted, logged, or returned to any surface.

/** A secret an adapter requires, referenced by the .env variable NAME (never a value). */
export interface SecretRequirement {
	/** The .env variable name the operator supplies (e.g. "NPM_TOKEN", "THUNDERSTORE_TOKEN"). */
	envVar: string;
	/** Human label for the surface (non-secret). */
	label: string;
	/** What the credential powers (non-secret help text). */
	purpose: string;
	/** When false, the adapter can still dry-run / package without it (presence is advisory). */
	required?: boolean;
}

/** One secret's PRESENCE — the ONLY thing any surface reveals about a secret (D-026). */
export interface SecretPresence {
	envVar: string;
	label: string;
	purpose: string;
	required: boolean;
	/** True iff the env var is set to a non-empty value. The value is NEVER exposed. */
	present: boolean;
}

/**
 * The CALL-TIME credential accessor handed to an adapter. Scoped: it resolves ONLY the names
 * the adapter declared in `secrets()` (a name it did not declare throws — fail closed, D-026),
 * and exposes presence without the value. The framework constructs it from the runtime env;
 * the adapter never sees the full env map.
 */
export interface SecretResolver {
	/** True iff a declared secret is present (non-empty). Throws for an undeclared name. */
	has(envVar: string): boolean;
	/**
	 * The secret VALUE for a declared name, or undefined when unset. The adapter uses this
	 * ONLY to authenticate its external tool at call time — it MUST NOT log/return/persist it
	 * (D-026). Throws for a name the adapter did not declare (confinement).
	 */
	get(envVar: string): string | undefined;
}

// ── Common shapes shared across the three families ────────────────────────────────────

/** The result of a probe: is the adapter usable right now, and if not, WHY (honest). */
export interface AdapterProbe {
	/** True iff the adapter can perform a REAL action right now (tool present + creds + target). */
	available: boolean;
	/** Human-readable reason when unavailable (shown in the UI; never a fabricated success). */
	reason?: string;
	/** The resolved external target (e.g. a registry url, a host, "owner/repo") when known. */
	target?: string;
	/** Per-secret presence (D-026) so the surface can tell the operator what to set. */
	secrets?: SecretPresence[];
}

/** Options every adapter call shares. Concrete adapters narrow/extend via their own types. */
export interface AdapterRunOptions {
	/** The Atelier project record id (`project:<id>`) the action belongs to. */
	projectId: string;
	/** Working directory the external tool runs in (the project root). */
	cwd: string;
	/** When true, compute the plan but perform NO external mutations (preview). */
	dryRun?: boolean;
	/** Adapter-specific config (the per-project `{adapterId, config}` config blob). */
	config?: Record<string, unknown>;
}

/** The common envelope of an adapter run result — honest, every field a real fact (F-008). */
export interface AdapterRunResult {
	/** The external target the run acted on (e.g. registry url / host / "owner/repo"). */
	target: string;
	/** True iff this was a dry-run (no external mutation). */
	dryRun: boolean;
	/** True iff the run completed without a fatal error. */
	ok: boolean;
	/** Human summary for the surface (honest — describes exactly what happened). */
	summary: string;
	/** Ordered, human-readable steps the run performed/planned (the dry-run plan). */
	steps: string[];
	/** Non-fatal per-step messages collected during the run. */
	warnings: string[];
}

/** The kind of adapter (the three D-037 families). */
export type AdapterKind = 'publish' | 'deploy' | 'sync';

/** The common base every adapter shares (id/label/kind + its declared secrets). */
export interface BaseAdapter {
	/** Stable adapter id used by the registry + the per-project config (e.g. "npm"). */
	readonly id: string;
	/** Human label for the surface. */
	readonly label: string;
	/** Which family this adapter belongs to. */
	readonly kind: AdapterKind;
	/** The named secrets this adapter needs (by env-var name, never a value — D-026). */
	secrets(): SecretRequirement[];
}

// ── PublisherAdapter (package + validate + publish, dry-run aware) ─────────────────────

/** The result of a publishable-artifact validation (a precondition for publish). */
export interface PublishValidation {
	/** True iff the project is in a publishable state for THIS adapter. */
	ok: boolean;
	/** Honest, human-readable blockers when not ok (never empty when ok===false). */
	blockers: string[];
	/** Non-blocking advisories. */
	warnings: string[];
}

/** What `package()` produced — a description of the artifact that WOULD be published. */
export interface PackageResult extends AdapterRunResult {
	/** The artifact name + version the publish would push (honest; from the manifest). */
	artifact?: { name: string; version: string };
}

/**
 * A pluggable PUBLISHER (D-037). One implementation per registry/store (npm, Thunderstore,
 * GitHub releases). The release pipeline (3.4) drives the project's CHOSEN publisher.
 * Stateless — every method takes per-call options + a scoped SecretResolver.
 */
export interface PublisherAdapter extends BaseAdapter {
	readonly kind: 'publish';
	/** Honest availability: tool present + creds + a resolvable target. NEVER throws. */
	probe(opts: { cwd: string; secrets: SecretResolver; config?: Record<string, unknown> }): Promise<AdapterProbe>;
	/** Validate the project is publishable for this target (a precondition; pure-ish, no push). */
	validate(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PublishValidation>;
	/** Build/describe the publishable artifact. dryRun computes the plan with no side effects. */
	package(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PackageResult>;
	/**
	 * Publish the artifact. dryRun computes the plan + asserts preconditions with NO external
	 * push. A real publish (dryRun:false) is GATED by the caller (D-018) and supplies the creds
	 * via the resolver. Returns an honest result; collects non-fatal warnings.
	 */
	publish(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult>;
	/**
	 * OPTIONAL post-publish verification (TASK 14.7): confirm the published artifact is ACTUALLY
	 * visible/live at the external target — e.g. poll the registry/package endpoint until the new
	 * version appears. Read-only (NEVER mutates externally), bounded in wall-clock (an honest
	 * timeout returns ok:false — it never spins, F-014 discipline), and honest about what it
	 * observed (F-008). Adapters with no cheap visibility check simply omit the method; the
	 * driver/pipeline degrade honestly (verify manually per the runbook).
	 */
	verify?(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult>;
}

// ── DeployTarget (deploy + status) ─────────────────────────────────────────────────────

/** A deployment's live status (honest — reflects the real target, or unknown). */
export interface DeployStatus {
	/** The deployment state. "unknown" when the adapter cannot determine it (honest, F-008). */
	state: 'deployed' | 'deploying' | 'failed' | 'unknown';
	/** The live url/ref of the deployment when known. */
	url?: string;
	/** Human detail (non-secret). */
	detail?: string;
	/** ISO timestamp of the last known deploy, when known. */
	at?: string;
}

/**
 * A pluggable DEPLOY target (D-037). One implementation per host/process (a static host, a
 * container registry, a custom per-project process). Stateless — per-call options + a resolver.
 */
export interface DeployTarget extends BaseAdapter {
	readonly kind: 'deploy';
	/** Honest availability: tool present + creds + a resolvable target. NEVER throws. */
	probe(opts: { cwd: string; secrets: SecretResolver; config?: Record<string, unknown> }): Promise<AdapterProbe>;
	/**
	 * Deploy the project. dryRun computes the plan with NO external mutation. A real deploy is
	 * GATED by the caller (D-018) + supplies creds via the resolver. Honest result + warnings.
	 */
	deploy(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult>;
	/** Report the live deployment status (honest "unknown" when undeterminable). NEVER throws. */
	status(opts: { cwd: string; secrets: SecretResolver; config?: Record<string, unknown> }): Promise<DeployStatus>;
}

// ── SyncAdapter — re-exported from the 9.4 reference so the framework is ONE surface ───
//
// The sync family already exists (sync/adapter.ts, the GitHub task↔issue reference). The
// D-037 CORE re-exports its types so a caller resolves any of the three families through the
// SAME framework. The sync registry (sync/index.ts) stays the source of truth for sync
// adapters; the per-project target config (this module) can point at a sync adapter id too.
export type {
	SyncAdapter,
	SyncProbe,
	SyncResult,
	SyncRunOptions,
	SyncDirection,
	SyncItemResult
} from '../sync/adapter';

// ── Errors (fail loud at the boundary) ─────────────────────────────────────────────────

/** Thrown when a requested adapter id is not registered (fail CLOSED — D-037/D-024). */
export class UnknownAdapterError extends Error {
	override readonly name = 'UnknownAdapterError';
	constructor(
		readonly adapterId: string,
		readonly kind?: AdapterKind
	) {
		super(
			`no ${kind ?? ''} adapter registered for id: ${JSON.stringify(adapterId)} — ` +
				`a project's configured target points at an unknown adapter (fail closed, D-037).`
		);
	}
}

/** Thrown when an adapter reads a secret name it did not declare (confinement, D-026). */
export class SecretConfinementError extends Error {
	override readonly name = 'SecretConfinementError';
	constructor(readonly envVar: string) {
		super(
			`adapter requested an undeclared secret ${JSON.stringify(envVar)} — ` +
				`an adapter may only resolve secrets it declares in secrets() (D-026).`
		);
	}
}

/** Any publish/deploy adapter (the gated-action families). */
export type ActionAdapter = PublisherAdapter | DeployTarget;
