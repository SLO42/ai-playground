// CC-STATUS — unit tests for the project status dashboard's pure derivations. The four shadow paths
// per function (happy / nil / empty / unknown-input) are exercised explicitly (F-008 honesty).

import { describe, it, expect } from 'vitest';
import {
	buildPipeline,
	loopBadge,
	summarizeSessions,
	PIPELINE_FUNNEL,
	type LoopStateLike
} from './project-status-core';

describe('buildPipeline', () => {
	it('counts each funnel status and computes integer bar shares of the funnel total', () => {
		const p = buildPipeline([
			{ status: 'proposed' },
			{ status: 'ready' },
			{ status: 'ready' },
			{ status: 'in_progress' },
			{ status: 'done' }
		]);
		expect(p.empty).toBe(false);
		expect(p.total).toBe(5);
		expect(p.funnelTotal).toBe(5);
		const ready = p.segments.find((s) => s.status === 'ready');
		expect(ready?.count).toBe(2);
		expect(ready?.pct).toBe(40); // 2/5
		// Percentages never exceed 100 and are integers.
		for (const s of p.segments) {
			expect(Number.isInteger(s.pct)).toBe(true);
			expect(s.pct).toBeGreaterThanOrEqual(0);
			expect(s.pct).toBeLessThanOrEqual(100);
		}
	});

	it('SHADOW nil → honest empty pipeline (no divide-by-zero, every segment 0)', () => {
		for (const input of [null, undefined, []] as const) {
			const p = buildPipeline(input);
			expect(p.empty).toBe(true);
			expect(p.total).toBe(0);
			expect(p.funnelTotal).toBe(0);
			expect(p.segments).toHaveLength(PIPELINE_FUNNEL.length);
			expect(p.segments.every((s) => s.count === 0 && s.pct === 0)).toBe(true);
			expect(p.exceptions.every((e) => e.count === 0)).toBe(true);
		}
	});

	it('SHADOW unknown status → counted in total, never folded into a funnel segment', () => {
		const p = buildPipeline([{ status: 'something_unmodelled' }, { status: 'done' }]);
		expect(p.total).toBe(2);
		expect(p.funnelTotal).toBe(1); // only the `done` row is in the funnel
		expect(p.segments.find((s) => s.status === 'done')?.count).toBe(1);
	});

	it('surfaces blocked/failed as exceptions OUTSIDE the forward funnel', () => {
		const p = buildPipeline([{ status: 'blocked' }, { status: 'failed' }, { status: 'failed' }]);
		expect(p.funnelTotal).toBe(0); // none are forward-funnel statuses
		expect(p.exceptions.find((e) => e.status === 'blocked')?.count).toBe(1);
		expect(p.exceptions.find((e) => e.status === 'failed')?.count).toBe(2);
	});
});

describe('loopBadge', () => {
	const mk = (state: string, reason = 'r', ticksUsed = 3): LoopStateLike => ({
		state,
		reason,
		ticksUsed
	});

	it('SHADOW nil → "not engaged" with tone none, never a fabricated running', () => {
		for (const input of [null, undefined] as const) {
			const b = loopBadge(input);
			expect(b.tone).toBe('none');
			expect(b.notEngaged).toBe(true);
			expect(b.label).toBe('not engaged');
			expect(b.reason).toBeNull();
			expect(b.ticksUsed).toBeNull();
		}
	});

	it('maps each known state to its honest tone + label', () => {
		expect(loopBadge(mk('running')).tone).toBe('running');
		expect(loopBadge(mk('blocked')).tone).toBe('blocked');
		expect(loopBadge(mk('cap-reached')).tone).toBe('warning');
		expect(loopBadge(mk('awaiting-release-confirm')).tone).toBe('warning');
		expect(loopBadge(mk('dod-reached')).tone).toBe('done');
		expect(loopBadge(mk('published')).label).toBe('v1 shipped');
		expect(loopBadge(mk('idle')).tone).toBe('idle');
		expect(loopBadge(mk('running')).ticksUsed).toBe(3);
	});

	it('SHADOW unknown state → surfaced (not hidden) with the raw state as the label', () => {
		const b = loopBadge(mk('quantum-superposition'));
		expect(b.tone).toBe('idle');
		expect(b.label).toBe('quantum-superposition');
		expect(b.notEngaged).toBe(false);
	});

	it('honest absent reason → null, never str(undefined)', () => {
		expect(loopBadge(mk('running', '')).reason).toBeNull();
	});
});

describe('summarizeSessions', () => {
	it('counts running + failed and carries the MC-4 honest failure notes', () => {
		const s = summarizeSessions([
			{ status: 'running' },
			{ status: 'running' },
			{ status: 'failed', note: 'child spawn died: cc_session_id=null' },
			{ status: 'done' }
		]);
		expect(s.running).toBe(2);
		expect(s.failed).toBe(1);
		expect(s.failures[0].note).toBe('child spawn died: cc_session_id=null');
	});

	it('SHADOW nil/empty → all-zero honest empty', () => {
		for (const input of [null, undefined, []] as const) {
			const s = summarizeSessions(input);
			expect(s.running).toBe(0);
			expect(s.failed).toBe(0);
			expect(s.failures).toHaveLength(0);
		}
	});

	it('failed session with no note → null (never fabricated)', () => {
		const s = summarizeSessions([{ status: 'failed', note: null }]);
		expect(s.failed).toBe(1);
		expect(s.failures[0].note).toBeNull();
	});

	it('caps the failures list at maxFailures while still counting all failures', () => {
		const many = Array.from({ length: 9 }, () => ({ status: 'failed', note: 'x' }));
		const s = summarizeSessions(many, 5);
		expect(s.failed).toBe(9);
		expect(s.failures).toHaveLength(5);
	});
});
