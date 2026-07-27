/**
 * FLEET VIEW — the pure view model behind the /claude-code session-fleet filters + collapse.
 *
 * OPERATOR ASK (2026-07-26, verbatim): *"the session fleet for claude code section should be
 * filterable by project, failure, or collapseable. to keep the page from getting to tall."*
 *
 * This module owns the WHOLE decision surface — parse, options, counts, predicate, filter, and
 * the URL round-trip — as pure, dependency-free functions so it can be unit-tested without a
 * browser and re-used by both the loader and the `.svelte` call site. No runes live here (F-009:
 * runes only compile in `.svelte`/`.svelte.ts`); the page holds the `$derived` wrappers.
 *
 * ── Why URL params ───────────────────────────────────────────────────────────────────────
 * Filter + collapse state survives a reload because it lives in the URL (`?fleet=`,
 * `?fleetProject=`, `?fleetState=`) — shareable, and it invents no storage mechanism (no
 * localStorage, no server-side view row). The page writes them with SvelteKit's shallow
 * `replaceState` so a filter click does NOT re-run the loader and re-pull the whole config
 * catalog (the page's DEFECT-2 "invalidate storm" rule); the loader never reads these params, so
 * the LT-1 trap — a replaceState-injected param that a re-invalidated loader cannot see — cannot
 * apply here.
 *
 * NOT back/forward-able, and the doc used to claim otherwise: `replaceState` REPLACES the current
 * history entry (kit client.js:2516 → `history.replaceState`), so a filter click is reachable by
 * reload or by sharing the address, never by pressing Back. Stated plainly here because the
 * page's re-seed rule ({@link reseedFleetView}) is built on exactly this history behaviour.
 *
 * ── Honesty (F-008) ──────────────────────────────────────────────────────────────────────
 * Every option offered is DERIVED FROM THE LOADED ROWS and carries its real count, so the UI
 * can never present a filter that cannot match. The fleet itself is a BOUNDED WINDOW (the
 * loader's `listFleetAcrossProjects(db, LIMIT)`) — the page discloses that bound next to the
 * filters, because "project X has no failures" and "project X's failures are older than the
 * window" are different facts and must not be conflated.
 *
 * ── The failure predicate is DERIVED, not invented ───────────────────────────────────────
 * `session.status` is `ASSERT $value IN ["running","done","failed","cancelled"]`
 * (`schema.ts:130-131`), so a HARD failure is exactly `status === 'failed'` — the same predicate
 * `SessionFailureReason.svelte:45` uses to raise its error banner. That component ALSO banners a
 * non-failed session that carries a `session.note` (`:48` — the WI-3 "work preserved on branch,
 * merge needed" advisory), so the broader `attention` filter is defined as *exactly the set of
 * rows this page already flags*: failed, or carrying a note. Nothing is invented; `cancelled`
 * with no note is a clean operator stop and is deliberately NOT called a failure.
 *
 * ── Shadow paths, all four, on every exported function ───────────────────────────────────
 *   • happy — real rows / real params → the composed view.
 *   • nil   — `null`/`undefined` rows, list, or params → the default view / an empty result.
 *   • empty — a zero-length list, a blank param value, a whitespace-only note → treated as
 *             absent, never as a match.
 *   • upstream error — an unknown state token, a stale project id no longer in the window, a
 *             non-string field → absorbed into an honest default + a `staleProject` flag the
 *             page renders as a named state. Nothing here throws.
 */

import { stripRecordId } from '$lib/shared/naming';

/**
 * How many sessions the cross-project fleet window carries (newest-first, TASK 9.3) — the
 * `listFleetAcrossProjects` limit the loader passes, and the bound the page DISCLOSES next to the
 * filters (F-008): with a project/failure filter engaged, "this project has no failures" and
 * "this project's failures are older than the window" are different facts, and a filtered-empty
 * list must not be read as portfolio-wide coverage.
 *
 * It lives here, not in `+page.server.ts`, because SvelteKit rejects any non-reserved export from
 * a `+page.server.ts` ("Invalid export 'FLEET_LIMIT'") — and because the loader and the page must
 * agree on ONE number rather than each hardcoding its own.
 */
export const FLEET_LIMIT = 40;

/** URL param: whether the fleet section is expanded (`open`) or collapsed (`closed`). */
export const FLEET_PARAM_OPEN = 'fleet';
/** URL param: the project filter — a `project:…` record id, or {@link FLEET_NO_PROJECT}. */
export const FLEET_PARAM_PROJECT = 'fleetProject';
/** URL param: the state filter — one of {@link FLEET_STATE_FILTERS}. */
export const FLEET_PARAM_STATE = 'fleetState';

/**
 * The sentinel project value meaning "sessions with NO project link" (a bare chat).
 *
 * It cannot collide with a real project id: `assertRecordId` (`db/validate.ts:18`) requires a
 * `table:id` shape, so every real `projectId` contains a `:` and `'none'` never can.
 */
export const FLEET_NO_PROJECT = 'none';

/** The state filters the section offers. `attention` is a SUPERSET of `failed` (see below). */
export const FLEET_STATE_FILTERS = ['all', 'running', 'failed', 'attention'] as const;
export type FleetStateFilter = (typeof FLEET_STATE_FILTERS)[number];

/** The short chip label per state filter. */
export const FLEET_STATE_LABELS: Record<FleetStateFilter, string> = {
	all: 'all',
	running: 'running',
	failed: 'failed',
	attention: 'needs attention'
};

/**
 * The honest, verbatim predicate behind each chip — rendered as the chip's `title`/description so
 * the operator can see WHAT "failed" means here rather than trusting a word (F-008).
 */
export const FLEET_STATE_HINTS: Record<FleetStateFilter, string> = {
	all: 'every session in the window',
	running: 'session.status = running',
	failed: 'session.status = failed',
	attention: 'failed, or carrying an operator note (the rows this page already flags)'
};

/**
 * The chip's hint, QUALIFIED by the project scope actually in force.
 *
 * LIVE-VERIFIED DEFECT (2026-07-26, browser, `?fleetProject=project:ghost&fleetState=failed`): the
 * `all` chip rendered its static hint *"every session in the window"* beside a badge reading `0`
 * while the window held 40. Both come from the same code — the badge is
 * {@link fleetStateCounts}, which is deliberately scoped to the selected project, while the hint
 * was window-wide prose — so the control contradicted itself (F-008, the same head-vs-body
 * contradiction {@link fleetCountScopeNote} exists to close on the head).
 *
 * The counts stay project-scoped (that is what makes a `0` mean "selecting this shows nothing");
 * the hint SAYS SO. Unscoped → the base predicate verbatim, unchanged.
 */
export function fleetStateHint(state: FleetStateFilter, scope: string | null | undefined): string {
	const base = FLEET_STATE_HINTS[state] ?? FLEET_STATE_HINTS.all;
	const s = clean(scope);
	return s ? `${base} · within ${s}` : base;
}

/**
 * Is a state chip a DEAD option that should be disabled?
 *
 * LIVE-VERIFIED DEFECT (2026-07-26, browser): the rule was a bare `count === 0 && !active`, which
 * disabled `all` — the WIDEN action — exactly in the dead end. Measured at
 * `?fleetProject=project:ghost&fleetState=failed`: `all 0 [DISABLED] · running 0 [DISABLED] ·
 * failed 0 · needs attention 0 [DISABLED]`, i.e. the one chip meaning "stop narrowing by state"
 * was the one the operator could not press.
 *
 * Three rules, in order:
 *   • the ACTIVE chip stays clickable — it must be un-settable;
 *   • `all` is never disabled — it is not a filter that can "fail to match", it is the un-set of
 *     the state filter, and a control whose only job is to widen must never be dead;
 *   • any other chip with a real `0` is disabled — offering a narrowing filter that cannot match
 *     would be a lie about the data (F-008).
 */
export function isFleetStateChipDisabled(
	state: FleetStateFilter,
	count: number,
	active: boolean
): boolean {
	if (active) return false;
	if (state === 'all') return false;
	return !(typeof count === 'number' && count > 0);
}

/** The resolved fleet view: which project, which state, and whether the section is expanded. */
export interface FleetView {
	/** A `project:…` id, {@link FLEET_NO_PROJECT}, or `null` for "every project". */
	project: string | null;
	state: FleetStateFilter;
	/** TRUE when the section body is expanded. Default TRUE — collapsing hides data, so it is
	 *  never the silent default; the operator opts in and the choice persists in the URL. */
	open: boolean;
}

/** The default view: everything, expanded. */
export const DEFAULT_FLEET_VIEW: FleetView = { project: null, state: 'all', open: true };

/**
 * The only row fields this module reads. Structural, so `FleetSessionXP` (analytics/fleet.ts)
 * satisfies it without this module importing a server type into a shared/client path.
 */
export interface FleetFilterRow {
	status: string;
	projectId: string | null;
	projectName: string | null;
	note: string | null;
}

/** Trimmed non-empty string, or `undefined`. Absorbs nil / blank / non-string (upstream error). */
function clean(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const s = v.trim();
	return s ? s : undefined;
}

/** TRUE when `v` is one of the known state tokens. Narrows for the parser. */
export function isFleetStateFilter(v: unknown): v is FleetStateFilter {
	return typeof v === 'string' && (FLEET_STATE_FILTERS as readonly string[]).includes(v);
}

/**
 * Parse the fleet view out of a URL's search params. Total — never throws.
 *
 *   `?fleet=closed&fleetState=failed&fleetProject=project:atelier`
 *      → `{ open:false, state:'failed', project:'project:atelier' }`
 *   `?fleetState=bogus`   → state `'all'`   (unknown token → honest default, not a crash)
 *   `?fleetProject=`      → project `null`  (blank → absent)
 *   `null` / `undefined`  → {@link DEFAULT_FLEET_VIEW}
 */
export function parseFleetView(params: URLSearchParams | null | undefined): FleetView {
	if (!params || typeof params.get !== 'function') return { ...DEFAULT_FLEET_VIEW };
	const rawState = clean(params.get(FLEET_PARAM_STATE));
	const rawProject = clean(params.get(FLEET_PARAM_PROJECT));
	const rawOpen = clean(params.get(FLEET_PARAM_OPEN))?.toLowerCase();
	return {
		project: rawProject ?? null,
		state: isFleetStateFilter(rawState) ? rawState : 'all',
		// Only the explicit `closed` collapses. Any other value (including a typo) keeps the
		// section expanded — a malformed param must never silently hide the fleet.
		open: rawOpen !== 'closed'
	};
}

/**
 * Write a view back into a copy of the current search params, DROPPING every default so a
 * pristine view leaves the URL clean (and `?session=` and anything else is preserved).
 */
export function applyFleetViewToParams(
	current: URLSearchParams | null | undefined,
	view: FleetView
): URLSearchParams {
	const out = new URLSearchParams(current ?? undefined);
	if (view.project) out.set(FLEET_PARAM_PROJECT, view.project);
	else out.delete(FLEET_PARAM_PROJECT);
	if (view.state !== 'all') out.set(FLEET_PARAM_STATE, view.state);
	else out.delete(FLEET_PARAM_STATE);
	if (!view.open) out.set(FLEET_PARAM_OPEN, 'closed');
	else out.delete(FLEET_PARAM_OPEN);
	return out;
}

/**
 * The outcome of {@link reseedFleetView}: the href to remember, and the view to ADOPT (or `null`
 * when the live view must be left exactly as the operator set it).
 */
export interface FleetSeedDecision {
	/** The href the caller should record as "the last one we seeded from". */
	href: string;
	/** A view to adopt, or `null` for "change nothing". */
	view: FleetView | null;
}

/**
 * Should a republished `page.url` re-seed the live view? — the rule that separates a REAL
 * NAVIGATION from a mere re-publish.
 *
 * ── Why the href alone is NOT the rule (regression, 2026-07-26, measured on :5174) ───────
 * The first cut of this function keyed the whole decision on `href === seededHref`. That is
 * correct for the invalidate path and WRONG for a same-href navigation, and both exist:
 *   • load `/claude-code` → the seeded href is the bare address;
 *   • click the `failed` chip → `syncFleetUrl` writes `?fleetState=failed` with `replaceState`,
 *     which updates the address bar and `page.state` but NEVER `page.url` (kit 2.63.0
 *     client.js:2489-2521 — `history.replaceState` + `page.state = state` + a re-clone, with no
 *     `page.url` assignment; only `update_url` at client.js:2923 assigns it);
 *   • click the sidebar self-link `a[href="/claude-code"]` → kit performs a REAL navigation whose
 *     url equals the seeded href, so the href test called it a re-publish and adopted nothing.
 * Measured result: the address bar dropped back to `/claude-code` while `failed 32` stayed
 * aria-pressed over 32 rows — the URL and the UI disagreed, a reload silently swung 32 rows to 40,
 * and copying the address yielded a link that did not reproduce the view, breaking this module's
 * own shareable contract (:14).
 *
 * Advancing the seeded href inside `syncFleetUrl` would RE-OPEN the defect below, because an
 * invalidate re-publishes the ORIGINAL bare href, which would then no longer match and would parse
 * as the default. The href genuinely CANNOT distinguish the two paths — a second, independent
 * signal is required, and the caller passes it in as {@link reseedFleetView} `navigated` rather
 * than this pure module importing kit runtime state.
 *
 * ── The signal, verified in kit 2.63.0 source ────────────────────────────────────────────
 * `afterNavigate` fires from exactly two places: the hydration path (client.js:724, with
 * `type:'enter'`) and the tail of `navigate()` (client.js:1987, after `update_url` at :2923 has
 * assigned `page.url`). `_invalidate` (client.js:405-488) calls `update(...)` + `root.$set(...)`
 * directly and touches NEITHER `after_navigate_callbacks` NOR `navigating` (:1713); `replaceState`
 * (:2489-2521) touches neither either. So "an `afterNavigate` fired since we last seeded" is TRUE
 * for every real navigation — including a same-href one — and FALSE for every invalidate
 * re-publish and every filter click. That is the discriminator the href could not provide.
 *
 * LIVE-VERIFIED DEFECT (2026-07-26, browser, :5174). The page re-seeded `fleetView` from
 * `page.url.searchParams` on every `page` change. `page` is republished by every `invalidate`,
 * and this page invalidates `app:fleet` on EVERY `session` row change (`+page.svelte` onDbChange)
 * — the one page whose whole subject is running sessions. But `replaceState` never writes
 * `page.url` (kit client.js:2490-2522 — the premise the URL mirror is built on), so the
 * republished `page.url` is still the URL of the last real navigation, WITHOUT the operator's
 * filter params. Measured: filter `failed` + collapsed → `?fleetState=failed&fleet=closed`,
 * `aria-expanded=false`, 0 rows; one `invalidate('app:fleet')` later → SAME URL,
 * `aria-expanded=true`, 40 rows. The filter and the collapse were wiped by the page's own live
 * stream, and the URL and the UI then disagreed, so a reload "fixed" it and it read as flaky.
 *
 * The fix is to key the re-seed on the href actually CHANGING. A re-publish carries an identical
 * href → nothing is adopted (the live view wins, because it is strictly newer than that URL). A
 * real navigation — a transcript link, a shared link, back/forward — carries a different href →
 * its params win, which is the behaviour the re-seed existed for.
 *
 * Total; never throws. nil url → keep the recorded href and change nothing. An identical parse
 * (a navigation to a URL that happens to express the same view) reports the new href with
 * `view:null`, so the caller never writes a redundant `$state` update.
 *
 * @param navigated TRUE when this publish was caused by a REAL navigation (the caller saw an
 *   `afterNavigate`). Defaults to FALSE — the conservative value: an un-signalled same-href
 *   publish is read as a re-publish and the operator's live view is kept, which is exactly the
 *   invalidate-path behaviour this function was written for. A DIFFERENT href re-seeds regardless
 *   of the flag, so a caller with no navigation signal at all loses nothing it had before.
 */
export function reseedFleetView(
	seededHref: string | null | undefined,
	url: { href?: string; searchParams?: URLSearchParams } | null | undefined,
	current: FleetView | null | undefined,
	navigated: boolean = false
): FleetSeedDecision {
	const prev = typeof seededHref === 'string' ? seededHref : '';
	const href = clean(url?.href);
	// nil / unusable url (SSR, a mangled object) — never discard what the operator has set, and
	// never report the navigation as consumed: the caller keeps the flag for its next run, when a
	// usable url may finally be present.
	if (!href) return { href: prev, view: null };
	// A RE-PUBLISH, not a navigation: same address AND no navigation fired, so it carries no newer
	// intent than the live view. This is the invalidate path — the one that used to wipe the
	// filter. A same-href REAL navigation (`navigated`) falls through to the parse below instead,
	// because the operator did address that URL and its params must win.
	if (href === prev && navigated !== true) return { href: prev, view: null };

	const parsed = parseFleetView(url?.searchParams);
	const now = current ?? DEFAULT_FLEET_VIEW;
	const same = parsed.project === now.project && parsed.state === now.state && parsed.open === now.open;
	return { href, view: same ? null : parsed };
}

/** TRUE when the view is the untouched default (nothing filtered, expanded). */
export function isDefaultFleetView(view: FleetView | null | undefined): boolean {
	return !view || (!view.project && view.state === 'all' && view.open);
}

/** TRUE when either FILTER is engaged (collapse alone is not a filter). */
export function isFleetFiltered(view: FleetView | null | undefined): boolean {
	return !!view && (!!view.project || view.state !== 'all');
}

// ── Predicates ────────────────────────────────────────────────────────────────────────────

/** A HARD failure: `session.status === 'failed'` (schema.ts:130-131). */
export function isFleetFailure(row: FleetFilterRow | null | undefined): boolean {
	return clean(row?.status) === 'failed';
}

/** Live: `session.status === 'running'` — never a pool/slot flag (UI-SPEC §199). */
export function isFleetRunning(row: FleetFilterRow | null | undefined): boolean {
	return clean(row?.status) === 'running';
}

/**
 * The set this page already flags with a `<SessionFailureReason>` banner: a hard failure, OR any
 * session carrying an operator-visible note (the WI-3 merge-preserved advisory). A whitespace-only
 * note is NOT a note.
 */
export function fleetNeedsAttention(row: FleetFilterRow | null | undefined): boolean {
	if (!row) return false;
	return isFleetFailure(row) || clean(row.note) !== undefined;
}

/** Does one row satisfy a state filter? An unknown filter degrades to `all` (never drops rows). */
export function matchesFleetState(
	row: FleetFilterRow | null | undefined,
	state: FleetStateFilter
): boolean {
	if (!row) return false;
	switch (state) {
		case 'running':
			return isFleetRunning(row);
		case 'failed':
			return isFleetFailure(row);
		case 'attention':
			return fleetNeedsAttention(row);
		default:
			return true;
	}
}

/**
 * The project FILTER KEY for a row: its `project:…` id, or {@link FLEET_NO_PROJECT} when the
 * session has no project link (an honest "no project", never an invented bucket).
 */
export function fleetProjectKey(row: FleetFilterRow | null | undefined): string {
	return clean(row?.projectId) ?? FLEET_NO_PROJECT;
}

/**
 * The human label for a project key. `projectName` wins; a name-less row falls back to the
 * SHARED naming composer's `stripRecordId` (LB-2) so `project:card_draw_control` reads
 * `card_draw_control` and an opaque auto-id honestly reads `unnamed project` — never a raw id.
 */
export function fleetProjectLabel(key: string, name: string | null | undefined): string {
	if (key === FLEET_NO_PROJECT) return 'no project';
	return clean(name) ?? stripRecordId(key) ?? 'unnamed project';
}

/**
 * What the section's HEADING is actually showing right now.
 *
 * LIVE-VERIFIED DEFECT (2026-07-26, browser): the head read a hardcoded `session fleet · all
 * projects` even with a project filter engaged — so a screen-reader user collapsing the section
 * heard "all projects" while the list held four `bepinexpack_rounds_port` rows. The heading is the
 * disclosure's ACCESSIBLE NAME; it must describe the real scope, not the widest possible one
 * (F-008). Unfiltered → `all projects`; filtered → that project's label, never a raw record id.
 */
export function fleetScopeLabel(
	view: FleetView | null | undefined,
	options: readonly FleetProjectOption[] | null | undefined
): string {
	const project = clean(view?.project);
	if (!project) return 'all projects';
	// The resolved options already carry the honest label (including the stale 0-count entry
	// resolveFleetView appends), so a selected project ALWAYS has a name to show.
	return (options ?? []).find((o) => o.value === project)?.label ?? fleetProjectLabel(project, null);
}

/**
 * The qualifier the ALWAYS-VISIBLE head counts need to stay TRUE.
 *
 * LIVE-VERIFIED DEFECT (2026-07-26, browser, `?fleetProject=project:bepinexpack_rounds_port`):
 * the head read `session fleet · bepinexpack_rounds_port` beside `0 running · 40 recent · 32
 * failed` over a 4-row list. Both halves are individually correct — the counts are deliberately
 * window-wide so collapsing can never hide a failure — but they used to be reconciled by the
 * heading's own hardcoded `all projects`. Scoping the heading ({@link fleetScopeLabel}) orphaned
 * the counts, so a reader attributes 32 failures to a project that has 4 (F-008).
 *
 * The counts stay window-wide (that invariant is the point); they SAY SO instead. Unfiltered the
 * heading already reads `all projects`, so the qualifier would be noise → null. A state-only
 * filter does not narrow the heading either, so it also needs no qualifier.
 */
export function fleetCountScopeNote(view: FleetView | null | undefined): string | null {
	return clean(view?.project) ? 'across all projects' : null;
}

// ── Options + counts ──────────────────────────────────────────────────────────────────────

/** One selectable project, with the real number of rows it would show. */
export interface FleetProjectOption {
	/** The URL value — a `project:…` id or {@link FLEET_NO_PROJECT}. */
	value: string;
	label: string;
	count: number;
	/**
	 * TRUE for an option that is only present because it is the CURRENTLY SELECTED value and no
	 * loaded row matches it any more (a shared/stale link, or the other filter excluded it). The
	 * page renders it as an honest "0 shown" state with a clear action — it is never silently
	 * dropped, which would make the select lie about what is filtering the list.
	 */
	stale?: boolean;
}

/**
 * The project options derived from the rows that already pass the STATE filter — so selecting one
 * can never yield an empty list ("never offer a filter option that cannot match"). Named projects
 * sort alphabetically; the "no project" bucket sorts last.
 *
 * nil/empty rows → `[]` (the page renders the project control only when there is a choice).
 */
export function fleetProjectOptions(
	rows: readonly (FleetFilterRow | null | undefined)[] | null | undefined,
	state: FleetStateFilter = 'all'
): FleetProjectOption[] {
	const byKey = new Map<string, FleetProjectOption>();
	for (const r of rows ?? []) {
		if (!r || !matchesFleetState(r, state)) continue;
		const value = fleetProjectKey(r);
		const existing = byKey.get(value);
		if (existing) {
			existing.count += 1;
			// A later row may carry the name an earlier one lacked — take the first real label.
			if (existing.label === 'unnamed project') existing.label = fleetProjectLabel(value, r.projectName);
			continue;
		}
		byKey.set(value, { value, label: fleetProjectLabel(value, r.projectName), count: 1 });
	}
	return [...byKey.values()].sort((a, b) => {
		if (a.value === FLEET_NO_PROJECT) return 1;
		if (b.value === FLEET_NO_PROJECT) return -1;
		return a.label.localeCompare(b.label);
	});
}

/**
 * The count each STATE chip would show, over the rows that already pass the PROJECT filter — so a
 * `0` means "selecting this shows nothing", and the page can disable that chip honestly.
 */
export function fleetStateCounts(
	rows: readonly (FleetFilterRow | null | undefined)[] | null | undefined,
	project: string | null = null
): Record<FleetStateFilter, number> {
	const counts: Record<FleetStateFilter, number> = { all: 0, running: 0, failed: 0, attention: 0 };
	for (const r of rows ?? []) {
		if (!r) continue;
		if (project && fleetProjectKey(r) !== project) continue;
		counts.all += 1;
		if (isFleetRunning(r)) counts.running += 1;
		if (isFleetFailure(r)) counts.failed += 1;
		if (fleetNeedsAttention(r)) counts.attention += 1;
	}
	return counts;
}

/** Apply both filters, preserving the loader's running-first / newest-first ordering. */
export function filterFleet<T extends FleetFilterRow>(
	rows: readonly T[] | null | undefined,
	view: FleetView | null | undefined
): T[] {
	const v = view ?? DEFAULT_FLEET_VIEW;
	const out: T[] = [];
	for (const r of rows ?? []) {
		if (!r) continue;
		if (v.project && fleetProjectKey(r) !== v.project) continue;
		if (!matchesFleetState(r, v.state)) continue;
		out.push(r);
	}
	return out;
}

/**
 * Everything the section needs to render in one pass: the (possibly repaired) view, the visible
 * rows, both option sets, and the named honest states.
 */
export interface ResolvedFleetView<T extends FleetFilterRow> {
	view: FleetView;
	/** The rows to render, after both filters. */
	visible: T[];
	/** Total rows in the loaded window, before any filter. */
	total: number;
	projectOptions: FleetProjectOption[];
	stateCounts: Record<FleetStateFilter, number>;
	/**
	 * TRUE when a project filter is selected that no loaded row matches — a stale/shared link, or
	 * a project with no rows in the current state. NAMED state: the page says so and offers Clear,
	 * instead of showing a bare empty list that looks like "no sessions exist".
	 */
	staleProject: boolean;
	/** TRUE when a filter is engaged and it matched nothing (the honest empty, F-008). */
	filteredEmpty: boolean;
}

/**
 * Resolve the whole section state from the loaded rows + the URL view.
 *
 * Shadow paths: nil rows → an empty resolution with the view intact; an empty window → no options
 * and `filteredEmpty:false` (the section's own "no sessions yet" copy owns that case); a stale
 * project id → kept, flagged, and appended to the options as a `stale` 0-count entry so the select
 * still shows what is filtering.
 */
export function resolveFleetView<T extends FleetFilterRow>(
	rows: readonly T[] | null | undefined,
	view: FleetView | null | undefined
): ResolvedFleetView<T> {
	const v: FleetView = view ? { ...view } : { ...DEFAULT_FLEET_VIEW };
	const all = (rows ?? []).filter((r): r is T => !!r);
	const projectOptions = fleetProjectOptions(all, v.state);
	const stateCounts = fleetStateCounts(all, v.project);
	const visible = filterFleet(all, v);

	let staleProject = false;
	if (v.project && !projectOptions.some((o) => o.value === v.project)) {
		staleProject = true;
		// Recover a label from the FULL window (the row may exist but be excluded by the state
		// filter) before falling back to the id-humanizer.
		const anyRow = all.find((r) => fleetProjectKey(r) === v.project);
		projectOptions.push({
			value: v.project,
			label: fleetProjectLabel(v.project, anyRow?.projectName ?? null),
			count: 0,
			stale: true
		});
	}

	return {
		view: v,
		visible,
		total: all.length,
		projectOptions,
		stateCounts,
		staleProject,
		filteredEmpty: all.length > 0 && visible.length === 0
	};
}
