/**
 * FLEET VIEW — unit contract for the /claude-code session-fleet filter + collapse view model.
 *
 * Operator ask (2026-07-26): the fleet section must be filterable by PROJECT and by FAILURE, and
 * COLLAPSIBLE, so a long fleet cannot make the page unbounded-tall.
 *
 * These are pure-function tests (no DB, no browser). The companion `fleet-filter.live.test.ts`
 * proves the same predicates against the REAL `listFleetAcrossProjects` projection off a live
 * SurrealDB — a stub can agree with itself, so the honest failure/project notions are pinned to
 * real rows there.
 *
 * Every exported function is exercised on all FOUR paths: happy, nil, empty, upstream-error.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_FLEET_VIEW,
	FLEET_NO_PROJECT,
	FLEET_PARAM_OPEN,
	FLEET_PARAM_PROJECT,
	FLEET_PARAM_STATE,
	FLEET_STATE_FILTERS,
	FLEET_STATE_HINTS,
	FLEET_STATE_LABELS,
	applyFleetViewToParams,
	filterFleet,
	fleetNeedsAttention,
	fleetProjectKey,
	fleetProjectLabel,
	fleetProjectOptions,
	fleetCountScopeNote,
	fleetScopeLabel,
	fleetStateCounts,
	fleetStateHint,
	isDefaultFleetView,
	isFleetFailure,
	isFleetFiltered,
	isFleetRunning,
	isFleetStateChipDisabled,
	isFleetStateFilter,
	matchesFleetState,
	parseFleetView,
	reseedFleetView,
	resolveFleetView,
	type FleetFilterRow,
	type FleetView
} from './fleet-view';

/** A fleet row shaped exactly like `FleetSessionXP`'s filterable subset. */
function row(over: Partial<FleetFilterRow> = {}): FleetFilterRow {
	return { status: 'done', projectId: null, projectName: null, note: null, ...over };
}

/** The live-shaped fixture window: 2 projects + a bare chat, across every status. */
const WINDOW: FleetFilterRow[] = [
	row({ status: 'running', projectId: 'project:atelier', projectName: 'Atelier' }),
	row({ status: 'failed', projectId: 'project:atelier', projectName: 'Atelier', note: 'spawn failed: no token' }),
	row({ status: 'done', projectId: 'project:atelier', projectName: 'Atelier' }),
	row({ status: 'done', projectId: 'project:rounds', projectName: 'ROUNDS', note: 'work preserved on branch x' }),
	row({ status: 'cancelled', projectId: 'project:rounds', projectName: 'ROUNDS' }),
	row({ status: 'running', projectId: null, projectName: null })
];

describe('parseFleetView — the URL is the persistence (shareable, survives reload)', () => {
	it('happy: reads project + state + collapse out of the params', () => {
		const v = parseFleetView(
			new URLSearchParams(`${FLEET_PARAM_PROJECT}=project:atelier&${FLEET_PARAM_STATE}=failed&${FLEET_PARAM_OPEN}=closed`)
		);
		expect(v).toEqual({ project: 'project:atelier', state: 'failed', open: false });
	});

	it('nil: null/undefined params → the default view (expanded, unfiltered)', () => {
		expect(parseFleetView(null)).toEqual(DEFAULT_FLEET_VIEW);
		expect(parseFleetView(undefined)).toEqual(DEFAULT_FLEET_VIEW);
		// upstream error: something URLSearchParams-shaped but not one.
		expect(parseFleetView({} as unknown as URLSearchParams)).toEqual(DEFAULT_FLEET_VIEW);
	});

	it('empty: blank / whitespace-only values are treated as absent, not as a filter', () => {
		const v = parseFleetView(new URLSearchParams(`${FLEET_PARAM_PROJECT}=%20%20&${FLEET_PARAM_STATE}=`));
		expect(v.project).toBeNull();
		expect(v.state).toBe('all');
		expect(v.open).toBe(true);
	});

	it('upstream error: an unknown state token degrades to `all` — it never throws or hides rows', () => {
		expect(parseFleetView(new URLSearchParams(`${FLEET_PARAM_STATE}=DROP+TABLE`)).state).toBe('all');
		expect(parseFleetView(new URLSearchParams(`${FLEET_PARAM_STATE}=Failed`)).state).toBe('all');
	});

	it('only the literal `closed` collapses — a malformed collapse param never hides the fleet', () => {
		expect(parseFleetView(new URLSearchParams(`${FLEET_PARAM_OPEN}=nonsense`)).open).toBe(true);
		expect(parseFleetView(new URLSearchParams(`${FLEET_PARAM_OPEN}=CLOSED`)).open).toBe(false);
		expect(parseFleetView(new URLSearchParams(`${FLEET_PARAM_OPEN}=open`)).open).toBe(true);
	});
});

describe('applyFleetViewToParams — round-trips, drops defaults, preserves foreign params', () => {
	it('happy: a non-default view round-trips through parse unchanged', () => {
		const view: FleetView = { project: FLEET_NO_PROJECT, state: 'attention', open: false };
		expect(parseFleetView(applyFleetViewToParams(new URLSearchParams(), view))).toEqual(view);
	});

	it('the default view leaves NO fleet params behind (a pristine view keeps the URL clean)', () => {
		const p = applyFleetViewToParams(
			new URLSearchParams(`${FLEET_PARAM_STATE}=failed&${FLEET_PARAM_OPEN}=closed&${FLEET_PARAM_PROJECT}=project:x`),
			DEFAULT_FLEET_VIEW
		);
		expect(p.toString()).toBe('');
	});

	it("preserves the page's OWN ?session= param (the transcript panel must survive a filter click)", () => {
		const p = applyFleetViewToParams(new URLSearchParams('session=session:abc'), {
			project: null,
			state: 'failed',
			open: true
		});
		expect(p.get('session')).toBe('session:abc');
		expect(p.get(FLEET_PARAM_STATE)).toBe('failed');
	});

	it('nil current params → a fresh set carrying only the non-default fields', () => {
		const p = applyFleetViewToParams(null, { project: 'project:atelier', state: 'all', open: true });
		expect(p.get(FLEET_PARAM_PROJECT)).toBe('project:atelier');
		expect(p.get(FLEET_PARAM_STATE)).toBeNull();
	});
});

describe('isDefaultFleetView / isFleetFiltered', () => {
	it('collapse alone is NOT a filter (the row set is unchanged, only hidden)', () => {
		const collapsed: FleetView = { project: null, state: 'all', open: false };
		expect(isFleetFiltered(collapsed)).toBe(false);
		expect(isDefaultFleetView(collapsed)).toBe(false);
	});
	it('nil view is treated as the default', () => {
		expect(isDefaultFleetView(null)).toBe(true);
		expect(isFleetFiltered(undefined)).toBe(false);
	});
});

describe('the failure predicate is DERIVED from the real session shape, not invented', () => {
	it("hard failure is exactly status==='failed' (schema.ts:130-131 ASSERT set)", () => {
		expect(isFleetFailure(row({ status: 'failed' }))).toBe(true);
		expect(isFleetFailure(row({ status: 'done' }))).toBe(false);
		expect(isFleetFailure(row({ status: 'cancelled' }))).toBe(false);
		expect(isFleetFailure(row({ status: 'running' }))).toBe(false);
	});

	it('a CANCELLED session with no note is an operator stop, NOT a failure and NOT attention', () => {
		const c = row({ status: 'cancelled' });
		expect(isFleetFailure(c)).toBe(false);
		expect(fleetNeedsAttention(c)).toBe(false);
	});

	it('attention === the set this page already banners: failed, or carrying a note', () => {
		expect(fleetNeedsAttention(row({ status: 'failed' }))).toBe(true);
		expect(fleetNeedsAttention(row({ status: 'failed', note: null }))).toBe(true);
		// SessionFailureReason.svelte:48 — a DONE session with a note is the WI-3 advisory.
		expect(fleetNeedsAttention(row({ status: 'done', note: 'work preserved on branch x' }))).toBe(true);
		expect(fleetNeedsAttention(row({ status: 'done' }))).toBe(false);
	});

	it('empty: a whitespace-only note is not a note (never a fabricated attention row)', () => {
		expect(fleetNeedsAttention(row({ status: 'done', note: '   ' }))).toBe(false);
		expect(fleetNeedsAttention(row({ status: 'done', note: '' }))).toBe(false);
	});

	it('nil / upstream error: nil rows and non-string statuses never match and never throw', () => {
		expect(isFleetFailure(null)).toBe(false);
		expect(isFleetRunning(undefined)).toBe(false);
		expect(fleetNeedsAttention(null)).toBe(false);
		expect(isFleetFailure({ status: 42 } as unknown as FleetFilterRow)).toBe(false);
		expect(matchesFleetState(null, 'failed')).toBe(false);
	});

	it('an unknown state filter degrades to `all` — it never silently drops every row', () => {
		expect(matchesFleetState(row({ status: 'done' }), 'bogus' as never)).toBe(true);
	});

	it('every declared filter has a label and an honest predicate hint', () => {
		for (const s of FLEET_STATE_FILTERS) {
			expect(isFleetStateFilter(s)).toBe(true);
			expect(FLEET_STATE_LABELS[s]).toBeTruthy();
			expect(FLEET_STATE_HINTS[s]).toBeTruthy();
		}
		expect(isFleetStateFilter('nope')).toBe(false);
		expect(isFleetStateFilter(null)).toBe(false);
	});
});

describe('project keys + labels (LB-2 shared composer, never a raw record id)', () => {
	it('happy: the key is the record id, the label is the project name', () => {
		const r = row({ projectId: 'project:atelier', projectName: 'Atelier' });
		expect(fleetProjectKey(r)).toBe('project:atelier');
		expect(fleetProjectLabel(fleetProjectKey(r), r.projectName)).toBe('Atelier');
	});

	it('a session with NO project links to the honest sentinel bucket, not an invented project', () => {
		expect(fleetProjectKey(row())).toBe(FLEET_NO_PROJECT);
		expect(fleetProjectLabel(FLEET_NO_PROJECT, null)).toBe('no project');
		// The sentinel can never collide: every real id carries a `table:` prefix (db/validate.ts:18).
		expect(FLEET_NO_PROJECT.includes(':')).toBe(false);
	});

	it('a name-less project falls back to the SHARED stripRecordId, never a raw `project:` id', () => {
		expect(fleetProjectLabel('project:card_draw_control', null)).toBe('card_draw_control');
		expect(fleetProjectLabel('project:card_draw_control', '   ')).toBe('card_draw_control');
		// An opaque auto-id carries no human content → honest placeholder, not the id.
		expect(fleetProjectLabel('project:gq3glfee2zcw993suhto', null)).toBe('unnamed project');
	});

	it('nil / upstream error: a non-string projectId collapses to the no-project bucket', () => {
		expect(fleetProjectKey(null)).toBe(FLEET_NO_PROJECT);
		expect(fleetProjectKey({ projectId: 7 } as unknown as FleetFilterRow)).toBe(FLEET_NO_PROJECT);
	});
});

describe('fleetProjectOptions — never offers an option that cannot match', () => {
	it('happy: one option per distinct project in the window, with real counts', () => {
		const opts = fleetProjectOptions(WINDOW);
		expect(opts.map((o) => o.value)).toEqual(['project:atelier', 'project:rounds', FLEET_NO_PROJECT]);
		expect(opts.map((o) => o.count)).toEqual([3, 2, 1]);
		// The "no project" bucket always sorts last.
		expect(opts[opts.length - 1].value).toBe(FLEET_NO_PROJECT);
	});

	it('options are derived from the STATE-filtered rows, so a combination can never be empty', () => {
		const opts = fleetProjectOptions(WINDOW, 'failed');
		expect(opts).toHaveLength(1);
		expect(opts[0]).toMatchObject({ value: 'project:atelier', count: 1 });
		// ROUNDS has no failure in the window ⇒ it is not offered under `failed`.
		expect(opts.some((o) => o.value === 'project:rounds')).toBe(false);
	});

	it('a project whose first row lacks a name still picks up the name from a later row', () => {
		const opts = fleetProjectOptions([
			row({ projectId: 'project:gq3glfee2zcw993suhto', projectName: null }),
			row({ projectId: 'project:gq3glfee2zcw993suhto', projectName: 'Late Name' })
		]);
		expect(opts[0].label).toBe('Late Name');
		expect(opts[0].count).toBe(2);
	});

	it('nil / empty: no rows → no options (the page hides the control rather than offering nothing)', () => {
		expect(fleetProjectOptions(null)).toEqual([]);
		expect(fleetProjectOptions([])).toEqual([]);
		expect(fleetProjectOptions([null, undefined])).toEqual([]);
	});
});

describe('fleetStateCounts — a 0 means "selecting this shows nothing"', () => {
	it('happy: counts over the whole window, attention a superset of failed', () => {
		const c = fleetStateCounts(WINDOW);
		expect(c.all).toBe(6);
		expect(c.running).toBe(2);
		expect(c.failed).toBe(1);
		// failed(1) + the done-with-note advisory(1) = 2.
		expect(c.attention).toBe(2);
		expect(c.attention).toBeGreaterThanOrEqual(c.failed);
	});

	it('counts respect the ACTIVE project filter (so a chip count matches what a click yields)', () => {
		const c = fleetStateCounts(WINDOW, 'project:rounds');
		expect(c.all).toBe(2);
		expect(c.failed).toBe(0);
		expect(c.attention).toBe(1);
		expect(filterFleet(WINDOW, { project: 'project:rounds', state: 'failed', open: true })).toHaveLength(0);
	});

	it('nil / empty: no rows → every count 0, never undefined', () => {
		expect(fleetStateCounts(null)).toEqual({ all: 0, running: 0, failed: 0, attention: 0 });
		expect(fleetStateCounts([])).toEqual({ all: 0, running: 0, failed: 0, attention: 0 });
	});
});

describe('filterFleet — both dimensions, order preserved', () => {
	it('happy: project + state compose', () => {
		const out = filterFleet(WINDOW, { project: 'project:atelier', state: 'attention', open: true });
		expect(out).toHaveLength(1);
		expect(out[0].status).toBe('failed');
	});

	it('the no-project sentinel selects exactly the unlinked sessions', () => {
		const out = filterFleet(WINDOW, { project: FLEET_NO_PROJECT, state: 'all', open: true });
		expect(out).toHaveLength(1);
		expect(out[0].projectId).toBeNull();
	});

	it('preserves the loader ordering (running-first, newest-first) — it only removes rows', () => {
		const out = filterFleet(WINDOW, { project: null, state: 'all', open: true });
		expect(out).toEqual(WINDOW);
	});

	it('nil / empty: nil rows or nil view never throw', () => {
		expect(filterFleet(null, null)).toEqual([]);
		expect(filterFleet([], DEFAULT_FLEET_VIEW)).toEqual([]);
		expect(filterFleet(WINDOW, null)).toEqual(WINDOW);
	});
});

describe('resolveFleetView — the whole section state, with NAMED honest states', () => {
	it('happy: visible rows, both option sets, and the untouched totals', () => {
		const r = resolveFleetView(WINDOW, { project: 'project:atelier', state: 'all', open: true });
		expect(r.total).toBe(6);
		expect(r.visible).toHaveLength(3);
		expect(r.stateCounts.failed).toBe(1);
		expect(r.staleProject).toBe(false);
		expect(r.filteredEmpty).toBe(false);
	});

	it('a filter that matches nothing is the honest FILTERED-EMPTY state, not "no sessions"', () => {
		const r = resolveFleetView(WINDOW, { project: 'project:rounds', state: 'failed', open: true });
		expect(r.visible).toHaveLength(0);
		expect(r.filteredEmpty).toBe(true);
		expect(r.total).toBe(6);
	});

	it('a STALE project id (shared link / excluded by state) is kept, flagged, and offered as 0-count', () => {
		const r = resolveFleetView(WINDOW, { project: 'project:rounds', state: 'failed', open: true });
		expect(r.staleProject).toBe(true);
		const stale = r.projectOptions.find((o) => o.value === 'project:rounds');
		expect(stale).toMatchObject({ count: 0, stale: true, label: 'ROUNDS' });
	});

	it('a project id NOT in the window at all still labels honestly (no raw id in the select)', () => {
		const r = resolveFleetView(WINDOW, { project: 'project:never_seen', state: 'all', open: true });
		expect(r.staleProject).toBe(true);
		expect(r.projectOptions.find((o) => o.value === 'project:never_seen')?.label).toBe('never_seen');
	});

	it('empty window: no options, and filteredEmpty stays FALSE (the "no sessions yet" copy owns it)', () => {
		const r = resolveFleetView([], { project: 'project:x', state: 'failed', open: true });
		expect(r.total).toBe(0);
		expect(r.filteredEmpty).toBe(false);
		expect(r.stateCounts.all).toBe(0);
	});

	it('nil: nil rows and nil view resolve to the default, never a throw', () => {
		const r = resolveFleetView(null, null);
		expect(r.view).toEqual(DEFAULT_FLEET_VIEW);
		expect(r.visible).toEqual([]);
		expect(r.projectOptions).toEqual([]);
	});

	it('upstream error: a rows array containing nils is filtered out of every count and option', () => {
		const r = resolveFleetView(
			[null, row({ status: 'failed', projectId: 'project:a', projectName: 'A' }), undefined] as never,
			DEFAULT_FLEET_VIEW
		);
		expect(r.total).toBe(1);
		expect(r.stateCounts.failed).toBe(1);
		expect(r.projectOptions).toHaveLength(1);
	});
});

describe('fleetScopeLabel — the heading names the REAL scope (live-verified defect)', () => {
	// Found in the browser at the end-gate: with a project filter engaged the head still read
	// `session fleet · all projects`, so the disclosure's ACCESSIBLE NAME described a scope the
	// list did not have. The heading now follows the filter.
	it('happy: an engaged project filter names THAT project, not "all projects"', () => {
		const r = resolveFleetView(WINDOW, { project: 'project:rounds', state: 'all', open: true });
		expect(fleetScopeLabel(r.view, r.projectOptions)).toBe('ROUNDS');
	});

	it('unfiltered: the honest widest scope', () => {
		expect(fleetScopeLabel(DEFAULT_FLEET_VIEW, [])).toBe('all projects');
		expect(fleetScopeLabel({ project: null, state: 'failed', open: true }, [])).toBe('all projects');
	});

	it('the no-project bucket names itself rather than claiming the whole portfolio', () => {
		const r = resolveFleetView(WINDOW, { project: FLEET_NO_PROJECT, state: 'all', open: true });
		expect(fleetScopeLabel(r.view, r.projectOptions)).toBe('no project');
	});

	it('a STALE project id still resolves to a name — never a raw `project:` id in the heading', () => {
		// resolveFleetView appends the stale selection as a 0-count option, so a label always exists.
		const r = resolveFleetView(WINDOW, { project: 'project:card_draw_control', state: 'all', open: true });
		expect(r.staleProject).toBe(true);
		expect(fleetScopeLabel(r.view, r.projectOptions)).toBe('card_draw_control');
	});

	it('nil / empty / upstream error: never throws, never renders an id, never blank', () => {
		expect(fleetScopeLabel(null, null)).toBe('all projects');
		expect(fleetScopeLabel(undefined, undefined)).toBe('all projects');
		expect(fleetScopeLabel({ project: '   ', state: 'all', open: true }, [])).toBe('all projects');
		// Options missing entirely (an upstream resolve that never ran) → the shared id-humanizer.
		expect(fleetScopeLabel({ project: 'project:rounds', state: 'all', open: true }, [])).toBe('rounds');
	});
});

describe('fleetCountScopeNote — the head counts stay TRUE beside a scoped heading (regression)', () => {
	// REGRESSION (2026-07-26, live at `?fleetProject=project:bepinexpack_rounds_port&fleetState=failed`):
	// scoping the heading orphaned the window-wide counts beside it — `bepinexpack_rounds_port`
	// next to `0 running · 40 recent · 32 failed` over a 4-row list. Before the heading was scoped,
	// its own hardcoded `all projects` had been reconciling those counts. The counts REMAIN
	// window-wide by design (a collapse must never hide a failure); they now say so.
	it('happy: a project-scoped heading forces the counts to declare their real scope', () => {
		const r = resolveFleetView(WINDOW, { project: 'project:rounds', state: 'all', open: true });
		// The exact pairing that read as a lie: scoped heading + unscoped counts.
		expect(fleetScopeLabel(r.view, r.projectOptions)).toBe('ROUNDS');
		expect(fleetCountScopeNote(r.view)).toBe('across all projects');
	});

	it('the no-project bucket is a narrowing too — it also needs the qualifier', () => {
		const r = resolveFleetView(WINDOW, { project: FLEET_NO_PROJECT, state: 'all', open: true });
		expect(fleetCountScopeNote(r.view)).toBe('across all projects');
	});

	it('a STALE project id still narrows the heading, so the counts still qualify themselves', () => {
		const r = resolveFleetView(WINDOW, {
			project: 'project:card_draw_control',
			state: 'all',
			open: true
		});
		expect(r.staleProject).toBe(true);
		expect(fleetCountScopeNote(r.view)).toBe('across all projects');
	});

	it('unfiltered: the heading already reads "all projects" — a qualifier would be noise', () => {
		expect(fleetCountScopeNote(DEFAULT_FLEET_VIEW)).toBeNull();
		// A STATE-only filter does not narrow the heading either, so the counts need nothing.
		expect(fleetCountScopeNote({ project: null, state: 'failed', open: true })).toBeNull();
	});

	it('nil / blank / upstream error: never throws, never emits a stray qualifier', () => {
		expect(fleetCountScopeNote(null)).toBeNull();
		expect(fleetCountScopeNote(undefined)).toBeNull();
		expect(fleetCountScopeNote({ project: '   ', state: 'all', open: true })).toBeNull();
	});

	it('the qualifier and the heading never both claim the widest scope (no double "all projects")', () => {
		for (const project of [null, 'project:rounds', FLEET_NO_PROJECT]) {
			const r = resolveFleetView(WINDOW, { project, state: 'all', open: true });
			const head = `${fleetScopeLabel(r.view, r.projectOptions)} ${fleetCountScopeNote(r.view) ?? ''}`;
			expect(head.match(/all projects/g) ?? []).toHaveLength(1);
		}
	});
});

/* ============================================================================
   REGRESSION — DEFECT 1 (HIGH, live-verified 2026-07-26 on :5174):
   the page's OWN live stream wiped the filter and re-expanded the collapse.

   Repro measured in the browser: on `/claude-code`, click the `failed` chip, then
   collapse. Address bar `?fleetState=failed&fleet=closed`, aria-expanded=false,
   0 rows, "32 of 40 sessions hidden · filtered by failed". One
   `invalidate('app:fleet')` — which `onDbChange('session')` fires on EVERY session
   row change — and: same URL, aria-expanded=TRUE, 40 rows, filter gone.

   Root cause: the re-seed `$effect` parsed the republished `page.url`, and
   `replaceState` never writes `page.url` — so the invalidate re-published the URL
   of the last real NAVIGATION, which carries no fleet params. Note the control
   case below: with the params in the INITIAL url, an invalidate was harmless —
   which is exactly why only clicked state was lost.
   ============================================================================ */
describe('reseedFleetView — a re-publish is not a navigation (DEFECT 1)', () => {
	const CLICKED: FleetView = { project: 'project:bepinexpack_rounds_port', state: 'failed', open: false };

	it('THE DEFECT: an invalidate re-publishes the SAME href — the live view survives untouched', () => {
		// The href is the last real navigation (paramless): exactly what `page.url` holds after a
		// filter click, because `replaceState` never wrote it.
		const url = new URL('http://x/claude-code');
		const d = reseedFleetView(url.href, url, CLICKED);
		expect(d.view).toBeNull(); // ← before the fix this returned DEFAULT_FLEET_VIEW
		expect(d.href).toBe(url.href);
	});

	it('re-publishing a hundred times never erodes the view (the session-churn case)', () => {
		const url = new URL('http://x/claude-code');
		let href = url.href;
		let view = { ...CLICKED };
		for (let i = 0; i < 100; i += 1) {
			const d = reseedFleetView(href, url, view);
			href = d.href;
			if (d.view) view = d.view;
		}
		expect(view).toEqual(CLICKED);
	});

	it('a REAL navigation (different href) still re-seeds — the behaviour the effect exists for', () => {
		const next = new URL('http://x/claude-code?session=session:abc&fleetState=running&fleet=closed');
		const d = reseedFleetView('http://x/claude-code', next, DEFAULT_FLEET_VIEW);
		expect(d.view).toEqual({ project: null, state: 'running', open: false });
		expect(d.href).toBe(next.href);
	});

	it('a navigation to a URL expressing the SAME view adopts the href but writes no state', () => {
		const next = new URL('http://x/claude-code?fleetState=failed');
		const d = reseedFleetView('http://x/claude-code', next, {
			project: null,
			state: 'failed',
			open: true
		});
		expect(d.view).toBeNull();
		expect(d.href).toBe(next.href);
	});

	it('CONTROL: params in the INITIAL url were always safe — proving the mechanism', () => {
		// A view seeded FROM the url round-trips through a re-publish unchanged, which is why the
		// defect only ever bit a clicked (replaceState-written) view.
		const url = new URL('http://x/claude-code?fleetState=failed&fleet=closed');
		const seeded = parseFleetView(url.searchParams);
		expect(reseedFleetView(url.href, url, seeded).view).toBeNull();
	});

	it('nil / empty / upstream-error: never throws, never discards the operator view', () => {
		expect(reseedFleetView(null, null, CLICKED)).toEqual({ href: '', view: null });
		expect(reseedFleetView('http://x/a', undefined, CLICKED).view).toBeNull();
		expect(reseedFleetView('http://x/a', { href: '   ' }, CLICKED).view).toBeNull();
		expect(reseedFleetView('http://x/a', { href: '   ' }, CLICKED).href).toBe('http://x/a');
		// A first run with no recorded href IS a navigation — it seeds.
		const url = new URL('http://x/claude-code?fleetState=running');
		expect(reseedFleetView(undefined, url, null).view).toEqual({
			project: null,
			state: 'running',
			open: true
		});
		// A url with no searchParams at all degrades to the default view, not a throw.
		expect(reseedFleetView('http://x/a', { href: 'http://x/b' }, CLICKED).view).toEqual(
			DEFAULT_FLEET_VIEW
		);
	});
});

/* ============================================================================
   REGRESSION — DEFECT 2 (MEDIUM, live-verified 2026-07-26):
   the universal escape chip was disabled exactly in the dead end, and its hint
   contradicted its own badge.

   Measured at `?fleetProject=project:ghost&fleetState=failed`:
   `all 0 [DISABLED] · running 0 [DISABLED] · failed 0 · needs attention 0
   [DISABLED]`, with the `all` chip's title reading "every session in the window"
   beside a badge of 0 while the window held 40.
   ============================================================================ */
describe('state chips — the widen action is never dead, the hint never lies (DEFECT 2)', () => {
	it('THE DEFECT: `all` is never disabled, even at a real 0', () => {
		expect(isFleetStateChipDisabled('all', 0, false)).toBe(false); // ← was `true`
		expect(isFleetStateChipDisabled('all', 0, true)).toBe(false);
	});

	it('a narrowing chip at 0 IS still disabled — no filter that cannot match (F-008)', () => {
		for (const st of ['running', 'failed', 'attention'] as const) {
			expect(isFleetStateChipDisabled(st, 0, false)).toBe(true);
			expect(isFleetStateChipDisabled(st, 3, false)).toBe(false);
		}
	});

	it('the ACTIVE chip stays clickable at 0 so it can be un-set', () => {
		expect(isFleetStateChipDisabled('failed', 0, true)).toBe(false);
	});

	it('the whole dead end has at least one live escape', () => {
		// The state the browser measured: every count 0 under a stale project, state=failed.
		const counts = { all: 0, running: 0, failed: 0, attention: 0 };
		const live = FLEET_STATE_FILTERS.filter(
			(st) => !isFleetStateChipDisabled(st, counts[st], st === 'failed')
		);
		expect(live).toContain('all');
		expect(live.length).toBeGreaterThan(0);
	});

	it('upstream error: a non-numeric / negative count degrades to disabled, never crashes', () => {
		expect(isFleetStateChipDisabled('failed', NaN, false)).toBe(true);
		expect(isFleetStateChipDisabled('failed', undefined as unknown as number, false)).toBe(true);
		expect(isFleetStateChipDisabled('all', undefined as unknown as number, false)).toBe(false);
	});

	it('THE DEFECT: a project-scoped chip discloses the scope its badge is counted under', () => {
		expect(fleetStateHint('all', 'ghost')).toBe('every session in the window · within ghost');
		expect(fleetStateHint('failed', 'ghost')).toBe('session.status = failed · within ghost');
	});

	it('unscoped: the base predicate is passed through verbatim, unchanged', () => {
		for (const st of FLEET_STATE_FILTERS) {
			expect(fleetStateHint(st, null)).toBe(FLEET_STATE_HINTS[st]);
			expect(fleetStateHint(st, undefined)).toBe(FLEET_STATE_HINTS[st]);
			expect(fleetStateHint(st, '   ')).toBe(FLEET_STATE_HINTS[st]); // blank → absent
		}
	});

	it('upstream error: an unknown state token still yields a usable hint, never undefined', () => {
		expect(fleetStateHint('bogus' as never, null)).toBe(FLEET_STATE_HINTS.all);
	});
});
