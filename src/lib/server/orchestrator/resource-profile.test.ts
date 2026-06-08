import { describe, it, expect } from 'vitest';
import {
	classifyTier,
	recommendCaps,
	detectResourceProfile,
	detectHostSnapshot,
	resolveBootCaps,
	RESOURCE_TUNING,
	type HostSnapshot
} from './resource-profile';

// TASK 4.2 — resource-profile detection (IMPLEMENTATION-PLAN §4.2 optional knob;
// ARCHITECTURE §388). PURE recommender: a host snapshot → default concurrency caps.
// Operator config always wins; the recommender only fills unset caps. Deterministic
// (snapshot is injectable — no faked runtime data, F-008).

const GIB = 1024 * 1024 * 1024;
const snap = (cpuCount: number, gib: number): HostSnapshot => ({
	cpuCount,
	totalMemBytes: gib * GIB
});

describe('recommendCaps — CPU/RAM → default concurrency caps', () => {
	it('takes the MIN of the CPU-bound and RAM-bound estimate (scarcer resource governs)', () => {
		// 16 cores → cpuBound 8; but only 3 GiB → ramBound floor(3/1.5)=2. RAM is scarcer.
		expect(recommendCaps(snap(16, 3)).maxAgents).toBe(2);
		// 4 cores → cpuBound 2; 64 GiB → ramBound 42. CPU is scarcer.
		expect(recommendCaps(snap(4, 64)).maxAgents).toBe(2);
	});

	it('clamps to MIN_AGENTS on a tiny box (1 core / 1 GiB still gets 1 agent)', () => {
		const caps = recommendCaps(snap(1, 1));
		expect(caps.maxAgents).toBe(RESOURCE_TUNING.MIN_AGENTS);
		expect(caps.maxAgents).toBeGreaterThanOrEqual(1);
	});

	it('clamps to MAX_AGENTS on a huge box (never over-spawns past the coordination ceiling)', () => {
		const caps = recommendCaps(snap(128, 512));
		expect(caps.maxAgents).toBe(RESOURCE_TUNING.MAX_AGENTS);
	});

	it('perProject is a fraction of maxAgents, floored at MIN_PER_PROJECT', () => {
		const caps = recommendCaps(snap(16, 64)); // maxAgents clamps to 8
		expect(caps.maxAgents).toBe(8);
		expect(caps.perProject).toBe(Math.floor(8 * RESOURCE_TUNING.PER_PROJECT_FRACTION)); // 4
		// A 1-agent box still allows ≥1 spawn per project.
		expect(recommendCaps(snap(1, 1)).perProject).toBeGreaterThanOrEqual(RESOURCE_TUNING.MIN_PER_PROJECT);
	});

	it('survives a degenerate snapshot (0 cores / 0 RAM) without going below the floor', () => {
		const caps = recommendCaps(snap(0, 0));
		expect(caps.maxAgents).toBe(RESOURCE_TUNING.MIN_AGENTS);
		expect(caps.perProject).toBe(RESOURCE_TUNING.MIN_PER_PROJECT);
		expect(Number.isInteger(caps.maxAgents)).toBe(true);
		expect(Number.isInteger(caps.perProject)).toBe(true);
	});

	it('is pure — same snapshot yields identical caps', () => {
		const s = snap(8, 16);
		expect(recommendCaps(s)).toEqual(recommendCaps(s));
	});
});

describe('classifyTier — coarse host bucket', () => {
	it('flags a small box constrained, a workstation ample, the rest standard', () => {
		expect(classifyTier(snap(2, 4))).toBe('constrained');
		expect(classifyTier(snap(1, 32))).toBe('constrained'); // few cores
		expect(classifyTier(snap(8, 2))).toBe('constrained'); // low RAM
		expect(classifyTier(snap(16, 32))).toBe('ample');
		expect(classifyTier(snap(4, 8))).toBe('standard');
	});
});

describe('detectHostSnapshot — the one impure read', () => {
	it('reports a sane live host (≥1 core, >0 RAM)', () => {
		const s = detectHostSnapshot();
		expect(s.cpuCount).toBeGreaterThanOrEqual(1);
		expect(s.totalMemBytes).toBeGreaterThan(0);
		expect(Number.isInteger(s.cpuCount)).toBe(true);
	});

	it('detectResourceProfile defaults to the live host and yields valid caps', () => {
		const p = detectResourceProfile();
		expect(p.caps.maxAgents).toBeGreaterThanOrEqual(1);
		expect(p.caps.maxAgents).toBeLessThanOrEqual(RESOURCE_TUNING.MAX_AGENTS);
		expect(p.caps.perProject).toBeGreaterThanOrEqual(1);
		expect(['constrained', 'standard', 'ample']).toContain(p.tier);
	});
});

describe('resolveBootCaps — operator config ALWAYS wins (ARCHITECTURE §6 boundary)', () => {
	const profile = detectResourceProfile(snap(16, 64)); // auto → { maxAgents: 8, perProject: 4 }

	it('uses the auto-detected default when the operator pins nothing', () => {
		const { caps, sources } = resolveBootCaps(undefined, profile);
		expect(caps).toEqual({ maxAgents: 8, perProject: 4 });
		expect(sources).toEqual({ maxAgents: 'auto', perProject: 'auto' });
	});

	it('lets an explicit operator cap override the auto default', () => {
		const { caps, sources } = resolveBootCaps({ maxAgents: 3, perProject: 2 }, profile);
		expect(caps).toEqual({ maxAgents: 3, perProject: 2 });
		expect(sources).toEqual({ maxAgents: 'config', perProject: 'config' });
	});

	it('fills only the unset field (partial operator config)', () => {
		const { caps, sources } = resolveBootCaps({ maxAgents: 2 }, profile);
		expect(caps).toEqual({ maxAgents: 2, perProject: 4 }); // perProject falls back to auto
		expect(sources).toEqual({ maxAgents: 'config', perProject: 'auto' });
	});

	it('ignores an invalid operator cap (0 / non-int) and falls back to auto', () => {
		const { caps, sources } = resolveBootCaps({ maxAgents: 0, perProject: 1.5 }, profile);
		expect(caps).toEqual({ maxAgents: 8, perProject: 4 });
		expect(sources).toEqual({ maxAgents: 'auto', perProject: 'auto' });
	});
});
