import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { agentUsageByName } from './usage';

// AGENT-INVOCATION usage bridge: the fold counts a `.claude/agents` agent's sessions by
// session.specialist (m0070, exact) UNION role.slug (certified-role fallback). These tests seed
// REAL session rows against the live schema and assert the union, the bridge labels, and the
// honest empties (F-008). Mirrors migrate.test.ts's startTestDb + runMigrations harness.

let tdb: TestDb;

beforeAll(async () => {
	tdb = await startTestDb();
}, 60_000);

afterAll(async () => {
	await tdb?.teardown();
});

async function freshDb(ns: string): Promise<Db> {
	const db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: ns,
		database: ns
	});
	await runMigrations(db, schemaMigrations);
	return db;
}

const MODEL = { provider: 'anthropic', model_id: 'claude-opus-4-8', tier: 'opus' };

/** Seed one session row. `specialist`/`role` optional; status/started/ended overridable. */
async function seedSession(
	db: Db,
	opts: {
		specialist?: string;
		roleId?: string; // record id of a role (must exist)
		status?: string;
		startedAt?: string;
		endedAt?: string;
	}
): Promise<void> {
	const content: Record<string, unknown> = {
		kind: 'task',
		model: MODEL,
		runtime: 'claude-code',
		status: opts.status ?? 'done'
	};
	if (opts.specialist) content.specialist = opts.specialist;
	// datetime columns expect a real datetime, not a string (SurrealDB 2.x) — bind JS Dates.
	if (opts.startedAt) content.started_at = new Date(opts.startedAt);
	if (opts.endedAt) content.ended_at = new Date(opts.endedAt);
	// role is a record link — bind it as a StringRecordId inside the content object (same shape
	// launch.ts's `link()` helper uses) so SurrealDB stores a real record<role> reference.
	if (opts.roleId) content.role = new StringRecordId(opts.roleId);
	await db.query(`CREATE session CONTENT $c;`, { c: content });
}

describe('agentUsageByName — specialist ∪ role.slug union (AGENT-INVOCATION)', () => {
	it('counts a specialist exactly by session.specialist (no role needed)', async () => {
		const db = await freshDb('usage_spec');
		try {
			await seedSession(db, { specialist: 'atelier-developer', status: 'done' });
			await seedSession(db, { specialist: 'atelier-developer', status: 'failed' });
			await seedSession(db, { specialist: 'atelier-developer', status: 'running' });

			const map = await agentUsageByName(db);
			const u = map.get('atelier-developer');
			expect(u).toBeTruthy();
			expect(u!.calls).toBe(3);
			expect(u!.viaSpecialist).toBe(3);
			expect(u!.viaRole).toBe(0);
			expect(u!.bridge).toBe('specialist');
			expect(u!.done).toBe(1);
			expect(u!.failed).toBe(1);
			expect(u!.running).toBe(1);
			expect(u!.key).toBe('atelier-developer');
			expect(u!.slug).toBe('atelier-developer'); // back-compat alias
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('UNIONs specialist + role.slug sessions under the same name → bridge "mixed"', async () => {
		const db = await freshDb('usage_union');
		try {
			// A certified role whose slug === the specialist name.
			await db.query(
				`CREATE role:dev SET slug = "atelier-developer", name = "Atelier Developer", purpose = "build";`
			);
			// Two exact specialist invocations + two role-bridged sessions for the SAME name.
			await seedSession(db, { specialist: 'atelier-developer', status: 'done' });
			await seedSession(db, { specialist: 'atelier-developer', status: 'done' });
			await seedSession(db, { roleId: 'role:dev', status: 'done' });
			await seedSession(db, { roleId: 'role:dev', status: 'cancelled' });

			const map = await agentUsageByName(db);
			const u = map.get('atelier-developer');
			expect(u).toBeTruthy();
			expect(u!.calls).toBe(4);
			expect(u!.viaSpecialist).toBe(2);
			expect(u!.viaRole).toBe(2);
			expect(u!.bridge).toBe('mixed');
			expect(u!.roleName).toBe('Atelier Developer'); // captured from the role bridge
			expect(u!.done).toBe(3);
			expect(u!.cancelled).toBe(1);
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('falls back to role.slug when no specialist is set → bridge "role"', async () => {
		const db = await freshDb('usage_role');
		try {
			await db.query(`CREATE role:rev SET slug = "reviewer", name = "Reviewer", purpose = "review";`);
			await seedSession(db, { roleId: 'role:rev', status: 'done' });
			await seedSession(db, { roleId: 'role:rev', status: 'done' });

			const map = await agentUsageByName(db);
			const u = map.get('reviewer');
			expect(u).toBeTruthy();
			expect(u!.viaSpecialist).toBe(0);
			expect(u!.viaRole).toBe(2);
			expect(u!.bridge).toBe('role');
			expect(u!.roleName).toBe('Reviewer');
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('skips sessions with neither specialist nor role (honest empty — F-008)', async () => {
		const db = await freshDb('usage_none');
		try {
			await seedSession(db, { status: 'done' }); // slot-only spawn — no bridge
			await seedSession(db, { status: 'running' });

			const map = await agentUsageByName(db);
			expect(map.size).toBe(0); // nothing fabricated
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('computes avg duration only over sessions with BOTH start+end (null otherwise)', async () => {
		const db = await freshDb('usage_dur');
		try {
			const t0 = '2026-06-30T00:00:00.000Z';
			const t10s = '2026-06-30T00:00:10.000Z'; // +10s
			await seedSession(db, { specialist: 'timer', startedAt: t0, endedAt: t10s, status: 'done' });
			// running session: start but no end → must NOT contribute to the average.
			await seedSession(db, { specialist: 'timer', startedAt: t0, status: 'running' });

			const map = await agentUsageByName(db);
			const u = map.get('timer');
			expect(u!.calls).toBe(2);
			expect(u!.avgDurationMs).toBe(10_000); // only the completed session counts
		} finally {
			await db.close().catch(() => {});
		}
	});
});
