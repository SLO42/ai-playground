import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, createSprint, updateProjectPlan } from './repo';
import {
	addPmMemory,
	addPmMemories,
	listPmMemory,
	pmMemoryStats,
	archivePmMemory,
	addDecision,
	listDecisions,
	completeSprint,
	bootstrapPm,
	PM_MEMORY_KINDS
} from './pm-repo';

// TASK 9.1 VERIFY: the Project Manager store round-trips against a REAL throwaway
// SurrealDB (namespace dropped per run) — typed PM memory, decisions, sprint
// lifecycle, and the live-state bootstrap. All values flow through $param bindings;
// record ids are validated at the D-016 chokepoint. No fabricated runtime data —
// every assertion reads back what the live DB persisted (F-008).

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
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied.length).toBeGreaterThan(0);
	// The 0023_pm migration must be present.
	expect(applied).toContain('0023_pm');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function freshProject(slug: string) {
	return createProject(db, {
		slug,
		name: `PM ${slug}`,
		root_path: 'F:/code/whatever',
		ecosystem: ['node'],
		test_command: 'npm test',
		repo_url: 'https://github.com/x/y'
	});
}

describe('pm typed memory', () => {
	it('adds + lists typed memory newest-first, filtered by kind', async () => {
		const p = await freshProject('pm_mem_a');
		await addPmMemory(db, { project: p.id, kind: 'observation', content: 'first obs' });
		await addPmMemory(db, { project: p.id, kind: 'risk', content: 'a risk', confidence: 0.4 });
		await addPmMemory(db, { project: p.id, kind: 'learning', content: 'a learning' });

		const all = await listPmMemory(db, p.id);
		expect(all.length).toBe(3);
		// Newest first.
		expect(all[0].content).toBe('a learning');

		const risks = await listPmMemory(db, p.id, { kind: 'risk' });
		expect(risks.length).toBe(1);
		expect(risks[0].kind).toBe('risk');
		expect(risks[0].confidence).toBeCloseTo(0.4);
	});

	it('rejects an out-of-taxonomy kind (ASSERT) and honours every valid kind', async () => {
		const p = await freshProject('pm_mem_kinds');
		for (const kind of PM_MEMORY_KINDS) {
			const row = await addPmMemory(db, { project: p.id, kind, content: `${kind} content` });
			expect(row.kind).toBe(kind);
		}
		await expect(
			// @ts-expect-error — deliberately invalid kind to prove the ASSERT fires.
			addPmMemory(db, { project: p.id, kind: 'bogus', content: 'x' })
		).rejects.toThrow();
	});

	it('computes honest per-kind stats', async () => {
		const p = await freshProject('pm_mem_stats');
		await addPmMemories(db, [
			{ project: p.id, kind: 'observation', content: 'o1' },
			{ project: p.id, kind: 'observation', content: 'o2' },
			{ project: p.id, kind: 'risk', content: 'r1' }
		]);
		const stats = await pmMemoryStats(db, p.id);
		expect(stats.observation).toBe(2);
		expect(stats.risk).toBe(1);
		expect(stats.learning).toBe(0);
		expect(stats.total).toBe(3);
	});

	it('soft-archives memory (excluded from active list + stats)', async () => {
		const p = await freshProject('pm_mem_archive');
		const m = await addPmMemory(db, { project: p.id, kind: 'pattern', content: 'a pattern' });
		expect((await listPmMemory(db, p.id)).length).toBe(1);
		const ok = await archivePmMemory(db, m.id);
		expect(ok).toBe(true);
		expect((await listPmMemory(db, p.id)).length).toBe(0);
		expect((await pmMemoryStats(db, p.id)).total).toBe(0);
	});
});

describe('decisions', () => {
	it('records + lists decisions newest-first', async () => {
		const p = await freshProject('pm_dec');
		await addDecision(db, {
			project: p.id,
			title: 'Use SurrealDB spine for PM memory',
			context: 'v1 used per-feature SQLite',
			rationale: 'lighter principle — one datastore',
			status: 'accepted'
		});
		await addDecision(db, { project: p.id, title: 'Defer GitHub board sync' });
		const list = await listDecisions(db, p.id);
		expect(list.length).toBe(2);
		expect(list[0].title).toBe('Defer GitHub board sync');
		expect(list[1].status).toBe('accepted');
		expect(list[1].rationale).toBe('lighter principle — one datastore');
	});

	it('links a decision to a sprint', async () => {
		const p = await freshProject('pm_dec_sprint');
		const s = await createSprint(db, { project: p.id, name: 'Sprint 1' });
		const d = await addDecision(db, { project: p.id, title: 'In-sprint call', sprint: s.id });
		expect(d.sprint).toBe(s.id);
	});
});

describe('sprint lifecycle', () => {
	it('creates active, then completes a sprint', async () => {
		const p = await freshProject('pm_sprint');
		const s = await createSprint(db, { project: p.id, name: 'Sprint A' });
		// status defaults to "active" via the 0023_pm DEFAULT.
		const completed = await completeSprint(db, s.id);
		expect(completed).not.toBeNull();
		expect(completed?.status).toBe('completed');
		expect(completed?.completed_at).toBeTruthy();
	});
});

describe('bootstrap', () => {
	it('seeds typed memory from LIVE project state, idempotently', async () => {
		const p = await freshProject('pm_boot');
		await updateProjectPlan(db, p.id, { purpose: 'A real purpose' });

		const first = await bootstrapPm(db, p.id);
		expect(first.bootstrapped).toBe(true);
		expect(first.alreadyBootstrapped).toBe(false);
		expect(first.memories.length).toBeGreaterThan(0);
		// Seeds the detected stack as an observation and the stated purpose.
		const contents = first.memories.map((m) => m.content).join('\n');
		expect(contents).toContain('node');
		expect(contents).toContain('A real purpose');

		// Idempotent: second call is a no-op that returns the existing rows.
		const again = await bootstrapPm(db, p.id);
		expect(again.bootstrapped).toBe(false);
		expect(again.alreadyBootstrapped).toBe(true);
		expect(again.memories.length).toBe(first.memories.length);
	});

	it('seeds a risk when no test command / no repo is detected', async () => {
		const bare = await createProject(db, {
			slug: 'pm_boot_bare',
			name: 'Bare',
			root_path: 'F:/code/bare',
			ecosystem: []
		});
		const res = await bootstrapPm(db, bare.id);
		const risks = res.memories.filter((m) => m.kind === 'risk');
		expect(risks.length).toBeGreaterThanOrEqual(1);
	});
});
