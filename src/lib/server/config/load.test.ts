import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	loadAgentPool,
	loadModels,
	loadOrchestration,
	loadGatesConfig,
	loadWorkforce,
	loadConfig,
	validateBundles,
	resolveAdaptiveConfig,
	bundleToBudgets,
	INTENT_CLASSES,
	ConfigError,
	type Orchestration
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
		expect(orch.bundles!['code-debug']!.retrievalDepth).toBe(8);
	});

	it('rejects an invalid mode (boundary validation)', () => {
		expect(() => loadOrchestration(join(FIX, 'bad-mode.yaml'))).toThrow(ConfigError);
	});

	// TASK 2.12 — intent-adaptive bundle validation at the config boundary (D-020).
	it('parses ALL FIVE intent bundles with their adaptive knobs', () => {
		const orch = loadOrchestration(join(FIX, 'orchestration.yaml'));
		for (const intent of INTENT_CLASSES) {
			expect(orch.bundles?.[intent]).toBeDefined();
		}
		expect(orch.bundles!['simple-question']!.thinking).toBe('none');
		expect(orch.bundles!['simple-question']!.retrievalShare).toBe(0);
		expect(orch.bundles!['deep-explore']!.thinking).toBe('high');
		expect(orch.bundles!['deep-explore']!.tokenBudget).toBe(200000);
	});

	it('rejects a bundle key that is not a known intent (typo fails closed)', () => {
		expect(() =>
			loadOrchestration(join(FIX, 'orchestration.yaml'), {
				_inject: { bundles: { 'code-wrte': { thinking: 'low' } } }
			})
		).toThrow(/not a known intent/);
	});

	it('rejects an unknown thinking level', () => {
		expect(() =>
			loadOrchestration(join(FIX, 'orchestration.yaml'), {
				_inject: { bundles: { 'code-write': { thinking: 'ultra' } } }
			})
		).toThrow(/thinking must be one of/);
	});

	it('rejects a negative retrievalDepth and a non-integer toolCalls', () => {
		expect(() =>
			loadOrchestration(join(FIX, 'orchestration.yaml'), {
				_inject: { bundles: { 'code-read': { retrievalDepth: -1 } } }
			})
		).toThrow(/retrievalDepth must be a non-negative integer/);
		expect(() =>
			loadOrchestration(join(FIX, 'orchestration.yaml'), {
				_inject: { bundles: { 'code-read': { toolCalls: 2.5 } } }
			})
		).toThrow(/toolCalls must be a non-negative integer/);
	});

	it('rejects a retrievalShare outside [0,1]', () => {
		expect(() =>
			loadOrchestration(join(FIX, 'orchestration.yaml'), {
				_inject: { bundles: { 'deep-explore': { retrievalShare: 1.5 } } }
			})
		).toThrow(/retrievalShare must be a number in \[0,1\]/);
	});

	it('permits unknown forward-compat knobs (open bundle)', () => {
		expect(() =>
			validateBundles({ 'code-write': { thinking: 'medium', vectorLimits: { task: 5 } } }, 'x.yaml')
		).not.toThrow();
	});

	it('rejects a non-mapping bundles and a non-mapping bundle value', () => {
		expect(() => validateBundles([], 'x.yaml')).toThrow(/must be a mapping/);
		expect(() => validateBundles({ 'code-write': 7 }, 'x.yaml')).toThrow(/must be a mapping/);
	});

	// TASK 5.1 (D-036): the capability block — SHAPE validation at the config boundary.
	it('accepts a well-shaped capabilities block { skills, agents, mcp }', () => {
		expect(() =>
			validateBundles(
				{ 'code-write': { capabilities: { skills: ['svelte5-patterns'], agents: ['coder'], mcp: ['context7'] } } },
				'x.yaml'
			)
		).not.toThrow();
	});

	it('accepts a partial capabilities block (only the declared dimensions)', () => {
		expect(() =>
			validateBundles({ 'code-read': { capabilities: { skills: ['design'] } } }, 'x.yaml')
		).not.toThrow();
	});

	it('rejects a non-mapping capabilities block', () => {
		expect(() =>
			validateBundles({ 'code-write': { capabilities: ['svelte5-patterns'] } }, 'x.yaml')
		).toThrow(/capabilities must be a mapping/);
	});

	it('rejects a capabilities dimension that is not a list of string ids', () => {
		expect(() =>
			validateBundles({ 'code-write': { capabilities: { skills: 'svelte5-patterns' } } }, 'x.yaml')
		).toThrow(/capabilities\.skills must be a list of string ids/);
		expect(() =>
			validateBundles({ 'code-write': { capabilities: { mcp: [42] } } }, 'x.yaml')
		).toThrow(/capabilities\.mcp must be a list of string ids/);
	});
});

describe('intent → bundle resolution (D-020 — TASK 2.12)', () => {
	const orch = loadOrchestration(join(FIX, 'orchestration.yaml'));

	it('resolveAdaptiveConfig returns the configured bundle for each intent', () => {
		expect(resolveAdaptiveConfig(orch, 'code-debug').retrievalDepth).toBe(8);
		expect(resolveAdaptiveConfig(orch, 'code-debug').thinking).toBe('high');
		expect(resolveAdaptiveConfig(orch, 'simple-question').thinking).toBe('none');
	});

	it('resolveAdaptiveConfig returns an empty bundle for an unconfigured intent (never throws)', () => {
		const sparse: Orchestration = {
			mode: 'event',
			concurrency: { maxAgents: 1, perProject: 1 },
			bundles: { 'code-write': { thinking: 'medium' } }
		};
		expect(resolveAdaptiveConfig(sparse, 'deep-explore')).toEqual({});
		const none: Orchestration = { mode: 'event', concurrency: { maxAgents: 1, perProject: 1 } };
		expect(resolveAdaptiveConfig(none, 'code-read')).toEqual({});
	});

	it('bundleToBudgets derives thinking/toolCalls/concurrency only', () => {
		const b = bundleToBudgets({
			thinking: 'high',
			toolCalls: 40,
			concurrency: 2,
			retrievalDepth: 8,
			retrievalShare: 0.5
		});
		expect(b).toEqual({ thinking: 'high', toolCalls: 40, concurrency: 2 });
		// retrievalDepth/Share are NOT budgets — they feed memory.recall, not the spawn budget.
		expect('retrievalDepth' in b).toBe(false);
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

// ── gates.yaml (TASK 15.1 / B1 scope-lock) — operator-editable pattern lists ─────────

describe('loadGatesConfig — the scope-lock destructive-bash pattern lists (15.1)', () => {
	const REAL = join(process.cwd(), 'config', 'gates.yaml');

	it('loads the SHIPPED config/gates.yaml — every default pattern compiles', () => {
		const cfg = loadGatesConfig(REAL);
		expect(cfg.destructiveBash.deny.length).toBeGreaterThan(0);
		expect(cfg.destructiveBash.allow.length).toBeGreaterThan(0);
		// every entry is well-shaped (id + compiling pattern — validated by the loader)
		for (const e of [...cfg.destructiveBash.deny, ...cfg.destructiveBash.allow]) {
			expect(e.id).toBeTruthy();
			expect(() => new RegExp(e.pattern)).not.toThrow();
		}
		// the task-mandated families are present in the shipped defaults
		const ids = cfg.destructiveBash.deny.map((e) => e.id);
		for (const required of [
			'surreal-remove-ddl',
			'sql-drop',
			'sql-truncate',
			'git-discard-worktree',
			'git-clean-force',
			'rm-recursive',
			'docker-prune'
		]) {
			expect(ids).toContain(required);
		}
	});

	it('throws ConfigError (not a raw fs error) for a missing file — scoped launches fail closed', () => {
		expect(() => loadGatesConfig(join(FIX, 'no-such-gates.yaml'))).toThrow(ConfigError);
	});

	it.each([
		['non-mapping destructiveBash', { destructiveBash: 'nope' }],
		['non-list deny', { destructiveBash: { deny: 'x', allow: [] } }],
		['entry missing id', { destructiveBash: { deny: [{ pattern: 'x' }], allow: [] } }],
		['entry missing pattern', { destructiveBash: { deny: [{ id: 'x' }], allow: [] } }],
		['non-string reason', { destructiveBash: { deny: [{ id: 'x', pattern: 'y', reason: 1 }], allow: [] } }],
		['UNCOMPILABLE pattern', { destructiveBash: { deny: [{ id: 'bad', pattern: '(' }], allow: [] } }]
	])('rejects %s at the boundary', (_label, inject) => {
		expect(() => loadGatesConfig(REAL, { _inject: inject as never })).toThrow(ConfigError);
	});
});

// ── TASK 16.1 — loadWorkforce (config/workforce.yaml, PM-SPEC §1) ──────────────────
describe('loadWorkforce — the single workforce config namespace', () => {
	const REAL_WF = join(process.cwd(), 'config', 'workforce.yaml');

	it('parses the fixture: pm.model_id + the justified provider default ("claude")', () => {
		const wf = loadWorkforce(join(FIX, 'workforce.yaml'));
		expect(wf.pm.model_id).toBe('claude-test-9');
		expect(wf.pm.provider).toBe('claude'); // omitted ⇒ the registered CLI backend
		// Forward-compat: other namespaces pass through untouched for their consumers.
		expect((wf.gauntlet as Record<string, unknown>).pass_recall).toBe(1.0);
	});

	it('the SHIPPED config/workforce.yaml routes the PM to Fable 5 (PM-SPEC §1)', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.pm.provider).toBe('claude');
		expect(wf.pm.model_id).toBe('claude-fable-5');
		// Unarmed bounds ship null, never 0 (G5/F-008 — null ≠ a dressed-up zero).
		const budget = wf.budget as Record<string, unknown>;
		expect(budget.max_auto_interviews_per_day).toBeNull();
	});

	it('throws ConfigError (not a raw fs error) for a missing file', () => {
		expect(() => loadWorkforce(join(FIX, 'no-such-workforce.yaml'))).toThrow(ConfigError);
	});

	it.each([
		['missing pm block', { pm: undefined }],
		['non-mapping pm', { pm: 'fable' }],
		['missing model_id', { pm: {} }],
		['empty model_id', { pm: { model_id: '   ' } }],
		['non-string provider', { pm: { model_id: 'claude-fable-5', provider: 5 } }]
	])('rejects %s at the boundary', (_label, inject) => {
		expect(() => loadWorkforce(REAL_WF, { _inject: inject as never })).toThrow(ConfigError);
	});
});
