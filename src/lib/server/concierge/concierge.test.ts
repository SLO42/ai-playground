// CONCIERGE (D-040 Stage-1) — unit + integration verification.
//
// Covers the three properties the operator asked for:
//   (1) resolveAtelier returns the LIVE session when atelier_self is up (via loadFleetSnapshot).
//   (2) the concierge turn GROUNDS + CITES and replies ADVISORY (non-steering).
//   (3) the TRIGGER path SPAWNS the atelier_self session on a pending atelier message, answers,
//       replies over the bus, marks the message delivered, and tears the session down ($0 idle).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { sendPeerMessage, loadFleetSnapshot } from '../peer/repo';
import { resolveAddress, ATELIER_PROJECT_KEY, ATELIER_SELF_PM } from '../peer/resolve';
import type { RecommendAgentInput } from '../agent-library/recommend';
import {
	runConciergeTurn,
	isRecommendRequest,
	ensureAtelierSession,
	handleAtelierMessages,
	fetchPendingAtelierInbox,
	type ConciergeGroundingItem,
	type ConciergeRecallFn,
	type ConciergeListAgentsFn
} from './concierge';

// ── deterministic stubs (pure turn tests) ────────────────────────────────────────

const GROUNDING: ConciergeGroundingItem[] = [
	{ citationId: '[#1]', body: 'Prior SvelteKit work used Svelte 5 runes and Tailwind v4.', score: 0.82 },
	{ citationId: '[#2]', body: 'The memory scene renders with d3-force.', score: 0.51 }
];
const recallStub: ConciergeRecallFn = async () => GROUNDING;
const recallEmpty: ConciergeRecallFn = async () => [];

const LIB: RecommendAgentInput[] = [
	{
		name: 'atelier-developer',
		description: 'SvelteKit Svelte 5 Tailwind SurrealDB dashboard specialist',
		type: 'developer',
		capabilities: ['svelte', 'sveltekit', 'tailwind', 'surrealdb', 'dashboard', 'ui']
	},
	{
		name: 'rounds-mod-developer',
		description: 'C# BepInEx Unity ROUNDS mod specialist',
		type: 'developer',
		capabilities: ['csharp', 'bepinex', 'unity', 'harmony']
	}
];
const listStub: ConciergeListAgentsFn = () => LIB;
const listEmpty: ConciergeListAgentsFn = () => [];

// ── (a) the concierge TURN — grounds + cites + advisory, non-steering (pure) ──────

describe('runConciergeTurn — grounds, cites, recommends, advisory', () => {
	it('cites grounding memory AND recommends the best-matching specialist', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub },
			'Please recommend an agent to build a SvelteKit dashboard UI'
		);
		expect(turn.handledIntent).toBe(true);
		// Grounding cited (S0 — traceable to real rows).
		expect(turn.groundingCitations).toEqual(['[#1]', '[#2]']);
		expect(turn.replyText).toContain('[#1]');
		expect(turn.replyText).toContain('Grounded on 2 memory item(s)');
		// Recommendation is the strongest overlap (atelier-developer, not the C#/ROUNDS agent).
		expect(turn.recommendations[0].name).toBe('atelier-developer');
		expect(turn.replyText).toContain('atelier-developer');
		// ADVISORY + NON-STEERING framing present; no command/spawn directive.
		expect(turn.replyText).toContain('[Atelier Concierge — advisory, non-steering]');
		expect(turn.replyText).toContain('The concierge advises; it never commands or spawns an agent.');
		expect(turn.replyText.toLowerCase()).not.toMatch(/\byou must\b/);
	});

	it('honest empty states — no grounding + no matching specialist (F-008)', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallEmpty, listAgents: listEmpty },
			'recommend an agent for xylophone quantum flux'
		);
		expect(turn.handledIntent).toBe(true);
		expect(turn.groundingCitations).toEqual([]);
		expect(turn.recommendations).toEqual([]);
		expect(turn.replyText).toContain('no relevant memory available');
		expect(turn.replyText).toContain('No matching specialist in the library');
	});

	it('a non-recommend atelier message gets an honest Stage-1 scope note (no fabricated answer)', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub },
			'what is the current sprint status?'
		);
		expect(turn.handledIntent).toBe(false);
		expect(turn.recommendations).toEqual([]);
		expect(turn.replyText).toContain('answer AGENT-RECOMMENDATION requests only');
		// Still non-steering + still grounded (it read the brain).
		expect(turn.replyText).toContain('advisory, non-steering');
		expect(turn.groundingCitations).toEqual(['[#1]', '[#2]']);
	});

	it('a recall fault degrades to honest empty grounding, never a throw', async () => {
		const turn = await runConciergeTurn(
			{ recall: async () => { throw new Error('embedder offline'); }, listAgents: listStub },
			'recommend an agent for a svelte ui'
		);
		expect(turn.groundingCitations).toEqual([]);
		expect(turn.replyText).toContain('no relevant memory available');
		// Recommendation still produced (recommend does not depend on grounding).
		expect(turn.recommendations[0].name).toBe('atelier-developer');
	});

	it('isRecommendRequest detects the Stage-1 intent', () => {
		expect(isRecommendRequest('please RECOMMEND an Agent for X')).toBe(true);
		expect(isRecommendRequest('recommend a skill')).toBe(false);
		expect(isRecommendRequest('status update')).toBe(false);
	});
});

// ── (b) + (c) DB-backed: reachability + the event trigger ─────────────────────────

describe('concierge — reachability + event trigger (live DB)', () => {
	let tdb: TestDb;
	let db: Db;
	let seq = 0;

	beforeAll(async () => {
		tdb = await startTestDb();
		db = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		const applied = await runMigrations(db, schemaMigrations);
		expect(applied).toContain('0074_session_pm');
	}, 90_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown();
	});

	async function freshProject(): Promise<string> {
		const slug = `conc_proj_${++seq}`;
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE type::thing('project', $slug) SET slug = $slug, name = $slug, root_path = "/tmp", status = "active" RETURN id;`,
			{ slug }
		);
		return String(rows[0].id);
	}

	async function freshSession(project?: string): Promise<string> {
		const set = [`kind = 'task'`, `model = { provider: 'claude', model_id: 'claude-test' }`];
		const bind: Record<string, unknown> = {};
		if (project) {
			set.push(`project = type::thing('project', $pj)`);
			bind.pj = project.split(':')[1];
		}
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session SET ${set.join(', ')} RETURN id;`,
			bind
		);
		return String(rows[0].id);
	}

	it('resolveAtelier resolves LIVE to the atelier_self session while it is up, offline after', async () => {
		// Before: no atelier session → offline (inboxes pending).
		let fleet = await loadFleetSnapshot(db);
		expect(fleet.pmByProject?.[ATELIER_PROJECT_KEY]).toBeUndefined();
		const senderSession = await freshSession(await freshProject());
		const offline = resolveAddress({ kind: 'atelier' }, { session: senderSession }, fleet);
		expect(offline.sessions).toEqual([]);
		expect(offline.note).toMatch(/offline|pending/i);

		// Bring the atelier_self session up.
		const { sessionId, created } = await ensureAtelierSession(db);
		expect(created).toBe(true);

		fleet = await loadFleetSnapshot(db);
		expect(fleet.pmByProject?.[ATELIER_PROJECT_KEY]).toBe(ATELIER_SELF_PM);
		const live = resolveAddress({ kind: 'atelier' }, { session: senderSession }, fleet);
		expect(live.sessions).toEqual([sessionId]);
		expect(live.note).toBeNull();

		// ensureAtelierSession is idempotent-ish: a second call reuses the running one (created=false).
		const again = await ensureAtelierSession(db);
		expect(again.sessionId).toBe(sessionId);
		expect(again.created).toBe(false);

		// Tear it down → offline again.
		await db.query(`UPDATE $sid SET status = 'done', ended_at = time::now();`, {
			sid: new StringRecordId(sessionId)
		});
		fleet = await loadFleetSnapshot(db);
		expect(fleet.pmByProject?.[ATELIER_PROJECT_KEY]).toBeUndefined();
	});

	it('the TRIGGER spawns atelier_self on a pending atelier msg, replies advisory, marks delivered, tears down', async () => {
		const requester = await freshSession(await freshProject());
		// A PM sends a recommend-agent request to the atelier identity → persists PENDING.
		const req = await sendPeerMessage(db, {
			from_session: requester,
			to_kind: 'atelier',
			body: 'Please recommend an agent to build a SvelteKit dashboard UI with SurrealDB.'
		});
		expect(req.status).toBe('pending');

		const pendingBefore = await fetchPendingAtelierInbox(db, 20);
		expect(pendingBefore.some((m) => m.id === req.id)).toBe(true);

		// Fire the event trigger (injected deterministic recall + library; real send + DB).
		const result = await handleAtelierMessages({
			db,
			recall: recallStub,
			listAgents: listStub
		});
		expect(result.handled).toBe(1);
		expect(result.replies).toBe(1);
		expect(result.sessionId).not.toBeNull();

		// The atelier message is now DELIVERED (drained, never silently dropped).
		const [msgRows] = await db.query<[Array<{ status: unknown }>]>(
			`SELECT status FROM $rid;`,
			{ rid: new StringRecordId(req.id) }
		);
		expect(String(msgRows[0].status)).toBe('delivered');

		// An ADVISORY reply was sent back to the requester over the bus (to_kind=session).
		const [replyRows] = await db.query<[Array<{ from_session: unknown; body: string; to_session: unknown }>]>(
			`SELECT from_session, to_session, body FROM peer_message WHERE to_kind = "session";`
		);
		const reply = replyRows.filter((r) => String(r.to_session) === requester);
		expect(reply.length).toBe(1);
		expect(String(reply[0].from_session)).toBe(result.sessionId);
		// The body is screened+fenced by the repo but the advisory recommendation text survives.
		expect(reply[0].body).toContain('atelier-developer');
		expect(reply[0].body).toContain('advisory, non-steering');

		// The concierge session was torn down (bounded, $0 idle) → atelier offline again.
		const [sessRows] = await db.query<[Array<{ status: unknown }>]>(
			`SELECT status FROM $sid;`,
			{ sid: new StringRecordId(result.sessionId as string) }
		);
		expect(String(sessRows[0].status)).toBe('done');
		const fleet = await loadFleetSnapshot(db);
		expect(fleet.pmByProject?.[ATELIER_PROJECT_KEY]).toBeUndefined();

		// The pending atelier inbox is now empty (idempotent — a re-trigger is a clean no-op).
		const again = await handleAtelierMessages({ db, recall: recallStub, listAgents: listStub });
		expect(again.handled).toBe(0);
		expect(again.replies).toBe(0);
		expect(again.sessionId).toBeNull();
	});
});
