/**
 * TASK BOARD VIEW — unit gate for the pure view model behind /projects/[id]/tasks (P3).
 *
 * The load-bearing group is `counts describe the set actually shown`. That defect has shipped
 * TWICE in this program (a hiring header counting 36 beside a list of 17; a collapsed fleet line
 * printing the FILTERED count as the HIDDEN count), so it is not tested by example here — it is
 * tested as an INVARIANT swept over every filter combination the board can reach, plus a targeted
 * regression for the specific inversion that shipped.
 *
 * The rest is the F-008/TB-10 surface: an option is never offered that cannot match, a completeness
 * chip counts only fields that really exist, and every exported function survives its four shadow
 * paths (happy · nil · empty · upstream error).
 */

import { describe, it, expect } from 'vitest';
import {
	applyBoardViewToParams,
	boardColumns,
	boardFeedbackLine,
	boardScalarOptions,
	boardSummaryLine,
	boardTagOptions,
	columnCountLabel,
	completenessHint,
	contextCompleteness,
	CONTEXT_FIELDS,
	DEFAULT_BOARD_VIEW,
	filterBoardTasks,
	filterSummary,
	isBoardChipDisabled,
	isBoardFiltered,
	linkLabel,
	matchesBoardQuery,
	matchesBoardTags,
	matchesBoardView,
	originLabel,
	parseBoardView,
	parseTagFilter,
	resolveBoard,
	selectBoardTask,
	type BoardClearedCounts,
	type BoardTask,
	type BoardView
} from './task-board-view';

const STATUSES = [
	'proposed',
	'backlog',
	'ready',
	'in_progress',
	'review',
	'blocked',
	'done',
	'failed',
	'withdrawn'
] as const;
const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;

function task(over: Partial<BoardTask> & { id: string }): BoardTask {
	return {
		title: `task ${over.id}`,
		description: 'seed',
		status: 'backlog',
		priority: 'normal',
		origin: 'manual',
		moves: [],
		createdAt: '2026-08-05T10:00:00.000Z',
		updatedAt: '2026-08-05T10:00:00.000Z',
		tags: [],
		acceptanceCriteria: [],
		provenanceEvidence: [],
		provenanceDetail: [],
		...over
	};
}

/** A population that exercises every filter axis at once. */
const ROWS: BoardTask[] = [
	task({ id: 'task:a', title: 'Migrate the ledger', status: 'ready', priority: 'high', origin: 'pm', tags: ['db', 'careful'], objective: 'Move it', purpose: 'Because', acceptanceCriteria: ['green'] }),
	task({ id: 'task:b', title: 'Fix the drain', status: 'ready', priority: 'normal', origin: 'manual', tags: ['db'] }),
	task({ id: 'task:c', title: 'Write the devlog', status: 'done', priority: 'low', origin: 'follow_up', tags: ['docs'] }),
	task({ id: 'task:d', title: 'Audit the gates', status: 'backlog', priority: 'critical', origin: 'review', tags: ['db', 'careful'] }),
	task({ id: 'task:e', title: 'Ship it', status: 'blocked', priority: 'normal', origin: 'release' })
];

/** Every filter combination the controls can produce over ROWS — the invariant sweep's domain. */
function everyView(): BoardView[] {
	const views: BoardView[] = [{ ...DEFAULT_BOARD_VIEW, tags: [] }];
	for (const q of ['', 'the', 'zzz']) {
		for (const tags of [[], ['db'], ['db', 'careful'], ['ghost']]) {
			for (const priority of [null, 'high', 'normal', 'nope']) {
				for (const origin of [null, 'pm', 'manual']) {
					for (const status of [null, 'ready', 'done', 'nope']) {
						views.push({ query: q, tags: [...tags], priority, origin, status, task: null });
					}
				}
			}
		}
	}
	return views;
}

describe('parse / write the URL', () => {
	it('parses a populated query string', () => {
		const v = parseBoardView(
			new URLSearchParams('q=migrate&tag=db,careful&prio=high&origin=pm&status=ready&task=task:a')
		);
		expect(v).toEqual({
			query: 'migrate',
			tags: ['db', 'careful'],
			priority: 'high',
			origin: 'pm',
			status: 'ready',
			task: 'task:a'
		});
	});

	it('nil / empty / blank params degrade to the default view, never to "undefined"', () => {
		expect(parseBoardView(null)).toEqual({ ...DEFAULT_BOARD_VIEW, tags: [] });
		expect(parseBoardView(undefined)).toEqual({ ...DEFAULT_BOARD_VIEW, tags: [] });
		expect(parseBoardView(new URLSearchParams(''))).toEqual({ ...DEFAULT_BOARD_VIEW, tags: [] });
		const blank = parseBoardView(new URLSearchParams('q=   &prio=&tag=,, ,&task='));
		expect(blank).toEqual({ ...DEFAULT_BOARD_VIEW, tags: [] });
	});

	it('an upstream-error params object (no .get) is absorbed, not thrown', () => {
		expect(() => parseBoardView({} as unknown as URLSearchParams)).not.toThrow();
		expect(parseBoardView({} as unknown as URLSearchParams)).toEqual({
			...DEFAULT_BOARD_VIEW,
			tags: []
		});
	});

	it('parseTagFilter trims, lower-cases and de-duplicates; nil → []', () => {
		expect(parseTagFilter(' DB , db ,, Careful ')).toEqual(['db', 'careful']);
		expect(parseTagFilter(null)).toEqual([]);
		expect(parseTagFilter(42)).toEqual([]);
	});

	it('round-trips through applyBoardViewToParams and drops every default', () => {
		const v: BoardView = {
			query: 'migrate',
			tags: ['db', 'careful'],
			priority: 'high',
			origin: 'pm',
			status: 'ready',
			task: 'task:a'
		};
		expect(parseBoardView(applyBoardViewToParams(null, v))).toEqual(v);
		// A pristine view leaves the URL completely clean.
		expect(applyBoardViewToParams(null, DEFAULT_BOARD_VIEW).toString()).toBe('');
		// Unrelated params survive.
		const kept = applyBoardViewToParams(new URLSearchParams('tab=tasks'), DEFAULT_BOARD_VIEW);
		expect(kept.get('tab')).toBe('tasks');
	});

	it('isBoardFiltered: an open detail panel is NOT a filter (it hides nothing)', () => {
		expect(isBoardFiltered(null)).toBe(false);
		expect(isBoardFiltered({ ...DEFAULT_BOARD_VIEW, tags: [], task: 'task:a' })).toBe(false);
		expect(isBoardFiltered({ ...DEFAULT_BOARD_VIEW, tags: ['db'] })).toBe(true);
		expect(isBoardFiltered({ ...DEFAULT_BOARD_VIEW, tags: [], query: 'x' })).toBe(true);
	});
});

describe('context completeness (TB-10) — counts only fields that really exist', () => {
	it('a fully-specified task is n/n and names nothing missing', () => {
		const c = contextCompleteness(ROWS[0]);
		expect(c).toEqual({
			have: 3,
			of: CONTEXT_FIELDS.length,
			present: ['objective', 'purpose', 'acceptance criteria'],
			missing: []
		});
	});

	it('a bare task is 0/n and names all three as missing', () => {
		const c = contextCompleteness(task({ id: 'task:x' }));
		expect(c.have).toBe(0);
		expect(c.missing).toEqual(['objective', 'purpose', 'acceptance criteria']);
	});

	it('a present-but-BLANK field counts as ABSENT — never inferred, never rounded up', () => {
		const c = contextCompleteness(
			task({ id: 'task:x', objective: '   ', purpose: '', acceptanceCriteria: ['  ', ''] })
		);
		expect(c.have).toBe(0);
		expect(c.present).toEqual([]);
	});

	it('shadow paths: nil task and a non-array criteria list are absorbed, never thrown', () => {
		expect(contextCompleteness(null).have).toBe(0);
		expect(contextCompleteness(undefined).of).toBe(CONTEXT_FIELDS.length);
		const broken = { ...task({ id: 'task:x' }), acceptanceCriteria: 'oops' } as unknown as BoardTask;
		expect(() => contextCompleteness(broken)).not.toThrow();
		expect(contextCompleteness(broken).have).toBe(0);
	});

	it('the hint NAMES the missing fields so n/3 is explainable, not a score', () => {
		const partial = contextCompleteness(task({ id: 'task:x', objective: 'do it' }));
		const hint = completenessHint(partial);
		expect(hint).toContain('1 of 3');
		expect(hint).toContain('purpose');
		expect(hint).toContain('acceptance criteria');
		expect(completenessHint(contextCompleteness(ROWS[0]))).toContain('all stored');
		expect(completenessHint(null)).toContain('0 of 3');
	});
});

describe('predicates', () => {
	it('a blank query matches everything; a query matches title or id, never the description', () => {
		expect(matchesBoardQuery(ROWS[0], '   ')).toBe(true);
		expect(matchesBoardQuery(ROWS[0], 'LEDGER')).toBe(true);
		expect(matchesBoardQuery(ROWS[0], 'task:a')).toBe(true);
		expect(matchesBoardQuery(ROWS[0], 'seed')).toBe(false);
		expect(matchesBoardQuery(null, 'x')).toBe(false);
	});

	it('tags AND together — a task must carry EVERY filtered tag', () => {
		expect(matchesBoardTags(ROWS[0], ['db', 'careful'])).toBe(true);
		expect(matchesBoardTags(ROWS[1], ['db', 'careful'])).toBe(false);
		expect(matchesBoardTags(ROWS[1], [])).toBe(true);
		expect(matchesBoardTags(ROWS[1], null)).toBe(true);
		expect(matchesBoardTags(null, ['db'])).toBe(false);
	});

	it('matchesBoardView ignores the detail selection — it never narrows the board', () => {
		const withDetail: BoardView = { ...DEFAULT_BOARD_VIEW, tags: [], task: 'task:zzz' };
		expect(ROWS.every((r) => matchesBoardView(r, withDetail))).toBe(true);
	});

	it('a nil view filters nothing; a nil row never matches', () => {
		expect(filterBoardTasks(ROWS, null)).toHaveLength(ROWS.length);
		expect(filterBoardTasks([null, undefined, ...ROWS], null)).toHaveLength(ROWS.length);
		expect(filterBoardTasks(null, null)).toEqual([]);
	});
});

describe('THE COUNTS INVARIANT — every printed number describes the set actually shown', () => {
	it('over EVERY reachable filter combination: column counts sum to the visible rows', () => {
		for (const view of everyView()) {
			const b = resolveBoard(ROWS, view, STATUSES, PRIORITIES);
			const summed = b.columns.reduce((n, c) => n + c.shown, 0);
			expect(summed).toBe(b.visible.length);
			for (const col of b.columns) {
				// The header's number IS the rendered array's length — not a parallel count.
				expect(col.shown).toBe(col.tasks.length);
				// Every card in a column really carries that status.
				expect(col.tasks.every((t) => t.status === col.status)).toBe(true);
				// `total` is the UNFILTERED count for the status; `hidden` is its complement — and
				// `hidden` is never silently the same quantity as `shown`.
				expect(col.total).toBe(ROWS.filter((r) => r.status === col.status).length);
				expect(col.hidden).toBe(col.total - col.shown);
			}
		}
	});

	it("the column label's FIRST number is always what is rendered beneath it", () => {
		const view: BoardView = { ...DEFAULT_BOARD_VIEW, tags: ['db'] };
		const b = resolveBoard(ROWS, view, STATUSES, PRIORITIES);
		for (const col of b.columns) {
			expect(columnCountLabel(col, true)).toBe(`${col.tasks.length} of ${col.total}`);
			// Unfiltered prints the bare count — `8 of 8` would be noise.
			expect(columnCountLabel(col, false)).toBe(`${col.tasks.length}`);
		}
		expect(columnCountLabel(null, true)).toBe('0 of 0');
	});

	it('REGRESSION — the summary states HIDDEN as its own quantity, never the shown count', () => {
		// The exact inversion that shipped in `fleetCollapsedSummary`: the filtered (== shown)
		// count printed as the hidden count. Pick a filter where the two genuinely differ.
		const view: BoardView = { ...DEFAULT_BOARD_VIEW, tags: ['careful'] };
		const b = resolveBoard(ROWS, view, STATUSES, PRIORITIES);
		expect(b.visible).toHaveLength(2);
		expect(b.total).toBe(5);
		expect(b.summaryLine).toContain('showing 2 of 5 tasks');
		expect(b.summaryLine).toContain('3 hidden by filters');
		// The shown count must NOT appear as the hidden quantity.
		expect(b.summaryLine).not.toContain('2 hidden');
	});

	it('REGRESSION — a WIDENING option counts the other filters, not the board total', () => {
		// LIVE-VERIFIED 2026-08-05 on :5173 (`?origin=pm&tag=ghost`): the Priority and Origin selects
		// read `any (5)` — the hardcoded loaded-row total — beside a board rendering ZERO cards and a
		// footer correctly saying `showing 0 of 5 tasks`. The widening controls were the one number
		// not derived from a filtered set, so they contradicted the body.
		const view: BoardView = { ...DEFAULT_BOARD_VIEW, tags: ['ghost'], origin: 'pm' };
		const b = resolveBoard(ROWS, view, STATUSES, PRIORITIES);
		expect(b.visible).toEqual([]);
		// Clearing ONLY origin leaves the impossible tag in force ⇒ still nothing.
		expect(b.clearedCounts.origin).toBe(0);
		expect(b.clearedCounts.priority).toBe(0);
		expect(b.clearedCounts.status).toBe(0);
		// Clearing the TAGS is the move that actually widens — and it says how far.
		expect(b.clearedCounts.tags).toBe(ROWS.filter((r) => r.origin === 'pm').length);
	});

	it('every widening count equals what clearing that ONE axis really shows', () => {
		for (const view of everyView()) {
			const b = resolveBoard(ROWS, view, STATUSES, PRIORITIES);
			const axes: [keyof BoardClearedCounts, Partial<BoardView>][] = [
				['priority', { priority: null }],
				['origin', { origin: null }],
				['status', { status: null }],
				['tags', { tags: [] }]
			];
			for (const [axis, patch] of axes) {
				const cleared = resolveBoard(ROWS, { ...view, ...patch }, STATUSES, PRIORITIES);
				expect(b.clearedCounts[axis]).toBe(cleared.visible.length);
			}
		}
	});

	it('with nothing filtered, every widening count IS the board total (no special case)', () => {
		const b = resolveBoard(ROWS, DEFAULT_BOARD_VIEW, STATUSES, PRIORITIES);
		expect(b.clearedCounts).toEqual({ priority: 5, origin: 5, status: 5, tags: 5 });
	});

	it('the summary omits the hidden clause when nothing is filtered', () => {
		const b = resolveBoard(ROWS, DEFAULT_BOARD_VIEW, STATUSES, PRIORITIES);
		expect(b.summaryLine).toBe('showing 5 of 5 tasks');
		expect(b.summaryLine).not.toContain('hidden');
	});

	it('boardSummaryLine shadow paths: nil/negative/NaN counts print 0, never NaN', () => {
		expect(boardSummaryLine(NaN, NaN, null)).toBe('showing 0 of 0 tasks');
		expect(boardSummaryLine(-3, -9, null)).toBe('showing 0 of 0 tasks');
		expect(boardSummaryLine(1, 1, null)).toBe('showing 1 of 1 task');
	});
});

describe('columns', () => {
	it('emits EVERY canonical status, including empty ones (the workflow shape is data)', () => {
		const cols = boardColumns(ROWS, ROWS, STATUSES);
		expect(cols.map((c) => c.status)).toEqual([...STATUSES]);
		expect(cols.find((c) => c.status === 'withdrawn')?.shown).toBe(0);
	});

	it('a status OUTSIDE the vocabulary still gets a column — a task is never dropped', () => {
		const rogue = task({ id: 'task:z', status: 'archived' });
		const cols = boardColumns([rogue], [rogue], STATUSES);
		const extra = cols.find((c) => c.status === 'archived');
		expect(extra?.shown).toBe(1);
		expect(cols.reduce((n, c) => n + c.shown, 0)).toBe(1);
	});

	it('shadow paths: nil rows / nil vocabulary are absorbed', () => {
		expect(boardColumns(null, null, null)).toEqual([]);
		expect(boardColumns(null, null, STATUSES).every((c) => c.shown === 0)).toBe(true);
		expect(boardColumns([null], [undefined], STATUSES).every((c) => c.total === 0)).toBe(true);
	});
});

describe('filter options — never offer a filter that cannot match', () => {
	it("a scalar option's count is exactly what selecting it would show", () => {
		const view = { ...DEFAULT_BOARD_VIEW, tags: [] };
		for (const o of boardScalarOptions(ROWS, view, 'priority', PRIORITIES)) {
			const shown = resolveBoard(ROWS, { ...view, priority: o.value }, STATUSES, PRIORITIES);
			expect(o.count).toBe(shown.visible.length);
			expect(o.count).toBeGreaterThan(0);
		}
	});

	it("a scalar option's count stays true UNDER another engaged filter", () => {
		const view: BoardView = { ...DEFAULT_BOARD_VIEW, tags: ['db'] };
		for (const o of boardScalarOptions(ROWS, view, 'priority', PRIORITIES)) {
			const shown = resolveBoard(ROWS, { ...view, priority: o.value }, STATUSES, PRIORITIES);
			expect(o.count).toBe(shown.visible.length);
		}
	});

	it('a tag chip counts what ADDING it would leave visible (tags AND)', () => {
		const view: BoardView = { ...DEFAULT_BOARD_VIEW, tags: ['db'] };
		const opts = boardTagOptions(ROWS, view);
		const careful = opts.find((o) => o.value === 'careful');
		// db ∩ careful = a, d
		expect(careful?.count).toBe(2);
		const docs = opts.find((o) => o.value === 'docs');
		// db ∩ docs = ∅ — offered, but honestly zero and therefore disabled.
		expect(docs?.count).toBe(0);
		expect(isBoardChipDisabled(docs!.count, false)).toBe(true);
	});

	it("an ACTIVE chip's count is what it shows now, and it is NEVER disabled", () => {
		const view: BoardView = { ...DEFAULT_BOARD_VIEW, tags: ['db'] };
		const db = boardTagOptions(ROWS, view).find((o) => o.value === 'db');
		expect(db?.count).toBe(3);
		// Un-settable is the whole point — a disabled active chip is a dead end.
		expect(isBoardChipDisabled(0, true)).toBe(false);
		expect(isBoardChipDisabled(db!.count, true)).toBe(false);
	});

	it('a SELECTED value that matches nothing is kept + flagged stale, never silently dropped', () => {
		const view: BoardView = { ...DEFAULT_BOARD_VIEW, tags: ['ghost'], priority: 'nope' };
		const b = resolveBoard(ROWS, view, STATUSES, PRIORITIES);
		expect(b.staleFilter).toBe(true);
		expect(b.tagOptions.find((o) => o.value === 'ghost')).toMatchObject({ count: 0, stale: true });
		expect(b.priorityOptions.find((o) => o.value === 'nope')).toMatchObject({
			count: 0,
			stale: true
		});
	});

	it('shadow paths: nil rows / nil view yield empty option lists, never a throw', () => {
		expect(boardTagOptions(null, null)).toEqual([]);
		expect(boardScalarOptions(null, null, 'origin')).toEqual([]);
		expect(boardScalarOptions([null, undefined], null, 'status', STATUSES)).toEqual([]);
	});
});

describe('detail selection', () => {
	it('resolves a loaded id', () => {
		expect(selectBoardTask(ROWS, 'task:a').task?.id).toBe('task:a');
		expect(selectBoardTask(ROWS, 'task:a').notFound).toBe(false);
	});

	it('an id that is NOT on this board is a NAMED not-found, not an empty panel', () => {
		const s = selectBoardTask(ROWS, 'task:ghost');
		expect(s).toEqual({ requested: 'task:ghost', task: null, notFound: true });
	});

	it('shadow paths: no id / blank id / nil rows request nothing', () => {
		expect(selectBoardTask(ROWS, null)).toEqual({ requested: null, task: null, notFound: false });
		expect(selectBoardTask(ROWS, '   ')).toEqual({ requested: null, task: null, notFound: false });
		expect(selectBoardTask(null, 'task:a').notFound).toBe(true);
	});
});

describe('labels go through the shared naming composer', () => {
	it('a record link reads as its human tail, and an opaque auto-id honestly reads —', () => {
		expect(linkLabel('task:hr-recruiter')).toBe('hr-recruiter');
		expect(linkLabel('role:probe_fit_1781894354268')).toBe('probe_fit');
		expect(linkLabel('task:gq3glfee2zcw993suhto')).toBe('—');
	});

	it('linkLabel shadow paths: nil / blank / non-string → —, never "undefined"', () => {
		expect(linkLabel(null)).toBe('—');
		expect(linkLabel('   ')).toBe('—');
		expect(linkLabel({})).toBe('—');
		expect(linkLabel(undefined)).toBe('—');
	});

	it('origin conveys PURPOSE, and an unknown token is never given an invented name', () => {
		expect(originLabel('pm')).toBe('pm (project manager)');
		expect(originLabel('follow_up')).toBe('follow-up');
		expect(originLabel('manual')).toBe('manual');
		expect(originLabel('brand_new_origin')).toBe('brand_new_origin');
		expect(originLabel(null)).toBe('—');
		expect(originLabel(7)).toBe('—');
	});
});

describe('resolveBoard — the honest states', () => {
	it('distinguishes "no tasks exist" from "filtered to nothing"', () => {
		const empty = resolveBoard([], DEFAULT_BOARD_VIEW, STATUSES, PRIORITIES);
		expect(empty.total).toBe(0);
		expect(empty.filteredEmpty).toBe(false); // the page's own "no tasks yet" copy owns this

		const dead = resolveBoard(ROWS, { ...DEFAULT_BOARD_VIEW, tags: ['ghost'] }, STATUSES, PRIORITIES);
		expect(dead.total).toBe(5);
		expect(dead.visible).toEqual([]);
		expect(dead.filteredEmpty).toBe(true);
	});

	it('nil rows resolve to an empty board with the view intact, never a throw', () => {
		const b = resolveBoard(null, { ...DEFAULT_BOARD_VIEW, tags: ['db'] }, STATUSES, PRIORITIES);
		expect(b.total).toBe(0);
		expect(b.view.tags).toEqual(['db']);
		expect(b.summaryLine).toContain('showing 0 of 0 tasks');
	});

	it('does not mutate the view it is given (the page holds it in $state)', () => {
		const view: BoardView = { ...DEFAULT_BOARD_VIEW, tags: ['db'] };
		const b = resolveBoard(ROWS, view, STATUSES, PRIORITIES);
		b.view.tags.push('mutated');
		expect(view.tags).toEqual(['db']);
	});

	it('filterSummary names every engaged filter, and nothing when none is', () => {
		expect(filterSummary(DEFAULT_BOARD_VIEW)).toBeNull();
		expect(filterSummary(null)).toBeNull();
		const s = filterSummary({
			query: 'led',
			tags: ['db', 'careful'],
			priority: 'high',
			origin: 'pm',
			status: 'ready',
			task: null
		});
		expect(s).toContain('title contains "led"');
		expect(s).toContain('tags db + careful');
		expect(s).toContain('priority high');
		expect(s).toContain('origin pm');
		expect(s).toContain('status ready');
	});
});

/**
 * THE BANNER — the one element that could contradict the board, and did.
 *
 * MEASURED (red-team, live, 2026-08-05): clicking `→ ready` rendered `Moved task to ready.` while
 * the same DOM read showed the badge at `in_progress` and the columns at `ready=0 in_progress=1` —
 * the orchestrator had claimed the task within ~1s. The banner interpolated the ACTION RESULT's
 * requested status, the only number/word on the page not derived from the live rows.
 *
 * So the regression is stated as the divergence itself: given a write that asked for X and a live
 * row that now reads Y, the sentence must never claim X as the current state.
 */
describe('boardFeedbackLine — the banner states the LIVE row, not the write request', () => {
	const moved = { ok: true as const, action: 'move', taskId: 'task:a', to: 'ready' };

	it('REGRESSION: a move the orchestrator has already advanced is not reported as `ready`', () => {
		const live = task({ id: 'task:a', status: 'in_progress' });
		const line = boardFeedbackLine(moved, live);
		expect(line).toBe('Move to ready accepted — the task now reads in_progress.');
		// The exact shape that shipped must be impossible: no sentence may assert the requested
		// status as the current one while the row says otherwise.
		expect(line).not.toBe('Moved task to ready.');
		expect(line).toContain('in_progress');
	});

	it('states the short sentence when the live row really does read the requested status', () => {
		expect(boardFeedbackLine(moved, task({ id: 'task:a', status: 'ready' }))).toBe(
			'Moved task to ready.'
		);
	});

	it('a row no longer loaded is reported WITHOUT any claim about current state', () => {
		expect(boardFeedbackLine(moved, null)).toBe('Move to ready accepted.');
	});

	it('retag counts the LIVE tags, falling back to the write readback only without a row', () => {
		const live = task({ id: 'task:a', tags: ['db', 'careful'] });
		const fb = { ok: true as const, action: 'retag', taskId: 'task:a', tagCount: 9 };
		// The write said 9; the row carries 2. The row wins.
		expect(boardFeedbackLine(fb, live)).toBe('Tags saved (2).');
		expect(boardFeedbackLine(fb, null)).toBe('Tags saved (9).');
		expect(boardFeedbackLine({ ...fb, tagCount: 0 }, task({ id: 'task:a' }))).toBe('Tags cleared.');
		expect(boardFeedbackLine({ ...fb, tagCount: 0 }, null)).toBe('Tags cleared.');
	});

	it('priority names the divergence the same way a move does', () => {
		const fb = { ok: true as const, action: 'priority', taskId: 'task:a', priority: 'high' };
		expect(boardFeedbackLine(fb, task({ id: 'task:a', priority: 'high' }))).toBe(
			'Priority set to high.'
		);
		expect(boardFeedbackLine(fb, task({ id: 'task:a', priority: 'critical' }))).toBe(
			'Priority change to high saved — the task now reads critical.'
		);
		expect(boardFeedbackLine(fb, null)).toBe('Priority set to high.');
	});

	it('shadow paths: nil · error · unknown action · missing field → no banner at all', () => {
		expect(boardFeedbackLine(null, null)).toBeNull();
		expect(boardFeedbackLine(undefined, task({ id: 'task:a' }))).toBeNull();
		// An error envelope is the page's own `.form-error` line — never a success banner too.
		expect(boardFeedbackLine({ error: 'task not found on this board' }, null)).toBeNull();
		expect(boardFeedbackLine({ ok: true, action: 'teleport' }, task({ id: 'task:a' }))).toBeNull();
		expect(boardFeedbackLine({ ok: true, action: 'move' }, task({ id: 'task:a' }))).toBeNull();
		expect(boardFeedbackLine({ ok: true, action: 'priority' }, task({ id: 'task:a' }))).toBeNull();
		expect(boardFeedbackLine({ ok: true }, task({ id: 'task:a' }))).toBeNull();
	});
});
