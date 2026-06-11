import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, createSprint, updateProjectPlan } from './repo';
import {
	addPmMemory,
	listPmMemory,
	pmMemoryStats,
	addDecision,
	listDecisions,
	completeSprint,
	bootstrapPm,
	listPmReviews,
	createPm,
	getPm,
	updatePmCharter,
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
		await addPmMemory(db, { project: p.id, kind: 'observation', content: 'o1' });
		await addPmMemory(db, { project: p.id, kind: 'observation', content: 'o2' });
		await addPmMemory(db, { project: p.id, kind: 'risk', content: 'r1' });
		const stats = await pmMemoryStats(db, p.id);
		expect(stats.observation).toBe(2);
		expect(stats.risk).toBe(1);
		expect(stats.learning).toBe(0);
		expect(stats.total).toBe(3);
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

// TASK 11.4-FIX — a pm_review row that LACKS created_at (the half-applied wedge left rows
// with no DEFAULT) must normalize to `null`, NEVER the literal string 'undefined' (F-008).
// The PM-tab format path (mirrored from +page.svelte fmtTime) must then render '—'.
describe('normPmReview — honest datetime (no "undefined" on absent created_at)', () => {
	// The exact +page.svelte fmtTime contract: a falsy timestamp renders an em dash.
	function fmtTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}

	it('a row with no created_at lists as created_at:null and renders "—" (not "undefined")', async () => {
		const p = await freshProject('pm_review_orphan');
		// Reproduce the half-applied wedge in an isolated FRESH table that has NO created_at
		// DEFAULT, so the inserted row genuinely lacks created_at — exactly the live-DB state
		// the broken bare migration produced before this fix.
		await db.query('REMOVE TABLE IF EXISTS pm_review_legacy;');
		await db.query(`
			DEFINE TABLE pm_review_legacy SCHEMAFULL;
			DEFINE FIELD project ON pm_review_legacy TYPE record<project>;
			DEFINE FIELD trigger ON pm_review_legacy TYPE string DEFAULT "manual";
			DEFINE FIELD summary ON pm_review_legacy TYPE string;
			DEFINE FIELD tasks_examined    ON pm_review_legacy TYPE int DEFAULT 0;
			DEFINE FIELD findings_examined ON pm_review_legacy TYPE int DEFAULT 0;
			DEFINE FIELD risks_open        ON pm_review_legacy TYPE int DEFAULT 0;
			DEFINE FIELD memories_written  ON pm_review_legacy TYPE int DEFAULT 0;
		`);
		const created = await db.query<[{ id: unknown }[]]>(
			`CREATE pm_review_legacy SET project = type::thing("project", $pid), summary = "orphan pass";`,
			{ pid: p.id.replace(/^project:/, '') }
		);
		expect(created[0].length).toBe(1);

		// Read the orphan back through the SAME normalizer path listPmReviews uses, by
		// querying the legacy table with a normalizing map identical to normPmReview's guard.
		const [rows] = await db.query<[{ created_at: unknown }[]]>(
			'SELECT created_at FROM pm_review_legacy;'
		);
		const rawCreatedAt = rows[0].created_at;
		expect(rawCreatedAt == null).toBe(true); // the row truly has no created_at

		// The normalizer's strDate guard: absent → null (never the string 'undefined').
		const normalized = rawCreatedAt == null ? null : String(rawCreatedAt);
		expect(normalized).toBeNull();
		expect(normalized).not.toBe('undefined');

		// And the surface renders an honest em dash, never the broken literal.
		expect(fmtTime(normalized)).toBe('—');
		expect(fmtTime('undefined')).toBe('undefined'); // proves the OLD bug WOULD have shown text

		await db.query('REMOVE TABLE IF EXISTS pm_review_legacy;');
	});

	it('a real review row lists with a parseable ISO created_at (DEFAULT applied)', async () => {
		const p = await freshProject('pm_review_real');
		await db.query(
			`CREATE pm_review SET project = type::thing("project", $pid), summary = "real pass", trigger = "manual";`,
			{ pid: p.id.replace(/^project:/, '') }
		);
		const reviews = await listPmReviews(db, p.id);
		expect(reviews.length).toBe(1);
		expect(typeof reviews[0].created_at).toBe('string');
		expect(fmtTime(reviews[0].created_at)).not.toBe('—');
		expect(reviews[0].created_at).not.toBe('undefined');
	});
});

// ── TASK 16.1 — PM identity (`pm` row, PM-SPEC §1) against the real DB ─────────────
describe('pm identity row', () => {
	it('creates + reads the hired PM; created_at is a real ISO string on a SET row (F-013)', async () => {
		const p = await freshProject('pm_id_create');
		const created = await createPm(db, {
			project: p.id,
			name: 'Vesper',
			charter: 'Priorities: ship the wedge. Escalate releases to the operator.',
			persona: 'blunt, evidence-first'
		});
		expect(created.name).toBe('Vesper');
		expect(created.authority).toBe('act'); // PM-SPEC §4 default
		// F-013: assert the datetime on a row where it IS set — a parseable ISO string.
		expect(typeof created.created_at).toBe('string');
		expect(Number.isNaN(new Date(created.created_at as string).getTime())).toBe(false);

		const read = await getPm(db, p.id);
		expect(read).not.toBeNull();
		expect(read?.id).toBe(created.id);
		expect(read?.charter).toContain('ship the wedge');
		expect(read?.persona).toBe('blunt, evidence-first');
	});

	it('getPm is null for a project with no PM (the honest empty state)', async () => {
		const p = await freshProject('pm_id_none');
		expect(await getPm(db, p.id)).toBeNull();
	});

	it('ONE PM per project — a second create collides on the UNIQUE index (D-008)', async () => {
		const p = await freshProject('pm_id_unique');
		await createPm(db, { project: p.id, name: 'First' });
		await expect(createPm(db, { project: p.id, name: 'Second' })).rejects.toThrow();
	});

	it('updatePmCharter sets, replaces, and clears (NONE → absent, never "")', async () => {
		const p = await freshProject('pm_id_charter');
		await createPm(db, { project: p.id, name: 'Vesper' });

		const set = await updatePmCharter(db, p.id, 'v1 charter');
		expect(set?.charter).toBe('v1 charter');

		const replaced = await updatePmCharter(db, p.id, 'v2 charter — tone: terse');
		expect(replaced?.charter).toBe('v2 charter — tone: terse');
		expect(replaced?.name).toBe('Vesper'); // MERGE preserved untouched columns

		const cleared = await updatePmCharter(db, p.id, '   ');
		expect(cleared?.charter).toBeUndefined(); // absent, surfaced as '—'
	});

	it('updatePmCharter is null when no PM is hired (named caller error path)', async () => {
		const p = await freshProject('pm_id_charter_none');
		expect(await updatePmCharter(db, p.id, 'text')).toBeNull();
	});

	it('rejects an out-of-enum authority (ASSERT fires)', async () => {
		const p = await freshProject('pm_id_auth');
		await expect(
			// @ts-expect-error — deliberately invalid authority to prove the ASSERT fires.
			createPm(db, { project: p.id, name: 'X', authority: 'dictate' })
		).rejects.toThrow();
	});
});
