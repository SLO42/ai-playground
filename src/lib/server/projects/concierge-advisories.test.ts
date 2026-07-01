import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from './repo';
import { createTask, setStatus, listTasksByProject } from '../tasks/repo';
import { createPm } from './pm-repo';
import { sendPeerMessage } from '../peer/repo';
import { maybeEmitConciergeConsult } from './pm-concierge';
import { listConciergeAdvisories } from './concierge-advisories';

// ADVISORY-SURFACING VERIFY (D-038) — the read-only projection both operator surfaces (project PM
// tab + /brain) load, against a REAL throwaway SurrealDB (real session/peer_message rows written by
// the REAL Path-B emit path). F-020: the reader's ORDER BY queries run against the live parser here.
// Honest states (F-008): PENDING until a real reply row landed; ANSWERED with the real advisory
// text; [] when no consult was ever emitted; and per-project scoping (no cross-project bleed).

let tdb: TestDb;
let db: Db;
let projectId: string;

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
		.query('DELETE peer_message; DELETE pm; DELETE pm_memory; DELETE task; DELETE session; DELETE project;')
		.catch(() => {});
	projectId = (await seedProject('advhost', 'Advisory Host')).id;
});

async function seedProject(slug: string, name: string) {
	return createProject(db, {
		slug,
		name,
		root_path: `F:/code/${slug}`,
		repo_url: `https://github.com/octo/${slug}`
	});
}

/** Emit a REAL Path-B consult for a project (hired act-PM + a real blocked task → the real emit). */
async function emitConsult(pid: string, label: string): Promise<void> {
	await createPm(db, { project: pid, name: 'Quill', charter: 'Ship it.', authority: 'act' });
	const t = await createTask(db, { project: pid, title: 'Stuck', description: '', status: 'ready' });
	await setStatus(db, t.id, 'in_progress');
	await setStatus(db, t.id, 'blocked');
	const tasks = await listTasksByProject(db, pid);
	const out = await maybeEmitConciergeConsult(
		db,
		{ projectId: pid, projectLabel: label, tasks, severe: [] },
		{ trigger: async () => {} }
	);
	expect(out.emitted).toBe(true);
}

/** Land a concierge advisory reply on a project's identity mailbox (as handleAtelierMessages does).
 *  `replyTo` stamps the m0079 exact-pairing id; omit it to simulate a LEGACY pre-m0079 reply. */
async function landReply(text: string, replyTo?: string): Promise<void> {
	const [consults] = await db.query<[Array<{ from_session: unknown }>]>(
		`SELECT from_session, created_at FROM peer_message WHERE to_kind = "atelier" ORDER BY created_at ASC;`
	);
	const identity = String(consults[consults.length - 1].from_session);
	const [sess] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT { kind: 'discussion', model: { provider: 'atelier', model_id: 'concierge-stage1' }, status: 'running', pm: 'pm:atelier_self' } RETURN AFTER;`
	);
	await sendPeerMessage(db, {
		from_session: String(sess[0].id),
		to_kind: 'session',
		to_session: identity,
		body: text,
		...(replyTo ? { reply_to: replyTo } : {})
	});
}

/** Land a WORKER-origin message on the identity mailbox (the a6be543 conversation layer: worker
 *  sessions can address the PM identity too). No reply_to, and the sender is NOT the concierge. */
async function landWorkerMessage(text: string): Promise<void> {
	const identity = await identityMailbox();
	const [sess] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT { kind: 'task', model: { provider: 'anthropic', model_id: 'claude-sonnet' }, status: 'running' } RETURN AFTER;`
	);
	await sendPeerMessage(db, {
		from_session: String(sess[0].id),
		to_kind: 'session',
		to_session: identity,
		body: text
	});
}

/** The identity mailbox session id (from the consults already emitted). */
async function identityMailbox(): Promise<string> {
	const [consults] = await db.query<[Array<{ from_session: unknown }>]>(
		`SELECT from_session, created_at FROM peer_message WHERE to_kind = "atelier" ORDER BY created_at ASC;`
	);
	return String(consults[consults.length - 1].from_session);
}

/** Send a SECOND consult from the SAME identity mailbox via the real writer (need: findings). */
async function sendFollowupConsult(identity: string): Promise<string> {
	const row = await sendPeerMessage(db, {
		from_session: identity,
		to_kind: 'atelier',
		body: 'Review findings pile-up — requesting an advisory.',
		client_key: 'pmconsult:findings:test-followup'
	});
	return row.id;
}

describe('listConciergeAdvisories — the operator projection of the Path-B consult lifecycle', () => {
	it('honest empty: no consult ever emitted ⇒ [] (project view AND cross-project view)', async () => {
		expect(await listConciergeAdvisories(db, { projectId })).toEqual([]);
		expect(await listConciergeAdvisories(db)).toEqual([]);
	});

	it('a sent-but-unanswered consult surfaces as PENDING with the need + ISO askedAt (F-013)', async () => {
		await emitConsult(projectId, 'Advisory Host');

		const rows = await listConciergeAdvisories(db, { projectId });
		expect(rows).toHaveLength(1);
		const r = rows[0];
		expect(r.status).toBe('pending');
		expect(r.need).toBe('blocked');
		expect(r.advisory).toBeNull();
		expect(r.answeredAt).toBeNull();
		// the ask is the content-free need line, unfenced for display
		expect(r.asked).toMatch(/blocked/i);
		expect(r.asked).not.toContain('⎆');
		// F-013: ISO string, never a raw SDK datetime
		expect(typeof r.askedAt).toBe('string');
		expect(new Date(r.askedAt as string).toISOString()).toBe(r.askedAt);
		expect(r.project).toBe(projectId);
	});

	it('a landed reply flips the consult to ANSWERED with the advisory text + ISO answeredAt', async () => {
		await emitConsult(projectId, 'Advisory Host');
		await landReply('Atelier advice: hire a build-tooling specialist to unblock this class of work.');

		const rows = await listConciergeAdvisories(db, { projectId });
		expect(rows).toHaveLength(1);
		const r = rows[0];
		expect(r.status).toBe('answered');
		expect(r.advisory).toMatch(/build-tooling specialist/);
		expect(r.advisory).not.toContain('⎆');
		expect(typeof r.answeredAt).toBe('string');
		expect(new Date(r.answeredAt as string).toISOString()).toBe(r.answeredAt);
	});

	it('cross-project view lists both projects; the project view is scoped (no bleed)', async () => {
		const other = await seedProject('advother', 'Advisory Other');
		await emitConsult(projectId, 'Advisory Host');
		await emitConsult(other.id, 'Advisory Other');
		await landReply('Atelier advice for the OTHER project only.');

		// cross-project (/brain): both consults, each attributed to its own project
		const all = await listConciergeAdvisories(db);
		expect(all).toHaveLength(2);
		expect(new Set(all.map((r) => r.project))).toEqual(new Set([projectId, other.id]));

		// project view: exactly this project's consult — the other project's reply never bleeds in
		const mine = await listConciergeAdvisories(db, { projectId });
		expect(mine).toHaveLength(1);
		expect(mine[0].project).toBe(projectId);
		expect(mine[0].status).toBe('pending');
		expect(mine[0].advisory).toBeNull();

		const theirs = await listConciergeAdvisories(db, { projectId: other.id });
		expect(theirs).toHaveLength(1);
		expect(theirs[0].status).toBe('answered');
		expect(theirs[0].advisory).toMatch(/OTHER project only/);
	});

	it('EXACT pairing (m0079): an out-of-order stamped reply pins to its consult — FIFO would mispair it', async () => {
		await emitConsult(projectId, 'Advisory Host');
		const identity = await identityMailbox();
		const second = await sendFollowupConsult(identity);

		// ONE reply, answering the SECOND consult. Positionally (FIFO) it would land on the first
		// consult (the mid-drain-fault skew); reply_to must pin it to the second.
		await landReply('Exact advice for the findings consult.', second);

		const rows = await listConciergeAdvisories(db, { projectId });
		expect(rows).toHaveLength(2);
		const blocked = rows.find((r) => r.need === 'blocked');
		const findings = rows.find((r) => r.need === 'findings');
		expect(findings?.status).toBe('answered');
		expect(findings?.advisory).toMatch(/Exact advice/);
		// The skipped consult stays honestly PENDING — no positional skew (F-008).
		expect(blocked?.status).toBe('pending');
		expect(blocked?.advisory).toBeNull();
		expect(blocked?.answeredAt).toBeNull();
	});

	it('LEGACY rows (no reply_to) still pair FIFO — pre-m0079 advisories are not stranded', async () => {
		await emitConsult(projectId, 'Advisory Host');
		const identity = await identityMailbox();
		await sendFollowupConsult(identity);
		await landReply('Legacy advice one.'); // pre-m0079 shape: reply_to absent
		await landReply('Legacy advice two.');

		const rows = await listConciergeAdvisories(db, { projectId });
		expect(rows).toHaveLength(2);
		const blocked = rows.find((r) => r.need === 'blocked');
		const findings = rows.find((r) => r.need === 'findings');
		expect(blocked?.status).toBe('answered');
		expect(blocked?.advisory).toMatch(/one/);
		expect(findings?.status).toBe('answered');
		expect(findings?.advisory).toMatch(/two/);
	});

	it('ORIGIN filter: an unstamped WORKER row on the mailbox never pairs as an advisory reply — a later legacy concierge reply still does', async () => {
		await emitConsult(projectId, 'Advisory Host');
		// A worker escalation lands FIRST on the identity mailbox (unstamped, non-concierge origin).
		// Pure FIFO would hand it to the consult as a fake advisory.
		await landWorkerMessage('Worker escalation: build tooling is flaky, please advise.');

		let rows = await listConciergeAdvisories(db, { projectId });
		expect(rows).toHaveLength(1);
		// The consult stays honestly PENDING (F-008) — the worker row is not an advisory.
		expect(rows[0].status).toBe('pending');
		expect(rows[0].advisory).toBeNull();
		expect(rows[0].answeredAt).toBeNull();

		// The worker row is EXCLUDED from the FIFO queue, not blocking it: a legacy (unstamped)
		// concierge reply landing later still pairs with the consult.
		await landReply('Real concierge advice, after the worker noise.');
		rows = await listConciergeAdvisories(db, { projectId });
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('answered');
		expect(rows[0].advisory).toMatch(/Real concierge advice/);
		expect(rows[0].advisory).not.toMatch(/Worker escalation/);
	});

	it('MIXED old+new: the stamped reply claims its consult; the legacy reply falls back to the remaining one', async () => {
		await emitConsult(projectId, 'Advisory Host');
		const identity = await identityMailbox();
		const second = await sendFollowupConsult(identity);
		// The stamped reply lands FIRST — pure position would hand it to the first consult.
		await landReply('Stamped advice for the second consult.', second);
		await landReply('Legacy advice for whoever is left.');

		const rows = await listConciergeAdvisories(db, { projectId });
		expect(rows).toHaveLength(2);
		const blocked = rows.find((r) => r.need === 'blocked');
		const findings = rows.find((r) => r.need === 'findings');
		expect(findings?.status).toBe('answered');
		expect(findings?.advisory).toMatch(/Stamped advice/);
		expect(blocked?.status).toBe('answered');
		expect(blocked?.advisory).toMatch(/whoever is left/);
	});

	it('bounded + newest-consult-first', async () => {
		const other = await seedProject('advnewer', 'Advisory Newer');
		await emitConsult(projectId, 'Advisory Host');
		await emitConsult(other.id, 'Advisory Newer');

		const all = await listConciergeAdvisories(db, { limit: 1 });
		expect(all).toHaveLength(1);
		// the second (newer) consult wins the newest-first cap
		expect(all[0].project).toBe(other.id);
	});
});
