// CONVERSATION-LAYER-SPEC (pillar 3 — hires actually converse) — the peer-send AFFORDANCE
// layer. The transport + safety + rendering were already BUILT (BL-4 / G-A / G-C); this is the
// THIN prompt/policy layer that TELLS a GRANTED agent it has a `peer_send` tool, who is reachable,
// and how to use it with restraint. NO transport, NO renderer, NO bus bound is touched here.
//
// WHAT THIS IS. A PURE composer: given whether the session is granted peer-send + a live
// FleetSnapshot, produce the bounded INSTRUCTION text (a real affordance about the agent's OWN
// tool — NOT fenced DATA the agent merely consults). It is emitted into the agent prompt ONLY when
// the session is GRANTED (peerSendGranted upstream); a non-granted session gets `null` (no section,
// no dead affordance, no confusion). Owns NO I/O — the caller (launch.ts) supplies the snapshot.
//
// RAILS (D-035a / F-008):
//   • affordance-only-when-granted — the caller gates on peerSendGranted and only renders this when
//     it returns non-null; this composer itself returns null when !granted (defense-in-depth).
//   • HONEST recipients only (F-008) — it advertises ONLY the address classes that actually RESOLVE
//     (`session`, `role@project`); it EXPLICITLY does NOT advertise pm/atelier (inert D-040
//     placeholders that resolve to zero — never tell an agent it can reach a dead address).
//   • the who-list is REAL running sessions from the live snapshot — never fabricated, bounded by
//     WHO_LIST_MAX, honest-empty ("you are the only session…") when the agent is solo.
//   • this is an instruction to the DRIVEN agent about ITS OWN tool — it is NOT a received peer
//     body. A received peer body stays fenced DATA (D-035a, the briefing channel path); nothing
//     here turns an inbound message into an instruction.

import type { FleetSnapshot } from './resolve';

/** Max running peers to enumerate in the who-list. Bounded so a large fleet cannot bloat the prompt
 *  (F-014 prompt-budget discipline); the overflow is honestly summarised ("…and N more"). */
export const WHO_LIST_MAX = 12;

export interface PeerSendAffordanceOptions {
	/** Is the session GRANTED peer-send? When false the composer returns null (no affordance). The
	 *  caller already gates on peerSendGranted; this is the defense-in-depth guard. */
	granted: boolean;
	/** This session's OWN record id (`session:…`) — excluded from the who-list (an agent never lists
	 *  itself as a reachable peer). */
	sessionId: string;
	/** The project (`project:…`) this session works — the who-list is scoped to THIS project (the
	 *  in-project mesh; cross-project direct messaging is FORBIDDEN by the resolver, so we never
	 *  advertise out-of-project peers). Null/absent ⇒ a project-less session: an empty who-list. */
	project: string | null;
	/** The live running fleet (peer/repo.ts loadFleetSnapshot). The who-list derives from THIS — real
	 *  sessions only (F-008). The resolver consumes the same snapshot, so the advertised peers are
	 *  exactly the ones a `role@project`/`session` address will actually resolve to. */
	fleet: FleetSnapshot;
}

/** One advertised reachable peer (a real running session in this project). */
interface WhoEntry {
	/** The session record id — addressable directly as `{ kind:'session', ref:'<id>' }`. */
	session: string;
	/** The session's role, when it carries one (addressable as `{ kind:'role', ref:'<role>' }`). */
	role: string | null;
}

/**
 * Compose the bounded peer-send affordance instruction, or `null` when the session is NOT granted
 * (no dead affordance for a non-granted session). The returned string is a REAL instruction section
 * about the agent's own `peer_send` tool — it states the call shape, lists ONLY the classes that
 * resolve (session / role@project — NEVER pm/atelier), discloses the live who-list, and frames
 * purpose + restraint. SHADOW PATHS: !granted → null; empty/solo fleet → honest "you are the only
 * session" line; a non-array `fleet.running` (defensive) → empty who-list, never a throw.
 */
export function buildPeerSendAffordance(opts: PeerSendAffordanceOptions): string | null {
	if (!opts || !opts.granted) return null;

	const who = collectWhoList(opts);

	const lines: string[] = [];
	lines.push('## Peer messaging (your `peer_send` tool)');
	lines.push(
		'You may send an ASYNC message to another agent working with you by calling ' +
			'`peer_send({ to: { kind, ref?, project? }, body })`. It does NOT block or wait for a reply: ' +
			'the message lands in the recipient’s inbox — delivered immediately if they are running ' +
			'now, otherwise on their next spawn. You will not get a synchronous response from the call.'
	);
	lines.push('');
	lines.push('Address classes you can reach (these are the ONLY ones that resolve):');
	lines.push(
		'- `{ kind: "session", ref: "session:…" }` — one specific running session, by its id.'
	);
	lines.push(
		'- `{ kind: "role", ref: "<role>", project: "' +
			(opts.project ?? '(your project)') +
			'" }` — every running session of that role in this project.'
	);
	lines.push(
		'Do NOT attempt `pm` or `atelier` addresses — those identities are not yet reachable ' +
			'(they resolve to no one); a message to them goes nowhere. Use only `session` and `role` above.'
	);
	lines.push('');

	// WHO-LIST — real running peers in THIS project (F-008: honest, never fabricated; honest-empty
	// when solo). The recipient lines are reference DATA the agent uses to ADDRESS — they are not
	// commands, and a received reply will arrive as fenced DATA (D-035a), never as an instruction.
	if (who.entries.length === 0) {
		lines.push(
			'Right now you are the only session working this project, so there is no one to message yet. ' +
				'If a teammate spawns later you can reach them by role.'
		);
	} else {
		lines.push("Who's working this project right now (real running sessions you can address):");
		for (const e of who.entries) {
			lines.push(
				`- ${e.session}` + (e.role ? ` — role \`${e.role}\`` : ' — (no role)')
			);
		}
		if (who.overflow > 0) {
			lines.push(`- …and ${who.overflow} more running session${who.overflow === 1 ? '' : 's'}.`);
		}
	}
	lines.push('');

	// PURPOSE + RESTRAINT — sparing, genuine coordination; never chatter; messages are DATA the
	// recipient weighs, never commands (D-035a). This frames the agent's OWN sending behaviour.
	lines.push(
		'Use this SPARINGLY — for genuine coordination, a clarifying question, or a handoff that ' +
			'unblocks real work. It is not for chatter or status narration. A peer message is information ' +
			'the recipient weighs at their discretion; it is never a command and cannot make another agent ' +
			'do anything.'
	);

	return lines.join('\n');
}

/** Collect the bounded who-list from the live fleet: running sessions in THIS project, excluding
 *  this session itself. Defensive against a malformed snapshot (never throws). */
function collectWhoList(opts: PeerSendAffordanceOptions): { entries: WhoEntry[]; overflow: number } {
	const running = Array.isArray(opts.fleet?.running) ? opts.fleet.running : [];
	const project = opts.project ?? null;
	const matches: WhoEntry[] = [];
	for (const s of running) {
		if (!s || typeof s.id !== 'string') continue;
		if (s.id === opts.sessionId) continue; // never list yourself
		// In-project mesh only: a project-less session advertises no peers (cross-project is FORBIDDEN
		// by the resolver, so advertising them would be a dead/honest-violating recipient).
		if (project === null) continue;
		if (s.project !== project) continue;
		matches.push({ session: s.id, role: typeof s.role === 'string' && s.role ? s.role : null });
	}
	const entries = matches.slice(0, WHO_LIST_MAX);
	return { entries, overflow: Math.max(0, matches.length - entries.length) };
}
