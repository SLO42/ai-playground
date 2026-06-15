import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { FENCE_OPEN } from '../memory/fence';
import { rowTurnKind, rowToTurn } from '../../client/transcript-core';
import { sendPeerMessage, getPeerMessage } from './repo';
import { sendPeer, type DeliverLive } from './send';
import { drainInbox, PEER_MESSAGE_TTL_MS, MAX_DRAIN_PER_SPAWN } from './drain';

// G-B DRAIN VERIFY — the OFFLINE drain end-to-end against a REAL throwaway SurrealDB. The close-the-
// loop half: a message sent while the recipient was OFFLINE stays pending, drains at the recipient's
// next spawn, marks delivered + renders as a 'communication' turn (G-A classification); the TTL/hops
// expiry path (honest, never silently dropped); idempotent no-double-deliver across the live (PM2)
// path + the drain AND across a re-run of the drain itself (interrupt contract); the role@project
// address drain; and the shadow paths (empty inbox, role-less session, stale row not delivered).

let tdb: TestDb;
let db: Db;
let dseq = 0;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function freshProject(): Promise<string> {
	const slug = `pdrain_proj_${++dseq}`;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $slug) SET slug = $slug, name = $slug, root_path = "/tmp", status = "active" RETURN id;`,
		{ slug }
	);
	return String(rows[0].id);
}

async function freshRole(): Promise<string> {
	const slug = `pdrain_role_${++dseq}`;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('role', $slug) SET slug = $slug, name = $slug, purpose = "test", status = "active" RETURN id;`,
		{ slug }
	);
	return String(rows[0].id);
}

async function freshSession(
	opts: { project?: string; role?: string; kind?: string; status?: string } = {}
): Promise<string> {
	const set: string[] = [`kind = $kind`, `status = $status`, `model = { provider: 'claude', model_id: 'claude-test' }`];
	const bind: Record<string, unknown> = { kind: opts.kind ?? 'task', status: opts.status ?? 'running' };
	if (opts.project) {
		set.push(`project = type::thing('project', $pj)`);
		bind.pj = opts.project.split(':')[1];
	}
	if (opts.role) {
		set.push(`role = type::thing('role', $rl)`);
		bind.rl = opts.role.split(':')[1];
	}
	const [rows] = await db.query<[Array<{ id: unknown }>]>(`CREATE session SET ${set.join(', ')} RETURN id;`, bind);
	return String(rows[0].id);
}

/** Read the persisted transcript message rows for a session (the G-A render input). */
async function transcriptRows(
	sessionId: string
): Promise<Array<{ id: string; role: string; kind?: string; origin?: string; content?: string; toolCall?: Record<string, unknown> }>> {
	const { StringRecordId } = await import('surrealdb');
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, role, kind, origin ?? "agent" AS origin, content, tool_call, seq, at FROM message WHERE session = $sid ORDER BY seq ASC, at ASC;`,
		{ sid: new StringRecordId(sessionId) }
	);
	return (rows ?? []).map((r) => ({
		id: String(r.id),
		role: String(r.role),
		kind: r.kind != null ? String(r.kind) : undefined,
		origin: r.origin != null ? String(r.origin) : undefined,
		content: r.content != null ? String(r.content) : undefined,
		toolCall: (r.tool_call ?? undefined) as Record<string, unknown> | undefined
	}));
}

// ── (a) OFFLINE DRAIN: pending → drained at spawn → delivered + communication turn ───

describe('drainInbox — offline drain delivers + renders as a communication turn (G-A)', () => {
	it('a message sent while the recipient was offline drains at its next spawn, marks delivered, and renders as a communication turn', async () => {
		const proj = await freshProject();
		// Recipient is NOT running yet (offline). The message inboxes as pending.
		const sender = await freshSession({ project: proj });
		const recipient = await freshSession({ project: proj });

		const msg = await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'session',
			to_session: recipient,
			body: 'I found the auth bug in src/login.ts — see line 42.'
		});
		expect(msg.status).toBe('pending');
		expect(msg.body).toContain(FENCE_OPEN); // already fenced DATA

		// Recipient SPAWNS → drain its inbox.
		const res = await drainInbox(db, { sessionId: recipient, project: proj });
		expect(res.delivered.map((d) => d.id)).toEqual([msg.id]);
		expect(res.delivered[0].fromSession).toBe(sender);
		expect(res.expiredCount).toBe(0);

		// The row is now delivered (durable status flip).
		const after = await getPeerMessage(db, msg.id);
		expect(after!.status).toBe('delivered');
		expect(after!.delivered_at).not.toBeNull();

		// Simulate the launch transcript-row write for the drained message (origin=agent, role=system),
		// then assert the SHARED transcript classifier renders it as a 'communication' turn (G-A).
		const { StringRecordId } = await import('surrealdb');
		await db.query(`CREATE message CONTENT $c;`, {
			c: {
				session: new StringRecordId(recipient),
				role: 'system',
				origin: 'agent',
				kind: 'system',
				seq: -2,
				content: res.delivered[0].body,
				tool_call: { kind: 'peer_message', from_session: sender }
			}
		});
		const rows = await transcriptRows(recipient);
		const peerRow = rows.find((r) => (r.toolCall as { kind?: string })?.kind === 'peer_message');
		expect(peerRow).toBeTruthy();
		expect(rowTurnKind(peerRow!)).toBe('communication');
		const turn = rowToTurn(peerRow!, 0);
		expect(turn.kind).toBe('communication');
		expect(turn.origin).toBe('agent'); // honest unknown peer — never promoted to operator
		expect(turn.content).toContain(FENCE_OPEN); // delivered as fenced DATA
	});
});

// ── (b) TTL / hops expiry — honest, never silently dropped ──────────────────────────

describe('drainInbox — TTL/hops expiry (honest expired, not delivered)', () => {
	it('a pending message older than the TTL EXPIRES on drain instead of delivering', async () => {
		const proj = await freshProject();
		const sender = await freshSession({ project: proj });
		const recipient = await freshSession({ project: proj });

		const msg = await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'session',
			to_session: recipient,
			body: 'a week-old finding'
		});
		// Backdate created_at past the TTL (a real long-offline recipient).
		const { StringRecordId } = await import('surrealdb');
		const stale = new Date(Date.now() - PEER_MESSAGE_TTL_MS - 60_000);
		await db.query(`UPDATE $rid SET created_at = $stale;`, {
			rid: new StringRecordId(msg.id),
			stale
		});

		const res = await drainInbox(db, { sessionId: recipient, project: proj });
		expect(res.delivered).toEqual([]); // NOT delivered
		expect(res.expiredCount).toBe(1);

		const after = await getPeerMessage(db, msg.id);
		expect(after!.status).toBe('expired'); // honest, never silently dropped
	});

	it('a pending message with exhausted hops (≤ 0) EXPIRES rather than delivering', async () => {
		const proj = await freshProject();
		const sender = await freshSession({ project: proj });
		const recipient = await freshSession({ project: proj });

		const msg = await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'session',
			to_session: recipient,
			body: 'terminal relay',
			hops: 0 // terminal — its relay TTL is spent
		});
		const res = await drainInbox(db, { sessionId: recipient, project: proj });
		expect(res.delivered).toEqual([]);
		expect(res.expiredCount).toBe(1);
		const after = await getPeerMessage(db, msg.id);
		expect(after!.status).toBe('expired');
	});
});

// ── (c) IDEMPOTENCY — no double-deliver across live(PM2)+drain and across drain re-runs ─

describe('drainInbox — idempotent (no double-deliver)', () => {
	it('a message LIVE-delivered (PM2) is NOT re-drained at the recipient spawn', async () => {
		const proj = await freshProject();
		const sender = await freshSession({ project: proj });
		const recipient = await freshSession({ project: proj });

		// PM2 live path: sendPeer with a deliver fn that acks → the row is marked delivered live.
		const deliver: DeliverLive = async () => true;
		const res = await sendPeer(
			{ senderSessionId: sender, address: { kind: 'session', toSession: recipient }, body: 'live now' },
			{ db, deliver }
		);
		expect(res.deliveredTo).toEqual([recipient]);
		const live = await getPeerMessage(db, res.messageId);
		expect(live!.status).toBe('delivered');

		// The recipient later (re)spawns → drain MUST NOT re-deliver the already-delivered message.
		const drain = await drainInbox(db, { sessionId: recipient, project: proj });
		expect(drain.delivered).toEqual([]); // collapsed by id (status guard)
		expect(drain.expiredCount).toBe(0);
	});

	it('a re-run of the drain (interrupted spawn re-launched) does not double-deliver', async () => {
		const proj = await freshProject();
		const sender = await freshSession({ project: proj });
		const recipient = await freshSession({ project: proj });

		const msg = await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'session',
			to_session: recipient,
			body: 'drain me once'
		});

		const first = await drainInbox(db, { sessionId: recipient, project: proj });
		expect(first.delivered.map((d) => d.id)).toEqual([msg.id]);

		// Re-run (the spawn died mid-launch and was re-invoked): the row is now 'delivered', so the
		// guarded UPDATE matches nothing → NOT re-delivered (interrupt contract: absorb prior work).
		const second = await drainInbox(db, { sessionId: recipient, project: proj });
		expect(second.delivered).toEqual([]);
	});
});

// ── (d) role@project address drain ──────────────────────────────────────────────────

describe('drainInbox — role@project address', () => {
	it('drains a message addressed to the recipient role IN the project', async () => {
		const proj = await freshProject();
		const role = await freshRole();
		const sender = await freshSession({ project: proj });
		// The recipient session is staffed with the role (workforce activation stamps session.role).
		const recipient = await freshSession({ project: proj, role });

		const msg = await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'role',
			to_role: role,
			project: proj,
			body: 'role-addressed handoff'
		});

		const res = await drainInbox(db, { sessionId: recipient, role, project: proj });
		expect(res.delivered.map((d) => d.id)).toEqual([msg.id]);
		expect(res.delivered[0].toKind).toBe('role');
		const after = await getPeerMessage(db, msg.id);
		expect(after!.status).toBe('delivered');
	});

	it('does NOT drain a role message to a session that lacks that role (in-project but wrong role)', async () => {
		const proj = await freshProject();
		const role = await freshRole();
		const otherRole = await freshRole();
		const sender = await freshSession({ project: proj });
		const wrong = await freshSession({ project: proj, role: otherRole });

		await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'role',
			to_role: role,
			project: proj,
			body: 'not for you'
		});

		const res = await drainInbox(db, { sessionId: wrong, role: otherRole, project: proj });
		expect(res.delivered).toEqual([]); // role mismatch → stays pending for the right session
	});
});

// ── (e) CROSS-PROJECT RE-ASSERTION AT DELIVERY TIME (PM1) ────────────────────────────

describe('drainInbox — cross-project isolation re-asserted at delivery (PM1)', () => {
	it('a pending DIRECT message from project-A to a then-OFFLINE project-B session is NOT delivered when that session comes up — it EXPIRES', async () => {
		const projA = await freshProject();
		const projB = await freshProject();
		const senderA = await freshSession({ project: projA });
		// The project-B recipient is OFFLINE at send time: sendPeer's resolver returns empty + pending
		// (it cannot policy-check a session it cannot see). We persist that exact row directly (the
		// send path would have written it identically, with NO cross-project check, because the target
		// was not running). Then the project-B session COMES UP and drains.
		const recipientB = await freshSession({ project: projB });
		const leak = await sendPeerMessage(db, {
			from_session: senderA,
			to_kind: 'session',
			to_session: recipientB,
			body: 'cross-project secret you should never see'
		});
		expect(leak.status).toBe('pending');

		const res = await drainInbox(db, { sessionId: recipientB, project: projB });
		// The forbidden cross-project delivery NEVER happens — and it is EXPIRED, not silently dropped.
		expect(res.delivered).toEqual([]);
		const after = await getPeerMessage(db, leak.id);
		expect(after!.status).toBe('expired'); // honest, never delivered cross-project
	});

	it('an in-project DIRECT message to a then-offline same-project session STILL drains (the guard is scoped to cross-project)', async () => {
		const proj = await freshProject();
		const sender = await freshSession({ project: proj });
		const recipient = await freshSession({ project: proj });
		const msg = await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'session',
			to_session: recipient,
			body: 'in-project handoff'
		});
		const res = await drainInbox(db, { sessionId: recipient, project: proj });
		expect(res.delivered.map((d) => d.id)).toEqual([msg.id]); // same project → delivers normally
		const after = await getPeerMessage(db, msg.id);
		expect(after!.status).toBe('delivered');
	});

	it('the cross-project guard does NOT touch role@project messages (their scope was checked at send)', async () => {
		const proj = await freshProject();
		const role = await freshRole();
		const sender = await freshSession({ project: proj });
		const recipient = await freshSession({ project: proj, role });
		const msg = await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'role',
			to_role: role,
			project: proj,
			body: 'role handoff'
		});
		const res = await drainInbox(db, { sessionId: recipient, role, project: proj });
		expect(res.delivered.map((d) => d.id)).toEqual([msg.id]);
	});
});

// ── shadow paths ────────────────────────────────────────────────────────────────────

describe('drainInbox — shadow paths', () => {
	it('an empty inbox drains to an honest empty result (no throw)', async () => {
		const proj = await freshProject();
		const recipient = await freshSession({ project: proj });
		const res = await drainInbox(db, { sessionId: recipient, project: proj });
		expect(res.delivered).toEqual([]);
		expect(res.expiredCount).toBe(0);
	});

	it('a role-less / project-less session drains only its direct to_session inbox (same-scope sender)', async () => {
		const role = await freshRole();
		// SAME-SCOPE: both sender and recipient are project-less (e.g. two global/atelier-ish sessions).
		// project-less↔project-less is in-scope (the cross-project guard treats NONE==NONE as same-scope),
		// so the direct message MUST still drain — only the role address has no identity to match.
		const sender = await freshSession({});
		const recipient = await freshSession({});

		// A direct message reaches it (same project scope — both NONE).
		const direct = await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'session',
			to_session: recipient,
			body: 'direct'
		});
		// A role message does NOT (no role identity to match).
		await sendPeerMessage(db, {
			from_session: sender,
			to_kind: 'role',
			to_role: role,
			project: await freshProject(),
			body: 'role'
		});

		const res = await drainInbox(db, { sessionId: recipient });
		expect(res.delivered.map((d) => d.id)).toEqual([direct.id]);
	});

	it('a malformed recipient session id fails loud at the chokepoint (a real bug, not a silent drop)', async () => {
		await expect(drainInbox(db, { sessionId: 'not a record id' })).rejects.toThrow();
	});

	it('exposes the documented bounds (TTL + max drain per spawn)', () => {
		expect(PEER_MESSAGE_TTL_MS).toBeGreaterThan(0);
		expect(MAX_DRAIN_PER_SPAWN).toBeGreaterThan(0);
	});
});
