// server/config — load + validate agent-pool / models / orchestration (TASK 0.e).
//
// ARCHITECTURE §6 / §5: the `config` module depends on NOTHING. It loads the
// three operator config files and validates them AT THE BOUNDARY (the only
// place untrusted-on-disk config enters the system) before any other module
// consumes them. Parse failures and invariant violations surface as a single
// ConfigError type — never a raw fs/parse error and never a silently-accepted
// malformed config.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import JSON5 from 'json5';

/** A single failure loading or validating a config file. */
export class ConfigError extends Error {
	readonly file?: string;
	constructor(message: string, file?: string) {
		super(file ? `${message} (${file})` : message);
		this.name = 'ConfigError';
		this.file = file;
	}
}

// --- agent-pool.yaml -------------------------------------------------------

export interface Tier {
	provider: string;
	model: string;
}
export interface AgentSlot {
	id: string;
	tier: string;
	role: string;
}
export interface AgentPool {
	tiers: Record<string, Tier>;
	slots: AgentSlot[];
	escalation?: { order: string[] };
	delegation?: { from: string; to: string };
}

// --- models.{json5,yaml} ---------------------------------------------------

export interface ProviderSpec {
	endpoint: string;
	models: string[];
}
export interface ModelsConfig {
	providers: Record<string, ProviderSpec>;
}

// --- orchestration.yaml ----------------------------------------------------

export const ORCH_MODES = ['event', 'periodic', 'manual'] as const;
export type OrchMode = (typeof ORCH_MODES)[number];

// --- intent-adaptive config bundles (D-020) --------------------------------
//
// TASK 2.12: the five intents KongCode classifies (mirrors runtime `Intent` and
// routing's INTENTS — kept in lock-step). Each intent maps to a tunable, operator-
// authored ConfigBundle in orchestration.yaml. The map is validated HERE — config is
// untrusted-on-disk and `config` is the sole boundary it crosses (ARCHITECTURE §6) —
// so a typo'd intent key or a negative budget fails to boot rather than silently
// mis-routing a live spawn.

/** The five intent classes a task routes into (lock-step with runtime Intent / routing INTENTS). */
export const INTENT_CLASSES = [
	'simple-question',
	'code-read',
	'code-write',
	'code-debug',
	'deep-explore'
] as const;
export type IntentClass = (typeof INTENT_CLASSES)[number];

/** Valid `thinking` levels for a bundle (the spawn budget's thinking tier — D-020). */
export const THINKING_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * A per-intent adaptive config (D-020): thinking level + tool/concurrency budget +
 * memory-retrieval depth/share + token budget. All knobs are OPTIONAL (an absent knob
 * falls through to the runtime/memory default); the map stays open (`[k]`) so operators
 * can add forward-compat tunables (e.g. per-table vector-search limits) without a code
 * change — but the KNOWN knobs below are type-checked AND boundary-validated.
 */
export interface ConfigBundle {
	/** Thinking tier fed to SpawnBudgets.thinking (none|low|medium|high). */
	thinking?: ThinkingLevel;
	/** Memory-recall depth (vector KNN limit) — non-negative integer. */
	retrievalDepth?: number;
	/** Share of the context window given to retrieval, 0..1. */
	retrievalShare?: number;
	/** Per-spawn tool-call budget — non-negative integer. */
	toolCalls?: number;
	/** Per-spawn concurrency hint — non-negative integer. */
	concurrency?: number;
	/** Token budget for the spawn — non-negative integer. */
	tokenBudget?: number;
	[k: string]: unknown;
}
export interface Orchestration {
	mode: OrchMode;
	triggers?: string[];
	intervalMs?: number;
	concurrency: { maxAgents: number; perProject: number };
	/**
	 * intent → adaptive config (D-020). Validated at the boundary (loadOrchestration).
	 * Partial: an unconfigured intent resolves to an empty bundle (all-defaults), so a
	 * sparsely-tuned orchestration.yaml still routes every intent (resolveAdaptiveConfig).
	 */
	bundles?: Partial<Record<IntentClass, ConfigBundle>>;
}

/** Spawn budgets derived from a bundle — the subset routing hands to AgentRuntime (D-020). */
export interface BundleBudgets {
	thinking?: ThinkingLevel;
	toolCalls?: number;
	concurrency?: number;
}

/** The full loaded config tree. */
export interface AppConfig {
	agentPool: AgentPool;
	models: ModelsConfig;
	orchestration: Orchestration;
}

/** Test seam: merge an override into the parsed object before validation. */
interface LoadOpts {
	_inject?: Record<string, unknown>;
}

function readText(file: string): string {
	try {
		return readFileSync(file, 'utf8');
	} catch (err) {
		throw new ConfigError(
			`cannot read config file: ${(err as Error).message}`,
			file
		);
	}
}

function parseYaml(file: string): unknown {
	try {
		return yaml.load(readText(file));
	} catch (err) {
		if (err instanceof ConfigError) throw err;
		throw new ConfigError(`invalid YAML: ${(err as Error).message}`, file);
	}
}

function parseJson5(file: string): unknown {
	try {
		return JSON5.parse(readText(file));
	} catch (err) {
		if (err instanceof ConfigError) throw err;
		throw new ConfigError(`invalid JSON5: ${(err as Error).message}`, file);
	}
}

function asObject(v: unknown, file: string): Record<string, unknown> {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) {
		throw new ConfigError('expected a mapping at the document root', file);
	}
	return v as Record<string, unknown>;
}

/** Load + validate agent-pool.yaml. */
export function loadAgentPool(file: string, opts: LoadOpts = {}): AgentPool {
	const raw = { ...asObject(parseYaml(file), file), ...(opts._inject ?? {}) };
	const tiers = raw.tiers;
	if (tiers === null || typeof tiers !== 'object' || Array.isArray(tiers)) {
		throw new ConfigError('agent-pool: "tiers" must be a mapping', file);
	}
	const slots = raw.slots;
	if (!Array.isArray(slots)) {
		throw new ConfigError('agent-pool: "slots" must be a list', file);
	}
	const tierNames = new Set(Object.keys(tiers as object));
	for (const slot of slots) {
		if (!slot || typeof slot !== 'object') {
			throw new ConfigError('agent-pool: each slot must be a mapping', file);
		}
		const s = slot as Record<string, unknown>;
		if (typeof s.id !== 'string' || typeof s.tier !== 'string' || typeof s.role !== 'string') {
			throw new ConfigError('agent-pool: slot needs string id/tier/role', file);
		}
		if (!tierNames.has(s.tier)) {
			throw new ConfigError(
				`agent-pool: slot "${s.id}" references undefined tier "${s.tier}"`,
				file
			);
		}
	}
	return raw as unknown as AgentPool;
}

/** Load + validate a models config (JSON5 or YAML chosen by caller). */
export function loadModels(file: string, opts: LoadOpts = {}): ModelsConfig {
	const isJson5 = file.endsWith('.json5');
	const parsed = isJson5 ? parseJson5(file) : parseYaml(file);
	const raw = { ...asObject(parsed, file), ...(opts._inject ?? {}) };
	const providers = raw.providers;
	if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
		throw new ConfigError('models: "providers" must be a mapping', file);
	}
	for (const [name, spec] of Object.entries(providers as Record<string, unknown>)) {
		if (!spec || typeof spec !== 'object') {
			throw new ConfigError(`models: provider "${name}" must be a mapping`, file);
		}
		const p = spec as Record<string, unknown>;
		if (typeof p.endpoint !== 'string') {
			throw new ConfigError(`models: provider "${name}" needs a string endpoint`, file);
		}
		if (!Array.isArray(p.models) || p.models.some((m) => typeof m !== 'string')) {
			throw new ConfigError(`models: provider "${name}" needs a list of model ids`, file);
		}
		// Project rule: the local Ollama endpoint must NOT carry a /v1 suffix.
		if (name === 'ollama' && /\/v1\/?$/.test(p.endpoint)) {
			throw new ConfigError(
				`models: ollama endpoint must not include a /v1 suffix ("${p.endpoint}")`,
				file
			);
		}
	}
	return raw as unknown as ModelsConfig;
}

/** Load + validate orchestration.yaml. */
export function loadOrchestration(file: string, opts: LoadOpts = {}): Orchestration {
	const raw = { ...asObject(parseYaml(file), file), ...(opts._inject ?? {}) };
	const mode = raw.mode;
	if (typeof mode !== 'string' || !(ORCH_MODES as readonly string[]).includes(mode)) {
		throw new ConfigError(
			`orchestration: "mode" must be one of ${ORCH_MODES.join(' | ')} (got ${String(mode)})`,
			file
		);
	}
	const conc = raw.concurrency;
	if (conc === null || typeof conc !== 'object' || Array.isArray(conc)) {
		throw new ConfigError('orchestration: "concurrency" must be a mapping', file);
	}
	const c = conc as Record<string, unknown>;
	if (!Number.isInteger(c.maxAgents) || (c.maxAgents as number) < 1) {
		throw new ConfigError('orchestration: concurrency.maxAgents must be a positive integer', file);
	}
	if (!Number.isInteger(c.perProject) || (c.perProject as number) < 1) {
		throw new ConfigError('orchestration: concurrency.perProject must be a positive integer', file);
	}
	// TASK 2.12: validate the intent-adaptive bundles at the boundary (D-020). Each key
	// MUST be one of the five intents; each known knob MUST be the right shape/range.
	if (raw.bundles !== undefined) {
		validateBundles(raw.bundles, file);
	}
	return raw as unknown as Orchestration;
}

/** A non-negative-integer knob check shared across the numeric bundle fields. */
function assertNonNegInt(value: unknown, intent: string, knob: string, file: string): void {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new ConfigError(
			`orchestration: bundle "${intent}".${knob} must be a non-negative integer`,
			file
		);
	}
}

/**
 * Validate orchestration.bundles (D-020) at the config boundary. Rejects:
 *   • a non-mapping `bundles`
 *   • any key that is not one of the five INTENT_CLASSES (a typo would silently
 *     mis-route — fail closed instead)
 *   • a non-mapping bundle value
 *   • an unknown `thinking` level
 *   • a negative / non-integer numeric knob (retrievalDepth/toolCalls/concurrency/tokenBudget)
 *   • a retrievalShare outside [0,1]
 * Unknown extra keys are PERMITTED (forward-compat tunables — the type keeps `[k]` open).
 */
export function validateBundles(bundles: unknown, file: string): void {
	if (bundles === null || typeof bundles !== 'object' || Array.isArray(bundles)) {
		throw new ConfigError('orchestration: "bundles" must be a mapping of intent → config', file);
	}
	const valid = new Set<string>(INTENT_CLASSES);
	for (const [intent, bundle] of Object.entries(bundles as Record<string, unknown>)) {
		if (!valid.has(intent)) {
			throw new ConfigError(
				`orchestration: bundle key "${intent}" is not a known intent (${INTENT_CLASSES.join(' | ')})`,
				file
			);
		}
		if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
			throw new ConfigError(`orchestration: bundle "${intent}" must be a mapping`, file);
		}
		const b = bundle as Record<string, unknown>;
		if (b.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(b.thinking as string)) {
			throw new ConfigError(
				`orchestration: bundle "${intent}".thinking must be one of ${THINKING_LEVELS.join(' | ')} (got ${String(b.thinking)})`,
				file
			);
		}
		if (b.retrievalDepth !== undefined) assertNonNegInt(b.retrievalDepth, intent, 'retrievalDepth', file);
		if (b.toolCalls !== undefined) assertNonNegInt(b.toolCalls, intent, 'toolCalls', file);
		if (b.concurrency !== undefined) assertNonNegInt(b.concurrency, intent, 'concurrency', file);
		if (b.tokenBudget !== undefined) assertNonNegInt(b.tokenBudget, intent, 'tokenBudget', file);
		if (b.retrievalShare !== undefined) {
			const s = b.retrievalShare;
			if (typeof s !== 'number' || Number.isNaN(s) || s < 0 || s > 1) {
				throw new ConfigError(
					`orchestration: bundle "${intent}".retrievalShare must be a number in [0,1] (got ${String(s)})`,
					file
				);
			}
		}
	}
}

// --- intent → bundle resolution (D-020 — the canonical map, TASK 2.12) ------
//
// resolveRoute (2.3) consumes these so the intent→config mapping lives in ONE place
// (the config layer that owns the bundle shape), not duplicated in routing. An intent
// with no configured bundle resolves to an empty bundle (all-defaults) — never throws,
// so a sparsely-configured orchestration.yaml still routes every intent.

/** The adaptive config bundle for an intent (D-020). Empty bundle when none is configured. */
export function resolveAdaptiveConfig(orchestration: Orchestration, intent: IntentClass): ConfigBundle {
	return orchestration.bundles?.[intent] ?? {};
}

/** Derive the spawn-budget subset from a bundle (thinking/toolCalls/concurrency → SpawnBudgets). */
export function bundleToBudgets(bundle: ConfigBundle): BundleBudgets {
	const out: BundleBudgets = {};
	if (bundle.thinking !== undefined) out.thinking = bundle.thinking;
	if (typeof bundle.toolCalls === 'number') out.toolCalls = bundle.toolCalls;
	if (typeof bundle.concurrency === 'number') out.concurrency = bundle.concurrency;
	return out;
}

/**
 * Composite loader: read all three config files from `configDir`.
 * Models prefers `models.json5`, falling back to `models.yaml`.
 */
export function loadConfig(configDir: string): AppConfig {
	const agentPool = loadAgentPool(join(configDir, 'agent-pool.yaml'));

	const json5Path = join(configDir, 'models.json5');
	const yamlPath = join(configDir, 'models.yaml');
	let models: ModelsConfig;
	try {
		readFileSync(json5Path);
		models = loadModels(json5Path);
	} catch {
		models = loadModels(yamlPath);
	}

	const orchestration = loadOrchestration(join(configDir, 'orchestration.yaml'));
	return { agentPool, models, orchestration };
}
