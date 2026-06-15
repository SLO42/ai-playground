import { describe, expect, it } from 'vitest';
import {
	ATELIER_PROJECT_KEY,
	CrossProjectError,
	PeerAddressError,
	resolveAddress,
	type FleetSnapshot,
	type LiveSession,
	type PeerSender
} from './resolve';

// G-B PURE address-resolution + recipient-policy unit tests (no DB). Covers the 4 address
// classes, the §11 identity hierarchy placeholders (pm/atelier offline → pending), and the
// §spec recipient policy (in-project mesh permitted, project↔project DIRECT forbidden as a
// NAMED error, →atelier cross-project permitted). Shadow paths: nil/empty coordinate, empty
// fleet, unknown to_kind.

const PROJ_A = 'project:alpha';
const PROJ_B = 'project:beta';
const ROLE_DEV = 'role:dev';
const PM_A = 'pm:alpha';
const PM_ATELIER = 'pm:atelier_self';

function sess(over: Partial<LiveSession> & { id: string }): LiveSession {
	return { role: null, project: null, kind: 'task', pm: null, ...over };
}

function senderIn(project: string | null): PeerSender {
	return { session: 'session:sender', role: null, project };
}

describe('resolveAddress — session class (direct)', () => {
	it('resolves a running in-project session', () => {
		const target = sess({ id: 'session:tgt', project: PROJ_A });
		const fleet: FleetSnapshot = { running: [target] };
		const r = resolveAddress({ kind: 'session', toSession: 'session:tgt' }, senderIn(PROJ_A), fleet);
		expect(r.sessions).toEqual(['session:tgt']);
		expect(r.note).toBeNull();
	});

	it('non-running target → empty set + pending note (honest, not error)', () => {
		const fleet: FleetSnapshot = { running: [] };
		const r = resolveAddress({ kind: 'session', toSession: 'session:gone' }, senderIn(PROJ_A), fleet);
		expect(r.sessions).toEqual([]);
		expect(r.note).toMatch(/pending/);
	});

	it('cross-project direct session → CrossProjectError (named)', () => {
		const target = sess({ id: 'session:tgt', project: PROJ_B });
		const fleet: FleetSnapshot = { running: [target] };
		expect(() =>
			resolveAddress({ kind: 'session', toSession: 'session:tgt' }, senderIn(PROJ_A), fleet)
		).toThrow(CrossProjectError);
	});

	it('nil/empty to_session → PeerAddressError (named)', () => {
		const fleet: FleetSnapshot = { running: [] };
		expect(() => resolveAddress({ kind: 'session' }, senderIn(PROJ_A), fleet)).toThrow(PeerAddressError);
		expect(() =>
			resolveAddress({ kind: 'session', toSession: '   ' }, senderIn(PROJ_A), fleet)
		).toThrow(PeerAddressError);
	});

	it('malformed to_session id → PeerAddressError (D-016 surfaced as named)', () => {
		const fleet: FleetSnapshot = { running: [] };
		expect(() =>
			resolveAddress({ kind: 'session', toSession: 'not a record id' }, senderIn(PROJ_A), fleet)
		).toThrow(PeerAddressError);
	});
});

describe('resolveAddress — role class (in-project mesh)', () => {
	it('resolves all running sessions of that role in the project', () => {
		const fleet: FleetSnapshot = {
			running: [
				sess({ id: 'session:1', role: ROLE_DEV, project: PROJ_A }),
				sess({ id: 'session:2', role: ROLE_DEV, project: PROJ_A }),
				sess({ id: 'session:other', role: ROLE_DEV, project: PROJ_B })
			]
		};
		const r = resolveAddress(
			{ kind: 'role', toRole: ROLE_DEV, project: PROJ_A },
			senderIn(PROJ_A),
			fleet
		);
		expect(new Set(r.sessions)).toEqual(new Set(['session:1', 'session:2']));
		expect(r.note).toBeNull();
	});

	it('no running session for the role → empty + pending note', () => {
		const fleet: FleetSnapshot = { running: [] };
		const r = resolveAddress(
			{ kind: 'role', toRole: ROLE_DEV, project: PROJ_A },
			senderIn(PROJ_A),
			fleet
		);
		expect(r.sessions).toEqual([]);
		expect(r.note).toMatch(/pending/);
	});

	it('cross-project role → CrossProjectError', () => {
		const fleet: FleetSnapshot = { running: [sess({ id: 'session:1', role: ROLE_DEV, project: PROJ_B })] };
		expect(() =>
			resolveAddress({ kind: 'role', toRole: ROLE_DEV, project: PROJ_B }, senderIn(PROJ_A), fleet)
		).toThrow(CrossProjectError);
	});

	it('missing project coordinate → PeerAddressError', () => {
		const fleet: FleetSnapshot = { running: [] };
		expect(() =>
			resolveAddress({ kind: 'role', toRole: ROLE_DEV }, senderIn(PROJ_A), fleet)
		).toThrow(PeerAddressError);
	});
});

describe('resolveAddress — pm class (hub, usually offline)', () => {
	it('offline PM (no running pm session) → empty + pending note, NOT error', () => {
		const fleet: FleetSnapshot = {
			running: [],
			pmByProject: { [PROJ_A]: PM_A }
		};
		const r = resolveAddress({ kind: 'pm', project: PROJ_A }, senderIn(PROJ_A), fleet);
		expect(r.sessions).toEqual([]);
		expect(r.note).toMatch(/offline|pending/);
	});

	it('running PM session → resolves to it', () => {
		const fleet: FleetSnapshot = {
			running: [sess({ id: 'session:pm', project: PROJ_A, pm: PM_A, kind: 'review' })],
			pmByProject: { [PROJ_A]: PM_A }
		};
		const r = resolveAddress({ kind: 'pm', project: PROJ_A }, senderIn(PROJ_A), fleet);
		expect(r.sessions).toEqual(['session:pm']);
	});

	it('project with no PM identity → empty + pending note', () => {
		const fleet: FleetSnapshot = { running: [], pmByProject: {} };
		const r = resolveAddress({ kind: 'pm', project: PROJ_A }, senderIn(PROJ_A), fleet);
		expect(r.sessions).toEqual([]);
		expect(r.note).toMatch(/no PM identity|pending/);
	});

	it('cross-project pm → CrossProjectError', () => {
		const fleet: FleetSnapshot = { running: [], pmByProject: { [PROJ_B]: 'pm:beta' } };
		expect(() =>
			resolveAddress({ kind: 'pm', project: PROJ_B }, senderIn(PROJ_A), fleet)
		).toThrow(CrossProjectError);
	});
});

describe('resolveAddress — atelier class (the one cross-project identity)', () => {
	it('a sender in ANY project may reach atelier (no CrossProjectError)', () => {
		const fleet: FleetSnapshot = { running: [], pmByProject: { [ATELIER_PROJECT_KEY]: PM_ATELIER } };
		const r = resolveAddress({ kind: 'atelier' }, senderIn(PROJ_A), fleet);
		expect(r.kind).toBe('atelier');
		// offline → pending; the point is it did NOT throw cross-project.
		expect(r.sessions).toEqual([]);
		expect(r.note).toMatch(/pending/);
	});

	it('atelier identity offline / not composed → empty + placeholder note', () => {
		const fleet: FleetSnapshot = { running: [], pmByProject: {} };
		const r = resolveAddress({ kind: 'atelier' }, senderIn(PROJ_B), fleet);
		expect(r.sessions).toEqual([]);
		expect(r.note).toMatch(/D-040|placeholder|offline/);
	});

	it('running atelier session → resolves to it', () => {
		const fleet: FleetSnapshot = {
			running: [sess({ id: 'session:atelier', pm: PM_ATELIER, project: null })],
			pmByProject: { [ATELIER_PROJECT_KEY]: PM_ATELIER }
		};
		const r = resolveAddress({ kind: 'atelier' }, senderIn(PROJ_A), fleet);
		expect(r.sessions).toEqual(['session:atelier']);
	});
});

describe('resolveAddress — in-project mesh permits same-scope', () => {
	it('two project-less (global) sessions are same-scope → permitted', () => {
		const fleet: FleetSnapshot = { running: [sess({ id: 'session:g', project: null })] };
		const r = resolveAddress(
			{ kind: 'session', toSession: 'session:g' },
			senderIn(null),
			fleet
		);
		expect(r.sessions).toEqual(['session:g']);
	});

	it('project-less sender → project-scoped session is cross-project (forbidden)', () => {
		const fleet: FleetSnapshot = { running: [sess({ id: 'session:p', project: PROJ_A })] };
		expect(() =>
			resolveAddress({ kind: 'session', toSession: 'session:p' }, senderIn(null), fleet)
		).toThrow(CrossProjectError);
	});
});

describe('resolveAddress — shadow paths', () => {
	it('missing sender session → PeerAddressError', () => {
		const fleet: FleetSnapshot = { running: [] };
		expect(() =>
			resolveAddress({ kind: 'atelier' }, { session: '' } as PeerSender, fleet)
		).toThrow(PeerAddressError);
	});

	it('unknown to_kind → PeerAddressError', () => {
		const fleet: FleetSnapshot = { running: [] };
		expect(() =>
			// @ts-expect-error — deliberately invalid kind for the shadow-path branch
			resolveAddress({ kind: 'broadcast' }, senderIn(PROJ_A), fleet)
		).toThrow(PeerAddressError);
	});

	it('empty fleet for every class → honest empty, never crash', () => {
		const fleet: FleetSnapshot = { running: [] };
		expect(resolveAddress({ kind: 'atelier' }, senderIn(PROJ_A), fleet).sessions).toEqual([]);
		expect(
			resolveAddress({ kind: 'role', toRole: ROLE_DEV, project: PROJ_A }, senderIn(PROJ_A), fleet)
				.sessions
		).toEqual([]);
		expect(resolveAddress({ kind: 'pm', project: PROJ_A }, senderIn(PROJ_A), fleet).sessions).toEqual([]);
	});
});
