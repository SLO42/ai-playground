import { describe, it, expect } from 'vitest';
import { buildPeerSendAffordance, WHO_LIST_MAX } from './affordance';
import type { FleetSnapshot, LiveSession } from './resolve';

// CONVERSATION-LAYER-SPEC (pillar 3) VERIFY — the peer-send AFFORDANCE composer (pure).
//
// Proves the four rails the affordance must honour:
//   • affordance-only-when-granted  — !granted → null (no section at all).
//   • call shape + async framing    — states peer_send({to,body}) is async/inbox, no blocking.
//   • HONEST address classes (F-008) — advertises session + role@project, EXPLICITLY NOT pm/atelier
//     (inert D-040 placeholders — never tell an agent it can reach a dead address).
//   • REAL bounded who-list (F-008)  — derived from the live FleetSnapshot: this project's running
//     sessions, excluding self; honest-empty when solo; capped at WHO_LIST_MAX with an overflow note.
//   • purpose + restraint            — frames sparing use; a message is DATA, never a command (D-035a).

const PROJECT = 'project:demo';
const SELF = 'session:self';

function sess(over: Partial<LiveSession> & { id: string }): LiveSession {
	return { role: null, project: PROJECT, kind: 'task', pm: null, ...over };
}

function fleet(running: LiveSession[]): FleetSnapshot {
	return { running, pmByProject: {} };
}

describe('buildPeerSendAffordance — granted gate', () => {
	it('returns null when NOT granted (no dead affordance for a non-granted session)', () => {
		expect(
			buildPeerSendAffordance({ granted: false, sessionId: SELF, project: PROJECT, fleet: fleet([]) })
		).toBeNull();
	});

	it('returns a non-null instruction section when granted', () => {
		const out = buildPeerSendAffordance({
			granted: true,
			sessionId: SELF,
			project: PROJECT,
			fleet: fleet([])
		});
		expect(out).not.toBeNull();
		expect(out).toContain('peer_send');
	});
});

describe('buildPeerSendAffordance — call shape + async framing', () => {
	const out = buildPeerSendAffordance({
		granted: true,
		sessionId: SELF,
		project: PROJECT,
		fleet: fleet([])
	})!;

	it('states the peer_send call shape and that it is async/inbox (never blocking)', () => {
		expect(out).toContain('peer_send({ to: { kind, ref?, project? }, body })');
		expect(out.toLowerCase()).toContain('inbox');
		expect(out.toLowerCase()).toMatch(/does not block|not block/);
	});
});

describe('buildPeerSendAffordance — honest address classes (F-008)', () => {
	const out = buildPeerSendAffordance({
		granted: true,
		sessionId: SELF,
		project: PROJECT,
		fleet: fleet([])
	})!;

	it('advertises the session and role address classes', () => {
		expect(out).toContain('"session"');
		expect(out).toContain('"role"');
	});

	it('does NOT advertise pm or atelier as reachable (inert D-040 placeholders)', () => {
		// They may appear ONLY in the explicit "do NOT use these" warning — never as a reachable
		// address class. Assert the warning is present and no reachable-address line offers them.
		expect(out.toLowerCase()).toContain('do not attempt `pm` or `atelier`');
		// No address-class bullet advertises pm/atelier as a { kind: "pm"/"atelier" } target.
		expect(out).not.toContain('kind: "pm"');
		expect(out).not.toContain('kind: "atelier"');
	});
});

describe('buildPeerSendAffordance — real who-list (F-008, bounded)', () => {
	it('honest-empty when the agent is the only session in the project', () => {
		const out = buildPeerSendAffordance({
			granted: true,
			sessionId: SELF,
			project: PROJECT,
			fleet: fleet([sess({ id: SELF, role: 'coder' })]) // only self running
		})!;
		expect(out.toLowerCase()).toContain('you are the only session');
		expect(out).not.toContain(SELF); // never lists itself as a reachable peer
	});

	it('lists real running peers in THIS project (excluding self), with their roles', () => {
		const out = buildPeerSendAffordance({
			granted: true,
			sessionId: SELF,
			project: PROJECT,
			fleet: fleet([
				sess({ id: SELF, role: 'coder' }),
				sess({ id: 'session:peer-a', role: 'reviewer' }),
				sess({ id: 'session:peer-b', role: null })
			])
		})!;
		expect(out).toContain('session:peer-a');
		expect(out).toContain('reviewer');
		expect(out).toContain('session:peer-b');
		expect(out).not.toContain(SELF);
	});

	it('excludes sessions in OTHER projects (in-project mesh only — cross-project forbidden)', () => {
		const out = buildPeerSendAffordance({
			granted: true,
			sessionId: SELF,
			project: PROJECT,
			fleet: fleet([
				sess({ id: 'session:here', role: 'coder' }),
				sess({ id: 'session:elsewhere', role: 'coder', project: 'project:other' })
			])
		})!;
		expect(out).toContain('session:here');
		expect(out).not.toContain('session:elsewhere');
	});

	it('a project-less session advertises NO peers (no cross-project recipients)', () => {
		const out = buildPeerSendAffordance({
			granted: true,
			sessionId: SELF,
			project: null,
			fleet: fleet([sess({ id: 'session:somewhere', role: 'coder' })])
		})!;
		expect(out.toLowerCase()).toContain('you are the only session');
		expect(out).not.toContain('session:somewhere');
	});

	it('caps the who-list at WHO_LIST_MAX and notes the overflow honestly', () => {
		const many: LiveSession[] = [];
		for (let i = 0; i < WHO_LIST_MAX + 5; i++) {
			many.push(sess({ id: `session:peer-${i}`, role: 'worker' }));
		}
		const out = buildPeerSendAffordance({
			granted: true,
			sessionId: SELF,
			project: PROJECT,
			fleet: fleet(many)
		})!;
		// Exactly WHO_LIST_MAX peer bullets enumerated.
		const enumerated = (out.match(/- session:peer-\d+/g) ?? []).length;
		expect(enumerated).toBe(WHO_LIST_MAX);
		expect(out).toContain('and 5 more running sessions');
	});
});

describe('buildPeerSendAffordance — purpose + restraint framing (D-035a)', () => {
	const out = buildPeerSendAffordance({
		granted: true,
		sessionId: SELF,
		project: PROJECT,
		fleet: fleet([])
	})!;

	it('frames sparing use and that a peer message is DATA, never a command', () => {
		expect(out.toLowerCase()).toContain('sparingly');
		expect(out.toLowerCase()).toContain('never a command');
	});
});

describe('buildPeerSendAffordance — shadow paths', () => {
	it('nil options → null (never throws)', () => {
		expect(buildPeerSendAffordance(undefined as never)).toBeNull();
	});

	it('a malformed fleet.running (non-array) yields the honest-empty who-list, never a throw', () => {
		const out = buildPeerSendAffordance({
			granted: true,
			sessionId: SELF,
			project: PROJECT,
			fleet: { running: undefined as never, pmByProject: {} }
		})!;
		expect(out).not.toBeNull();
		expect(out.toLowerCase()).toContain('you are the only session');
	});
});
