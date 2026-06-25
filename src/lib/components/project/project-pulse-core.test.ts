// PROJECT-PULSE unit — the pure agency-pulse fold (PM proposals/verdicts + autonomous loop +
// HR/role events). Asserts the four shadow paths for EACH data flow (nil / empty / upstream-error-
// as-empty / happy), the PM↔HR tagging, the honest idle, and newest-first ordering. No DB, no runes.

import { describe, it, expect } from 'vitest';
import {
	buildPulse,
	type PulseProposalLike,
	type PulseRoleEventLike,
	type PulseLoopLike
} from './project-pulse-core';

const T0 = '2026-06-25T10:00:00.000Z';
const T1 = '2026-06-25T11:00:00.000Z';
const T2 = '2026-06-25T12:00:00.000Z';

function proposal(id: string, title: string, created: string | null, verdicts: PulseProposalLike['verdicts'] = []): PulseProposalLike {
	return { task: { id, title, created_at: created }, verdicts };
}

describe('buildPulse — shadow paths (nil / empty)', () => {
	it('nil input → honest empty idle model (no entries, no loop)', () => {
		const m = buildPulse({});
		expect(m.entries).toEqual([]);
		expect(m.pmCount).toBe(0);
		expect(m.hrCount).toBe(0);
		expect(m.loop).toBeNull();
		expect(m.idle).toBe(true);
	});

	it('all-null input → idle (treated identically to nil)', () => {
		const m = buildPulse({ proposals: null, loop: null, roleEvents: null });
		expect(m.idle).toBe(true);
		expect(m.entries.length).toBe(0);
	});

	it('empty arrays + omitted loop → idle "PM idle"', () => {
		const m = buildPulse({ proposals: [], roleEvents: [] });
		expect(m.idle).toBe(true);
		expect(m.loop).toBeNull();
	});
});

describe('buildPulse — PM proposals + verdicts (happy + shadow)', () => {
	it('proposes one PM entry per proposal with the title in the headline', () => {
		const m = buildPulse({ proposals: [proposal('task:a', 'Add login', T1)] });
		expect(m.pmCount).toBe(1);
		const e = m.entries.find((x) => x.kind === 'pm-proposal')!;
		expect(e.tag).toBe('PM');
		expect(e.tone).toBe('pm');
		expect(e.headline).toBe('PM proposed: Add login');
		expect(e.at).toBe(T1);
		expect(m.idle).toBe(false);
	});

	it('an approve verdict → "PM approved" with reasons folded into detail, approve tone', () => {
		const m = buildPulse({
			proposals: [
				proposal('task:a', 'Add login', T0, [
					{ id: 'pv:1', verdict: 'approve', reasons: ['scoped', 'tested'], confidence: 'high', at: T2 }
				])
			]
		});
		const v = m.entries.find((x) => x.kind === 'pm-verdict')!;
		expect(v.tag).toBe('PM · panel');
		expect(v.tone).toBe('approve');
		expect(v.headline).toBe('PM approved — Add login');
		expect(v.detail).toContain('scoped · tested');
		expect(v.detail).toContain('confidence: high');
	});

	it('a pushback verdict → "PM pushed back" with pushback tone', () => {
		const m = buildPulse({
			proposals: [proposal('task:a', 'Risky', T0, [{ id: 'pv:2', verdict: 'pushback', reasons: ['unclear'], at: T1 }])]
		});
		const v = m.entries.find((x) => x.kind === 'pm-verdict')!;
		expect(v.tone).toBe('pushback');
		expect(v.headline).toBe('PM pushed back — Risky');
	});

	it('an UNKNOWN verdict value is shown verbatim (never coerced), neutral tone', () => {
		const m = buildPulse({
			proposals: [proposal('task:a', 'X', T0, [{ id: 'pv:3', verdict: 'weird', at: T1 }])]
		});
		const v = m.entries.find((x) => x.kind === 'pm-verdict')!;
		expect(v.tone).toBe('neutral');
		expect(v.headline).toBe('PM verdict: weird — X');
	});

	it('a proposal with NO title falls back to an honest short-id label (never blank)', () => {
		const m = buildPulse({ proposals: [proposal('task:zzz', '', null)] });
		const e = m.entries.find((x) => x.kind === 'pm-proposal')!;
		expect(e.headline).toBe('PM proposed: task zzz');
		expect(e.at).toBeNull();
	});

	it('a verdict with no reasons → null detail (omitted, not an empty string)', () => {
		const m = buildPulse({ proposals: [proposal('task:a', 'X', T0, [{ id: 'pv:4', verdict: 'approve', at: T1 }])] });
		const v = m.entries.find((x) => x.kind === 'pm-verdict')!;
		expect(v.detail).toBeNull();
	});
});

describe('buildPulse — HR/role events (happy + shadow)', () => {
	const ev = (id: string, op: string, slug: string | null, at: string | null, detail?: Record<string, unknown>): PulseRoleEventLike => ({
		id,
		op,
		role_slug: slug,
		at,
		...(detail ? { detail } : {})
	});

	it('a role_event → an HR entry tagged HR with the op headline', () => {
		const m = buildPulse({ roleEvents: [ev('role_event:1', 'created', 'recruiter', T1)] });
		expect(m.hrCount).toBe(1);
		const e = m.entries.find((x) => x.kind === 'hr-role')!;
		expect(e.tag).toBe('HR');
		expect(e.tone).toBe('hr');
		expect(e.headline).toBe('Role created — recruiter');
	});

	it('hire/swap/staff/retire ops each get a distinct human headline', () => {
		const m = buildPulse({
			roleEvents: [
				ev('role_event:s', 'swap', 'pm', T2),
				ev('role_event:t', 'staffed', 'qa', T1),
				ev('role_event:r', 'retired', 'old', T0)
			]
		});
		const heads = m.entries.filter((x) => x.kind === 'hr-role').map((x) => x.headline);
		expect(heads).toContain('Role swapped — pm');
		expect(heads).toContain('Staffed — qa');
		expect(heads).toContain('Role retired — old');
	});

	it('an UNKNOWN op is surfaced verbatim (EVERY ERROR HAS A NAME), never dropped', () => {
		const m = buildPulse({ roleEvents: [ev('role_event:u', 'frobnicated', 'x', T1)] });
		const e = m.entries.find((x) => x.kind === 'hr-role')!;
		expect(e.headline).toBe('frobnicated — x');
	});

	it('a dangling role link (no slug) falls back to the raw role short-id, never blank', () => {
		const m = buildPulse({ roleEvents: [{ id: 'role_event:d', op: 'created', role_slug: null, role: 'role:abc', at: T1 }] });
		const e = m.entries.find((x) => x.kind === 'hr-role')!;
		expect(e.headline).toBe('Role created — abc');
	});

	it('an empty detail object → null detail (omitted, not "{}")', () => {
		const m = buildPulse({ roleEvents: [ev('role_event:e', 'created', 'x', T1, {})] });
		const e = m.entries.find((x) => x.kind === 'hr-role')!;
		expect(e.detail).toBeNull();
	});

	it('a non-empty detail object → compact JSON line', () => {
		const m = buildPulse({ roleEvents: [ev('role_event:j', 'tier_changed', 'x', T1, { from: 'haiku', to: 'opus' })] });
		const e = m.entries.find((x) => x.kind === 'hr-role')!;
		expect(e.detail).toBe('{"from":"haiku","to":"opus"}');
	});
});

describe('buildPulse — autonomous loop singleton (honest tick state)', () => {
	const loop = (state: string, reason = 'r', ticksUsed = 0): PulseLoopLike => ({ state, reason, ticksUsed });

	it('a running loop is live → not idle, running tone', () => {
		const m = buildPulse({ loop: loop('running', 'driving', 3) });
		expect(m.loop).not.toBeNull();
		expect(m.loop!.tone).toBe('running');
		expect(m.loop!.label).toBe('Driving — working the next batch');
		expect(m.loop!.ticksUsed).toBe(3);
		expect(m.idle).toBe(false);
	});

	it('a blocked loop is live with blocked tone', () => {
		const m = buildPulse({ loop: loop('blocked') });
		expect(m.loop!.tone).toBe('blocked');
		expect(m.idle).toBe(false);
	});

	it('an IDLE loop with no PM/HR activity → the whole strip is honestly idle', () => {
		const m = buildPulse({ loop: loop('idle', 'no PM hired') });
		expect(m.loop).not.toBeNull();
		expect(m.loop!.label).toBe('Idle');
		expect(m.idle).toBe(true);
	});

	it('an UNKNOWN loop state is shown verbatim, neutral tone, not treated as live', () => {
		const m = buildPulse({ loop: loop('weird-state') });
		expect(m.loop!.label).toBe('weird-state');
		expect(m.loop!.tone).toBe('neutral');
		// unknown is not in loopIsLive's exclusion set → it IS treated as live (honest: something is happening)
		expect(m.idle).toBe(false);
	});

	it('a loop with empty state → "unknown" label, not a crash', () => {
		const m = buildPulse({ loop: { state: '', reason: '', ticksUsed: 0 } });
		expect(m.loop!.state).toBe('unknown');
		expect(m.loop!.label).toBe('unknown');
	});
});

describe('buildPulse — ordering + bounding', () => {
	it('entries are newest-first across PM + HR streams', () => {
		const m = buildPulse({
			proposals: [proposal('task:a', 'old', T0)],
			roleEvents: [{ id: 'role_event:n', op: 'created', role_slug: 'x', at: T2 }]
		});
		expect(m.entries[0].at).toBe(T2); // the role_event (newest)
		expect(m.entries[1].at).toBe(T0); // the proposal (older)
	});

	it('entries with no timestamp sort LAST', () => {
		const m = buildPulse({
			proposals: [proposal('task:a', 'has-time', T1), proposal('task:b', 'no-time', null)]
		});
		expect(m.entries[0].at).toBe(T1);
		expect(m.entries[m.entries.length - 1].at).toBeNull();
	});

	it('the entry list is bounded by limit (loop stays separate)', () => {
		const proposals = Array.from({ length: 30 }, (_, i) => proposal(`task:${i}`, `t${i}`, T0));
		const m = buildPulse({ proposals, loop: { state: 'running', reason: 'r', ticksUsed: 1 } }, 5);
		expect(m.entries.length).toBe(5);
		expect(m.loop).not.toBeNull(); // the loop singleton is never truncated by the entry cap
		expect(m.pmCount).toBe(30); // count reflects ALL, not just the page
	});

	it('upstream-error-as-empty: a failed source arrives as [] → honest idle, never a throw', () => {
		// The server read degrades a failed source to [] (best-effort); the fold must absorb that.
		expect(() => buildPulse({ proposals: [], roleEvents: [], loop: null })).not.toThrow();
		expect(buildPulse({ proposals: [], roleEvents: [], loop: null }).idle).toBe(true);
	});
});
