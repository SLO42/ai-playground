import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildProjectUsage } from './project-usage';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';

// COST-GOVERNANCE-SPEC CG-6 — per-PROJECT usage attribution via the session→project join.
//   1. STUB tests — the load-bearing FOLD (per project) + honest empty (F-008), fast, no DB. The
//      stub feeds the already-JOINED `project` field (the query resolves session.project).
//   2. A REAL-SURREAL test (F-020) — the stub NEVER parses SurrealQL, so the record-link traversal
//      (`session.project AS project`) + the `ORDER BY at` idiom are invisible to it. This layer
//      seeds real sessions across two projects + an orphan + a project-less session and runs the
//      ACTUAL query against a live throwaway DB, so any future join / ORDER BY idiom gap fails the
//      suite, not a live /usage page.

function stubDb(rows: unknown[]): Db {
	return { query: async () => [rows] } as unknown as Db;
}

describe('buildProjectUsage — fold per project (CG-6)', () => {
	it('returns an HONEST empty array when there are no rows (F-008)', async () => {
		const out = await buildProjectUsage(stubDb([]));
		expect(out).toEqual([]);
	});

	it('folds runs/sessions/tokens/cost per project and buckets unlinked rows as "unknown"', async () => {
		const rows = [
			{ project: 'project:alpha', session: 'session:s1', type: 'spawn', tokens_in: 100, tokens_out: 50 },
			{ project: 'project:alpha', session: 'session:s1', type: 'completion', cost_usd: 0.03 },
			{ project: 'project:alpha', session: 'session:s2', type: 'spawn', tokens_in: 20, tokens_out: 10 },
			{ project: 'project:beta', session: 'session:s3', type: 'spawn', tokens_in: 500, tokens_out: 200, cost_usd: 0.05 },
			// no session at all → unknown, and it must NOT inflate the session count.
			{ project: null, type: 'error' },
			// session set but project-less → unknown, tokens still fold, session IS counted.
			{ project: null, session: 'session:s4', type: 'spawn', tokens_in: 5, tokens_out: 5 }
		];
		const out = await buildProjectUsage(stubDb(rows));

		const alpha = out.find((p) => p.project === 'project:alpha');
		const beta = out.find((p) => p.project === 'project:beta');
		const unknown = out.find((p) => p.project === 'unknown');

		expect(alpha).toMatchObject({
			sessions: 2, // s1 + s2
			runs: 2,
			completions: 1,
			tokensIn: 120,
			tokensOut: 60,
			costUsd: 0.03
		});
		expect(beta).toMatchObject({ sessions: 1, runs: 1, tokensIn: 500, tokensOut: 200, costUsd: 0.05 });
		expect(unknown).toMatchObject({
			sessions: 1, // only s4 carried a session; the orphan error did not
			runs: 1,
			errors: 1,
			tokensIn: 5,
			tokensOut: 5,
			costUsd: null // never priced ⇒ null, never a fake $0 (F-008)
		});
	});

	it('sorts projects by total tokens (busiest spend first)', async () => {
		const rows = [
			{ project: 'project:small', session: 'session:a', type: 'spawn', tokens_in: 10, tokens_out: 5 },
			{ project: 'project:big', session: 'session:b', type: 'spawn', tokens_in: 900, tokens_out: 100 }
		];
		const out = await buildProjectUsage(stubDb(rows));
		expect(out.map((p) => p.project)).toEqual(['project:big', 'project:small']);
	});
});

// ── REAL-SURREAL (F-020: the session.project join + ORDER BY at actually execute) ──────────────
describe('buildProjectUsage — live SurrealDB (F-020)', () => {
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
	}, 60_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown().catch(() => {});
	});

	beforeEach(async () => {
		await db.query('DELETE agent_event; DELETE session;');
	});

	/** Seed a real session row (SCHEMAFULL: kind + model required; project optional). */
	async function seedSession(id: string, project?: string): Promise<void> {
		const parts = [`kind="task"`, `model={ provider: "claude", model_id: "m" }`];
		if (project) parts.push(`project=${project}`);
		await db.query(`CREATE ${id} SET ${parts.join(', ')} RETURN NONE;`);
	}

	interface SeedEvent {
		session?: string;
		type: string;
		tokens_in?: number;
		tokens_out?: number;
		cost_usd?: number;
	}

	/** Seed one real agent_event row; session is a true record link (matches events.ts:237). */
	async function seedEvent(e: SeedEvent): Promise<void> {
		const parts = [`type="${e.type}"`];
		if (e.session) parts.push(`session=${e.session}`);
		for (const k of ['tokens_in', 'tokens_out', 'cost_usd'] as const) {
			if (e[k] != null) parts.push(`${k}=${e[k]}`);
		}
		await db.query(`CREATE agent_event SET ${parts.join(', ')} RETURN NONE;`);
	}

	it('joins agent_event → session → project and folds per project, unlinked → unknown', async () => {
		await seedSession('session:s1', 'project:alpha');
		await seedSession('session:s2', 'project:alpha');
		await seedSession('session:s3', 'project:beta');
		await seedSession('session:s4'); // project-less

		await seedEvent({ session: 'session:s1', type: 'spawn', tokens_in: 100, tokens_out: 50 });
		await seedEvent({ session: 'session:s1', type: 'completion', cost_usd: 0.03 });
		await seedEvent({ session: 'session:s2', type: 'spawn', tokens_in: 20, tokens_out: 10 });
		await seedEvent({ session: 'session:s3', type: 'spawn', tokens_in: 500, tokens_out: 200, cost_usd: 0.05 });
		await seedEvent({ type: 'error' }); // orphan — no session
		await seedEvent({ session: 'session:s4', type: 'spawn', tokens_in: 5, tokens_out: 5 }); // session, no project

		const out = await buildProjectUsage(db);
		const alpha = out.find((p) => p.project === 'project:alpha');
		const beta = out.find((p) => p.project === 'project:beta');
		const unknown = out.find((p) => p.project === 'unknown');

		expect(alpha).toMatchObject({
			sessions: 2,
			runs: 2,
			completions: 1,
			tokensIn: 120,
			tokensOut: 60,
			costUsd: 0.03
		});
		expect(beta).toMatchObject({ sessions: 1, runs: 1, tokensIn: 500, tokensOut: 200, costUsd: 0.05 });
		expect(unknown).toMatchObject({
			sessions: 1, // only s4; the orphan error had no session
			runs: 1,
			errors: 1,
			tokensIn: 5,
			tokensOut: 5,
			costUsd: null
		});
		// busiest-spend-first ordering holds over the live rows (beta 700 > alpha 180 > unknown 10).
		expect(out.map((p) => p.project)).toEqual(['project:beta', 'project:alpha', 'unknown']);
	});

	it('HONEST empty when the window has no rows (F-008)', async () => {
		expect(await buildProjectUsage(db)).toEqual([]);
	});
});
