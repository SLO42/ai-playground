// TIME-FORMAT — pure, deterministic time helpers shared by the project command-center surfaces
// (ProjectActivity rows, the session list, the task board cards). Extracted so the relative-time /
// elapsed-duration logic is unit-testable WITHOUT rendering Svelte and stays consistent across every
// surface (previously each surface carried its own inline `ago()` copy — those copies are left in
// place for now; TODO consolidate ActivityFeed/RightTray/Home onto this module).
//
// HONESTY (F-008 / F-013): a missing or unparseable timestamp ALWAYS yields '—' — never a fabricated
// time, never the literal string "Invalid Date", never str(undefined). Every function takes an
// explicit `now` (ms) so the caller can drive a SINGLE ticking clock (one interval for the whole
// page) rather than per-row timers, and so tests are deterministic. This is a plain .ts module — NO
// runes (F-009); the reactive "now" lives in the .svelte caller.

/** Parse an ISO string to epoch-ms, or null when absent/blank/unparseable (the honest '—' path). */
function parseMs(iso: string | null | undefined): number | null {
	if (iso == null) return null;
	const trimmed = String(iso).trim();
	if (trimmed === '') return null;
	const t = new Date(trimmed).getTime();
	return Number.isNaN(t) ? null : t;
}

/**
 * Compact relative time, e.g. `3s ago`, `5m ago`, `2h ago`, `4d ago`, or (future clock skew) `in 5s`.
 * Absent/unparseable → '—'. `now` defaults to Date.now() but callers SHOULD pass a shared tick.
 *
 * SHADOW PATHS: nil iso → '—'; empty string → '—'; non-date string → '—'; a timestamp slightly in
 * the future (clock skew) → 'in Ns' rather than a nonsensical negative.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
	const t = parseMs(iso);
	if (t === null) return '—';
	const deltaS = Math.round((now - t) / 1000);
	const future = deltaS < 0;
	const s = Math.abs(deltaS);
	const body = humanizeSeconds(s);
	if (body === 'now') return 'now';
	return future ? `in ${body}` : `${body} ago`;
}

/** Turn a non-negative second count into a compact magnitude ('now' / 'Ns' / 'Nm' / 'Nh' / 'Nd'). */
function humanizeSeconds(s: number): string {
	if (s < 1) return 'now';
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d`;
}

/**
 * Elapsed DURATION for a session/task: from `startIso` to `endIso` (terminal — final, frozen) or to
 * `now` (running — live, ticks). Formatted compactly: `<60s` → `Ns`, `<60m` → `Mm Ss`, else `Hh Mm`.
 * Absent/unparseable start → '—' (honest, never a fabricated 0). A non-positive span clamps to '0s'.
 *
 * SHADOW PATHS: nil start → '—'; empty start → '—'; bad start → '—'; end BEFORE start (or bad end on
 * a terminal row) → clamps to '0s' rather than rendering a negative duration; running row (end null)
 * → measured to `now`.
 */
export function elapsed(
	startIso: string | null | undefined,
	endIso: string | null | undefined,
	now: number = Date.now()
): string {
	const start = parseMs(startIso);
	if (start === null) return '—';
	// Terminal rows measure to their recorded end; a running row (or one whose end won't parse)
	// measures to the live `now`. We never fabricate an end — an unparseable end on a row that has
	// one falls back to `now`, which is honest for a row we believe is still open.
	const end = endIso == null ? now : (parseMs(endIso) ?? now);
	const ms = Math.max(0, end - start);
	return humanizeDuration(Math.round(ms / 1000));
}

/** Format a non-negative second count as a compact duration ('Ns' / 'Mm Ss' / 'Hh Mm'). */
function humanizeDuration(totalS: number): string {
	if (totalS < 60) return `${totalS}s`;
	const m = Math.floor(totalS / 60);
	const s = totalS % 60;
	if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

/**
 * Absolute, locale-formatted timestamp for a hover title (the precise time behind the relative one),
 * or '' when absent/unparseable so the caller can omit the `title` attribute entirely (never a
 * misleading "Invalid Date" tooltip).
 */
export function absoluteTime(iso: string | null | undefined): string {
	const t = parseMs(iso);
	if (t === null) return '';
	return new Date(t).toLocaleString();
}
