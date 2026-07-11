// TASK 12.1 — the D-037 adapter framework barrel + the process-wide AdapterRegistry.
//
// Built-in adapters (npm + Thunderstore publishers, the static-host deploy target) register at
// first use. A project resolves its adapter by the id it declares in a `project_target`
// ({adapterId, config}); an UNKNOWN id fails CLOSED (UnknownAdapterError).
//
// EXTENSION POSTURE (ADAPTER-FRAMEWORK-SPEC §2, corrects a prior over-claim): a novel adapter is
// a CODE CONTRIBUTION — implement the framework interface, pass the contract harness (contract.ts),
// and `register()` it here. There is deliberately NO config/runtime path that loads adapter code:
// adapters run with resolved secrets and outward network access, so a runtime-loadable adapter
// would be arbitrary-code-execution behind a config row (a D-026/D-018 violation). A "per-project
// custom target" is a per-project `project_target` row selecting any ALREADY-REGISTERED adapter
// with custom config — not per-project code. The sync family keeps its own SyncRegistry
// (sync/index.ts) — both share the SAME framework types (re-exported here).

export * from './types';
export * from './secrets';
export * from './registry';
export * from './contract';
export {
	buildAdapterCatalog,
	installedIds,
	isInstalled,
	ADAPTER_KINDS,
	type CatalogEntry
} from './catalog';
export {
	NpmPublisherAdapter,
	ThunderstorePublisherAdapter,
	GitHubReleasesPublisherAdapter,
	StaticHostDeployTarget
} from './builtins';
export {
	runTargetAction,
	runTargetVerify,
	confirmTokenFor,
	GateConfirmError,
	runSyncTarget,
	type RunTargetActionInput,
	type RunTargetActionResult,
	type RunTargetVerifyInput,
	type RunTargetVerifyResult,
	type RunSyncTargetInput,
	type RunSyncTargetResult
} from './driver';

import { AdapterRegistry } from './registry';
import {
	NpmPublisherAdapter,
	ThunderstorePublisherAdapter,
	GitHubReleasesPublisherAdapter,
	StaticHostDeployTarget
} from './builtins';

let registry: AdapterRegistry | null = null;

/** The process-wide adapter registry, constructed + seeded with built-ins on first use. */
export function getAdapterRegistry(): AdapterRegistry {
	if (!registry) {
		registry = new AdapterRegistry();
		registry.register(new NpmPublisherAdapter());
		registry.register(new ThunderstorePublisherAdapter());
		registry.register(new GitHubReleasesPublisherAdapter());
		registry.register(new StaticHostDeployTarget());
	}
	return registry;
}

/** Reset the registry (tests only). */
export function resetAdapterRegistry(): void {
	registry = null;
}
