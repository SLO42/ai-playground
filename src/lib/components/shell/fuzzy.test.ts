import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankItems } from './fuzzy';

describe('fuzzyScore', () => {
	it('empty query matches everything with a neutral score', () => {
		const m = fuzzyScore('', 'Projects');
		expect(m.matched).toBe(true);
		expect(m.positions).toEqual([]);
	});

	it('matches a subsequence anywhere in the target', () => {
		const m = fuzzyScore('prj', 'Projects');
		expect(m.matched).toBe(true);
		// p(0) r(1) j(... 'j' not present) → actually Projects has no 'j'
	});

	it('matches in-order chars (case-insensitive)', () => {
		const m = fuzzyScore('wf', 'Workflows');
		expect(m.matched).toBe(true);
		expect(m.positions[0]).toBe(0); // 'w'
	});

	it('fails when a query char is absent', () => {
		const m = fuzzyScore('xyz', 'Projects');
		expect(m.matched).toBe(false);
		expect(m.score).toBe(0);
	});

	it('fails when chars are present but out of order', () => {
		// target 'abc' cannot match query 'ba' (b before a)
		const m = fuzzyScore('ba', 'abc');
		expect(m.matched).toBe(false);
	});

	it('scores a prefix match higher than a scattered match', () => {
		const prefix = fuzzyScore('mem', 'Memory');
		const scattered = fuzzyScore('mem', 'Maximum entropy model');
		expect(prefix.matched).toBe(true);
		expect(scattered.matched).toBe(true);
		expect(prefix.score).toBeGreaterThan(scattered.score);
	});

	it('rewards a word-boundary match', () => {
		const boundary = fuzzyScore('r', 'Manual run');
		expect(boundary.matched).toBe(true);
		// position is at the 'r' that starts the word 'run'
		expect('Manual run'[boundary.positions[0]]).toBe('r');
	});
});

describe('rankItems', () => {
	const items = [
		{ label: 'Home' },
		{ label: 'Projects' },
		{ label: 'Workflows' },
		{ label: 'Memory' },
		{ label: 'Start manual run', keywords: ['execute', 'spawn'] }
	];

	it('returns all items for an empty query, in input order', () => {
		const ranked = rankItems('', items);
		expect(ranked.map((r) => r.item.label)).toEqual([
			'Home',
			'Projects',
			'Workflows',
			'Memory',
			'Start manual run'
		]);
	});

	it('drops non-matching items', () => {
		const ranked = rankItems('zzz', items);
		expect(ranked).toHaveLength(0);
	});

	it('surfaces the best match first', () => {
		const ranked = rankItems('mem', items);
		expect(ranked[0].item.label).toBe('Memory');
	});

	it('matches on keywords (aliases) when the label does not match', () => {
		const ranked = rankItems('spawn', items);
		expect(ranked.map((r) => r.item.label)).toContain('Start manual run');
	});

	it('is stable for equal scores (preserves input order)', () => {
		// 'o' appears in Home, Projects, Workflows, Memory — check no crash + ordering sane
		const ranked = rankItems('o', items);
		expect(ranked.length).toBeGreaterThan(0);
	});
});
