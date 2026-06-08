import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { listFindings } from './findings-repo';
import { scanProjectDependencies } from './dep-repo';
import type { AdvisorySource } from './dependencies';

// TASK 3.2 VERIFY (integration) — scanning a REAL project's package.json under CODE_ROOT
// flags an outdated/vulnerable dependency WITH its advisory and persists it as a
// security_finding row in a LIVE throwaway SurrealDB, read back on the Maintain surface.
// The advisory lookup uses a MOCKED offline source (the verify note allows mocking the
// registry response). F-008: every row is a real version-vs-advisory comparison.

let tdb: TestDb;
let db: Db;
let codeRoot: string;
let projectDir: string;
let projectId: string;

const offlineSource: AdvisorySource = {
	lookup(name) {
		switch (name) {
			case 'lodash':
				return {
					latest: '4.17.21',
					advisories: [
						{
							id: 'GHSA-p6mc-m468-83gw',
							severity: 'high',
							vulnerableRange: '<4.17.21',
							title: 'Prototype pollution in lodash'
						}
					]
				};
			case 'minimist':
				return { latest: '1.2.8', advisories: [] };
			default:
				return undefined;
		}
	}
};

function mkProject(): string {
	const dir = join(codeRoot, 'dep_app');
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({
			name: 'dep_app',
			version: '1.0.0',
			dependencies: { lodash: '4.17.20' },
			devDependencies: { minimist: '1.2.5' }
		})
	);
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

	codeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dep-root-')));
	projectDir = mkProject();
	const p = await createProject(db, { slug: 'dep_app', name: 'Dep App', root_path: projectDir });
	projectId = p.id;
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
	if (codeRoot) rmSync(codeRoot, { recursive: true, force: true });
});

describe('§3.2 scanProjectDependencies — live persistence', () => {
	it('flags a vulnerable dependency WITH its advisory and persists it', async () => {
		const written = await scanProjectDependencies(db, projectId, projectDir, {
			codeRoot,
			source: offlineSource
		});
		const vuln = written.find((f) => f.rule === 'dependency.vulnerable');
		expect(vuln).toBeDefined();
		expect(vuln!.severity).toBe('high');
		expect(vuln!.detail).toContain('GHSA-p6mc-m468-83gw'); // the advisory rides along
		expect(vuln!.project).toBe(projectId);
		expect(vuln!.status).toBe('active');
		expect(vuln!.id.startsWith('security_finding:')).toBe(true);
	});

	it('reads the dependency findings back from the LIVE DB (no mocks of the DB, F-008)', async () => {
		const rows = await listFindings(db, projectId);
		const rules = rows.map((r) => r.rule);
		expect(rules).toContain('dependency.vulnerable');
		expect(rules).toContain('dependency.outdated');
		// The vulnerable advisory must be persisted in the detail.
		const vuln = rows.find((r) => r.rule === 'dependency.vulnerable');
		expect(vuln!.detail).toContain('GHSA-p6mc-m468-83gw');
	});

	it('re-scanning soft-archives stale dependency findings (D-015) — live set replaced, not doubled', async () => {
		const before = (await listFindings(db, projectId)).filter((r) =>
			r.rule.startsWith('dependency.')
		);
		const second = await scanProjectDependencies(db, projectId, projectDir, {
			codeRoot,
			source: offlineSource
		});
		const after = (await listFindings(db, projectId)).filter((r) =>
			r.rule.startsWith('dependency.')
		);
		expect(after.length).toBe(before.length);
		expect(second.length).toBe(after.length);
		// Archived rows survive (never DELETEd) — total dependency rows > active.
		const [allRows] = await db.query<[Array<{ rule: string }>]>(
			`SELECT rule FROM security_finding WHERE project = $p;`,
			{ p: new StringRecordId(projectId) }
		);
		const totalDep = allRows.filter((r) => r.rule.startsWith('dependency.')).length;
		expect(totalDep).toBeGreaterThan(after.length);
	});

	it('does NOT archive security findings when re-scanning dependencies (scoped archive)', async () => {
		// Plant a security finding directly, then re-scan deps; the security row must survive active.
		await db.query(
			`CREATE security_finding CONTENT { project: $p, rule: "dangerous-sink.eval", severity: "medium" };`,
			{ p: new StringRecordId(projectId) }
		);
		await scanProjectDependencies(db, projectId, projectDir, { codeRoot, source: offlineSource });
		const live = await listFindings(db, projectId);
		expect(live.some((r) => r.rule === 'dangerous-sink.eval')).toBe(true);
	});
});
