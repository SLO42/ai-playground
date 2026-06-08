import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import {
	scanProjectSecurity,
	listFindings,
	listAllFindings,
	archiveActiveFindings
} from './findings-repo';

// TASK 3.1 VERIFY (integration) — scanning a REAL project dir under CODE_ROOT produces
// security_finding rows persisted to a LIVE throwaway SurrealDB and read back grouped by
// severity (F-008: every row is a real scan result, no fabricated data, no mocks). The
// detector runs over an on-disk temp tree confined to a temp CODE_ROOT.

let tdb: TestDb;
let db: Db;
let codeRoot: string;
let projectDir: string;
let projectId: string;

function mkProject(): string {
	// A real project tree under CODE_ROOT with planted issues.
	const dir = join(codeRoot, 'demo_app');
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(
		join(dir, 'src', 'cfg.ts'),
		[
			'const awsId = "AKIAIOSFODNN7EXAMPLE";',
			'const apiKey = "sk_live_abcdef0123456789";',
			'export const r = "us-east-1";'
		].join('\n')
	);
	writeFileSync(join(dir, 'src', 'run.js'), 'function f(s){ return eval(s); }');
	return dir;
}

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

	codeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sec-root-')));
	projectDir = mkProject();
	const p = await createProject(db, {
		slug: 'demo_app',
		name: 'Demo App',
		root_path: projectDir
	});
	projectId = p.id;
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
	if (codeRoot) rmSync(codeRoot, { recursive: true, force: true });
});

describe('§3.1 scanProjectSecurity — live persistence', () => {
	it('scans a real project under CODE_ROOT and writes security_finding rows', async () => {
		const written = await scanProjectSecurity(db, projectId, projectDir, { codeRoot });
		expect(written.length).toBeGreaterThanOrEqual(3); // aws + secret + eval
		// Every persisted row links back to the project and is active.
		for (const f of written) {
			expect(f.project).toBe(projectId);
			expect(f.status).toBe('active');
			expect(f.id.startsWith('security_finding:')).toBe(true);
		}
	});

	it('reads findings back from the LIVE DB grouped by severity (no mocks, F-008)', async () => {
		const rows = await listFindings(db, projectId);
		expect(rows.length).toBeGreaterThanOrEqual(3);
		// Sorted critical→low.
		expect(rows[0].severity).toBe('critical');
		const rules = rows.map((r) => r.rule);
		expect(rules).toContain('hardcoded-secret.aws-access-key');
		expect(rules).toContain('hardcoded-secret.generic-assignment');
		expect(rules).toContain('dangerous-sink.eval');
		// No secret value persisted in any detail.
		for (const r of rows) {
			expect(r.detail ?? '').not.toContain('sk_live_abcdef0123456789');
		}
	});

	it('global rollup lists findings across all projects', async () => {
		const all = await listAllFindings(db);
		expect(all.some((f) => f.project === projectId)).toBe(true);
	});

	it('re-scanning soft-archives stale findings (D-015) — live set is replaced, not duplicated', async () => {
		const before = await listFindings(db, projectId);
		const second = await scanProjectSecurity(db, projectId, projectDir, { codeRoot });
		const after = await listFindings(db, projectId);
		// Active count is stable (old archived, fresh inserted) — not doubled.
		expect(after.length).toBe(before.length);
		expect(second.length).toBe(after.length);
		// The archived rows still exist (never DELETEd) — total > active.
		const [allRows] = await db.query<[unknown[]]>(
			`SELECT * FROM security_finding WHERE project = $p;`,
			{ p: new (await import('surrealdb')).StringRecordId(projectId) }
		);
		expect(allRows.length).toBeGreaterThan(after.length);
	});

	it('archiveActiveFindings flips active rows out of the live read', async () => {
		const n = await archiveActiveFindings(db, projectId, 'manual-test');
		expect(n).toBeGreaterThan(0);
		const live = await listFindings(db, projectId);
		expect(live.length).toBe(0);
	});
});
