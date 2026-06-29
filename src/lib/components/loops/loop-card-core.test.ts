import { describe, it, expect } from 'vitest';
import type { LoopView } from '$lib/server/loops/read';
import {
	kindMeta,
	phaseMeta,
	relativeTime,
	nextFireLabel,
	lastRunLabel,
	tracksRunHistory,
	ticksLabel,
	groupLoops,
	orchConfigView
} from './loop-card-core';

/** A minimal LoopView factory — only the fields a given test reads need to be realistic. */
function view(over: Partial<LoopView> = {}): LoopView {
	return {
		id: 'orch:drain',
		name: 'Orchestrator drain',
		kind: 'orchestrator',
		scope: 'global',
		tone: 'running',
		stateLabel: 'armed · event',
		phase: 'unknown',
		cadenceLabel: 'event-driven',
		lastRunAt: null,
		nextFireAt: null,
		recentRuns: [],
		...over
	};
}

describe('kindMeta', () => {
	it('maps every loop kind to a stable icon key + role word', () => {
		for (const kind of ['orchestrator', 'pm-autonomous', 'pm-cadence', 'memory-review'] as const) {
			const m = kindMeta(kind);
			expect(m.icon).toBe(kind);
			expect(m.srLabel.length).toBeGreaterThan(0);
		}
	});

	it('falls back neutrally for an unmodelled kind (never throws)', () => {
		// @ts-expect-error — deliberately exercise the defensive fallback path
		expect(kindMeta('nonsense').icon).toBe('orchestrator');
	});
});

describe('phaseMeta', () => {
	it('gives each ladder rung a distinct face + descriptive title', () => {
		expect(phaseMeta('L1').text).toBe('L1');
		expect(phaseMeta('L2').text).toBe('L2');
		expect(phaseMeta('L3').text).toBe('L3');
		expect(phaseMeta('L1').title).toMatch(/report-only/);
		expect(phaseMeta('L3').title).toMatch(/autonomous/);
	});

	it("renders 'unknown' as an honest dash, not a fabricated rung", () => {
		expect(phaseMeta('unknown').text).toBe('—');
	});
});

describe('relativeTime — shadow paths', () => {
	const now = Date.UTC(2026, 5, 29, 12, 0, 0);
	it('null / undefined / empty ⇒ honest dash', () => {
		expect(relativeTime(null, now)).toBe('—');
		expect(relativeTime(undefined, now)).toBe('—');
		expect(relativeTime('', now)).toBe('—');
	});
	it('un-parseable ISO ⇒ dash (never NaN leaks)', () => {
		expect(relativeTime('not-a-date', now)).toBe('—');
	});
	it('formats seconds / minutes / hours / days ago', () => {
		expect(relativeTime(new Date(now - 5_000).toISOString(), now)).toBe('5s ago');
		expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago');
		expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h ago');
		expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2d ago');
	});
	it('clamps a future timestamp to a non-negative value (no "-3s ago")', () => {
		expect(relativeTime(new Date(now + 10_000).toISOString(), now)).toBe('0s ago');
	});
});

describe('nextFireLabel — forward-looking, never collapses a future fire to "0s"', () => {
	const now = Date.UTC(2026, 5, 29, 12, 0, 0);
	it('null / undefined / empty / un-parseable ⇒ honest dash', () => {
		expect(nextFireLabel(null, now)).toBe('—');
		expect(nextFireLabel(undefined, now)).toBe('—');
		expect(nextFireLabel('', now)).toBe('—');
		expect(nextFireLabel('not-a-date', now)).toBe('—');
	});
	it('REGRESSION (gap 1): a future fire renders "in Xm", NOT "0s from now"', () => {
		// A */10 cron up to ~10m out — the exact case the old relativeTime path collapsed to 0.
		expect(nextFireLabel(new Date(now + 7 * 60_000).toISOString(), now)).toBe('in 7m');
		expect(nextFireLabel(new Date(now + 30_000).toISOString(), now)).toBe('in 30s');
		expect(nextFireLabel(new Date(now + 3 * 3_600_000).toISOString(), now)).toBe('in 3h');
		expect(nextFireLabel(new Date(now + 2 * 86_400_000).toISOString(), now)).toBe('in 2d');
	});
	it('a non-future fire (≤ now / overdue) ⇒ "due now", never a negative value', () => {
		expect(nextFireLabel(new Date(now).toISOString(), now)).toBe('due now');
		expect(nextFireLabel(new Date(now - 5_000).toISOString(), now)).toBe('due now');
	});
});

describe('lastRunLabel — honest absent semantics', () => {
	const now = Date.UTC(2026, 5, 29, 12, 0, 0);
	it('a run-driven loop with no history ⇒ "not yet run"', () => {
		expect(lastRunLabel(view({ id: 'orch:drain', lastRunAt: null }), now)).toBe('not yet run');
		expect(lastRunLabel(view({ id: 'pm-auto:project:x', lastRunAt: null }), now)).toBe(
			'not yet run'
		);
	});
	it('the by-design no-history loops ⇒ "—" (NOT "not yet run")', () => {
		expect(lastRunLabel(view({ id: 'orch:gc', lastRunAt: null }), now)).toBe('—');
		expect(lastRunLabel(view({ id: 'mem-review', lastRunAt: null }), now)).toBe('—');
	});
	it('a present timestamp ⇒ relative time regardless of loop', () => {
		expect(
			lastRunLabel(view({ id: 'orch:gc', lastRunAt: new Date(now - 60_000).toISOString() }), now)
		).toBe('1m ago');
	});
});

describe('tracksRunHistory', () => {
	it('is false only for the by-design no-history loops', () => {
		expect(tracksRunHistory(view({ id: 'orch:gc' }))).toBe(false);
		expect(tracksRunHistory(view({ id: 'mem-review' }))).toBe(false);
		expect(tracksRunHistory(view({ id: 'orch:drain' }))).toBe(true);
		expect(tracksRunHistory(view({ id: 'pm-cadence:pm:1' }))).toBe(true);
	});
});

describe('ticksLabel', () => {
	it('null when no tick window exists', () => {
		expect(ticksLabel(view({ ticksUsed: null, ticksMax: null }))).toBeNull();
	});
	it('renders used/max, treating absent used as 0 (never NaN)', () => {
		expect(ticksLabel(view({ ticksUsed: 3, ticksMax: 24 }))).toBe('3 / 24');
		expect(ticksLabel(view({ ticksUsed: null, ticksMax: 24 }))).toBe('0 / 24');
	});
});

describe('groupLoops', () => {
	it('nil / empty ⇒ [] (page renders its honest empty state)', () => {
		expect(groupLoops(null)).toEqual([]);
		expect(groupLoops([])).toEqual([]);
	});

	it('puts System loops first, then one block per project in first-seen order', () => {
		const loops = [
			view({ id: 'orch:drain', scope: 'global' }),
			view({ id: 'pm-auto:project:b', scope: 'project', projectId: 'project:b' }),
			view({ id: 'orch:gc', scope: 'global' }),
			view({ id: 'pm-cadence:pm:a', scope: 'project', projectId: 'project:a' }),
			view({ id: 'pm-auto:project:a', scope: 'project', projectId: 'project:a' })
		];
		const groups = groupLoops(loops, { 'project:a': 'Alpha', 'project:b': 'Bravo' });
		expect(groups.map((g) => g.key)).toEqual(['system', 'project:b', 'project:a']);
		expect(groups[0].title).toBe('System loops');
		expect(groups[0].loops).toHaveLength(2);
		expect(groups[1].title).toBe('Bravo');
		expect(groups[2].title).toBe('Alpha');
		expect(groups[2].loops).toHaveLength(2);
	});

	it('falls back to the de-prefixed id when no project name is known (never a fabricated name)', () => {
		const groups = groupLoops([
			view({ id: 'pm-auto:project:rounds', scope: 'project', projectId: 'project:rounds' })
		]);
		expect(groups[0].title).toBe('rounds');
	});

	it('buckets a project-scoped loop missing its projectId rather than dropping it', () => {
		const groups = groupLoops([view({ id: 'weird', scope: 'project', projectId: undefined })]);
		expect(groups).toHaveLength(1);
		expect(groups[0].title).toBe('Unknown project');
		expect(groups[0].loops).toHaveLength(1);
	});
});

describe('orchConfigView (LP-2 drain config/sync block)', () => {
	it('returns null for a loop with no orchestrator mode-config (gc card / other kinds)', () => {
		// GC card: orchestrator kind but no configuredMode field set.
		expect(orchConfigView(view({ id: 'orch:gc' }))).toBeNull();
		// A non-orchestrator loop never carries config.
		expect(orchConfigView(view({ kind: 'pm-cadence' }))).toBeNull();
	});

	it('shows a warning "restart needed" status when running differs from configured', () => {
		const o = orchConfigView(
			view({ configuredMode: 'periodic', runningMode: 'event', restartNeeded: true, intervalMs: 60_000 })
		)!;
		expect(o.configured).toBe('periodic');
		expect(o.running).toBe('event');
		expect(o.interval).toBe('60s sweep');
		expect(o.restartNeeded).toBe(true);
		expect(o.status).toEqual({ text: 'restart needed', tone: 'warning' });
	});

	it('shows a done "in sync" status when running equals configured', () => {
		const o = orchConfigView(
			view({ configuredMode: 'event', runningMode: 'event', restartNeeded: false, intervalMs: 60_000 })
		)!;
		expect(o.restartNeeded).toBe(false);
		expect(o.status).toEqual({ text: 'in sync', tone: 'done' });
	});

	it('shows an idle "not running" status and "—"/"not running" labels when nothing is live', () => {
		const o = orchConfigView(
			view({ configuredMode: 'event', runningMode: null, restartNeeded: false, intervalMs: 60_000 })
		)!;
		expect(o.running).toBe('not running');
		expect(o.status).toEqual({ text: 'not running', tone: 'idle' });
	});

	it('renders configured "—" honestly when the config is unreadable, and drops the interval row when null', () => {
		const o = orchConfigView(
			view({ configuredMode: null, runningMode: 'event', restartNeeded: false, intervalMs: null })
		)!;
		expect(o.configured).toBe('—');
		expect(o.interval).toBeNull();
		// Running is live but config is unreadable → we do NOT falsely claim "in sync" (F-008 honesty).
		expect(o.status).toEqual({ text: 'config unreadable', tone: 'warning' });
	});
});
