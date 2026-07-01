import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from './repo';
import { createTask, setStatus } from '../tasks/repo';
import { createPm, listPmMemory } from './pm-repo';
import { sendPeerMessage, type SendPeerMessageInput, type PeerMessageRow } from '../peer/repo';
import { runPmReview } from './pm-review';
import {
	maybeEmitConciergeConsult,
	surfaceConciergeReplies,
	CONSULT_SOURCE,
	CONSULT_REPLY_SOURCE,
	type PmConciergeDeps
} from './pm-concierge';

// PATH B VERIFY (D-038) — the autonomous review consults the Atelier concierge, against a REAL
// throwaway SurrealDB (real peer_message + pm_memory + session tables). Every assertion is an honest
// derivation (F-008): a consult only on a real specialist-need, deduped once per novel need; a reply
// surfaces only when a real reply row landed; send-failure absorbed (never throws); non-steering.

let tdb: TestDb;
let db: Db;
let projectId: string;

const CWD = 'F:/code/pmconcierge';

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

beforeEach(async () => {
	await db
		.query(
			'DELETE peer_message; DELETE pm; DELETE pm_review; DELETE pm_memory; DELETE security_finding; DELETE task; DELETE session; DELETE project;'
		)
		.catch(() => {});
	const p = await createProject(db, {
		slug: 'pmconcierge',
		name: 'Concierge Host',
		root_path: CWD,
		repo_url: 'https://github.com/octo/pmconcierge'
	});
	projectId = p.id;
});

/** Hire a PM with the given authority (default 'act' — the propose/act gate the consult shares). */
async function hirePm(authority: 'observe' | 'propose' | 'act' = 'act') {
	return createPm(db, { project: projectId, name: 'Quill', charter: 'Ship it.', authority });
}

/** Seed a real blocked task (the clearest specialist-need signal). */
async function seedBlockedTask(title: string): Promise<string> {
	const t = await createTask(db, { project: projectId, title, description: '', status: 'ready' });
	await setStatus(db, t.id, 'in_progress');
	await setStatus(db, t.id, 'blocked');
	return t.id;
}

/** A send spy wrapping the REAL repo writer — records every call and still persists the row. */
function spySend() {
	const calls: SendPeerMessageInput[] = [];
	const send = async (d: Db, input: SendPeerMessageInput): Promise<PeerMessageRow> => {
		calls.push(input);
		return sendPeerMessage(d, input);
	};
	return { calls, send };
}

async function atelierMessages(): Promise<Array<{ id: string; from_session: string; client_key: string | null }>> {
	const [rows] = await db.query<[Array<{ id: unknown; from_session: unknown; client_key: unknown }>]>(
		`SELECT id, from_session, client_key FROM peer_message WHERE to_kind = "atelier";`
	);
	return (rows ?? []).map((r) => ({
		id: String(r.id),
		from_session: String(r.from_session),
		client_key: r.client_key != null ? String(r.client_key) : null
	}));
}

describe('maybeEmitConciergeConsult — emit once per novel specialist-need (dedup)', () => {
	it('a novel blocked-task need emits EXACTLY ONE atelier consult + fires the trigger once + records the pending state', async () => {
		await hirePm('act');
		const blockedId = await seedBlockedTask('Stuck');
		const tasks = await import('../tasks/repo').then((m) => m.listTasksByProject(db, projectId));

		let triggerCount = 0;
		const { calls, send } = spySend();
		const deps: PmConciergeDeps = { send, trigger: async () => void triggerCount++ };

		const severe: never[] = [];
		const out = await maybeEmitConciergeConsult(db, { projectId, projectLabel: 'Concierge Host', tasks, severe }, deps);

		expect(out.emitted).toBe(true);
		// exactly ONE atelier consult persisted
		const atelier = await atelierMessages();
		expect(atelier).toHaveLength(1);
		expect(calls.filter((c) => c.to_kind === 'atelier')).toHaveLength(1);
		// the consult is sent FROM the durable PM peer-identity (not a live agent) — never the raw sender
		expect(atelier[0].from_session).toMatch(/^session:pmidentity_/);
		// the trigger fired once (async, fire-and-forget)
		expect(triggerCount).toBe(1);
		// honest PENDING state recorded as pm_memory (awaiting advice)
		const mem = await listPmMemory(db, projectId);
		expect(mem.some((m) => m.source === CONSULT_SOURCE && /awaiting advice/i.test(m.content))).toBe(true);
		// the consult body is content-free (D-026) — no task id / title leaked
		const [bodyRow] = await db.query<[Array<{ body: unknown }>]>(
			`SELECT body FROM peer_message WHERE to_kind = "atelier";`
		);
		expect(String(bodyRow[0].body)).not.toContain(blockedId);
	});

	it('a REPEAT tick for the SAME standing need emits NONE (dedup) — no second consult, no re-fire', async () => {
		await hirePm('act');
		await seedBlockedTask('Stuck');
		const tasks = await import('../tasks/repo').then((m) => m.listTasksByProject(db, projectId));

		let triggerCount = 0;
		const { send } = spySend();
		const deps: PmConciergeDeps = { send, trigger: async () => void triggerCount++ };

		const first = await maybeEmitConciergeConsult(db, { projectId, projectLabel: 'Concierge Host', tasks, severe: [] }, deps);
		const second = await maybeEmitConciergeConsult(db, { projectId, projectLabel: 'Concierge Host', tasks, severe: [] }, deps);

		expect(first.emitted).toBe(true);
		expect(second.emitted).toBe(false);
		expect(second.reason).toMatch(/dedup/i);
		// still exactly one atelier row, and the trigger only fired for the novel emit
		expect(await atelierMessages()).toHaveLength(1);
		expect(triggerCount).toBe(1);
	});

	it('an observe-only PM does NOT consult (same gate as deriveProposals)', async () => {
		await hirePm('observe');
		await seedBlockedTask('Stuck');
		const tasks = await import('../tasks/repo').then((m) => m.listTasksByProject(db, projectId));
		const out = await maybeEmitConciergeConsult(db, { projectId, projectLabel: 'Concierge Host', tasks, severe: [] }, {});
		expect(out.emitted).toBe(false);
		expect(out.reason).toMatch(/observe-only/i);
		expect(await atelierMessages()).toHaveLength(0);
	});

	it('a send fault is ABSORBED (fail-open) — never throws, never crashes the review', async () => {
		await hirePm('act');
		await seedBlockedTask('Stuck');
		const tasks = await import('../tasks/repo').then((m) => m.listTasksByProject(db, projectId));
		const deps: PmConciergeDeps = {
			send: async () => {
				throw new Error('bus down');
			},
			trigger: async () => {}
		};
		const out = await maybeEmitConciergeConsult(db, { projectId, projectLabel: 'Concierge Host', tasks, severe: [] }, deps);
		expect(out.emitted).toBe(false);
		expect(out.reason).toMatch(/fail-open/i);
	});
});

describe('surfaceConciergeReplies — the async advisory lands on a later pass', () => {
	it('surfaces a landed concierge reply into pm_memory ONCE (not re-surfaced on the next pass)', async () => {
		await hirePm('act');
		await seedBlockedTask('Stuck');
		const tasks = await import('../tasks/repo').then((m) => m.listTasksByProject(db, projectId));

		// 1) Emit the consult (creates the durable PM peer-identity mailbox).
		const { send } = spySend();
		await maybeEmitConciergeConsult(db, { projectId, projectLabel: 'Concierge Host', tasks, severe: [] }, { send, trigger: async () => {} });
		const identity = (await atelierMessages())[0].from_session;

		// 2) Simulate the concierge's async reply — addressed TO the identity mailbox (as
		//    handleAtelierMessages does: to_kind:'session', to_session: msg.fromSession).
		const [atelierSess] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT { kind: 'discussion', model: { provider: 'atelier', model_id: 'concierge-stage1' }, status: 'running', pm: 'pm:atelier_self' } RETURN AFTER;`
		);
		await sendPeerMessage(db, {
			from_session: String(atelierSess[0].id),
			to_kind: 'session',
			to_session: identity,
			body: 'Atelier advice: consider hiring a specialist to unblock this class of work.'
		});

		// 3) A LATER pass surfaces it into pm_memory (advisory), exactly once.
		const surfaced = await surfaceConciergeReplies(db, projectId);
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0].source).toBe(CONSULT_REPLY_SOURCE);
		expect(/Atelier advice/i.test(surfaced[0].content)).toBe(true);

		// 4) The reply row is now consumed (delivered) — a subsequent pass surfaces NOTHING (no dup).
		const again = await surfaceConciergeReplies(db, projectId);
		expect(again).toHaveLength(0);
		const replyMemories = (await listPmMemory(db, projectId)).filter((m) => m.source === CONSULT_REPLY_SOURCE);
		expect(replyMemories).toHaveLength(1);
	});

	it('no identity mailbox (no consult ever) ⇒ surfacing is a clean no-op', async () => {
		await hirePm('act');
		const surfaced = await surfaceConciergeReplies(db, projectId);
		expect(surfaced).toEqual([]);
	});
});

describe('runPmReview — Path B is additive + NON-STEERING', () => {
	it('the consult is emitted alongside — but never alters — the deterministic proposals', async () => {
		const pm = await hirePm('act');
		await seedBlockedTask('Stuck');

		// A no-op trigger keeps the concierge turn out of the review (bounded, deterministic).
		const res = await runPmReview(db, projectId, 'manual', undefined, {}, { trigger: async () => {} });

		// The review's OWN proposal derivation is unchanged: the unblock proposal is still produced.
		expect(res.proposals.some((p) => /Unblock/i.test(p.task?.title ?? ''))).toBe(true);
		// AND the consult was emitted additively (one atelier peer_message from the PM identity).
		expect(await atelierMessages()).toHaveLength(1);
		// The awaiting-advice note is NOT folded into this pass's derived count (that count closed).
		expect(res.review.memories_written).toBe(res.written.length);

		// A prior consult's reply surfaces into the NEXT pass's written[] (round-trip).
		const identity = (await atelierMessages())[0].from_session;
		const [atelierSess] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT { kind: 'discussion', model: { provider: 'atelier', model_id: 'concierge-stage1' }, status: 'running', pm: 'pm:atelier_self' } RETURN AFTER;`
		);
		await sendPeerMessage(db, {
			from_session: String(atelierSess[0].id),
			to_kind: 'session',
			to_session: identity,
			body: 'Atelier advice: try the c-developer specialist.'
		});
		const next = await runPmReview(db, projectId, 'manual', undefined, {}, { trigger: async () => {} });
		expect(next.written.some((m) => m.source === CONSULT_REPLY_SOURCE)).toBe(true);
		expect(pm.authority).toBe('act');
	});
});
