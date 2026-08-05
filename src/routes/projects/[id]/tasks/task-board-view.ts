/**
 * TASK BOARD VIEW — the pure view model behind /projects/[id]/tasks (TASK-BOARD-SPEC §5, P3).
 *
 * OPERATOR ASK (2026-07-26, verbatim): *"how are sprints configured? do they have tasks or goals?
 * and do they have tickets/todos/tasks that clarify the what, why, how? basically want to turn the
 * tasks section into an asana board that we can view, with a full page view and each task having
 * meta data and tags to help remind our models exactly why and how to handle each task."*
 *
 * So the board's job is to show WHAT a task is and WHY it exists at a glance, and its detail view's
 * job is to show every field the row actually carries. Both are read-side only: the board writes
 * nothing this module decides (`setStatus` and `updateTask` remain the only writers, TB-4/TB-5).
 *
 * ── Why a separate pure module (the fleet-view.ts precedent) ───────────────────────────────
 * The whole decision surface — parse, options, counts, predicate, filter, grouping, completeness —
 * lives here as pure, dependency-free functions so it is unit-testable without a browser and shared
 * by the `.svelte` call site. No runes live here (F-009: runes only compile in `.svelte`/
 * `.svelte.ts`); the page holds the `$derived` wrappers.
 *
 * ── The counts invariant (the defect this module exists to prevent) ────────────────────────
 * A count must describe the set actually SHOWN. This exact defect shipped twice recently — a
 * hiring header counting 36 beside a list rendering 17, and a collapsed fleet line printing the
 * FILTERED count as the HIDDEN count (`fleetCollapsedSummary`'s doc has the measurement). So every
 * number this module produces is derived from the SAME array the page renders:
 * {@link resolveBoard} groups the VISIBLE rows once and the column head reads `column.shown` off
 * that group — the header literally cannot disagree with the list beneath it. Where a number
 * describes something else (the status's unfiltered total, the rows hidden by filters), it is
 * NAMED separately and never shares an "N of M" with the visible count.
 *
 * That discipline had one HOLE, found in the browser on 2026-08-05 and closed by
 * {@link BoardClearedCounts}: the WIDENING options ("any priority", "every column") were the one
 * number the page did NOT derive from a filtered set, and they read `any (5)` beside a board
 * rendering zero cards. Every count on this page is now a measurement of a reachable set.
 *
 * ── Honesty (F-008) ───────────────────────────────────────────────────────────────────────
 * Every filter option is DERIVED FROM THE LOADED ROWS and carries its real count, so the board can
 * never offer a narrowing filter that cannot match. A task missing a field is an honest ABSENCE —
 * {@link contextCompleteness} counts only fields that are really present and never infers one.
 *
 * ── Shadow paths, all four, on every exported function ────────────────────────────────────
 *   • happy — real rows / real params → the composed view.
 *   • nil   — `null`/`undefined` rows, list, or params → the default view / an empty result.
 *   • empty — a zero-length list, a blank param value, a whitespace-only title → treated as
 *             absent, never as a match.
 *   • upstream error — an unknown status token, a stale tag no longer on any row, a non-string
 *             field → absorbed into an honest default + a named flag the page renders. Nothing
 *             here throws.
 */

import { stripRecordId } from '$lib/shared/naming';

// ── URL params (the view is shareable + survives a reload; no invented storage) ─────────────

/** URL param: the open detail task (`?task=task:…`). Deep-linkable — §5.2. */
export const BOARD_PARAM_TASK = 'task';
/** URL param: free-text search over the title. */
export const BOARD_PARAM_QUERY = 'q';
/** URL param: tag filter — comma-separated, ANDed (a task must carry ALL of them). */
export const BOARD_PARAM_TAGS = 'tag';
/** URL param: priority filter (one of the loaded rows' priorities). */
export const BOARD_PARAM_PRIORITY = 'prio';
/** URL param: origin filter. */
export const BOARD_PARAM_ORIGIN = 'origin';
/** URL param: status filter — narrows the board to ONE column. */
export const BOARD_PARAM_STATUS = 'status';

/**
 * The §4.1 "why & how" fields the completeness chip counts. Order is the reading order the detail
 * panel uses, and the chip's denominator is this array's length — never a hardcoded 3 that could
 * drift away from what is actually checked.
 */
export const CONTEXT_FIELDS = ['objective', 'purpose', 'acceptance criteria'] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];

/**
 * One task as the board renders it — the loader's wire shape.
 *
 * Structural on purpose (like `FleetFilterRow`): the loader builds it from a `TaskRow` with every
 * datetime already ISO-coerced and every record link already `String()`-ed, so this shared/client
 * module never imports a server type. Optional fields are ABSENT when the row does not carry them
 * (F-008) — never `''`, never a fabricated placeholder.
 */
export interface BoardTask {
	id: string;
	title: string;
	/** The immutable run seed (D-008) — displayed read-only, never editable from this surface. */
	description: string;
	status: string;
	priority: string;
	origin: string;
	/** The statuses this task may legally move TO (computed server-side from `canTransition`). */
	moves: string[];
	/** ISO string, or null when absent/unparseable (F-013 — the card renders '—'). */
	createdAt: string | null;
	updatedAt: string | null;
	/** Operator tags (m0087). `[]` ⇒ the task carries none and NO chip row renders. */
	tags: string[];
	// ── §4.1 Act-with-Purpose fields — absent on tasks that never carried them ───────────────
	objective?: string;
	purpose?: string;
	/** `[]` ⇒ none stored (the panel says so); never a fabricated criterion. */
	acceptanceCriteria: string[];
	/** `provenance.kind` — the machine enum. Evidence/detail are separate (see below). */
	provenanceKind?: string;
	/** `provenance.evidence` — record ids. DISPLAY-ONLY: D-026 keeps these out of PROMPTS, not
	 *  out of the operator's own UI (spec §5.5). */
	provenanceEvidence: string[];
	/** `provenance.detail` flattened to printable `key → value` pairs at the loader (F-013). */
	provenanceDetail: { key: string; value: string }[];
	proposedBy?: string;
	revisionOf?: string;
	supersededBy?: string;
	proposalFingerprint?: string;
	parent?: string;
}

/** The resolved filter state. All fields nullable/empty ⇒ the untouched default. */
export interface BoardView {
	/** Free-text title query (trimmed, lower-cased at match time). */
	query: string;
	/** Tag filter, ANDed — a task must carry EVERY tag listed. */
	tags: string[];
	priority: string | null;
	origin: string | null;
	status: string | null;
	/** The open detail task id, or null. Not a filter — it never narrows the board. */
	task: string | null;
}

/** The default view: everything, nothing selected. */
export const DEFAULT_BOARD_VIEW: BoardView = {
	query: '',
	tags: [],
	priority: null,
	origin: null,
	status: null,
	task: null
};

// ── Helpers ────────────────────────────────────────────────────────────────────────────────

/** Trimmed non-empty string, or `undefined`. Absorbs nil / blank / non-string (upstream error). */
function clean(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const s = v.trim();
	return s ? s : undefined;
}

/** A count that is safe to print: nil / negative / NaN / non-number (upstream error) → 0. */
function safeCount(n: unknown): number {
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The row's tags as a clean, lower-cased list. Absorbs nil / non-array / non-string entries. */
function taskTags(t: BoardTask | null | undefined): string[] {
	if (!t || !Array.isArray(t.tags)) return [];
	const out: string[] = [];
	for (const raw of t.tags) {
		const tag = clean(raw)?.toLowerCase();
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out;
}

/** Parse the comma-separated tag param into a clean, de-duplicated, lower-cased list. */
export function parseTagFilter(raw: unknown): string[] {
	const s = clean(raw);
	if (!s) return [];
	const out: string[] = [];
	for (const part of s.split(',')) {
		const tag = clean(part)?.toLowerCase();
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out;
}

// ── Parse / write the URL ──────────────────────────────────────────────────────────────────

/**
 * Parse the board view out of a URL's search params. Total — never throws.
 *
 *   `?q=migrate&tag=db,careful&prio=high&task=task:abc`
 *      → `{ query:'migrate', tags:['db','careful'], priority:'high', … , task:'task:abc' }`
 *   `?prio=`            → priority `null`  (blank → absent)
 *   `null`/`undefined`  → {@link DEFAULT_BOARD_VIEW}
 *
 * An UNKNOWN priority/origin/status token is kept verbatim rather than silently dropped: the page
 * surfaces it as a stale-filter state with a Clear action, because silently widening a filter the
 * address bar still advertises is the same URL-vs-UI disagreement `fleetMirrorDrift` exists to
 * close. Validity against the loaded rows is decided in {@link resolveBoardView}, not here.
 */
export function parseBoardView(params: URLSearchParams | null | undefined): BoardView {
	if (!params || typeof params.get !== 'function') return { ...DEFAULT_BOARD_VIEW, tags: [] };
	return {
		query: clean(params.get(BOARD_PARAM_QUERY)) ?? '',
		tags: parseTagFilter(params.get(BOARD_PARAM_TAGS)),
		priority: clean(params.get(BOARD_PARAM_PRIORITY)) ?? null,
		origin: clean(params.get(BOARD_PARAM_ORIGIN)) ?? null,
		status: clean(params.get(BOARD_PARAM_STATUS)) ?? null,
		task: clean(params.get(BOARD_PARAM_TASK)) ?? null
	};
}

/**
 * Write a view back into a copy of the current search params, DROPPING every default so a pristine
 * view leaves the URL clean (and any unrelated param is preserved).
 */
export function applyBoardViewToParams(
	current: URLSearchParams | null | undefined,
	view: BoardView | null | undefined
): URLSearchParams {
	const v = view ?? DEFAULT_BOARD_VIEW;
	const out = new URLSearchParams(current ?? undefined);
	const set = (key: string, value: string | null | undefined) => {
		const s = clean(value);
		if (s) out.set(key, s);
		else out.delete(key);
	};
	set(BOARD_PARAM_QUERY, v.query);
	set(BOARD_PARAM_TAGS, (v.tags ?? []).join(','));
	set(BOARD_PARAM_PRIORITY, v.priority);
	set(BOARD_PARAM_ORIGIN, v.origin);
	set(BOARD_PARAM_STATUS, v.status);
	set(BOARD_PARAM_TASK, v.task);
	return out;
}

/** TRUE when any FILTER is engaged. An open detail panel is not a filter — it hides nothing. */
export function isBoardFiltered(view: BoardView | null | undefined): boolean {
	if (!view) return false;
	return (
		clean(view.query) !== undefined ||
		(view.tags ?? []).length > 0 ||
		!!clean(view.priority) ||
		!!clean(view.origin) ||
		!!clean(view.status)
	);
}

// ── Context completeness (TB-10) ───────────────────────────────────────────────────────────

/** What a task actually carries of the §4.1 why/how fields. */
export interface ContextCompleteness {
	/** How many of {@link CONTEXT_FIELDS} are really present on the row. */
	have: number;
	/** The denominator — always `CONTEXT_FIELDS.length`, never a literal that can drift. */
	of: number;
	/** The field names that are present, in reading order. */
	present: ContextField[];
	/** The field names that are absent — what the chip's tooltip names, so `1/3` is explainable. */
	missing: ContextField[];
}

/**
 * Count ONLY the §4.1 fields that actually exist on the row (TB-10) — never inferred, never
 * backfilled from the description, never rounded up.
 *
 * A present-but-blank field counts as ABSENT: `objective: '   '` tells a model nothing, and calling
 * it context would be the fabricated-value class (F-008). An empty `acceptanceCriteria` array is
 * likewise absent — "no criteria stored" and "criteria stored that happen to be blank" are the same
 * fact to a reader, and neither is a criterion.
 *
 * Shadow paths: nil task → `0/3` with everything missing (the honest unknown, never a crash); a
 * non-array `acceptanceCriteria` (upstream error) → absent.
 */
export function contextCompleteness(task: BoardTask | null | undefined): ContextCompleteness {
	const present: ContextField[] = [];
	const missing: ContextField[] = [];
	const push = (field: ContextField, ok: boolean) => (ok ? present : missing).push(field);

	push('objective', clean(task?.objective) !== undefined);
	push('purpose', clean(task?.purpose) !== undefined);
	push(
		'acceptance criteria',
		Array.isArray(task?.acceptanceCriteria) &&
			task.acceptanceCriteria.some((c) => clean(c) !== undefined)
	);

	return { have: present.length, of: CONTEXT_FIELDS.length, present, missing };
}

/**
 * The completeness chip's TOOLTIP: what the `n/3` is counting, named field by field.
 *
 * A bare `why/how 1/3` is a number without a referent — the operator cannot tell WHICH context the
 * executing model will be missing. Naming the absent fields is the difference between an honest
 * count and a score.
 */
export function completenessHint(c: ContextCompleteness | null | undefined): string {
	const have = safeCount(c?.have);
	const of = safeCount(c?.of) || CONTEXT_FIELDS.length;
	if (!c || have === 0) return `no objective, purpose or acceptance criteria stored (0 of ${of})`;
	if (have >= of) return `objective, purpose and acceptance criteria all stored (${have} of ${of})`;
	return `${have} of ${of} stored · missing: ${c.missing.join(', ')}`;
}

// ── Predicates ─────────────────────────────────────────────────────────────────────────────

/** Does the task's title (or id) contain the free-text query? Blank query → every task matches. */
export function matchesBoardQuery(task: BoardTask | null | undefined, query: string): boolean {
	const q = clean(query)?.toLowerCase();
	if (!q) return true;
	if (!task) return false;
	// Title only, per §5.4. The id is included so a pasted `task:…` finds its own card — searching
	// the DESCRIPTION is deliberately NOT done: it is the run seed and for pm tasks it embeds the
	// objective/purpose prose, which would make a query match cards whose visible text lacks it.
	const title = clean(task.title)?.toLowerCase() ?? '';
	const id = clean(task.id)?.toLowerCase() ?? '';
	return title.includes(q) || id.includes(q);
}

/** Does the task carry EVERY filtered tag (AND, per §5.4)? Empty filter → every task matches. */
export function matchesBoardTags(
	task: BoardTask | null | undefined,
	tags: readonly string[] | null | undefined
): boolean {
	const want = (tags ?? []).map((t) => clean(t)?.toLowerCase()).filter((t): t is string => !!t);
	if (want.length === 0) return true;
	if (!task) return false;
	const have = taskTags(task);
	return want.every((t) => have.includes(t));
}

/** Does one task satisfy the WHOLE view? The detail selection is not consulted — it never filters. */
export function matchesBoardView(
	task: BoardTask | null | undefined,
	view: BoardView | null | undefined
): boolean {
	if (!task) return false;
	const v = view ?? DEFAULT_BOARD_VIEW;
	if (!matchesBoardQuery(task, v.query)) return false;
	if (!matchesBoardTags(task, v.tags)) return false;
	if (v.priority && clean(task.priority) !== v.priority) return false;
	if (v.origin && clean(task.origin) !== v.origin) return false;
	if (v.status && clean(task.status) !== v.status) return false;
	return true;
}

/** Apply every filter, preserving the loader's newest-first ordering. */
export function filterBoardTasks(
	rows: readonly (BoardTask | null | undefined)[] | null | undefined,
	view: BoardView | null | undefined
): BoardTask[] {
	const out: BoardTask[] = [];
	for (const r of rows ?? []) {
		if (!r) continue;
		if (!matchesBoardView(r, view)) continue;
		out.push(r);
	}
	return out;
}

// ── Options + counts ───────────────────────────────────────────────────────────────────────

/**
 * The count each "any / every" option would leave visible — that axis CLEARED, every OTHER filter
 * still in force.
 *
 * LIVE-VERIFIED DEFECT (2026-08-05, browser, `?origin=pm&tag=ghost` on atelier_self): the widening
 * options were hardcoded to the loaded-row total, so the Priority control read `any (5)` and the
 * Origin control read `any (5)` beside a board rendering ZERO cards and a footer correctly stating
 * `showing 0 of 5 tasks · 5 hidden by filters`. The header contradicted the body in the one control
 * whose job is to say what widening would do — the same head-vs-list class this module exists to
 * prevent, arriving through the one number that was NOT derived from a filtered set.
 *
 * Every widening option is therefore a MEASURED count like every narrowing one: clearing `origin`
 * while `tag=ghost` stands really does show 0, and the control now says so.
 */
export interface BoardClearedCounts {
	priority: number;
	origin: number;
	status: number;
	tags: number;
}

/** One selectable filter value with the real number of rows it would leave visible. */
export interface BoardOption {
	value: string;
	label: string;
	count: number;
	/**
	 * TRUE for an option present ONLY because it is the currently-selected value that no loaded row
	 * matches any more (a stale/shared link, or another filter excluded it). Kept and flagged, never
	 * silently dropped — a control that hides what is filtering the list lies about the list.
	 */
	stale?: boolean;
}

/**
 * Count how many rows would remain if `patch` were applied on top of `view` — the honest count for
 * every filter control, computed against the OTHER filters already in force.
 *
 * This is what makes a `0` mean "selecting this shows nothing" rather than "this value does not
 * exist anywhere", and it is why no option is ever offered that cannot match.
 */
function countWith(
	rows: readonly BoardTask[],
	view: BoardView,
	patch: Partial<BoardView>
): number {
	const probe: BoardView = { ...view, ...patch };
	let n = 0;
	for (const r of rows) if (matchesBoardView(r, probe)) n += 1;
	return n;
}

/** Distinct values of one scalar field across the rows, in first-seen order. */
function distinct(rows: readonly BoardTask[], pick: (t: BoardTask) => string | undefined): string[] {
	const out: string[] = [];
	for (const r of rows) {
		const v = clean(pick(r));
		if (v && !out.includes(v)) out.push(v);
	}
	return out;
}

/**
 * Build the option list for one scalar filter (priority / origin / status).
 *
 * `order` — when supplied (the canonical status/priority vocabulary) — fixes the display order so
 * the controls do not reshuffle as rows arrive; values outside it keep first-seen order after.
 * A selected value with no matching row is APPENDED as a `stale` 0-count option (see BoardOption).
 */
export function boardScalarOptions(
	rows: readonly (BoardTask | null | undefined)[] | null | undefined,
	view: BoardView | null | undefined,
	field: 'priority' | 'origin' | 'status',
	order?: readonly string[] | null
): BoardOption[] {
	const all = (rows ?? []).filter((r): r is BoardTask => !!r);
	const v = view ?? DEFAULT_BOARD_VIEW;
	const seen = distinct(all, (t) => t[field]);
	const ordered = order?.length
		? [...order.filter((o) => seen.includes(o)), ...seen.filter((s) => !order.includes(s))]
		: seen;

	const options: BoardOption[] = ordered.map((value) => ({
		value,
		label: value,
		// The option's own field is UNSET in the probe so the count is "what selecting this shows",
		// not "what it shows on top of the value already selected" (which would print 0 for every
		// non-selected option the moment a filter is engaged).
		count: countWith(all, v, { [field]: value } as Partial<BoardView>)
	}));

	const selected = clean(v[field]);
	if (selected && !options.some((o) => o.value === selected)) {
		options.push({ value: selected, label: selected, count: 0, stale: true });
	}
	return options;
}

/**
 * The tag chips, each with the count it would leave visible if ADDED to the current tag filter
 * (they AND, §5.4) — so a chip reading `0` genuinely means "adding this shows nothing".
 *
 * Sorted by count descending then alphabetically: the operator's most-used reminder leads. A
 * SELECTED tag that no visible row carries is kept as a `stale` option — de-selecting it is the
 * only way out of that dead end and the chip must therefore stay present and pressable.
 */
export function boardTagOptions(
	rows: readonly (BoardTask | null | undefined)[] | null | undefined,
	view: BoardView | null | undefined
): BoardOption[] {
	const all = (rows ?? []).filter((r): r is BoardTask => !!r);
	const v = view ?? DEFAULT_BOARD_VIEW;
	const active = (v.tags ?? []).map((t) => t.toLowerCase());

	const universe: string[] = [];
	for (const r of all) for (const t of taskTags(r)) if (!universe.includes(t)) universe.push(t);

	const options: BoardOption[] = universe.map((tag) => {
		const on = active.includes(tag);
		// An ACTIVE chip's count is "what it shows now" (removing it can only widen); an INACTIVE
		// chip's is "what adding it would leave" — both are counts of a real, reachable set.
		const probeTags = on ? active : [...active, tag];
		return { value: tag, label: tag, count: countWith(all, v, { tags: probeTags }) };
	});

	options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

	for (const tag of active) {
		if (!options.some((o) => o.value === tag)) {
			options.push({ value: tag, label: tag, count: 0, stale: true });
		}
	}
	return options;
}

/**
 * Is a filter chip a DEAD option that should be disabled?
 *
 * The `fleet-view.ts` rule, ported verbatim in spirit (its doc records the measured defect where
 * the one control meaning "stop narrowing" was the only one disabled):
 *   • an ACTIVE chip stays clickable — it must be un-settable, or the operator is stuck;
 *   • any other chip with a real `0` is disabled — offering a narrowing filter that cannot match
 *     would be a lie about the data (F-008).
 */
export function isBoardChipDisabled(count: number, active: boolean): boolean {
	if (active) return false;
	return !(typeof count === 'number' && count > 0);
}

// ── Columns ────────────────────────────────────────────────────────────────────────────────

/** One board column: its status, the rows RENDERED in it, and its unfiltered total. */
export interface BoardColumn {
	status: string;
	/** The tasks the page renders in this column — the array the header's count is taken FROM. */
	tasks: BoardTask[];
	/** `tasks.length`, named so a template can never reach for a different number. */
	shown: number;
	/** How many tasks this status holds across ALL loaded rows, before any filter. */
	total: number;
	/** `total - shown` — the rows this column is hiding right now. Never conflated with `shown`. */
	hidden: number;
}

/**
 * Group the VISIBLE tasks into columns, carrying each status's unfiltered total alongside.
 *
 * The two numbers are computed from two different arrays ON PURPOSE and are never interchangeable:
 * `shown` comes from the grouped visible rows (so the header equals the list), `total` from the
 * full loaded set (so "this column is empty" and "this column's tasks are filtered out" stay
 * distinguishable). {@link columnCountLabel} is the only place they are printed together.
 *
 * Statuses are emitted in the CANONICAL order given, including empty ones — a board that drops its
 * empty columns hides the shape of the workflow.
 */
export function boardColumns(
	visible: readonly (BoardTask | null | undefined)[] | null | undefined,
	all: readonly (BoardTask | null | undefined)[] | null | undefined,
	statuses: readonly string[] | null | undefined
): BoardColumn[] {
	const order = (statuses ?? []).filter((s): s is string => !!clean(s));
	const shownBy = new Map<string, BoardTask[]>();
	const totalBy = new Map<string, number>();

	for (const r of all ?? []) {
		const s = clean(r?.status);
		if (!s) continue;
		totalBy.set(s, (totalBy.get(s) ?? 0) + 1);
	}
	for (const r of visible ?? []) {
		if (!r) continue;
		const s = clean(r.status);
		if (!s) continue;
		const bucket = shownBy.get(s);
		if (bucket) bucket.push(r);
		else shownBy.set(s, [r]);
	}

	// A status carried by a row but ABSENT from the canonical vocabulary still gets a column — a
	// task the board cannot show is worse than a column the vocabulary did not predict (F-008).
	const extras = [...totalBy.keys()].filter((s) => !order.includes(s)).sort();

	return [...order, ...extras].map((status) => {
		const tasks = shownBy.get(status) ?? [];
		const total = totalBy.get(status) ?? 0;
		return { status, tasks, shown: tasks.length, total, hidden: Math.max(0, total - tasks.length) };
	});
}

/**
 * A column header's count label.
 *
 * Unfiltered → the bare count (`8`), because `8 of 8` is noise. Filtered → `3 of 8`, where the
 * FIRST number is always what is rendered below it. The pair is only ever built here, from a
 * {@link BoardColumn} whose `shown` came from the very array the template iterates — which is what
 * makes the header-vs-list contradiction structurally impossible rather than merely tested-for.
 */
export function columnCountLabel(column: BoardColumn | null | undefined, filtered: boolean): string {
	const shown = safeCount(column?.shown);
	const total = safeCount(column?.total);
	return filtered ? `${shown} of ${total}` : `${shown}`;
}

// ── The board's one honest summary line ────────────────────────────────────────────────────

/** A human phrase for each engaged filter, for the summary line and the filtered-empty copy. */
export function filterSummary(view: BoardView | null | undefined): string | null {
	const v = view ?? DEFAULT_BOARD_VIEW;
	const parts: string[] = [];
	const q = clean(v.query);
	if (q) parts.push(`title contains "${q}"`);
	if ((v.tags ?? []).length) parts.push(`tags ${v.tags.join(' + ')}`);
	if (clean(v.priority)) parts.push(`priority ${v.priority}`);
	if (clean(v.origin)) parts.push(`origin ${v.origin}`);
	if (clean(v.status)) parts.push(`status ${v.status}`);
    return parts.length ? parts.join(' · ') : null;
}

/**
 * The board's footer line: how many tasks are SHOWN, out of how many exist, and — explicitly —
 * how many the filters are HIDDEN and why.
 *
 * The shape is the shipped house convention (`/claude-code`'s `showing N of M` plus an explicit
 * statement of what is hidden). The two numbers here are `visible` and `total`, and `hidden` is
 * stated as its own named quantity with its own word — never as the numerator of a second "N of M",
 * which is exactly the inversion `fleetCollapsedSummary` documents shipping once already.
 *
 * Shadow paths: nil/garbage counts → 0 (never `NaN of undefined`); unfiltered → no hidden clause,
 * because "0 hidden" beside no filter controls is noise, not disclosure.
 */
export function boardSummaryLine(
	visible: number,
	total: number,
	view: BoardView | null | undefined
): string {
	const shown = safeCount(visible);
	const all = safeCount(total);
	const head = `showing ${shown} of ${all} task${all === 1 ? '' : 's'}`;
	const filter = filterSummary(view);
	if (!filter) return head;
	const hidden = Math.max(0, all - shown);
	return `${head} · ${hidden} hidden by filters (${filter})`;
}

// ── Detail selection ───────────────────────────────────────────────────────────────────────

/**
 * The outcome of resolving `?task=` against the loaded rows.
 *
 * `requested` without `task` is a NAMED state, not an empty panel: a shared link to a task that was
 * withdrawn, belongs to another project, or was never real must SAY so (§5.2's "honest 404-state
 * inside the panel"). Rendering nothing would read as "this task has no fields".
 */
export interface BoardSelection {
	/** The id the URL asked for, or null. */
	requested: string | null;
	/** The resolved task, or null when the id matched nothing loaded. */
	task: BoardTask | null;
	/** TRUE when an id was requested and nothing matched — the panel's honest not-found state. */
	notFound: boolean;
}

/**
 * Resolve `?task=` against the loaded rows. Total — never throws.
 *
 * Deliberately matched against the SAME loaded array the board renders (§5.2: one loader, one live
 * surface) — so a task that exists in the DB but not in this project's rows resolves to `notFound`,
 * which is the correct answer for a per-project board.
 */
export function selectBoardTask(
	rows: readonly (BoardTask | null | undefined)[] | null | undefined,
	requestedId: string | null | undefined
): BoardSelection {
	const requested = clean(requestedId) ?? null;
	if (!requested) return { requested: null, task: null, notFound: false };
	const task = (rows ?? []).find((r) => !!r && r.id === requested) ?? null;
	return { requested, task: task ?? null, notFound: !task };
}

// ── Labels (every human-facing label goes through the shared composer) ─────────────────────

/**
 * The human label for a RECORD LINK the detail panel shows (parent, revision_of, superseded_by,
 * proposed_by).
 *
 * Routed through the shared composer's {@link stripRecordId} per the standing operator rule: a
 * label must convey PURPOSE, and a raw `task:gq3glfee2zcw993suhto` conveys none. When the id is a
 * pure auto-id the composer returns null and this returns the honest `'—'` rather than a
 * meaningless token dressed as a name; the page renders the id separately as an id (mono) for
 * traceability.
 *
 * Shadow paths: nil/blank → `'—'`; a non-string (upstream error) → `'—'`, never `"undefined"`.
 */
export function linkLabel(value: unknown): string {
	return stripRecordId(value) ?? '—';
}

/**
 * The label for a task's ORIGIN — the "who asked for this" badge.
 *
 * `follow_up` reads as `follow-up` and `pm` as `pm (project manager)`: the vocabulary is a stored
 * enum (`TASK_ORIGINS`), and a two-letter enum token is exactly the "tells you nothing" class the
 * naming rule targets. Unknown tokens pass through verbatim — inventing a friendly name for a value
 * we do not recognise would be the fabrication the rule also forbids.
 */
export function originLabel(origin: unknown): string {
	const o = clean(origin);
	if (!o) return '—';
	if (o === 'pm') return 'pm (project manager)';
	if (o === 'follow_up') return 'follow-up';
	return o;
}

// ── One-pass resolution ────────────────────────────────────────────────────────────────────

/** Everything the board needs to render in one pass. */
export interface ResolvedBoard {
	view: BoardView;
	/** Total loaded rows, before any filter. */
	total: number;
	/** The rows that pass every filter — the SAME array the columns are grouped from. */
	visible: BoardTask[];
	columns: BoardColumn[];
	tagOptions: BoardOption[];
	priorityOptions: BoardOption[];
	originOptions: BoardOption[];
	statusOptions: BoardOption[];
	/** What each "any / every" widening option would leave visible (see {@link BoardClearedCounts}). */
	clearedCounts: BoardClearedCounts;
	selection: BoardSelection;
	filtered: boolean;
	/** TRUE when rows exist and the filters matched none — the honest filtered-empty (F-008). */
	filteredEmpty: boolean;
	/** TRUE when any engaged filter value matches no loaded row (a stale/shared link). */
	staleFilter: boolean;
	/** The footer line — `showing N of M` + what is hidden. */
	summaryLine: string;
}

/**
 * Resolve the whole board from the loaded rows + the URL view.
 *
 * Shadow paths: nil rows → an empty board with the view intact and `filteredEmpty:false` (the
 * page's own "no tasks yet" copy owns that case, which is a different fact from "filtered to
 * nothing"); an unknown filter token → kept, counted as 0, flagged `staleFilter` so the page offers
 * Clear; a nil `statuses` vocabulary → columns derived from the rows themselves.
 */
export function resolveBoard(
	rows: readonly (BoardTask | null | undefined)[] | null | undefined,
	view: BoardView | null | undefined,
	statuses: readonly string[] | null | undefined,
	priorities?: readonly string[] | null
): ResolvedBoard {
	const all = (rows ?? []).filter((r): r is BoardTask => !!r);
	const v: BoardView = view ? { ...view, tags: [...(view.tags ?? [])] } : { ...DEFAULT_BOARD_VIEW, tags: [] };

	const visible = filterBoardTasks(all, v);
	const columns = boardColumns(visible, all, statuses);
	const tagOptions = boardTagOptions(all, v);
	const priorityOptions = boardScalarOptions(all, v, 'priority', priorities);
	const originOptions = boardScalarOptions(all, v, 'origin');
	const statusOptions = boardScalarOptions(all, v, 'status', statuses);
	const filtered = isBoardFiltered(v);

	const staleFilter =
		tagOptions.some((o) => o.stale) ||
		priorityOptions.some((o) => o.stale) ||
		originOptions.some((o) => o.stale) ||
		statusOptions.some((o) => o.stale);

	return {
		view: v,
		total: all.length,
		visible,
		columns,
		tagOptions,
		priorityOptions,
		originOptions,
		statusOptions,
		clearedCounts: {
			priority: countWith(all, v, { priority: null }),
			origin: countWith(all, v, { origin: null }),
			status: countWith(all, v, { status: null }),
			tags: countWith(all, v, { tags: [] })
		},
		selection: selectBoardTask(all, v.task),
		filtered,
		filteredEmpty: all.length > 0 && visible.length === 0,
		staleFilter,
		summaryLine: boardSummaryLine(visible.length, all.length, v)
	};
}
