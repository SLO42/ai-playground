// THE CHIP WALL — the pure grouping/labelling logic behind SessionRefChips.svelte.
//
// OPERATOR REVIEW 2026-07-26 §2: the /agents "capability usage (granted vs used)" card rendered
// `TOOL-ALLOW Edit  used · 21 calls` followed by ~30 IDENTICAL `code-write` chips. The rows were
// NOT duplicates — `observability/usage.ts` folds grants into a Set of session ids and the
// `{#each}` keys on `ref.sessionId`, so every chip is a genuinely distinct session. The defect was
// the LABEL: the old page-local `refLabel()` went `roleId → intent → session-id tail`, and
// `session.role` is unset on orchestrator-drained sessions (live: 0 of 32), so all ~30 collapsed
// onto the intent slug.
//
// The fix is TWO things, and both live here so they are unit-testable without a browser:
//   (1) LABEL from the shared naming composer ($lib/shared/naming) — the same spine every other
//       surface uses, so a session is not called one thing on /agents and another in the memory
//       scene. No second competing fallback chain gets written here.
//   (2) GROUP by that label with a REAL count (`code-write ×30`), collapsed by default, expandable
//       to the distinct sessions carrying `taskId` + `startedAt` — the discriminators that were
//       already loaded and thrown away. The drill-through link is preserved per session.
//
// ONE pattern, applied to every granted dimension (skill|agent|mcp|reserved|tool-allow) AND the
// `used by` chips — fixed once, not per card.
//
// HONESTY (F-008): a ref with no purposeful field yields the composer's explicit placeholder and
// is flagged `isPlaceholder` so the renderer can dim it; the session-id tail is still offered, but
// as an ID for traceability — never promoted into the name slot. Nothing here invents a value.

import { describeSession, shortRef } from '$lib/shared/naming';

/**
 * The shape this module needs from `observability/usage.SessionRef`.
 *
 * Declared STRUCTURALLY rather than imported from `$lib/server/**` on purpose: this module is
 * compiled into the client bundle, and SvelteKit forbids a client module from reaching into the
 * server tree (even a type-only import is a footgun once `verbatimModuleSyntax` erases it
 * differently). Every added field is optional so a caller on an older projection still type-checks
 * and simply renders the honest fallback.
 */
export interface SessionRefLike {
	sessionId: string;
	taskId: string | null;
	taskTitle?: string | null;
	roleId: string | null;
	roleName?: string | null;
	roleSlug?: string | null;
	intent: string | null;
	startedAt?: string | null;
}

/** One session inside an expanded group — the row the operator drills into. */
export interface SessionRefDetail {
	sessionId: string;
	/** The drill-through target (the existing /claude-code session deep-link). */
	href: string;
	/** `task.title` when known, else null. NEVER the raw id — {@link taskRef} carries that. */
	taskTitle: string | null;
	/** A short task-id tail for traceability when there is no title, else null. */
	taskRef: string | null;
	/** ISO start time, or null → the renderer shows '—' (F-013: never `String(undefined)`). */
	startedAt: string | null;
	/** A short session-id tail — shown as an ID (mono/dim), never as the name. */
	idTail: string;
	/** The full session id, for the `title` tooltip. */
	sessionTitle: string;
}

/** A label-group of sessions: the chip the operator sees, plus what it expands to. */
export interface SessionRefGroup {
	/** Stable `{#each}` key — the case-folded label. Distinct groups never collide. */
	key: string;
	/**
	 * A DOM-id-safe suffix for `aria-controls` / `id`. The label is arbitrary human text
	 * (`HR Recruiter`, `unnamed session`) and an HTML id may not contain whitespace, so the key is
	 * slugified and suffixed with the group ordinal — slugging alone could collide two labels that
	 * differ only in punctuation, which would silently break the disclosure wiring.
	 */
	domKey: string;
	/** The composed identity (role name → role slug → role id → specialist → intent). */
	label: string;
	/** True when NOTHING purposeful existed and `label` is the honest placeholder (F-008). */
	isPlaceholder: boolean;
	/** How many distinct sessions carry this label. Always ≥ 1 — a REAL count, not a guess. */
	count: number;
	/** The sessions, newest-first (unknown start times last). */
	sessions: SessionRefDetail[];
}

/** The placeholder used when a session offers no purposeful field at all. */
export const UNNAMED_SESSION = 'unnamed session';

/**
 * Compose ONE session's chip label off the shared naming spine.
 *
 * `includeQualifier` is irrelevant here (a SessionRef carries no slot id) and the TASK TITLE is
 * deliberately NOT part of the label: the whole point is to collapse many sessions onto a shared
 * identity, and a title makes every row unique again. The title reappears in the expanded detail,
 * which is where the operator actually wants the discriminator.
 */
export function refLabel(ref: SessionRefLike | null | undefined): {
	label: string;
	isPlaceholder: boolean;
} {
	const d = describeSession(
		{
			roleName: ref?.roleName,
			roleSlug: ref?.roleSlug,
			role: ref?.roleId,
			intent: ref?.intent
		},
		{ placeholder: UNNAMED_SESSION }
	);
	return { label: d.identity, isPlaceholder: d.isPlaceholder };
}

/** Build the expanded-row detail for one session ref. */
export function refDetail(ref: SessionRefLike): SessionRefDetail {
	const title = typeof ref.taskTitle === 'string' && ref.taskTitle.trim() ? ref.taskTitle.trim() : null;
	// Only offer a raw task tail when there is no human title — an id is traceability, not a name.
	const taskRef = title == null && ref.taskId ? shortRef(ref.taskId) : null;
	return {
		sessionId: ref.sessionId,
		href: `/claude-code?session=${encodeURIComponent(ref.sessionId)}`,
		taskTitle: title,
		taskRef: taskRef === '—' ? null : taskRef,
		startedAt: typeof ref.startedAt === 'string' && ref.startedAt.trim() ? ref.startedAt : null,
		idTail: shortRef(ref.sessionId),
		sessionTitle: ref.sessionId
	};
}

/** Newest-first; a ref with no `startedAt` sorts LAST (unknown ≠ oldest — it is unknown). */
function byStartedAtDesc(a: SessionRefDetail, b: SessionRefDetail): number {
	if (a.startedAt === b.startedAt) return a.sessionId.localeCompare(b.sessionId);
	if (a.startedAt == null) return 1;
	if (b.startedAt == null) return -1;
	return a.startedAt < b.startedAt ? 1 : -1;
}

/**
 * Fold a list of session refs into label-groups, largest first.
 *
 * Shadow paths, all four:
 *   • happy          — real refs → one group per distinct label, counts summing to the input size.
 *   • nil            — `null`/`undefined` (or a non-array) → `[]`; the renderer shows its honest
 *                      "no in-window session" state, never an empty chip.
 *   • empty          — `[]` → `[]`.
 *   • upstream error — a nil entry, or one with a blank/absent `sessionId`, is DROPPED rather than
 *                      rendered as a chip that links nowhere. Duplicate `sessionId`s are collapsed
 *                      so the count stays a count of DISTINCT sessions (the roll-up already dedups
 *                      via a Set, so a duplicate here means an upstream fault, not real data).
 */
export function groupSessionRefs(
	refs: readonly SessionRefLike[] | null | undefined
): SessionRefGroup[] {
	if (!Array.isArray(refs)) return [];
	const groups = new Map<string, { label: string; isPlaceholder: boolean; seen: Set<string>; sessions: SessionRefDetail[] }>();
	for (const ref of refs) {
		if (!ref || typeof ref.sessionId !== 'string' || ref.sessionId.trim() === '') continue;
		const { label, isPlaceholder } = refLabel(ref);
		const key = label.toLowerCase();
		const g = groups.get(key) ?? { label, isPlaceholder, seen: new Set<string>(), sessions: [] };
		if (g.seen.has(ref.sessionId)) continue; // distinct-session count stays honest
		g.seen.add(ref.sessionId);
		g.sessions.push(refDetail(ref));
		groups.set(key, g);
	}
	return (
		[...groups.entries()]
			.map(([key, g]) => ({
				key,
				domKey: '',
				label: g.label,
				isPlaceholder: g.isPlaceholder,
				count: g.sessions.length,
				sessions: g.sessions.sort(byStartedAtDesc)
			}))
			// Biggest group first (that IS the operator's signal — "30 sessions share this grant"),
			// then alphabetical so the order is stable across renders of equal-sized groups.
			.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
			// domKey is assigned AFTER the sort so the ordinal matches render order and stays stable
			// for a given input (the sort is total: count, then label).
			.map((g, i) => ({ ...g, domKey: `${slugify(g.key)}-${i}` }))
	);
}

/** Reduce an arbitrary label to `[a-z0-9-]`, safe for an HTML id fragment. Never empty. */
function slugify(s: string): string {
	const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return out === '' ? 'g' : out;
}
