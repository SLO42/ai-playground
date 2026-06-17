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
	MODEL_IDS,
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

	// ── CA-H3 — fail closed on a retired/unknown CLAUDE-provider tier model id ─────────
	const REAL_POOL = join(process.cwd(), 'config', 'agent-pool.yaml');

	it('SHIPPED agent-pool.yaml loads clean (claude tiers carry canonical MODEL_IDS)', () => {
		const pool = loadAgentPool(REAL_POOL);
		expect(pool.tiers.opus.model).toBe('claude-opus-4-8');
		// every claude-provider tier in the shipped config is a known model id
		for (const t of Object.values(pool.tiers)) {
			if (t.provider === 'claude') expect(MODEL_IDS).toContain(t.model);
		}
	});

	it('rejects a retired claude tier model id (fable-5) at the boundary', () => {
		expect(() =>
			loadAgentPool(REAL_POOL, {
				_inject: { tiers: { opus: { provider: 'claude', model: 'claude-fable-5' } }, slots: [] }
			})
		).toThrow(ConfigError);
	});

	it('rejects an unknown/typo claude tier model id at the boundary', () => {
		expect(() =>
			loadAgentPool(REAL_POOL, {
				_inject: { tiers: { opus: { provider: 'claude', model: 'claude-made-up-9' } }, slots: [] }
			})
		).toThrow(ConfigError);
	});

	it('rejects an empty claude tier model id (shadow: empty input)', () => {
		expect(() =>
			loadAgentPool(REAL_POOL, {
				_inject: { tiers: { opus: { provider: 'claude', model: '   ' } }, slots: [] }
			})
		).toThrow(ConfigError);
	});

	it('rejects a tier with a non-string model (shadow: nil/wrong-type input)', () => {
		expect(() =>
			loadAgentPool(REAL_POOL, {
				_inject: { tiers: { opus: { provider: 'claude' } }, slots: [] }
			})
		).toThrow(ConfigError);
	});

	it('does NOT bind a non-claude provider tier to the Claude allowlist (ollama gpt-oss)', () => {
		const pool = loadAgentPool(REAL_POOL, {
			_inject: {
				tiers: { local: { provider: 'ollama', model: 'gpt-oss:20b' } },
				slots: [{ id: 'l', tier: 'local', role: 'local' }]
			}
		});
		expect(pool.tiers.local.model).toBe('gpt-oss:20b');
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

	// ── CA-H3 — fail closed on a retired/unknown id in the `claude` provider's models list
	it('accepts a claude provider whose models are all canonical MODEL_IDS', () => {
		const models = loadModels(join(FIX, 'models.json5'), {
			_inject: {
				providers: {
					claude: { endpoint: 'https://api.anthropic.com', models: [...MODEL_IDS] }
				}
			}
		});
		expect(models.providers.claude.models).toEqual([...MODEL_IDS]);
	});

	it('rejects a retired (fable-5) id in the claude provider models list', () => {
		expect(() =>
			loadModels(join(FIX, 'models.json5'), {
				_inject: {
					providers: {
						claude: { endpoint: 'https://api.anthropic.com', models: ['claude-opus-4-8', 'claude-fable-5'] }
					}
				}
			})
		).toThrow(ConfigError);
	});

	it('rejects an unknown/typo id in the claude provider models list', () => {
		expect(() =>
			loadModels(join(FIX, 'models.json5'), {
				_inject: {
					providers: {
						claude: { endpoint: 'https://api.anthropic.com', models: ['claude-made-up-9'] }
					}
				}
			})
		).toThrow(ConfigError);
	});

	it('does NOT bind a non-claude provider models list to the Claude allowlist (ollama)', () => {
		const models = loadModels(join(FIX, 'models.json5'), {
			_inject: {
				providers: { ollama: { endpoint: 'http://127.0.0.1:11434', models: ['gpt-oss:20b'] } }
			}
		});
		expect(models.providers.ollama.models).toContain('gpt-oss:20b');
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
		expect(wf.pm.model_id).toBe('claude-opus-4-8');
		expect(wf.pm.provider).toBe('claude'); // omitted ⇒ the registered CLI backend
		// Forward-compat: other namespaces pass through untouched for their consumers.
		expect((wf.gauntlet as Record<string, unknown>).pass_recall).toBe(1.0);
	});

	it('the SHIPPED config/workforce.yaml routes the PM to Opus (PM-SPEC §1; opus-everywhere)', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.pm.provider).toBe('claude');
		expect(wf.pm.model_id).toBe('claude-opus-4-8');
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
		['non-string provider', { pm: { model_id: 'claude-opus-4-8', provider: 5 } }],
		// CA-0 — fail closed on a retired/unknown model id (claude-fable-5 RETIRED).
		['retired model_id (fable-5)', { pm: { model_id: 'claude-fable-5' } }],
		['unknown model_id', { pm: { model_id: 'claude-made-up-9' } }]
	])('rejects %s at the boundary', (_label, inject) => {
		expect(() => loadWorkforce(REAL_WF, { _inject: inject as never })).toThrow(ConfigError);
	});

	// ── TASK 16.2 — pm.triggers.failure_threshold (PM-SPEC §3 event ①) ────────────
	it('the SHIPPED config ships the failure trigger UNARMED (null — F-008, no invented bound)', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.pm.triggers.failure_threshold).toBeNull();
	});

	it('an absent triggers block defaults to unarmed (older files stay valid)', () => {
		const wf = loadWorkforce(REAL_WF, { _inject: { pm: { model_id: 'claude-opus-4-8' } } });
		expect(wf.pm.triggers.failure_threshold).toBeNull();
	});

	it('accepts an armed non-negative integer threshold', () => {
		const wf = loadWorkforce(REAL_WF, {
			_inject: { pm: { model_id: 'claude-opus-4-8', triggers: { failure_threshold: 3 } } }
		});
		expect(wf.pm.triggers.failure_threshold).toBe(3);
	});

	it.each([
		['non-mapping triggers', { pm: { model_id: 'claude-opus-4-8', triggers: 'lots' } }],
		['negative threshold', { pm: { model_id: 'claude-opus-4-8', triggers: { failure_threshold: -1 } } }],
		['non-integer threshold', { pm: { model_id: 'claude-opus-4-8', triggers: { failure_threshold: 1.5 } } }],
		['string threshold', { pm: { model_id: 'claude-opus-4-8', triggers: { failure_threshold: '3' } } }]
	])('rejects %s at the trigger boundary (fail closed)', (_label, inject) => {
		expect(() => loadWorkforce(REAL_WF, { _inject: inject as never })).toThrow(ConfigError);
	});

	// ── TASK 16.4 — panel.scope.* + workforce.max_open_proposals (PM-SPEC §4.6/§4) ──
	it('the SHIPPED config ships panel.scope tripwires UNARMED (null, G5/F-008)', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.panel.scope.max_files).toBeNull();
		expect(wf.panel.scope.max_new_services).toBeNull();
	});

	it('the SHIPPED config ships max_open_proposals = 2 (the §5 conservative start)', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.workforce.max_open_proposals).toBe(2);
	});

	it('absent panel/workforce blocks default honestly (unarmed scope, cap 2)', () => {
		const wf = loadWorkforce(REAL_WF, {
			_inject: { pm: { model_id: 'claude-opus-4-8' }, panel: undefined, workforce: undefined }
		});
		expect(wf.panel.scope.max_files).toBeNull();
		expect(wf.workforce.max_open_proposals).toBe(2);
	});

	it('accepts armed integer scope bounds', () => {
		const wf = loadWorkforce(REAL_WF, {
			_inject: { pm: { model_id: 'claude-opus-4-8' }, panel: { scope: { max_files: 9 } } }
		});
		expect(wf.panel.scope.max_files).toBe(9);
		expect(wf.panel.scope.max_new_services).toBeNull();
	});

	it.each([
		['non-mapping panel', { pm: { model_id: 'claude-opus-4-8' }, panel: 'big' }],
		['non-mapping scope', { pm: { model_id: 'claude-opus-4-8' }, panel: { scope: 7 } }],
		['negative max_files', { pm: { model_id: 'claude-opus-4-8' }, panel: { scope: { max_files: -1 } } }],
		['float max_new_services', { pm: { model_id: 'claude-opus-4-8' }, panel: { scope: { max_new_services: 1.5 } } }],
		['non-mapping workforce', { pm: { model_id: 'claude-opus-4-8' }, workforce: 3 }],
		['zero cap', { pm: { model_id: 'claude-opus-4-8' }, workforce: { max_open_proposals: 0 } }],
		['string cap', { pm: { model_id: 'claude-opus-4-8' }, workforce: { max_open_proposals: '2' } }]
	])('rejects %s at the 16.4 boundary (fail closed)', (_label, inject) => {
		expect(() => loadWorkforce(REAL_WF, { _inject: inject as never })).toThrow(ConfigError);
	});

	// ── TASK 16.6 — gauntlet.* + budget.* (WORKFORCE-SPEC §3.5/§3.1/§3.7) ──────────
	it('the SHIPPED config arms the §3.5 pass bar (1.0 recall / 0 FP) + the 15-min bound', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.gauntlet.pass_recall).toBe(1.0);
		expect(wf.gauntlet.max_false_positives).toBe(0);
		expect(wf.gauntlet.session_timeout_minutes).toBe(15);
	});

	it('the SHIPPED budget is UNARMED: null cap + empty auto tiers (§3.7, F-008)', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.budget.max_auto_interviews_per_day).toBeNull();
		expect(wf.budget.allowed_auto_tiers).toEqual([]);
	});

	it('absent gauntlet/budget blocks fall back to the spec-justified defaults (older files stay valid)', () => {
		const wf = loadWorkforce(REAL_WF, {
			_inject: { pm: { model_id: 'claude-opus-4-8' }, gauntlet: undefined, budget: undefined }
		});
		expect(wf.gauntlet.pass_recall).toBe(1.0);
		expect(wf.gauntlet.max_false_positives).toBe(0);
		expect(wf.gauntlet.session_timeout_minutes).toBe(15);
		expect(wf.budget.max_auto_interviews_per_day).toBeNull();
		expect(wf.budget.allowed_auto_tiers).toEqual([]);
	});

	it('accepts an armed budget (integer cap + valid tier list)', () => {
		const wf = loadWorkforce(REAL_WF, {
			_inject: {
				pm: { model_id: 'claude-opus-4-8' },
				budget: { max_auto_interviews_per_day: 3, allowed_auto_tiers: ['sonnet', 'haiku'] }
			}
		});
		expect(wf.budget.max_auto_interviews_per_day).toBe(3);
		expect(wf.budget.allowed_auto_tiers).toEqual(['sonnet', 'haiku']);
	});

	it.each([
		['non-mapping gauntlet', { pm: { model_id: 'claude-opus-4-8' }, gauntlet: 'hard' }],
		['recall above 1', { pm: { model_id: 'claude-opus-4-8' }, gauntlet: { pass_recall: 1.2 } }],
		['negative recall', { pm: { model_id: 'claude-opus-4-8' }, gauntlet: { pass_recall: -0.1 } }],
		['string recall', { pm: { model_id: 'claude-opus-4-8' }, gauntlet: { pass_recall: '1.0' } }],
		['float max_false_positives', { pm: { model_id: 'claude-opus-4-8' }, gauntlet: { max_false_positives: 0.5 } }],
		['negative max_false_positives', { pm: { model_id: 'claude-opus-4-8' }, gauntlet: { max_false_positives: -1 } }],
		['zero timeout', { pm: { model_id: 'claude-opus-4-8' }, gauntlet: { session_timeout_minutes: 0 } }],
		['non-mapping budget', { pm: { model_id: 'claude-opus-4-8' }, budget: [] }],
		['float day cap', { pm: { model_id: 'claude-opus-4-8' }, budget: { max_auto_interviews_per_day: 1.5 } }],
		['negative day cap', { pm: { model_id: 'claude-opus-4-8' }, budget: { max_auto_interviews_per_day: -1 } }],
		['unknown tier', { pm: { model_id: 'claude-opus-4-8' }, budget: { allowed_auto_tiers: ['mega'] } }],
		['non-array tiers', { pm: { model_id: 'claude-opus-4-8' }, budget: { allowed_auto_tiers: 'sonnet' } }]
	])('rejects %s at the 16.6 boundary (fail closed)', (_label, inject) => {
		expect(() => loadWorkforce(REAL_WF, { _inject: inject as never })).toThrow(ConfigError);
	});

	// ── WORKFORCE-SPEC §5 — drift.* + workforce.{track_window_days,min_events_for_claim} ──
	it('the SHIPPED config arms the categorical + miscalibration drift signals; rate signals UNARMED', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.drift.escaped_defect).toBe(true);
		expect(wf.drift.operator_feedback).toBe(true);
		expect(wf.drift.confidence_miscalibration).toBe(true);
		expect(wf.drift.confidence_miscalibration_rate).toBe(0.5);
		// Post-B2 rate signals ship null (F-008 — '— (needs B2)', never a fabricated bound).
		expect(wf.drift.refutation_rate).toBeNull();
		expect(wf.drift.fixloop_rate).toBeNull();
	});

	it('the SHIPPED config carries the §5 track window + claim floor (14 / 5)', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.workforce.track_window_days).toBe(14);
		expect(wf.workforce.min_events_for_claim).toBe(5);
	});

	it('an absent drift block defaults to armed categorical + null rate signals (older files stay valid)', () => {
		const wf = loadWorkforce(REAL_WF, { _inject: { pm: { model_id: 'claude-opus-4-8' }, drift: undefined } });
		expect(wf.drift.escaped_defect).toBe(true);
		expect(wf.drift.operator_feedback).toBe(true);
		expect(wf.drift.confidence_miscalibration).toBe(true);
		expect(wf.drift.confidence_miscalibration_rate).toBeNull(); // unarmed until set
		expect(wf.drift.refutation_rate).toBeNull();
	});

	it('an operator may DISARM the miscalibration signal (bool false) or its rate (null)', () => {
		const off = loadWorkforce(REAL_WF, {
			_inject: { pm: { model_id: 'claude-opus-4-8' }, drift: { confidence_miscalibration: false } }
		});
		expect(off.drift.confidence_miscalibration).toBe(false);
		const noRate = loadWorkforce(REAL_WF, {
			_inject: { pm: { model_id: 'claude-opus-4-8' }, drift: { confidence_miscalibration_rate: null } }
		});
		expect(noRate.drift.confidence_miscalibration_rate).toBeNull();
	});

	it('absent workforce block defaults the window + floor honestly (14 / 5)', () => {
		const wf = loadWorkforce(REAL_WF, { _inject: { pm: { model_id: 'claude-opus-4-8' }, workforce: undefined } });
		expect(wf.workforce.track_window_days).toBe(14);
		expect(wf.workforce.min_events_for_claim).toBe(5);
	});

	it.each([
		['non-mapping drift', { pm: { model_id: 'claude-opus-4-8' }, drift: 'on' }],
		['non-boolean escaped_defect', { pm: { model_id: 'claude-opus-4-8' }, drift: { escaped_defect: 'yes' } }],
		['non-boolean miscalibration', { pm: { model_id: 'claude-opus-4-8' }, drift: { confidence_miscalibration: 1 } }],
		['rate above 1', { pm: { model_id: 'claude-opus-4-8' }, drift: { confidence_miscalibration_rate: 1.2 } }],
		['negative rate', { pm: { model_id: 'claude-opus-4-8' }, drift: { confidence_miscalibration_rate: -0.1 } }],
		['string rate', { pm: { model_id: 'claude-opus-4-8' }, drift: { refutation_rate: '0.5' } }],
		['zero track window', { pm: { model_id: 'claude-opus-4-8' }, workforce: { track_window_days: 0 } }],
		['float track window', { pm: { model_id: 'claude-opus-4-8' }, workforce: { track_window_days: 1.5 } }],
		['negative min events', { pm: { model_id: 'claude-opus-4-8' }, workforce: { min_events_for_claim: -1 } }]
	])('rejects %s at the §5 drift/window boundary (fail closed)', (_label, inject) => {
		expect(() => loadWorkforce(REAL_WF, { _inject: inject as never })).toThrow(ConfigError);
	});

	// ── WORKFORCE-SPEC §7b rail ⑤ — research.* budget (ships UNARMED) ──
	it('the SHIPPED config ships research.* UNARMED (null = no fetch, honest partial)', () => {
		const wf = loadWorkforce(REAL_WF);
		expect(wf.research.max_wall_clock_minutes).toBeNull();
		expect(wf.research.max_fetches).toBeNull();
	});

	it('an absent research block defaults UNARMED (older files stay valid)', () => {
		const wf = loadWorkforce(REAL_WF, { _inject: { pm: { model_id: 'claude-opus-4-8' }, research: undefined } });
		expect(wf.research.max_wall_clock_minutes).toBeNull();
		expect(wf.research.max_fetches).toBeNull();
	});

	it('an operator may ARM the research budget (positive minutes + a fetch cap)', () => {
		const wf = loadWorkforce(REAL_WF, {
			_inject: { pm: { model_id: 'claude-opus-4-8' }, research: { max_wall_clock_minutes: 10, max_fetches: 20 } }
		});
		expect(wf.research.max_wall_clock_minutes).toBe(10);
		expect(wf.research.max_fetches).toBe(20);
	});

	it.each([
		['non-mapping research', { pm: { model_id: 'claude-opus-4-8' }, research: 'on' }],
		['zero wall-clock', { pm: { model_id: 'claude-opus-4-8' }, research: { max_wall_clock_minutes: 0 } }],
		['negative wall-clock', { pm: { model_id: 'claude-opus-4-8' }, research: { max_wall_clock_minutes: -5 } }],
		['float fetches', { pm: { model_id: 'claude-opus-4-8' }, research: { max_fetches: 1.5 } }],
		['negative fetches', { pm: { model_id: 'claude-opus-4-8' }, research: { max_fetches: -1 } }],
		['string fetches', { pm: { model_id: 'claude-opus-4-8' }, research: { max_fetches: '5' } }]
	])('rejects %s at the §7b research boundary (fail closed)', (_label, inject) => {
		expect(() => loadWorkforce(REAL_WF, { _inject: inject as never })).toThrow(ConfigError);
	});
});
