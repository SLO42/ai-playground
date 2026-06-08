import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	loadAgentPool,
	loadModels,
	loadOrchestration,
	loadConfig,
	ConfigError
} from './load';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('loadAgentPool — YAML', () => {
	it('parses tiers, slots, escalation, delegation', () => {
		const pool = loadAgentPool(join(FIX, 'agent-pool.yaml'));
		expect(pool.tiers.opus.model).toBe('claude-opus');
		expect(pool.slots).toHaveLength(3);
		expect(pool.slots[0]).toMatchObject({ id: 'coder-1', tier: 'opus', role: 'coder' });
		expect(pool.escalation?.order).toEqual(['haiku', 'sonnet', 'opus']);
	});

	it('rejects a slot referencing an undefined tier (boundary validation)', () => {
		expect(() =>
			loadAgentPool(join(FIX, 'agent-pool.yaml'), {
				// inject an override that breaks the invariant
				_inject: { slots: [{ id: 'x', tier: 'ghost', role: 'coder' }], tiers: {} }
			})
		).toThrow(ConfigError);
	});

	it('throws ConfigError (not a raw fs error) for a missing file', () => {
		expect(() => loadAgentPool(join(FIX, 'does-not-exist.yaml'))).toThrow(ConfigError);
	});
});

describe('loadModels — JSON5', () => {
	it('parses providers + endpoints + model ids', () => {
		const models = loadModels(join(FIX, 'models.json5'));
		expect(models.providers.ollama.endpoint).toBe('http://127.0.0.1:11434');
		expect(models.providers.anthropic.models).toContain('claude-opus');
	});

	it('rejects an Ollama endpoint carrying a /v1 suffix (project rule, boundary)', () => {
		expect(() =>
			loadModels(join(FIX, 'models.json5'), {
				_inject: {
					providers: { ollama: { endpoint: 'http://127.0.0.1:11434/v1', models: ['x'] } }
				}
			})
		).toThrow(/\/v1/);
	});
});

describe('loadOrchestration — YAML + enum validation', () => {
	it('parses mode, triggers, interval, concurrency caps, bundles', () => {
		const orch = loadOrchestration(join(FIX, 'orchestration.yaml'));
		expect(orch.mode).toBe('event');
		expect(orch.concurrency.maxAgents).toBe(8);
		expect(orch.concurrency.perProject).toBe(3);
		expect(orch.bundles?.['code-debug'].retrievalDepth).toBe(8);
	});

	it('rejects an invalid mode (boundary validation)', () => {
		expect(() => loadOrchestration(join(FIX, 'bad-mode.yaml'))).toThrow(ConfigError);
	});
});

describe('loadConfig — composite loader', () => {
	it('loads all three files from a config dir', () => {
		const cfg = loadConfig(FIX);
		expect(cfg.agentPool.slots).toHaveLength(3);
		expect(cfg.models.providers.ollama).toBeDefined();
		expect(cfg.orchestration.mode).toBe('event');
	});

	it('prefers models.json5, falling back to models.yaml when json5 is absent', () => {
		const cfg = loadConfig(FIX);
		// fixture dir has models.json5
		expect(cfg.models.providers.anthropic.models).toContain('claude-opus');
	});
});
