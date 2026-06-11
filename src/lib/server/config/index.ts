// server/config — public barrel (TASK 0.e; ARCHITECTURE §5/§6, D-025).
//
// This module depends on NOTHING (the leaf of the dependency graph). It loads
// the operator config files and runs the D-025 control-plane startup gate:
// assert every listener binds loopback (fail to boot otherwise) + mint the
// per-boot token. Other modules read config from here; none re-parse the files.

export {
	ConfigError,
	loadConfig,
	loadAgentPool,
	loadModels,
	loadOrchestration,
	loadGatesConfig,
	validateBundles,
	resolveAdaptiveConfig,
	bundleToBudgets,
	ORCH_MODES,
	INTENT_CLASSES,
	THINKING_LEVELS,
	type GatesConfig,
	type GatePatternEntry,
	type AppConfig,
	type AgentPool,
	type AgentSlot,
	type Tier,
	type ModelsConfig,
	type ProviderSpec,
	type Orchestration,
	type OrchMode,
	type ConfigBundle,
	type BundleBudgets,
	type IntentClass,
	type ThinkingLevel
} from './load';

export {
	isLoopbackHost,
	assertLoopback,
	mintBootToken,
	bootstrapControlPlane,
	LoopbackBindError,
	type ListenerSpec,
	type ControlPlane
} from './loopback';

// TASK 10.3 — the /settings WRITE side: orchestration.yaml mode write (D-004/D-010 diff+confirm)
// + API-key presence/set (D-026, presence only — never a value).
export {
	planOrchestrationWrite,
	applyOrchestrationWrite,
	StaleConfirmError as OrchestrationStaleConfirmError,
	OrchestrationWriteError,
	type OrchestrationChange,
	type OrchestrationDiff,
	type OrchestrationPlan,
	type ApplyResult as OrchestrationApplyResult
} from './settings-write';

export {
	describeKeyPresence,
	setEnvKey,
	MANAGED_KEYS,
	EnvWriteError,
	type ManagedKey,
	type KeyPresence,
	type SetKeyResult,
	type EnvLike
} from './env-presence';

import { loadConfig, type AppConfig } from './load';
import { bootstrapControlPlane, type ControlPlane, type ListenerSpec } from './loopback';

/** The fully bootstrapped runtime config: files + control-plane gate result. */
export interface BootstrappedConfig {
	config: AppConfig;
	controlPlane: ControlPlane;
}

/**
 * One-shot boot entry: load the config files, then run the D-025 startup gate
 * over the supplied listeners. Throws (fail-closed) if any listener is routable
 * or any config file is malformed — the process must not boot in either case.
 */
export function bootstrapConfig(
	configDir: string,
	listeners: readonly ListenerSpec[]
): BootstrappedConfig {
	const config = loadConfig(configDir);
	const controlPlane = bootstrapControlPlane(listeners);
	return { config, controlPlane };
}
