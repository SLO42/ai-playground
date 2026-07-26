// COMPLETION-LEDGER Wave A (finding 2) — the /brain SURFACE half, against a REAL throwaway
// SurrealDB. Landing the concierge thinking row is only half a fix; this proves the page the
// operator actually opens can SERVE it.
//
// The +page.server load() pulls $env + hooks.server boot side-effects, so (mirroring
// settings/page.live.test and skills/page.live.test) we exercise the SAME backend the loader
// calls — listConciergeTurns — and assert the contract end-to-end:
//
//   1. LOAD-SHAPE — every row the loader serializes is a devalue-safe POJO: no Surreal RecordId /
//      Datetime leaks through (the F-013 class guard that turns into a 500 at the load boundary).
//   2. HAPPY PATH — a recorded turn is actually RETURNED (a best-effort-looking loader that
//      silently returns [] would render "no concierge turns yet", the fabricated-empty lie).
//   3. HONEST EMPTY — an untouched DB returns [], which the page renders as an explicit empty
//      state, never a fabricated turn.
//   4. HONEST ERROR — the read PROPAGATES rather than swallowing, so the loader's catch can show
//      a visible disconnected state instead of a plausible-looking empty list.
//   5. BOUNDED — the limit is respected (the panel is a window, not all history).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import {
	recordConciergeTurn,
	listConciergeTurns,
	CONCIERGE_TURNS_LIMIT
} from '$lib/server/concierge/turn-events';

let tdb: TestDb;
let db: Db;

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
	await db.query(`DELETE agent_event;`);
});

describe('/brain — the concierge turns panel', () => {
	it('HONEST EMPTY: an untouched brain serves [] (the page shows the empty state, not a fake turn)', async () => {
		expect(await listConciergeTurns(db, { limit: CONCIERGE_TURNS_LIMIT })).toEqual([]);
	});

	it('HAPPY PATH: a recorded turn is actually returned to the page', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:brain1',
			fromRole: 'pm',
			intent: 'recommend_agent',
			handledIntent: true,
			llmUsed: false,
			brainConfigured: { provider: 'ollama', model: 'gpt-oss:20b', tier: 'local' },
			groundingCitations: ['#1'],
			recommendations: [{ name: 'atelier-developer', score: 0.9 }],
			ask: 'who should own the release pipeline?',
			reply: 'atelier-developer',
			durationMs: 88,
			outcome: 'replied'
		});

		const turns = await listConciergeTurns(db, { limit: CONCIERGE_TURNS_LIMIT });
		expect(turns).toHaveLength(1);
		// Everything the panel renders is present and human-readable.
		expect(turns[0].intent).toBe('recommend_agent');
		expect(turns[0].outcomeLabel).toBe('advice delivered to the requester');
		expect(turns[0].costClassLabel).toBe('no model call');
		expect(turns[0].ask).toContain('release pipeline');
	});

	it('LOAD-SHAPE: every row is devalue-safe (no RecordId / Datetime leaks → no 500)', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:brain2',
			intent: 'open_question',
			llmUsed: true,
			brainConfigured: { provider: 'claude', model: 'claude-sonnet-4', tier: 'sonnet' },
			outcome: 'replied'
		});
		const turns = await listConciergeTurns(db);
		// The structuredClone a devalue-serialized load must survive.
		expect(() => structuredClone(turns)).not.toThrow();
		for (const t of turns) {
			for (const [k, v] of Object.entries(t)) {
				expect(
					v === null || ['string', 'number', 'boolean'].includes(typeof v),
					`field ${k} must be a primitive or null, got ${typeof v}`
				).toBe(true);
			}
			// F-013: the datetime arrived as an ISO STRING, not a Date/Datetime object.
			expect(typeof t.at === 'string' || t.at === null).toBe(true);
		}
		// The round-trip through JSON (what the client actually receives) is lossless.
		expect(JSON.parse(JSON.stringify(turns))).toEqual(turns);
	});

	it('BOUNDED: the panel window is respected, newest first', async () => {
		for (let i = 0; i < 6; i++) {
			await recordConciergeTurn(db, {
				messageId: `peer_message:b${i}`,
				intent: `intent${i}`,
				outcome: 'replied'
			});
			await new Promise((r) => setTimeout(r, 5));
		}
		const turns = await listConciergeTurns(db, { limit: 3 });
		expect(turns).toHaveLength(3);
		expect(turns[0].intent).toBe('intent5');
	});

	it('HONEST ERROR: a read fault PROPAGATES so the loader can show a disconnected state', async () => {
		const broken = {
			query: async () => {
				throw new Error('IAM error: Not enough permissions');
			}
		} as unknown as Db;
		// Deliberately NOT swallowed — a swallowed read would render "no concierge turns yet".
		await expect(listConciergeTurns(broken)).rejects.toThrow('Not enough permissions');
	});
});
