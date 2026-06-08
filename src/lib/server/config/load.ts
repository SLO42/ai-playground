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

export interface ConfigBundle {
	thinking?: string;
	retrievalDepth?: number;
	[k: string]: unknown;
}
export interface Orchestration {
	mode: OrchMode;
	triggers?: string[];
	intervalMs?: number;
	concurrency: { maxAgents: number; perProject: number };
	bundles?: Record<string, ConfigBundle>;
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
	return raw as unknown as Orchestration;
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
