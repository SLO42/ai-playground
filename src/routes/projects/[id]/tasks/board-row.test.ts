/**
 * BOARD ROW — the UPSTREAM-ERROR shadow path of the row → wire projection.
 *
 * `board-loader.live.test.ts` covers happy/nil/empty against REAL SurrealDB rows, which is the leg
 * that matters most (F-020). What a real row cannot easily produce is the fourth path: a value that
 * is the WRONG SHAPE — a cyclic `provenance.detail`, a non-array `acceptance_criteria`, a datetime
 * that will not parse, the literal string `"undefined"` that `String(x)` leaves behind on a missing
 * field (F-013). Those are the ones that turn into a devalue 500 or a fabricated value in the UI,
 * so they are pinned here directly.
 *
 * The rule under test throughout: an unusable value becomes an honest ABSENCE or a NAMED
 * placeholder — never a crash, and never something that reads as real data.
 */

import { describe, it, expect } from 'vitest';
import { detailPairs, isoOrNullish, present, stringList, toBoardTask } from './board-row';
import type { TaskRow } from '$lib/server/tasks/repo';

function row(over: Partial<TaskRow> = {}): TaskRow {
	return {
		id: 'task:a',
		project: 'project:p',
		title: 'T',
		description: 'D',
		status: 'backlog',
		priority: 'normal',
		origin: 'manual',
		created_at: '2026-08-05T10:00:00.000Z',
		updated_at: '2026-08-05T10:00:00.000Z',
		...over
	} as TaskRow;
}

describe('isoOrNullish (F-013)', () => {
	it('normalizes a real datetime to ISO', () => {
		expect(isoOrNullish('2026-08-05T10:00:00Z')).toBe('2026-08-05T10:00:00.000Z');
	});

	it('the str(undefined) literals are NEVER accepted as a time', () => {
		expect(isoOrNullish('undefined')).toBeNull();
		expect(isoOrNullish('null')).toBeNull();
		expect(isoOrNullish(undefined)).toBeNull();
		expect(isoOrNullish(null)).toBeNull();
		expect(isoOrNullish('   ')).toBeNull();
	});

	it('an unparseable value is null, not a fabricated date', () => {
		expect(isoOrNullish('not a date')).toBeNull();
		expect(isoOrNullish({})).toBeNull();
	});
});

describe('present / stringList', () => {
	it('a blank or non-string is ABSENT, not an empty string', () => {
		expect(present('  x  ')).toBe('x');
		expect(present('   ')).toBeUndefined();
		expect(present(null)).toBeUndefined();
		expect(present(7)).toBeUndefined();
	});

	it('a non-array (upstream error) yields [], and blanks inside are dropped', () => {
		expect(stringList(['a', '  ', '', 'b'])).toEqual(['a', 'b']);
		expect(stringList('oops')).toEqual([]);
		expect(stringList(null)).toEqual([]);
		expect(stringList([1, 2])).toEqual([]);
	});
});

describe('detailPairs — everything crossing the wire is a printable string', () => {
	it('flattens primitives and stringifies nested objects', () => {
		expect(detailPairs({ a: 'x', n: 3, b: true, o: { k: 1 } })).toEqual([
			{ key: 'a', value: 'x' },
			{ key: 'n', value: '3' },
			{ key: 'b', value: 'true' },
			{ key: 'o', value: '{"k":1}' }
		]);
	});

	it('a CYCLIC value is named [unprintable] — the key is not silently dropped', () => {
		const cyclic: Record<string, unknown> = { name: 'loop' };
		cyclic.self = cyclic;
		const pairs = detailPairs({ bad: cyclic, good: 'ok' });
		expect(pairs).toContainEqual({ key: 'bad', value: '[unprintable]' });
		expect(pairs).toContainEqual({ key: 'good', value: 'ok' });
	});

	it('a Date-like / RecordId-like value is stringified, never passed through raw (devalue 500)', () => {
		const pairs = detailPairs({ when: new Date('2026-08-05T10:00:00Z') });
		expect(typeof pairs[0].value).toBe('string');
	});

	it('null values are skipped rather than printed as the word "null"', () => {
		expect(detailPairs({ a: null, b: undefined })).toEqual([]);
	});

	it('shadow paths: nil / an array / a primitive all yield []', () => {
		expect(detailPairs(null)).toEqual([]);
		expect(detailPairs(['a'])).toEqual([]);
		expect(detailPairs('x')).toEqual([]);
	});
});

describe('toBoardTask', () => {
	it('omits absent optionals entirely — no key, no "", no "undefined"', () => {
		const t = toBoardTask(row());
		expect(t).not.toHaveProperty('objective');
		expect(t).not.toHaveProperty('provenanceKind');
		expect(t.acceptanceCriteria).toEqual([]);
		expect(t.tags).toEqual([]);
		expect(JSON.stringify(t)).not.toContain('undefined');
	});

	it('treats a present-but-BLANK field as absent (a blank objective is not context)', () => {
		const t = toBoardTask(row({ objective: '   ', purpose: '' } as Partial<TaskRow>));
		expect(t).not.toHaveProperty('objective');
		expect(t).not.toHaveProperty('purpose');
	});

	it('absorbs a wrong-shaped acceptance_criteria / tags without throwing', () => {
		const broken = row({
			acceptance_criteria: 'oops',
			tags: { not: 'an array' }
		} as unknown as Partial<TaskRow>);
		expect(() => toBoardTask(broken)).not.toThrow();
		const t = toBoardTask(broken);
		expect(t.acceptanceCriteria).toEqual([]);
		expect(t.tags).toEqual([]);
	});

	it('computes moves from the state machine, not from a hand-written list', () => {
		expect([...toBoardTask(row({ status: 'proposed' })).moves].sort()).toEqual([
			'ready',
			'withdrawn'
		]);
		// `done` is terminal — a finished task never silently reopens.
		expect(toBoardTask(row({ status: 'done' })).moves).toEqual([]);
	});

	it('only provenance.KIND crosses as a scalar; evidence/detail stay separate fields (TB-2)', () => {
		const t = toBoardTask(
			row({
				provenance: { kind: 'scan', evidence: ['finding:1'], detail: { note: 'secret-ish' } }
			})
		);
		expect(t.provenanceKind).toBe('scan');
		expect(t.provenanceEvidence).toEqual(['finding:1']);
		expect(t.provenanceDetail).toEqual([{ key: 'note', value: 'secret-ish' }]);
		// The evidence never leaks into a scalar field the prompt composer might pick up.
		expect(t.objective).toBeUndefined();
		expect(t.description).toBe('D');
	});

	// ── REGRESSION: provenance.authority was DROPPED by this projection ───────────────────────
	// `pm-proposals.ts` stamps `authority` on EVERY PM proposal, and `TaskProvenance` declares it,
	// but the projection carried only kind/evidence/detail — so a stored field vanished before the
	// wire and the panel could neither render it nor name it absent. The whole point of that panel
	// is completeness, so a silently-dropped §4.1 field is the defect, not a cosmetic gap.
	it('provenance.AUTHORITY crosses the wire — a stored §4.1 field is never silently dropped', () => {
		const t = toBoardTask(
			row({ provenance: { kind: 'periodic', evidence: [], authority: 'act' } })
		);
		expect(t.provenanceAuthority).toBe('act');
	});

	it('an absent or blank provenance.authority stays ABSENT — no key, never "undefined"', () => {
		const none = toBoardTask(row({ provenance: { kind: 'scan', evidence: [] } }));
		expect(none).not.toHaveProperty('provenanceAuthority');
		const blank = toBoardTask(
			row({ provenance: { kind: 'scan', evidence: [], authority: '   ' } })
		);
		expect(blank).not.toHaveProperty('provenanceAuthority');
		expect(JSON.stringify(blank)).not.toContain('undefined');
	});

	// ── REGRESSION: 'proposed by' called a NAMED pm "(unnamed)" ───────────────────────────────
	// `proposed_by` is `pm.id` — an opaque auto-id. The naming composer refuses (correctly) to make
	// a name out of one, so the panel printed "(unnamed)" about a PM the DB calls Vesper. The name
	// is one FK away; the loader joins it and passes it here. Standing operator rule 2026-07-26.
	it('joins the proposer NAME when the loader resolved one', () => {
		const t = toBoardTask(
			row({ proposed_by: 'pm:a1czfobj2cx28qzbfijl' }),
			new Map([['pm:a1czfobj2cx28qzbfijl', 'Vesper']])
		);
		expect(t.proposedBy).toBe('pm:a1czfobj2cx28qzbfijl');
		expect(t.proposedByName).toBe('Vesper');
	});

	it('leaves the name ABSENT when nothing resolves — "unnamed" must stay a TRUE statement', () => {
		// No map at all (the DB read failed), an empty map (no PM hired), a map that names some OTHER
		// record, and a PM whose stored name is blank. None of them may invent a name.
		expect(toBoardTask(row({ proposed_by: 'pm:x' }))).not.toHaveProperty('proposedByName');
		expect(toBoardTask(row({ proposed_by: 'pm:x' }), new Map())).not.toHaveProperty(
			'proposedByName'
		);
		expect(
			toBoardTask(row({ proposed_by: 'pm:x' }), new Map([['pm:other', 'Vesper']]))
		).not.toHaveProperty('proposedByName');
		expect(
			toBoardTask(row({ proposed_by: 'pm:x' }), new Map([['pm:x', '   ']]))
		).not.toHaveProperty('proposedByName');
	});

	it('never carries a name for a task that has no proposer at all', () => {
		const t = toBoardTask(row(), new Map([['pm:x', 'Vesper']]));
		expect(t).not.toHaveProperty('proposedBy');
		expect(t).not.toHaveProperty('proposedByName');
	});
});
