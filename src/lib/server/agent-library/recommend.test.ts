import { describe, it, expect } from 'vitest';
import {
	recommendAgentsForTask,
	asRecommendAgentInput,
	type RecommendAgentInput
} from './recommend';
import type { LibraryAgent } from './library';

// Propose-only recommender: pure scoring of a task against library agents. Deterministic ranking,
// capability-weighted, honest empties (F-008). No DB / disk / spawn involved.

const AGENTS: RecommendAgentInput[] = [
	{
		name: 'atelier-developer',
		description: 'Full-stack SvelteKit + Svelte 5 runes + SurrealDB schema migrations specialist.',
		type: 'development',
		category: 'development',
		capabilities: ['code_generation', 'schema_migration', 'svelte5_runes', 'data_visualization'],
		whenToUse: 'Use for dashboard UI, server loaders, schema migrations, and the heartbeat orchestrator.'
	},
	{
		name: 'rounds-mod-developer',
		description: 'C#/BepInEx/Unity specialist for ROUNDS card and gamemode mods.',
		type: 'development',
		category: 'development',
		capabilities: ['csharp', 'bepinex', 'unity', 'harmony_patch'],
		whenToUse: 'Use for UnboundLib card mods, HarmonyX patches, and in-game verification of ROUNDS.'
	},
	{
		name: 'security-auditor',
		description: 'Vulnerability detection, CVE search, and compliance auditing.',
		type: 'security',
		category: 'core',
		capabilities: ['threat_model', 'vulnerability_scan', 'compliance'],
		whenToUse: 'Use to audit code for injection, secrets leakage, and CVE exposure.'
	}
];

describe('recommendAgentsForTask — propose-only scoring', () => {
	it('ranks the on-topic specialist first for a SvelteKit migration task', () => {
		const recs = recommendAgentsForTask(
			{
				title: 'Add a SurrealDB migration for session.specialist',
				description: 'New Svelte 5 runes dashboard surface on the agents catalog page.',
				objective: 'Track per-specialist usage via a schema migration and show it in the UI.'
			},
			AGENTS
		);
		expect(recs.length).toBeGreaterThan(0);
		expect(recs[0].name).toBe('atelier-developer');
		expect(recs[0].normalized).toBe(1); // top score normalizes to 1.0
		// The migration/schema capability is cited as evidence.
		expect(recs[0].matchedCapabilities).toContain('schema_migration');
		expect(recs[0].rationale).toMatch(/Matches on/);
		// It out-scores the unrelated security auditor.
		const sec = recs.find((r) => r.name === 'security-auditor');
		if (sec) expect(recs[0].score).toBeGreaterThan(sec.score);
	});

	it('ranks the C# modder first for a ROUNDS/Unity task', () => {
		const recs = recommendAgentsForTask(
			{
				title: 'Build a new ROUNDS card with a HarmonyX patch',
				description: 'Unity BepInEx mod using UnboundLib; verify in-game.'
			},
			AGENTS
		);
		expect(recs[0].name).toBe('rounds-mod-developer');
		expect(recs[0].matchedCapabilities.length).toBeGreaterThan(0);
	});

	it('returns [] for a task with no usable signal (honest — F-008)', () => {
		expect(recommendAgentsForTask({ title: 'a an the to', description: '' }, AGENTS)).toEqual([]);
		expect(recommendAgentsForTask({}, AGENTS)).toEqual([]);
	});

	it('returns [] when there are no agents', () => {
		expect(recommendAgentsForTask({ title: 'svelte migration' }, [])).toEqual([]);
	});

	it('only includes agents with a positive score and respects the limit', () => {
		const recs = recommendAgentsForTask(
			{ title: 'svelte runes schema migration dashboard' },
			AGENTS,
			{ limit: 1 }
		);
		expect(recs.length).toBe(1);
		expect(recs[0].name).toBe('atelier-developer');
	});

	it('is deterministic: equal scores tie-break by name asc', () => {
		const twins: RecommendAgentInput[] = [
			{ name: 'zeta', capabilities: ['alpha'] },
			{ name: 'alpha-agent', capabilities: ['alpha'] }
		];
		const recs = recommendAgentsForTask({ title: 'alpha task' }, twins);
		expect(recs.map((r) => r.name)).toEqual(['alpha-agent', 'zeta']);
	});

	it('folds acceptanceCriteria (array or string) into the task signal', () => {
		const arr = recommendAgentsForTask(
			{ title: 'work', acceptanceCriteria: ['svelte runes render', 'migration applies'] },
			AGENTS
		);
		const str = recommendAgentsForTask(
			{ title: 'work', acceptanceCriteria: 'svelte runes render migration applies' },
			AGENTS
		);
		expect(arr[0]?.name).toBe('atelier-developer');
		expect(str[0]?.name).toBe('atelier-developer');
	});

	it('asRecommendAgentInput maps a LibraryAgent + when-to-use body', () => {
		const lib: LibraryAgent = {
			name: 'x',
			description: 'd',
			type: 't',
			color: null,
			priority: null,
			category: 'c',
			capabilities: ['cap_one'],
			relPath: 'dir/x.md'
		};
		const mapped = asRecommendAgentInput(lib, 'body text');
		expect(mapped).toEqual({
			name: 'x',
			description: 'd',
			type: 't',
			category: 'c',
			capabilities: ['cap_one'],
			whenToUse: 'body text'
		});
	});
});
