// Unit tests for the ACTIVITY-panel pure core (project-activity-core.ts). Pure functions, no
// Svelte runtime — the four shadow paths (nil / empty / unknown / error-shaped) plus the happy
// path for every public function (the transcript-core / project-status-core test discipline).

import { describe, it, expect } from 'vitest';
import {
	statusTone,
	activityLabel,
	buildActivity,
	type ActivitySessionLike
} from './project-activity-core';

describe('statusTone', () => {
	it('maps the known statuses to their tones', () => {
		expect(statusTone('running')).toBe('running');
		expect(statusTone('done')).toBe('done');
		expect(statusTone('shipped')).toBe('done');
		expect(statusTone('failed')).toBe('failed');
		expect(statusTone('blocked')).toBe('blocked');
		expect(statusTone('cancelled')).toBe('blocked');
	});
	it('SHADOW: nil / unknown status → neutral (never dropped)', () => {
		expect(statusTone(null)).toBe('neutral');
		expect(statusTone(undefined)).toBe('neutral');
		expect(statusTone('weird-new-status')).toBe('neutral');
	});
});

describe('activityLabel', () => {
	it('labels a PM session by its kind (lifecycle / validation panel / discussion / release)', () => {
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'task', roleSlug: 'pm' })).toBe(
			'PM lifecycle'
		);
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'chat', roleSlug: 'pm' })).toBe(
			'PM lifecycle'
		);
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'review', roleSlug: 'pm' })).toBe(
			'PM validation panel'
		);
		expect(
			activityLabel({ id: 's:1', status: 'running', kind: 'discussion', roleSlug: 'pm' })
		).toBe('PM discussion');
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'release', roleSlug: 'pm' })).toBe(
			'PM release'
		);
		// A pm-prefixed slug still reads as PM.
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'task', roleSlug: 'pm-foo' })).toBe(
			'PM lifecycle'
		);
	});

	it('labels an HR/recruiter session', () => {
		expect(
			activityLabel({ id: 's:1', status: 'running', kind: 'interview', roleSlug: 'hr-recruiter' })
		).toBe('HR interview');
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'task', roleSlug: 'recruiter' })).toBe(
			'HR recruiter'
		);
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'review', roleSlug: 'hr' })).toBe(
			'HR review'
		);
	});

	it('labels a roleless dev task / validation by kind', () => {
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'task' })).toBe('dev task');
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'review' })).toBe('validation panel');
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'chat' })).toBe('chat');
	});

	it('shows an unrecognised role verbatim joined to the kind (never coerced)', () => {
		expect(
			activityLabel({
				id: 's:1',
				status: 'running',
				kind: 'task',
				roleSlug: 'data-scientist',
				roleName: 'Data Scientist'
			})
		).toBe('Data Scientist · dev task');
	});

	it('SHADOW: nil row / empty kind / unknown kind', () => {
		expect(activityLabel(null)).toBe('session');
		expect(activityLabel(undefined)).toBe('session');
		expect(activityLabel({ id: 's:1', status: 'running' })).toBe('session');
		expect(activityLabel({ id: 's:1', status: 'running', kind: '' })).toBe('session');
		// Unmodelled kind shown verbatim, not hidden.
		expect(activityLabel({ id: 's:1', status: 'running', kind: 'audit' })).toBe('audit');
	});
});

describe('buildActivity', () => {
	const mk = (over: Partial<ActivitySessionLike>): ActivitySessionLike => ({
		id: 's:1',
		status: 'done',
		...over
	});

	it('SHADOW: nil / empty list → honest idle model', () => {
		for (const input of [null, undefined, []] as const) {
			const m = buildActivity(input);
			expect(m.entries).toEqual([]);
			expect(m.runningCount).toBe(0);
			expect(m.idle).toBe(true);
			expect(m.nothingRunning).toBe(false);
		}
	});

	it('floats running sessions to the top, then most-recent-started', () => {
		const m = buildActivity([
			mk({ id: 's:old-done', status: 'done', startedAt: '2026-06-01T00:00:00Z' }),
			mk({ id: 's:running', status: 'running', startedAt: '2026-06-02T00:00:00Z' }),
			mk({ id: 's:new-done', status: 'done', startedAt: '2026-06-03T00:00:00Z' })
		]);
		expect(m.entries.map((e) => e.id)).toEqual(['s:running', 's:new-done', 's:old-done']);
		expect(m.runningCount).toBe(1);
		expect(m.idle).toBe(false);
		expect(m.nothingRunning).toBe(false);
	});

	it('nothingRunning is true when only finished sessions exist (history, not idle)', () => {
		const m = buildActivity([mk({ id: 's:a', status: 'done' }), mk({ id: 's:b', status: 'failed' })]);
		expect(m.idle).toBe(false);
		expect(m.nothingRunning).toBe(true);
		expect(m.runningCount).toBe(0);
	});

	it('keeps ALL running rows but bounds the finished tail (a storm cannot hide running ones)', () => {
		const sessions: ActivitySessionLike[] = [];
		for (let i = 0; i < 30; i++) {
			sessions.push(mk({ id: `s:done${i}`, status: 'done', startedAt: `2026-06-01T00:00:${String(i).padStart(2, '0')}Z` }));
		}
		sessions.push(mk({ id: 's:run1', status: 'running', startedAt: '2026-05-01T00:00:00Z' }));
		sessions.push(mk({ id: 's:run2', status: 'running', startedAt: '2026-05-01T00:00:01Z' }));
		const m = buildActivity(sessions, 5);
		// Both running survive even though their startedAt is older than the finished storm.
		expect(m.entries.filter((e) => e.running).map((e) => e.id).sort()).toEqual(['s:run1', 's:run2']);
		// Finished tail bounded to 5.
		expect(m.entries.filter((e) => !e.running).length).toBe(5);
		expect(m.runningCount).toBe(2);
	});

	it('carries the honest MC-4 failure note through and tones a failed row', () => {
		const m = buildActivity([mk({ id: 's:f', status: 'failed', note: 'spawn failed: cc_session_id=null' })]);
		expect(m.entries[0].tone).toBe('failed');
		expect(m.entries[0].note).toBe('spawn failed: cc_session_id=null');
	});

	it('SHADOW: an unknown-status row is listed (neutral tone), never dropped', () => {
		const m = buildActivity([mk({ id: 's:x', status: 'mystery' })]);
		expect(m.entries).toHaveLength(1);
		expect(m.entries[0].tone).toBe('neutral');
		expect(m.entries[0].status).toBe('mystery');
	});
});
