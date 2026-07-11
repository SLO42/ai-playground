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
import { withScanLock, scanLockInFlightCount } from './scan-lock';
import { scanProjectSecurity, listFindings } from './findings-repo';
import { scanProjectDependencies } from './dep-repo';
import type { AdvisorySource } from './dependencies';

// SCN-1 — the per-(project,family) single-flight lock around the scan-and-persist window.
// Two families of tests: (A) the lock helper in isolation (serialization, cross-key
// concurrency, throw-releases, map cleanup — the four shadow paths), and (B) a real-surreal
// proof that two concurrent same-key scans leave EXACTLY ONE active finding set while a
// different-family scan is unaffected.

// ── (A) Lock helper — pure, no DB ───────────────────────────────────────────────────────────
describe('SCN-1 withScanLock — serialization + cross-key concurrency', () => {
	it('serializes same (family, project): the second runs only after the first settles', async () => {
		const log: string[] = [];
		const first = withScanLock('security', 'project:a', async () => {
			log.push('1-start');
			await new Promise((r) => setTimeout(r, 30));
			log.push('1-end');
			return 1;
		});
		// Enqueued while the first is mid-flight; despite doing NO async work it must wait.
		const second = withScanLock('security', 'project:a', async () => {
			log.push('2-start');
			log.push('2-end');
			return 2;
		});
		expect(await first).toBe(1);
		expect(await second).toBe(2);
		expect(log).toEqual(['1-start', '1-end', '2-start', '2-end']);
		expect(scanLockInFlightCount()).toBe(0); // map cleaned up when the chain drains
	});

	it('runs DIFFERENT keys concurrently (different project OR different family)', async () => {
		let releaseA!: () => void;
		const gateA = new Promise<void>((r) => (releaseA = r));
		const order: string[] = [];

		// A parks on a gate; B (different project) and C (different family) must still enter.
		const a = withScanLock('security', 'project:a', async () => {
			order.push('a-start');
			await gateA;
			order.push('a-end');
		});
		const b = withScanLock('security', 'project:b', async () => {
			order.push('b-ran');
		});
		const c = withScanLock('dependency', 'project:a', async () => {
			order.push('c-ran');
		});

		await Promise.all([b, c]); // resolve WITHOUT releasing A ⇒ not blocked by A's lock
		expect(order).toContain('b-ran');
		expect(order).toContain('c-ran');
		expect(order).not.toContain('a-end'); // A is still parked
		expect(scanLockInFlightCount()).toBe(1); // only A's key remains in flight

		releaseA();
		await a;
		expect(scanLockInFlightCount()).toBe(0);
	});

	it('a scan that THROWS releases the lock — the next same-key scan is not wedged', async () => {
		const boom = withScanLock('security', 'project:x', async () => {
			throw new Error('scan blew up');
		});
		await expect(boom).rejects.toThrow('scan blew up');
		// The next scan of the SAME key runs on the settled tail (never poisoned by the throw).
		const ok = await withScanLock('security', 'project:x', async () => 'recovered');
		expect(ok).toBe('recovered');
		expect(scanLockInFlightCount()).toBe(0);
	});

	it('is idle (count 0) between runs — the map never accumulates drained keys', async () => {
		await withScanLock('ux', 'project:y', async () => 'done');
		expect(scanLockInFlightCount()).toBe(0);
	});
});

// ── (B) Real-surreal — exactly ONE active set under concurrency ──────────────────────────────
let tdb: TestDb;
let db: Db;
let codeRoot: string;
let projectDir: string;
let projectId: string;

const offlineSource: AdvisorySource = {
	lookup(name) {
		if (name === 'lodash') {
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
		}
		return undefined;
	}
};

function mkProject(): string {
	// One tree carrying BOTH a security issue (secret/eval) and a dependency issue (outdated lodash),
	// so a security scan and a dependency scan each produce ≥1 finding over the same project dir.
	const dir = join(codeRoot, 'scn_app');
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(
		join(dir, 'src', 'cfg.ts'),
		['const apiKey = "sk_live_abcdef0123456789";', 'export const r = "us-east-1";'].join('\n')
	);
	writeFileSync(join(dir, 'src', 'run.js'), 'function f(s){ return eval(s); }');
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'scn_app', version: '1.0.0', dependencies: { lodash: '4.17.20' } })
	);
	return dir;
}

async function activeRules(pid: string): Promise<string[]> {
	return (await listFindings(db, pid)).map((f) => f.rule);
}

async function totalRowCount(pid: string): Promise<number> {
	const [rows] = await db.query<[unknown[]]>(`SELECT id FROM security_finding WHERE project = $p;`, {
		p: new StringRecordId(pid)
	});
	return rows.length;
}

describe('SCN-1 concurrent scans (real-surreal) — one active set, no double-insert', () => {
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

		codeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'scn-lock-root-')));
		projectDir = mkProject();
		const p = await createProject(db, { slug: 'scn_app', name: 'SCN App', root_path: projectDir });
		projectId = p.id;
	}, 60_000);

	afterAll(async () => {
		if (projectId) await deleteProject(db, projectId).catch(() => {});
		await db?.close();
		await tdb?.teardown();
		if (codeRoot) rmSync(codeRoot, { recursive: true, force: true });
	});

	it('two concurrent SAME-key security scans leave exactly ONE active set (not doubled)', async () => {
		// Baseline: a single scan's active count is the "one set" size.
		const single = await scanProjectSecurity(db, projectId, projectDir, { codeRoot });
		const oneSetSize = single.length;
		expect(oneSetSize).toBeGreaterThan(0);
		const baselineActive = (await listFindings(db, projectId)).length;
		expect(baselineActive).toBe(oneSetSize);

		// Fire TWO scans of the same (project, security) key concurrently. Without the lock both
		// would archive-then-insert into TWO active sets; the lock serializes them to ONE.
		const [a, b] = await Promise.all([
			scanProjectSecurity(db, projectId, projectDir, { codeRoot }),
			scanProjectSecurity(db, projectId, projectDir, { codeRoot })
		]);
		expect(a.length).toBe(oneSetSize);
		expect(b.length).toBe(oneSetSize);

		// The live (active) set is exactly one scan's worth — NOT doubled.
		const active = await listFindings(db, projectId);
		expect(active.length).toBe(oneSetSize);

		// Both scans really ran (append-only D-015): 3 scans total ⇒ 3 batches of rows persisted,
		// with only the last active. This proves the fix serialized rather than dropped a scan.
		const total = await totalRowCount(projectId);
		expect(total).toBe(oneSetSize * 3);
		expect(scanLockInFlightCount()).toBe(0);
	}, 60_000);

	it('a concurrent DIFFERENT-family scan is unaffected — both families coexist active', async () => {
		// Security + dependency scans race on the SAME project (different lock keys ⇒ concurrent).
		// Each archives only its own rule prefix, so both active sets survive together.
		const [sec, dep] = await Promise.all([
			scanProjectSecurity(db, projectId, projectDir, { codeRoot }),
			scanProjectDependencies(db, projectId, projectDir, { codeRoot, source: offlineSource })
		]);
		expect(sec.length).toBeGreaterThan(0);
		expect(dep.length).toBeGreaterThan(0);

		const rules = await activeRules(projectId);
		expect(rules.some((r) => r.startsWith('dependency.'))).toBe(true);
		expect(rules.some((r) => !r.startsWith('dependency.'))).toBe(true); // security rows still active
		expect(scanLockInFlightCount()).toBe(0);
	}, 60_000);
});
