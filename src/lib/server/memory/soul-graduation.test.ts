// Stage S4 VERIFY — soul GRADUATION HISTORY (m0078) recorder + timeline reader.
//
// Two layers:
//   1. FAIL-OPEN unit test (no DB) — a DB fault in the recorder is ABSORBED to null, never thrown
//      (F-014/F-048: a brain-history write must never crash the heartbeat drain).
//   2. REAL-SURREAL integration (F-020: stubDb does NOT parse SurrealQL) — the recorder's
//      last-recorded-stage dedup guard + the WHERE-subject / ORDER BY graduated_at reads run against
//      a live throwaway DB: a stage change records EXACTLY ONE event, re-running records NONE, the
//      timeline reads newest-first with ISO dates, a cold brain records nothing (honest empty), a
//      downward regression is recorded honestly, and subjects are isolated (atelier vs a PM subject).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	recordGraduationIfChanged,
	listGraduations,
	readLatestGraduationStage,
	ATELIER_SUBJECT
} from './soul-graduation';

// ── 1. FAIL-OPEN (no DB) ────────────────────────────────────────────────────────────────────

describe('recordGraduationIfChanged — fail-open (F-014/F-048)', () => {
	it('absorbs a DB fault to null instead of throwing', async () => {
		const throwingDb = {
			query: async () => {
				throw new Error('db down (dead socket)');
			}
		} as unknown as Db;
		await expect(recordGraduationIfChanged(throwingDb)).resolves.toBeNull();
	});
});

// ── 2. REAL-SURREAL recorder + reader (F-020) ───────────────────────────────────────────────

describe('soul graduation history — live SurrealDB (F-020)', () => {
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
		await db.query(
			'DELETE soul_graduation; DELETE concept; DELETE memory; DELETE causal_chain; DELETE session; DELETE retrieval_outcome;'
		);
	});

	async function seedConcept(label: string): Promise<void> {
		await db.query(
			`CREATE concept SET label=$label, summary="", namespace="default",
			   embedding=array::repeat(0.0, 1024), importance=5.0, stability=0.5, access_count=0,
			   status="active", screen_status="clean" RETURN NONE;`,
			{ label }
		);
	}
	async function seedCorrection(content: string): Promise<void> {
		await db.query(
			`CREATE memory SET content=$c, kind="semantic", namespace=$ns, scope="project",
			   embedding=array::repeat(0.0, 1024), importance=9.0, status="active", screen_status="clean",
			   category="correction" RETURN NONE;`,
			{ c: content, ns: content.slice(0, 12) }
		);
	}
	async function seedCausal(i: number): Promise<void> {
		await db.query(
			`CREATE causal_chain SET trigger=$t, outcome=$o, kind="fix", success=true, confidence=0.8 RETURN NONE;`,
			{ t: `trigger ${i}`, o: `outcome ${i}` }
		);
	}
	async function seedSession(): Promise<void> {
		await db.query(
			`CREATE session SET kind="discussion", model={ provider: "test", model_id: "m" }, runtime="claude-code", status="done" RETURN NONE;`
		);
	}

	/** Seed enough live brain rows to clear the DEVELOPING gates (concepts≥5, corrections≥1, causal≥3, sessions≥10). */
	async function seedDeveloping(): Promise<void> {
		for (let i = 0; i < 5; i++) await seedConcept(`concept ${i}`);
		await seedCorrection('idempotent additive migrations only (F-015)');
		for (let i = 0; i < 3; i++) await seedCausal(i);
		for (let i = 0; i < 10; i++) await seedSession();
	}

	it('a cold brain records NOTHING and the timeline is honestly empty', async () => {
		const rec = await recordGraduationIfChanged(db);
		expect(rec).toBeNull();
		expect(await listGraduations(db, ATELIER_SUBJECT)).toEqual([]);
		expect(await readLatestGraduationStage(db)).toBeNull();
	});

	it('a stage change records EXACTLY ONE event with the metric snapshot; re-running records NONE (dedup)', async () => {
		await seedDeveloping();

		const rec = await recordGraduationIfChanged(db);
		expect(rec).toEqual({ subject: ATELIER_SUBJECT, fromStage: 'nascent', toStage: 'developing' });

		// Re-running the pass at the SAME stage is a no-op (last-recorded-stage dedup guard).
		expect(await recordGraduationIfChanged(db)).toBeNull();

		const rows = await listGraduations(db, ATELIER_SUBJECT);
		expect(rows).toHaveLength(1);
		const [g] = rows;
		expect(g.subject).toBe(ATELIER_SUBJECT);
		expect(g.fromStage).toBe('nascent');
		expect(g.toStage).toBe('developing');
		// Snapshot reflects the live counts at graduation (F-008).
		expect(g.concepts).toBe(5);
		expect(g.corrections).toBe(1);
		expect(g.causalChains).toBe(3);
		expect(g.sessions).toBe(10);
		// competence is honestly null under MIN_COMPETENCE_SAMPLE (no outcomes seeded).
		expect(g.competence).toBeNull();
		// F-013: graduated_at is an ISO string, never a raw SDK datetime.
		expect(typeof g.graduatedAt).toBe('string');
		expect(Number.isNaN(Date.parse(g.graduatedAt as string))).toBe(false);
	});

	it('records a downward regression honestly and lists NEWEST-FIRST', async () => {
		await seedDeveloping();
		expect((await recordGraduationIfChanged(db))?.toStage).toBe('developing');

		await new Promise((r) => setTimeout(r, 5)); // distinct graduated_at for a deterministic order
		// Brain collapses back to cold → an honest downward transition is recorded (not just promotions).
		await db.query('DELETE concept; DELETE memory; DELETE causal_chain; DELETE session;');
		const down = await recordGraduationIfChanged(db);
		expect(down).toEqual({ subject: ATELIER_SUBJECT, fromStage: 'developing', toStage: 'nascent' });

		const rows = await listGraduations(db, ATELIER_SUBJECT);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => `${r.fromStage}->${r.toStage}`)).toEqual([
			'developing->nascent', // newest first
			'nascent->developing'
		]);
	});

	it('keeps subjects isolated — an atelier graduation never collides with a PM subject', async () => {
		await seedDeveloping();
		await recordGraduationIfChanged(db, ATELIER_SUBJECT);
		await recordGraduationIfChanged(db, 'project:test'); // future PM-soul subject, same table

		expect(await listGraduations(db, ATELIER_SUBJECT)).toHaveLength(1);
		expect(await listGraduations(db, 'project:test')).toHaveLength(1);
		expect(await readLatestGraduationStage(db, 'project:test')).toBe('developing');
		// Re-running either subject is a per-subject no-op.
		expect(await recordGraduationIfChanged(db, ATELIER_SUBJECT)).toBeNull();
		expect(await recordGraduationIfChanged(db, 'project:test')).toBeNull();
	});
});
