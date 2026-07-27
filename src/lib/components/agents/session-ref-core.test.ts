// THE CHIP WALL — unit contract for the grouping/labelling logic (operator review §2).
//
// The regression under guard: ~30 chips all reading `code-write`, because the label degraded to
// the intent slug on every orchestrator-drained session (session.role unset, live 0/32). These
// tests pin (a) the label comes off the SHARED naming spine, (b) identical labels collapse into
// ONE chip carrying a real count, (c) the discriminators (task title / start time / session id)
// survive into the expanded rows, and (d) all four shadow paths.

import { describe, it, expect } from 'vitest';
import {
	groupSessionRefs,
	refDetail,
	refLabel,
	UNNAMED_SESSION,
	type SessionRefLike
} from './session-ref-core';

/** The live shape the review measured: intent-only, no role, distinct task + start time. */
function codeWriteRef(n: number): SessionRefLike {
	return {
		sessionId: `session:01k9codewrite${n}`,
		taskId: `task:t${n}`,
		taskTitle: `Unblock ${n} stalled task(s)`,
		roleId: null,
		roleName: null,
		roleSlug: null,
		intent: 'code-write',
		startedAt: `2026-07-2${n % 10}T10:00:00.000Z`
	};
}

describe('refLabel — the identity comes off the shared naming spine', () => {
	it('prefers role.name over every weaker field', () => {
		const r = refLabel({
			sessionId: 's:1',
			taskId: null,
			roleId: 'role:hr_recruiter',
			roleName: 'HR Recruiter',
			roleSlug: 'hr-recruiter',
			intent: 'code-write'
		});
		expect(r).toEqual({ label: 'HR Recruiter', isPlaceholder: false });
	});

	it('falls back to role.slug, then to a HUMANIZED record id — never the raw id', () => {
		expect(
			refLabel({ sessionId: 's:1', taskId: null, roleId: 'role:x', roleSlug: 'code-reviewer', intent: null })
				.label
		).toBe('code-reviewer');
		// The §5 dangling-role case: `role:probe_fit_1781894354268` → `probe_fit`.
		expect(
			refLabel({ sessionId: 's:1', taskId: null, roleId: 'role:probe_fit_1781894354268', intent: null }).label
		).toBe('probe_fit');
	});

	it('uses the intent when no role exists — the live orchestrator-drained shape', () => {
		expect(refLabel(codeWriteRef(1))).toEqual({ label: 'code-write', isPlaceholder: false });
	});

	it('an OPAQUE role auto-id is not a name: honest placeholder, flagged', () => {
		const r = refLabel({ sessionId: 's:1', taskId: null, roleId: 'role:gq3glfee2zcw993suhto', intent: null });
		expect(r).toEqual({ label: UNNAMED_SESSION, isPlaceholder: true });
	});

	it('nil / empty input → the honest placeholder, never "undefined"', () => {
		expect(refLabel(null)).toEqual({ label: UNNAMED_SESSION, isPlaceholder: true });
		expect(refLabel(undefined).label).toBe(UNNAMED_SESSION);
		expect(
			refLabel({ sessionId: 's:1', taskId: null, roleId: null, roleName: '  ', intent: '' }).label
		).toBe(UNNAMED_SESSION);
	});

	it('never promotes the task title into the identity (it would un-collapse every group)', () => {
		expect(refLabel(codeWriteRef(3)).label).toBe('code-write');
	});
});

describe('refDetail — the discriminators the old markup threw away', () => {
	it('carries the task TITLE, the start time and a drill-through link', () => {
		const d = refDetail(codeWriteRef(4));
		expect(d.taskTitle).toBe('Unblock 4 stalled task(s)');
		expect(d.taskRef).toBeNull(); // a title exists → no raw id needed
		expect(d.startedAt).toBe('2026-07-24T10:00:00.000Z');
		expect(d.href).toBe('/claude-code?session=session%3A01k9codewrite4');
		expect(d.sessionTitle).toBe('session:01k9codewrite4');
	});

	it('with a task but NO title, offers the id tail for traceability instead', () => {
		const d = refDetail({ sessionId: 's:abc', taskId: 'task:0123456789abcdef', roleId: null, intent: null });
		expect(d.taskTitle).toBeNull();
		expect(d.taskRef).toBe('89abcdef');
	});

	it('with NO task at all, both task fields are honestly null (renderer shows "no task")', () => {
		const d = refDetail({ sessionId: 's:abc', taskId: null, roleId: null, intent: null });
		expect(d.taskTitle).toBeNull();
		expect(d.taskRef).toBeNull();
	});

	it('a blank/absent startedAt is null — NEVER the string "undefined" (F-013)', () => {
		expect(refDetail({ sessionId: 's:a', taskId: null, roleId: null, intent: null }).startedAt).toBeNull();
		expect(
			refDetail({ sessionId: 's:a', taskId: null, roleId: null, intent: null, startedAt: '   ' }).startedAt
		).toBeNull();
	});
});

describe('groupSessionRefs — the actual chip-wall fix', () => {
	it('collapses 30 identical labels into ONE chip with a real count of 30', () => {
		const refs = Array.from({ length: 30 }, (_, i) => codeWriteRef(i));
		const groups = groupSessionRefs(refs);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe('code-write');
		expect(groups[0].count).toBe(30);
		expect(groups[0].sessions).toHaveLength(30);
	});

	it('every grouped session keeps its OWN drill-through link and discriminators', () => {
		const groups = groupSessionRefs([codeWriteRef(1), codeWriteRef(2)]);
		const hrefs = groups[0].sessions.map((s) => s.href);
		expect(new Set(hrefs).size).toBe(2);
		expect(groups[0].sessions.every((s) => s.taskTitle !== null)).toBe(true);
	});

	it('keeps distinct labels in distinct groups, biggest first', () => {
		const refs: SessionRefLike[] = [
			...Array.from({ length: 3 }, (_, i) => codeWriteRef(i)),
			{ sessionId: 's:r1', taskId: null, roleId: 'role:a', roleName: 'HR Recruiter', intent: null },
			{ sessionId: 's:r2', taskId: null, roleId: 'role:a', roleName: 'HR Recruiter', intent: null },
			{ sessionId: 's:o1', taskId: null, roleId: null, intent: 'read-only' }
		];
		const groups = groupSessionRefs(refs);
		expect(groups.map((g) => [g.label, g.count])).toEqual([
			['code-write', 3],
			['HR Recruiter', 2],
			['read-only', 1]
		]);
	});

	it('sorts sessions newest-first, with UNKNOWN start times LAST (unknown ≠ oldest)', () => {
		const groups = groupSessionRefs([
			{ sessionId: 's:1', taskId: null, roleId: null, intent: 'x', startedAt: '2026-01-01T00:00:00.000Z' },
			{ sessionId: 's:2', taskId: null, roleId: null, intent: 'x', startedAt: null },
			{ sessionId: 's:3', taskId: null, roleId: null, intent: 'x', startedAt: '2026-06-01T00:00:00.000Z' }
		]);
		expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['s:3', 's:1', 's:2']);
	});

	it('emits a DOM-id-safe, collision-free domKey for the aria-controls wiring', () => {
		const groups = groupSessionRefs([
			{ sessionId: 's:1', taskId: null, roleId: null, roleName: 'HR Recruiter', intent: null },
			{ sessionId: 's:2', taskId: null, roleId: null, roleName: 'HR-Recruiter', intent: null }
		]);
		const keys = groups.map((g) => g.domKey);
		expect(keys.every((k) => /^[a-z0-9-]+$/.test(k))).toBe(true);
		expect(new Set(keys).size).toBe(groups.length); // punctuation-only differences do not collide
	});

	// ── Shadow paths ──────────────────────────────────────────────────────────────────
	it('nil / non-array input → [] (the renderer shows its honest empty state)', () => {
		expect(groupSessionRefs(null)).toEqual([]);
		expect(groupSessionRefs(undefined)).toEqual([]);
		expect(groupSessionRefs('nope' as unknown as SessionRefLike[])).toEqual([]);
	});

	it('empty input → []', () => {
		expect(groupSessionRefs([])).toEqual([]);
	});

	it('upstream error: a nil entry, or one with no sessionId, is dropped — never a dead chip', () => {
		const groups = groupSessionRefs([
			null as unknown as SessionRefLike,
			{ sessionId: '', taskId: null, roleId: null, intent: 'code-write' },
			{ sessionId: '   ', taskId: null, roleId: null, intent: 'code-write' },
			codeWriteRef(1)
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(1);
	});

	it('upstream error: a duplicate sessionId is counted ONCE — the count stays honest', () => {
		const dup = codeWriteRef(7);
		expect(groupSessionRefs([dup, { ...dup }, codeWriteRef(8)])[0].count).toBe(2);
	});

	it('refs with nothing purposeful group under the flagged placeholder, not an id tail', () => {
		const groups = groupSessionRefs([
			{ sessionId: 's:aaaa1111', taskId: null, roleId: null, intent: null },
			{ sessionId: 's:bbbb2222', taskId: null, roleId: null, intent: null }
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe(UNNAMED_SESSION);
		expect(groups[0].isPlaceholder).toBe(true);
		expect(groups[0].count).toBe(2);
		// The ids are still reachable — as IDs, in the expanded rows. With no start times to sort
		// on, the tiebreak is the session id, so the order is at least STABLE across renders.
		expect(groups[0].sessions.map((s) => s.idTail)).toEqual(['aaaa1111', 'bbbb2222']);
	});
});
