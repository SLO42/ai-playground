import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { captureSnapshot, SnapshotPathError } from './file-snapshot';
import { getLatestSnapshotByPath, getSnapshotById } from './file-snapshot-query';

// FILE-SNAPSHOT-SPEC §4 (FS-3) — the read side. The pure path-confinement shadow paths run without
// a DB; the resolve/latest/dedup/project-scope/absolute-relativize/honest-empty behaviour is
// integration-tested vs a REAL throwaway SurrealDB so the D-016/F-008/F-013 rails are proven
// against the real schema (m0054).

// ─────────────────────────────────────────────────────────────────────────────────────
// SHADOW PATHS (no DB) — a malformed/escaping path is rejected BEFORE any query (D-016).
// getLatestSnapshotByPath normalizes the (relative) path up front, so these throw without a DB.
// ─────────────────────────────────────────────────────────────────────────────────────

describe('getLatestSnapshotByPath — D-016 path shadow paths (pre-DB, no query)', () => {
	it('rejects an empty path (named SnapshotPathError)', async () => {
		await expect(getLatestSnapshotByPath(null as never, { path: '' })).rejects.toBeInstanceOf(
			SnapshotPathError
		);
	});
	it('rejects a relative `..` escape before touching the DB', async () => {
		await expect(
			getLatestSnapshotByPath(null as never, { path: '../../etc/passwd' })
		).rejects.toBeInstanceOf(SnapshotPathError);
	});
	it('an ABSOLUTE path with NO projectRoot is an honest miss (null), not an escape', async () => {
		const abs = process.platform === 'win32' ? 'C:\\x\\y.ts' : '/x/y.ts';
		// No DB call happens — the absolute branch returns null before any query.
		await expect(getLatestSnapshotByPath(null as never, { path: abs })).resolves.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────
// INTEGRATION — resolve / latest-as-of / dedup / project-scope / absolute-relativize / empty.
// ─────────────────────────────────────────────────────────────────────────────────────

describe('file-snapshot-query (integration, real SurrealDB)', () => {
	let tdb: TestDb;
	let db: Db;
	let root: string;

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
		root = realpathSync(await mkdtemp(join(tmpdir(), 'fs3-')));
	}, 90_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown();
		if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
	});

	it('resolves a captured snapshot by project-relative path', async () => {
		await captureSnapshot(db, { path: 'src/a.ts', content: 'v1\n', project: 'project:q1' });
		const snap = await getLatestSnapshotByPath(db, { path: 'src/a.ts', project: 'project:q1' });
		expect(snap).not.toBeNull();
		expect(snap?.path).toBe('src/a.ts');
		expect(snap?.content).toBe('v1\n');
		// F-013 — captured_at is an ISO string, never a raw non-POJO / "undefined".
		expect(typeof snap?.captured_at).toBe('string');
		expect(snap?.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('returns the MOST RECENT snapshot when a file was captured multiple times (latest as-of)', async () => {
		await captureSnapshot(db, { path: 'src/edit.ts', content: 'first\n', project: 'project:q1' });
		// A later, DIFFERENT content → a new content-addressed row with a newer captured_at.
		await new Promise((r) => setTimeout(r, 15));
		await captureSnapshot(db, { path: 'src/edit.ts', content: 'second\n', project: 'project:q1' });
		const snap = await getLatestSnapshotByPath(db, { path: 'src/edit.ts', project: 'project:q1' });
		expect(snap?.content).toBe('second\n');
	});

	it('honest empty (null) when no snapshot was ever captured for the reference (F-008)', async () => {
		const snap = await getLatestSnapshotByPath(db, {
			path: 'src/never.ts',
			project: 'project:q1'
		});
		expect(snap).toBeNull();
	});

	it('is project-scoped — a different project does not see another snapshot', async () => {
		await captureSnapshot(db, { path: 'src/scope.ts', content: 'p1\n', project: 'project:q1' });
		const other = await getLatestSnapshotByPath(db, {
			path: 'src/scope.ts',
			project: 'project:q2'
		});
		expect(other).toBeNull();
		const own = await getLatestSnapshotByPath(db, { path: 'src/scope.ts', project: 'project:q1' });
		expect(own?.content).toBe('p1\n');
	});

	it('a project-less reference matches only project-less snapshots (IS NONE split)', async () => {
		await captureSnapshot(db, { path: 'noproj.ts', content: 'bare\n' });
		const bare = await getLatestSnapshotByPath(db, { path: 'noproj.ts' });
		expect(bare?.content).toBe('bare\n');
	});

	it('relativizes an ABSOLUTE path against projectRoot to the stored relative key', async () => {
		const rel = 'src/abs.ts';
		await captureSnapshot(db, { path: rel, content: 'abs-body\n', project: 'project:q1' });
		const abs = join(root, 'src', 'abs.ts');
		const snap = await getLatestSnapshotByPath(db, {
			path: abs,
			project: 'project:q1',
			projectRoot: root
		});
		expect(snap?.content).toBe('abs-body\n');
	});

	it('an ABSOLUTE path OUTSIDE the projectRoot is an honest miss (null), never an escape query', async () => {
		const outside = process.platform === 'win32' ? 'C:\\elsewhere\\z.ts' : '/elsewhere/z.ts';
		const snap = await getLatestSnapshotByPath(db, {
			path: outside,
			project: 'project:q1',
			projectRoot: root
		});
		expect(snap).toBeNull();
	});

	it('resolves a marker (secret-screened) snapshot WITHOUT un-withholding content (D-026)', async () => {
		// A private-key PEM block → screen quarantines (quarantineOnHit) → a marker row (body withheld).
		const secret =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc123def456ghi789\n-----END RSA PRIVATE KEY-----\n';
		const cap = await captureSnapshot(db, {
			path: 'key.pem',
			content: secret,
			project: 'project:q1'
		});
		expect(cap.isMarker).toBe(true);
		const snap = await getLatestSnapshotByPath(db, { path: 'key.pem', project: 'project:q1' });
		expect(snap?.is_marker).toBe(true);
		expect(snap?.marker_reason).toBe('quarantined');
		// The stored body is a marker line, NOT the raw key material.
		expect(snap?.content).not.toContain('MIIEowIBAAKCAQEAabc123def456ghi789');
	});

	it('getSnapshotById resolves the exact row and returns null on a miss', async () => {
		const cap = await captureSnapshot(db, {
			path: 'src/byid.ts',
			content: 'by-id\n',
			project: 'project:q1'
		});
		const snap = await getSnapshotById(db, cap.id);
		expect(snap?.content).toBe('by-id\n');
		expect(snap?.id).toBe(cap.id);
		const miss = await getSnapshotById(db, 'file_snapshot:does_not_exist');
		expect(miss).toBeNull();
	});
});
