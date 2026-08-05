/**
 * BOARD ROW — the server-side projection from a normalized `TaskRow` onto the board's wire shape.
 *
 * It lives in its OWN module rather than in `+page.server.ts` because SvelteKit validates that file
 * at build time and REFUSES any non-reserved export ("Invalid export 'toBoardTask' … valid exports
 * are load, prerender, csr, ssr, trailingSlash, config, actions, entries") — the same constraint
 * that put `FLEET_LIMIT` in `/claude-code`'s `fleet-view.ts`. Keeping it out of
 * `task-board-view.ts` is also deliberate: that module is shared with the `.svelte` call site and
 * must stay free of server types, while this one is the boundary where a DB row becomes a POJO.
 *
 * ── What this boundary is FOR (F-013 / devalue) ───────────────────────────────────────────
 * `normTask` already `str()`s the id, the project link and both datetimes, but `provenance.detail`
 * is a free-form `Record<string, unknown>` written by the PM propose path — it can legitimately
 * carry an SDK `RecordId` or `Datetime`, either of which makes `devalue` throw a 500 the moment a
 * `load` returns it. Every value that crosses here is reduced to a string, an array of strings, or
 * an omitted key. Absent stays ABSENT: never `''`, never a fabricated `[]` claiming "considered,
 * chose none", and never the literal `"undefined"`.
 *
 * Shadow paths on every function: happy · nil · empty/blank · upstream error (a non-array where an
 * array is expected, a cyclic object, a datetime that will not parse). Nothing here throws.
 */

import { canTransition, TASK_STATUSES, type TaskRow } from '$lib/server/tasks/repo';
import type { BoardTask } from './task-board-view';

/**
 * ISO-coerce a datetime that `normTask` already `str()`-ed.
 *
 * The `'undefined'` / `'null'` literals are checked explicitly: they are what `String(x)` produces
 * for a missing field, and letting one through as a TIME is the exact F-013 defect. Unparseable →
 * `null`, which the page renders as '—'.
 */
export function isoOrNullish(value: unknown): string | null {
	if (value == null) return null;
	const s = String(value).trim();
	if (!s || s === 'undefined' || s === 'null') return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Trimmed non-empty string, or undefined — so an absent field stays ABSENT on the wire. */
export function present(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const s = value.trim();
	return s ? s : undefined;
}

/** A string array with blanks dropped; a non-array (upstream error) → `[]`, never a fabrication. */
export function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const v of value) {
		const s = present(v);
		if (s !== undefined) out.push(s);
	}
	return out;
}

/**
 * Flatten `provenance.detail` into printable pairs.
 *
 * Every value is reduced to a STRING: primitives directly, objects through `JSON.stringify` with a
 * named fallback when that throws (a cyclic or exotic value is an upstream error, and
 * `[unprintable]` is the honest way to say so — dropping the key silently would hide that the field
 * exists at all). A `null`/`undefined` value is skipped rather than printed as the word "null".
 */
export function detailPairs(detail: unknown): { key: string; value: string }[] {
	if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return [];
	const out: { key: string; value: string }[] = [];
	for (const [key, raw] of Object.entries(detail as Record<string, unknown>)) {
		const k = present(key);
		if (!k) continue;
		if (raw == null) continue;
		let value: string;
		if (typeof raw === 'string') value = raw.trim();
		else if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
			value = String(raw);
		} else {
			try {
				value = JSON.stringify(raw) ?? '[unprintable]';
			} catch {
				value = '[unprintable]';
			}
		}
		if (value) out.push({ key: k, value });
	}
	return out;
}

/**
 * Project one normalized `TaskRow` onto the board's POJO wire shape.
 *
 * `names` maps a RECORD ID to the purposeful display name behind it (today: the project's `pm` row,
 * resolved once in the loader). It exists because `proposed_by` stores an opaque auto-id and the
 * naming composer will not — correctly — invent a name from one; the name is a JOIN away, not a
 * fabrication. A miss leaves `proposedByName` ABSENT so the page can honestly say "unnamed"; the
 * map is never consulted for anything it was not asked to resolve.
 */
export function toBoardTask(t: TaskRow, names?: ReadonlyMap<string, string>): BoardTask {
	const objective = present(t.objective);
	const purpose = present(t.purpose);
	const proposedBy = present(t.proposed_by);
	const proposedByName = proposedBy ? present(names?.get(proposedBy)) : undefined;
	const revisionOf = present(t.revision_of);
	const supersededBy = present(t.superseded_by);
	const fingerprint = present(t.proposal_fingerprint);
	const parent = present(t.parent);
	const provenanceKind = present(t.provenance?.kind);
	const provenanceAuthority = present(t.provenance?.authority);

	return {
		id: t.id,
		title: t.title,
		description: t.description,
		status: t.status,
		priority: t.priority,
		origin: t.origin,
		// The legal move targets — the state machine is the authority, computed once server-side so
		// the page can never offer a move `setStatus` would refuse.
		moves: [...TASK_STATUSES].filter((s) => canTransition(t.status, s)),
		createdAt: isoOrNullish(t.created_at),
		updatedAt: isoOrNullish(t.updated_at),
		tags: stringList(t.tags),
		...(objective ? { objective } : {}),
		...(purpose ? { purpose } : {}),
		acceptanceCriteria: stringList(t.acceptance_criteria),
		...(provenanceKind ? { provenanceKind } : {}),
		...(provenanceAuthority ? { provenanceAuthority } : {}),
		provenanceEvidence: stringList(t.provenance?.evidence),
		provenanceDetail: detailPairs(t.provenance?.detail),
		...(proposedBy ? { proposedBy } : {}),
		...(proposedByName ? { proposedByName } : {}),
		...(revisionOf ? { revisionOf } : {}),
		...(supersededBy ? { supersededBy } : {}),
		...(fingerprint ? { proposalFingerprint: fingerprint } : {}),
		...(parent ? { parent } : {})
	};
}
