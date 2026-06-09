// TASK 9.4 — the sync module barrel + the process-wide SyncRegistry (D-037).
//
// Built-in adapters register at module load. A project resolves its adapter by the id it
// declares (today: "github" — the only built-in). The registry is the v1.8 generalization
// point: new external targets register here without touching any caller.

export * from './adapter';
export * from './gh';
export * from './gh-client';
export {
	GitHubSyncAdapter,
	issueToTaskStatus,
	issueBodyForTask,
	listMappings,
	type GitHubSyncAdapterOptions
} from './github';

import { SyncRegistry } from './adapter';
import { GitHubSyncAdapter } from './github';

let registry: SyncRegistry | null = null;

/** The process-wide sync registry, constructed + seeded with built-ins on first use. */
export function getSyncRegistry(): SyncRegistry {
	if (!registry) {
		registry = new SyncRegistry();
		registry.register(new GitHubSyncAdapter());
	}
	return registry;
}

/** Reset the registry (tests only). */
export function resetSyncRegistry(): void {
	registry = null;
}
