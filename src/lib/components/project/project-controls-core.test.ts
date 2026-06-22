import { describe, it, expect } from 'vitest';
import {
	readyTaskCount,
	restartableSessions,
	sessionLabel,
	continueState,
	continueSummary,
	restartState,
	restartSummary,
	RESTARTABLE_SESSION_STATUSES
} from './project-controls-core';

// CC-CONTROLS — pure presentation logic for the controls card. SHADOW PATHS everywhere: nil/empty
// inputs, unknown statuses, and error/noop/ok result mapping (never a fake success).

describe('readyTaskCount', () => {
	it('counts ONLY ready tasks; nil/empty → 0 (SHADOW: nil, empty)', () => {
		expect(readyTaskCount(null)).toBe(0);
		expect(readyTaskCount([])).toBe(0);
		expect(
			readyTaskCount([
				{ status: 'ready' },
				{ status: 'ready' },
				{ status: 'backlog' },
				{ status: 'in_progress' }
			])
		).toBe(2);
	});
});

describe('restartableSessions', () => {
	it('returns only failed/stuck sessions that HAVE a task; filters done/running + task-less', () => {
		const rows = restartableSessions([
			{ id: 'session:1', status: 'failed', taskId: 'task:1', note: 'boom' },
			{ id: 'session:2', status: 'done', taskId: 'task:2' }, // clean done → not restartable
			{ id: 'session:3', status: 'running', taskId: 'task:3' }, // live → not restartable
			{ id: 'session:4', status: 'failed', taskId: null }, // no task → filtered
			{ id: 'session:5', status: 'stale', taskId: 'task:5' }
		]);
		expect(rows.map((r) => r.sessionId)).toEqual(['session:1', 'session:5']);
		expect(rows[0].note).toBe('boom');
		expect(rows[1].note).toBeNull(); // honest null, never str(undefined)
	});

	it('nil/empty → [] (SHADOW); caps the list at max', () => {
		expect(restartableSessions(null)).toEqual([]);
		expect(restartableSessions([])).toEqual([]);
		const many = Array.from({ length: 20 }, (_, i) => ({
			id: `session:${i}`,
			status: 'failed',
			taskId: `task:${i}`
		}));
		expect(restartableSessions(many, 8)).toHaveLength(8);
	});

	it('RESTARTABLE_SESSION_STATUSES mirrors the server module’s allow-list', () => {
		// The UI filter MUST match the server guard so the UI never offers an impossible restart.
		expect([...RESTARTABLE_SESSION_STATUSES]).toEqual(['failed', 'stale', 'unknown']);
	});
});

describe('sessionLabel', () => {
	it('combines role + kind; falls back honestly when unknown (never fabricated)', () => {
		expect(sessionLabel({ id: 's', status: 'failed', roleName: 'PM', kind: 'lifecycle' })).toBe(
			'PM — lifecycle'
		);
		expect(sessionLabel({ id: 's', status: 'failed', roleSlug: 'hr-recruiter' })).toBe('hr-recruiter');
		expect(sessionLabel({ id: 's', status: 'failed', kind: 'task' })).toBe('task');
		expect(sessionLabel({ id: 's', status: 'failed' })).toBe('agent run');
	});
});

describe('continueState / continueSummary', () => {
	it('busy wins; nil → idle; error → error', () => {
		expect(continueState(undefined, true)).toBe('busy');
		expect(continueState({ readyCount: 3 }, true)).toBe('busy');
		expect(continueState(undefined, false)).toBe('idle');
		expect(continueState({ error: 'no orchestrator' }, false)).toBe('error');
	});

	it('found+drove → ok; found nothing + did nothing → noop (never a fake ok)', () => {
		expect(continueState({ readyCount: 2, enqueued: 2, spawned: 2 }, false)).toBe('ok');
		expect(continueState({ readyCount: 0, enqueued: 0, claimed: 0, spawned: 0 }, false)).toBe('noop');
		// drove pre-queued work even though nothing newly ready → ok (it did something real).
		expect(continueState({ readyCount: 0, enqueued: 0, spawned: 1 }, false)).toBe('ok');
	});

	it('summary is honest real counts; noop says nothing-ready; error passes the reason through', () => {
		expect(continueSummary({ error: 'boom' })).toBe('boom');
		expect(continueSummary({ readyCount: 0, enqueued: 0, spawned: 0 })).toContain('Nothing ready');
		const s = continueSummary({ readyCount: 2, enqueued: 1, alreadyQueued: 1, spawned: 1 });
		expect(s).toContain('2 ready tasks');
		expect(s).toContain('1 enqueued');
		expect(s).toContain('1 already queued');
		expect(s).toContain('1 session started');
	});
});

describe('restartState / restartSummary', () => {
	it('busy wins; nil → idle; error → error', () => {
		expect(restartState(undefined, true)).toBe('busy');
		expect(restartState(undefined, false)).toBe('idle');
		expect(restartState({ error: 'cross-project' }, false)).toBe('error');
	});

	it('enqueued/spawned → ok; dedup no-op (not enqueued, 0 spawned) → noop', () => {
		expect(restartState({ enqueued: true, spawned: 1 }, false)).toBe('ok');
		expect(restartState({ enqueued: true, spawned: 0 }, false)).toBe('ok'); // enqueued, slot busy
		expect(restartState({ enqueued: false, spawned: 0 }, false)).toBe('noop'); // already in flight
	});

	it('summary: noop explains the double-run guard; ok reports the spawn', () => {
		expect(restartSummary({ enqueued: false, spawned: 0 })).toContain('Already re-running');
		expect(restartSummary({ enqueued: true, spawned: 1 })).toContain('1 session');
		expect(restartSummary({ enqueued: true, spawned: 0 })).toContain('enqueued');
		expect(restartSummary({ error: 'boom' })).toBe('boom');
	});
});
