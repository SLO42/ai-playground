import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, updateProjectPlan } from './repo';
import { addPmMemory, createPm } from './pm-repo';
import { assemblePmContext, resolvePmRoute } from './pm-session';

// TASK 16.1 VERIFY (D-038) — the PM session seams against a REAL throwaway SurrealDB:
//   • assemblePmContext — charter FIRST, then plan, then memory; every shadow path
//     (no pm / no charter / no plan / no memory) degrades honestly (F-008).
//   • resolvePmRoute — the EXPLICIT workforce.yaml override (F-005 short-circuit)
//     persisted as a routing_event with method "explicit"; an unreadable config falls
//     back HONESTLY (method "fallback", real reason) — never a silent constant.

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

async function freshProject(slug: string) {
	return createProject(db, {
		slug,
		name: `Ctx ${slug}`,
		root_path: 'F:/code/ctxtest',
		ecosystem: ['node']
	});
}

describe('assemblePmContext — charter + plan + memory, fenced DATA payloads', () => {
	it('charter FIRST, then plan macro, then typed memory (the §2 layer order)', async () => {
		const p = await freshProject('ctx_full');
		const pm = await createPm(db, {
			project: p.id,
			name: 'Vesper',
			charter: 'Escalate anything release-shaped.'
		});
		await updateProjectPlan(db, p.id, { purpose: 'Run the mods' });
		await addPmMemory(db, { project: p.id, kind: 'risk', content: 'no CI yet' });

		const ctx = await assemblePmContext(db, p.id);
		expect(ctx.charter).toBe('Escalate anything release-shaped.');
		expect(ctx.items.length).toBe(3);
		expect(ctx.items[0].text).toContain('PM charter');
		expect(ctx.items[0].text).toContain('Escalate anything release-shaped.');
		expect(ctx.items[0].citationId).toBe(pm.id);
		expect(ctx.items[1].text).toContain('Purpose: Run the mods');
		expect(ctx.items[1].citationId).toBe('plan');
		expect(ctx.items[2].text).toBe('[risk] no CI yet');
	});

	it('shadow: no pm row → no charter item, charter:null (the rest still assembles)', async () => {
		const p = await freshProject('ctx_nopm');
		await updateProjectPlan(db, p.id, { purpose: 'Plan only' });
		const ctx = await assemblePmContext(db, p.id);
		expect(ctx.charter).toBeNull();
		expect(ctx.items.some((i) => i.text.includes('PM charter'))).toBe(false);
		expect(ctx.items.some((i) => i.citationId === 'plan')).toBe(true);
	});

	it('shadow: pm hired but NO charter → no charter item (absent, not an empty fence)', async () => {
		const p = await freshProject('ctx_nocharter');
		await createPm(db, { project: p.id, name: 'Quill' });
		const ctx = await assemblePmContext(db, p.id);
		expect(ctx.charter).toBeNull();
		expect(ctx.items.some((i) => i.text.includes('PM charter'))).toBe(false);
	});

	it('shadow: empty everything → an EMPTY bundle (no fabricated placeholder items)', async () => {
		const p = await freshProject('ctx_empty');
		const ctx = await assemblePmContext(db, p.id);
		expect(ctx.items).toEqual([]);
		expect(ctx.charter).toBeNull();
	});
});

describe('resolvePmRoute — the explicit workforce.yaml override (F-005)', () => {
	function tempConfigDir(yaml?: string): string {
		const dir = mkdtempSync(join(tmpdir(), 'wf-'));
		if (yaml !== undefined) writeFileSync(join(dir, 'workforce.yaml'), yaml, 'utf8');
		return dir;
	}
	const FALLBACK = { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' };

	it('routes the PM to the configured model, method "explicit", routing_event persisted', async () => {
		const p = await freshProject('route_explicit');
		const dir = tempConfigDir('pm:\n  provider: claude\n  model_id: claude-fable-5\n');
		try {
			const route = await resolvePmRoute(db, p.id, { configDir: dir, fallback: FALLBACK });
			expect(route.method).toBe('explicit');
			expect(route.model).toEqual({ provider: 'claude', modelId: 'claude-fable-5' });
			expect(route.reason).toContain('config/workforce.yaml pm.model_id');

			// The decision is a REAL routing_event row (analytics first-class, F-008) —
			// read it back by the id resolvePmRoute returned.
			const [rows] = await db.query<
				[Array<{ method: string; reason: string; chosen: { provider: string; model_id: string } }>]
			>(`SELECT * FROM ONLY $rid;`, { rid: new StringRecordId(route.routingEventId) });
			const row = (Array.isArray(rows) ? rows[0] : rows) as {
				method: string;
				reason: string;
				chosen: { provider: string; model_id: string };
			};
			expect(row.method).toBe('explicit');
			expect(row.chosen.provider).toBe('claude');
			expect(row.chosen.model_id).toBe('claude-fable-5');
			expect(row.reason).toContain('F-005 short-circuit');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('falls back HONESTLY when workforce.yaml is missing (method "fallback", named reason)', async () => {
		const p = await freshProject('route_fallback');
		const dir = tempConfigDir(); // no workforce.yaml inside
		try {
			const route = await resolvePmRoute(db, p.id, { configDir: dir, fallback: FALLBACK });
			expect(route.method).toBe('fallback');
			expect(route.model).toEqual(FALLBACK);
			expect(route.reason).toContain('workforce.yaml unreadable');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
