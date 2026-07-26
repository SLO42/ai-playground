// NAMING — the shared display-name composer.
//
// Operator rule under test (standing, 2026-07-26): a display name must convey PURPOSE. A name
// that degrades to a model tier, a pool-slot ordinal, a repeated intent slug, or a raw record id
// is a DEFECT of the same severity class as a fabricated value under F-008.
//
// Every exported function is exercised on all FOUR data-flow shadow paths:
//   happy · nil · empty/blank · upstream-error (wrong type / stringified-nil / throwing toString).

import { describe, it, expect } from 'vitest';
import {
	stripRecordId,
	shortRef,
	describeSession,
	sessionDisplayName,
	describeAgent,
	agentDisplayName,
	describeRole,
	roleDisplayName
} from './naming';

describe('stripRecordId — a raw record id is not a name', () => {
	it('humanizes a seeded role id by dropping the table prefix and the epoch suffix', () => {
		// The exact live residue the review found rendered verbatim on the workforce surfaces.
		expect(stripRecordId('role:probe_fit_1781894354268')).toBe('probe_fit');
		expect(stripRecordId('role:rtprobe_hire_1781892363650')).toBe('rtprobe_hire');
		expect(stripRecordId('role:ph2_live_1781892016151')).toBe('ph2_live');
	});

	it('keeps a real slug intact', () => {
		expect(stripRecordId('role:hr-recruiter')).toBe('hr-recruiter');
		expect(stripRecordId('bare-slug')).toBe('bare-slug');
		expect(stripRecordId('role:qa-lead')).toBe('qa-lead');
	});

	it('returns null for an OPAQUE auto-id — honest namelessness, never a fake name (F-008)', () => {
		// The live residue role `role:gq3glfee2zcw993suhto` and any ULID session id.
		expect(stripRecordId('role:gq3glfee2zcw993suhto')).toBeNull();
		expect(stripRecordId('session:01k9abcdefghjkmnpqrs')).toBeNull();
	});

	it('unwraps a bracketed complex id', () => {
		expect(stripRecordId('role:⟨probe_fit_1781894354268⟩')).toBe('probe_fit');
	});

	// ── shadow: nil ──
	it('nil input → null', () => {
		expect(stripRecordId(null)).toBeNull();
		expect(stripRecordId(undefined)).toBeNull();
	});

	// ── shadow: empty ──
	it('empty / whitespace / prefix-only input → null', () => {
		expect(stripRecordId('')).toBeNull();
		expect(stripRecordId('   ')).toBeNull();
		expect(stripRecordId('role:')).toBeNull();
		expect(stripRecordId('role:   ')).toBeNull();
		expect(stripRecordId('role:_1781894354268')).toBeNull();
	});

	// ── shadow: upstream error ──
	it('a stringified-nil or non-string upstream value → null, never the literal "undefined"', () => {
		expect(stripRecordId('undefined')).toBeNull();
		expect(stripRecordId('null')).toBeNull();
		expect(stripRecordId({})).toBeNull(); // '[object Object]' must never leak into a label
		expect(stripRecordId(42)).toBe('42');
		expect(stripRecordId(Number.NaN)).toBeNull();
		expect(stripRecordId(true)).toBeNull();
		expect(
			stripRecordId({
				toString() {
					throw new Error('boom');
				}
			})
		).toBeNull();
	});

	it('accepts a RecordId-like object whose toString yields table:id', () => {
		const rid = { toString: () => 'role:hr-recruiter' };
		expect(stripRecordId(rid)).toBe('hr-recruiter');
	});
});

describe('shortRef — the traceability id, rendered as an id and never as a name', () => {
	it('returns the id tail', () => {
		expect(shortRef('session:01k9abcdefghjkmnpqrs')).toBe('jkmnpqrs');
		expect(shortRef('session:abcdefghij')).toBe('cdefghij');
		expect(shortRef('short')).toBe('short');
	});

	it('nil / empty → the honest em dash, never "undefined" (F-013)', () => {
		expect(shortRef(null)).toBe('—');
		expect(shortRef(undefined)).toBe('—');
		expect(shortRef('')).toBe('—');
		expect(shortRef('   ')).toBe('—');
		expect(shortRef('undefined')).toBe('—');
	});
});

describe('describeSession — THE NAMED CASE', () => {
	it('composes the operator target shape from the real live row', () => {
		// Live sample from the review: `sonnet-1 / code-write / "Unblock 1 stalled task(s)"`.
		const d = describeSession({
			intent: 'code-write',
			taskTitle: 'Unblock 1 stalled task(s)',
			qualifier: 'sonnet-1'
		});
		expect(d.name).toBe('code-write · Unblock 1 stalled task(s) · sonnet-1');
		expect(d.identity).toBe('code-write');
		expect(d.subject).toBe('Unblock 1 stalled task(s)');
		expect(d.qualifier).toBe('sonnet-1');
		expect(d.isPlaceholder).toBe(false);
	});

	it('the slot id is NEVER promoted to the identity when nothing purposeful exists', () => {
		const d = describeSession({ qualifier: 'sonnet-1' });
		expect(d.identity).toBe('unnamed session');
		expect(d.name).toBe('unnamed session · sonnet-1');
		expect(d.isPlaceholder).toBe(true);
		// The regression the operator reported: the label must not BE the slot id.
		expect(d.name).not.toBe('sonnet-1');
		expect(d.identity).not.toBe('sonnet-1');
	});

	it('honors the documented priority order role.name → slug → role-ref → specialist → intent', () => {
		const all = {
			roleName: 'HR Recruiter',
			roleSlug: 'hr-recruiter',
			role: 'role:probe_fit_1781894354268',
			specialist: 'rounds-mod-developer',
			intent: 'code-write',
			kind: 'interview'
		};
		expect(describeSession(all).identity).toBe('HR Recruiter');
		expect(describeSession({ ...all, roleName: undefined }).identity).toBe('hr-recruiter');
		expect(describeSession({ ...all, roleName: null, roleSlug: '' }).identity).toBe('probe_fit');
		expect(
			describeSession({ ...all, roleName: null, roleSlug: null, role: null }).identity
		).toBe('rounds-mod-developer');
		expect(
			describeSession({ ...all, roleName: null, roleSlug: null, role: null, specialist: null })
				.identity
		).toBe('code-write');
	});

	it('uses `kind` only as the LAST resort — never in front of a real task title', () => {
		expect(describeSession({ kind: 'chat' }).name).toBe('chat');
		const withTitle = describeSession({ kind: 'task', taskTitle: 'Wire the reaper' });
		expect(withTitle.name).toBe('Wire the reaper');
		expect(withTitle.name).not.toContain('task ·');
	});

	it('drops a subject that merely repeats the identity (the repeated-slug defect)', () => {
		const d = describeSession({ intent: 'code-write', taskTitle: 'code-write' });
		expect(d.name).toBe('code-write');
		expect(d.subject).toBeNull();
	});

	it('includeKind appends the coarse kind, de-duplicated, and stays OFF by default', () => {
		// OFF by default so the scene node keeps the agreed 3-part shape.
		expect(sessionDisplayName({ roleName: 'PM', kind: 'lifecycle' })).toBe('PM');
		// ON for surfaces with room (a restart row, a session card).
		expect(sessionDisplayName({ roleName: 'PM', kind: 'lifecycle' }, { includeKind: true })).toBe(
			'PM · lifecycle'
		);
		// never duplicated against the identity …
		expect(sessionDisplayName({ intent: 'review', kind: 'review' }, { includeKind: true })).toBe(
			'review'
		);
		// … nor against the subject.
		expect(
			sessionDisplayName({ intent: 'code-write', taskTitle: 'task', kind: 'task' }, { includeKind: true })
		).toBe('code-write · task');
		// it rides BEFORE the qualifier — the model/slot id is always last.
		expect(
			sessionDisplayName(
				{ roleName: 'PM', kind: 'lifecycle', qualifier: 'opus-1' },
				{ includeKind: true }
			)
		).toBe('PM · lifecycle · opus-1');
		// a blank kind adds nothing (empty shadow path).
		expect(sessionDisplayName({ roleName: 'PM', kind: '  ' }, { includeKind: true })).toBe('PM');
	});

	it('maxSubjectChars ellipsizes the task title VISIBLY, and never the identity or qualifier', () => {
		// A real live title (>200 chars) is unreadable as a graph-node label.
		const long =
			'Establish SDK-style project targeting net472 with a Directory.Build.props that resolves ROUNDS/Unity reference assemblies from an env-pointed local install';
		const d = describeSession(
			{ intent: 'code-write', taskTitle: long, qualifier: 'sonnet-1' },
			{ maxSubjectChars: 56 }
		);
		expect(d.subject!.length).toBeLessThanOrEqual(56);
		expect(d.subject!.endsWith('…')).toBe(true); // truncation is VISIBLE, not a silent clip
		expect(d.name.startsWith('code-write · ')).toBe(true);
		expect(d.name.endsWith(' · sonnet-1')).toBe(true); // qualifier survives intact
		// a title already under the cap is untouched, and no cap means no truncation.
		expect(describeSession({ taskTitle: 'build the mod' }, { maxSubjectChars: 56 }).subject).toBe(
			'build the mod'
		);
		expect(describeSession({ taskTitle: long }).subject).toBe(long);
		// a degenerate cap must not throw or produce a lone ellipsis-less fragment.
		expect(() => describeSession({ taskTitle: long }, { maxSubjectChars: 0 })).not.toThrow();
		expect(describeSession({ taskTitle: long }, { maxSubjectChars: 0 }).subject).toBe(long);
	});

	it('can omit the qualifier for a card that renders the model in its own chip', () => {
		const d = describeSession(
			{ intent: 'code-write', qualifier: 'sonnet-1' },
			{ includeQualifier: false }
		);
		expect(d.name).toBe('code-write');
		expect(d.qualifier).toBeNull();
	});

	it('accepts a caller-supplied placeholder for a dense cell', () => {
		expect(sessionDisplayName(null, { placeholder: '—' })).toBe('—');
	});

	// ── shadow: nil ──
	it('nil input → the honest placeholder', () => {
		expect(sessionDisplayName(null)).toBe('unnamed session');
		expect(sessionDisplayName(undefined)).toBe('unnamed session');
		expect(describeSession(undefined).isPlaceholder).toBe(true);
	});

	// ── shadow: empty ──
	it('all-blank fields are treated as absent, not rendered', () => {
		const d = describeSession({
			roleName: '   ',
			roleSlug: '',
			specialist: '',
			taskTitle: '  ',
			intent: '',
			kind: '',
			qualifier: ''
		});
		expect(d.name).toBe('unnamed session');
		expect(d.isPlaceholder).toBe(true);
	});

	it('empty object → the honest placeholder', () => {
		expect(sessionDisplayName({})).toBe('unnamed session');
	});

	// ── shadow: upstream error ──
	it('stringified-nil and wrong-typed fields never leak into the name (F-013)', () => {
		const d = describeSession({
			roleName: 'undefined',
			roleSlug: 'null',
			specialist: {},
			taskTitle: Number.NaN,
			intent: 'code-write',
			qualifier: []
		});
		expect(d.name).toBe('code-write');
		expect(d.name).not.toContain('undefined');
		expect(d.name).not.toContain('[object Object]');
		expect(d.name).not.toContain('NaN');
	});

	it('never throws on a hostile input', () => {
		expect(() =>
			describeSession({
				roleName: {
					toString() {
						throw new Error('boom');
					}
				}
			})
		).not.toThrow();
	});
});

describe('describeAgent — the scene cluster node (F-046 demotion)', () => {
	it('names the cluster by purpose and demotes the pool slot id', () => {
		const d = describeAgent({ slot: 'sonnet-1', intents: ['code-write'] });
		expect(d.name).toBe('code-write · sonnet-1');
		expect(d.identity).toBe('code-write');
		expect(d.qualifier).toBe('sonnet-1');
	});

	it('DISCLOSES the cluster spread rather than showing one of several at random', () => {
		const d = describeAgent({ slot: 'sonnet-1', intents: ['code-write', 'read-only', 'review'] });
		expect(d.name).toBe('code-write +2 · sonnet-1');
	});

	it('collapses duplicates case-insensitively (26 sessions, one intent → no "+25")', () => {
		const intents = Array.from({ length: 26 }, () => 'code-write');
		expect(describeAgent({ slot: 'sonnet-1', intents }).name).toBe('code-write · sonnet-1');
		expect(describeAgent({ slot: 'x', intents: ['Code-Write', 'code-write'] }).name).toBe(
			'Code-Write · x'
		);
	});

	it('prefers roles, then specialists, then intents, then kinds', () => {
		const all = {
			slot: 'opus-1',
			roleNames: ['HR Recruiter'],
			specialists: ['rounds-mod-developer'],
			intents: ['code-write'],
			kinds: ['interview']
		};
		expect(describeAgent(all).identity).toBe('HR Recruiter');
		expect(describeAgent({ ...all, roleNames: [] }).identity).toBe('rounds-mod-developer');
		expect(describeAgent({ ...all, roleNames: [], specialists: [] }).identity).toBe('code-write');
		expect(
			describeAgent({ ...all, roleNames: [], specialists: [], intents: [] }).identity
		).toBe('interview');
	});

	it('a bare slot id is the placeholder + qualifier — the exact operator regression', () => {
		const d = describeAgent({ slot: 'sonnet-1' });
		expect(d.name).toBe('unnamed agent · sonnet-1');
		expect(d.isPlaceholder).toBe(true);
		expect(d.name).not.toBe('sonnet-1');
	});

	// ── shadow: nil / empty / upstream error ──
	it('nil, empty and wrong-typed dimensions degrade honestly', () => {
		expect(agentDisplayName(null)).toBe('unnamed agent');
		expect(agentDisplayName(undefined)).toBe('unnamed agent');
		expect(agentDisplayName({})).toBe('unnamed agent');
		expect(agentDisplayName({ slot: '  ', intents: [] })).toBe('unnamed agent');
		// a non-array where a list was expected, and nil members inside a real list
		expect(
			agentDisplayName({ slot: 'x', intents: 'code-write' as unknown as string[] })
		).toBe('unnamed agent · x');
		expect(agentDisplayName({ slot: 'x', intents: [null, undefined, '', 'code-write'] })).toBe(
			'code-write · x'
		);
	});
});

describe('describeRole — the raw `role:` id class', () => {
	it('prefers the human name, then the slug, then a humanized id', () => {
		expect(roleDisplayName({ name: 'HR Recruiter', slug: 'hr-recruiter' })).toBe('HR Recruiter');
		expect(roleDisplayName({ slug: 'hr-recruiter' })).toBe('hr-recruiter');
		expect(roleDisplayName({ ref: 'role:probe_fit_1781894354268' })).toBe('probe_fit');
	});

	it('an opaque dangling role is labelled honestly — the row is NOT hidden', () => {
		const d = describeRole({ ref: 'role:gq3glfee2zcw993suhto' });
		expect(d.name).toBe('unnamed role');
		expect(d.isPlaceholder).toBe(true);
	});

	// ── shadow: nil / empty / upstream error ──
	it('nil, empty and wrong-typed inputs degrade honestly', () => {
		expect(roleDisplayName(null)).toBe('unnamed role');
		expect(roleDisplayName(undefined)).toBe('unnamed role');
		expect(roleDisplayName({})).toBe('unnamed role');
		expect(roleDisplayName({ name: '  ', slug: '', ref: 'role:' })).toBe('unnamed role');
		expect(roleDisplayName({ name: 'undefined', slug: null, ref: undefined })).toBe('unnamed role');
		expect(roleDisplayName({ name: {} as unknown as string })).toBe('unnamed role');
	});

	it('honors a caller placeholder for a dense cell', () => {
		expect(roleDisplayName(null, { placeholder: '—' })).toBe('—');
	});
});
