import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { CONFIG_PROTECTION_DENY, DANGEROUS_BASH_DENY } from '../claude-code/guardrails';
import { scanProject, confineToRoot, PathConfinementError } from './registry';

// TASK 1.1 VERIFY: scanning a real directory under CODE_ROOT creates the expected
// `project` row in a throwaway test DB (namespace dropped per run). Also covers
// idempotency (re-scan = same row, no dupes) and D-018 path-confinement.

let tdb: TestDb;
let db: Db;
let codeRoot: string;

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

	// A real code root with a real project directory underneath it.
	// realpathSync so the stored path matches the symlink-resolved confinement.
	codeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'scanner-root-')));
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (codeRoot) rmSync(codeRoot, { recursive: true, force: true });
});

function project(name: string, files: Record<string, string>): string {
	const dir = join(codeRoot, name);
	mkdirSync(dir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe('scanProject — upsert into the project registry', () => {
	it('creates the expected project row for a real TS dir under CODE_ROOT', async () => {
		const dir = project('my-ts-app', {
			'package.json': '{"name":"my-ts-app"}',
			'tsconfig.json': '{}'
		});

		const row = await scanProject(db, dir, { codeRoot });

		expect(row.id).toBe('project:my_ts_app');
		expect(row.slug).toBe('my_ts_app');
		expect(row.name).toBe('my-ts-app');
		expect(row.root_path).toBe(realpathSync(dir));
		expect(row.ecosystem).toContain('typescript');
		expect(row.build_tool).toBe('npm');
		expect(row.test_command).toBe('npm test');
		expect(row.status).toBe('active');

		// And it is actually persisted (live read, not the RETURN AFTER echo).
		const [found] = await db.query<[{ slug: string }[]]>(
			'SELECT slug FROM project WHERE slug = $s;',
			{ s: 'my_ts_app' }
		);
		expect(found).toHaveLength(1);
	});

	it('is idempotent — re-scanning updates, does not duplicate', async () => {
		const dir = project('dupe-app', { 'Cargo.toml': '[package]' });

		const first = await scanProject(db, dir, { codeRoot });
		const second = await scanProject(db, dir, { codeRoot });

		expect(second.id).toBe(first.id);

		const [rows] = await db.query<[{ n: number }[]]>(
			"SELECT count() AS n FROM project WHERE slug = 'dupe_app' GROUP ALL;"
		);
		expect(rows[0].n).toBe(1);
	});

	it('detects a BepInEx mod project and stores its mod platform', async () => {
		const dir = project('rounds-mod', {
			'src/SWIP.csproj': '<Project/>',
			'thunderstore/manifest.json': '{"name":"SWIP"}'
		});
		const row = await scanProject(db, dir, { codeRoot });
		expect(row.ecosystem).toContain('csharp');
		expect(row.ecosystem).toContain('bepinex');
	});

	// CCH-2 — registration seeds the D-024 PRIMARY guardrail (.claude/settings.json permissions.deny)
	// at the scanned root, BEFORE any agent can spawn into the project. scanProject is the sole
	// upsert-from-detection funnel, so this is what makes the primary boundary EXIST on new projects.
	it('seeds the .claude/settings.json permissions.deny guardrail at the scanned root (D-024)', async () => {
		const dir = project('guarded-app', { 'package.json': '{"name":"guarded-app"}' });

		await scanProject(db, dir, { codeRoot });

		const settingsPath = join(realpathSync(dir), '.claude', 'settings.json');
		expect(existsSync(settingsPath)).toBe(true);
		const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
		expect(written.permissions.deny).toEqual(
			expect.arrayContaining([...CONFIG_PROTECTION_DENY, ...DANGEROUS_BASH_DENY])
		);
		expect(written.permissions.additionalDirectories).toEqual([realpathSync(dir)]);
	});
});

describe('confineToRoot — D-018 path-confinement (fail-closed)', () => {
	it('accepts a directory under the root', () => {
		const dir = project('inside', { 'go.mod': 'module x' });
		expect(confineToRoot(dir, codeRoot)).toBe(realpathSync(dir));
	});

	it('rejects a `..` escape outside the root', () => {
		expect(() => confineToRoot(join(codeRoot, '..', 'elsewhere'), codeRoot)).toThrow(
			PathConfinementError
		);
	});

	it('rejects a sibling that shares a name prefix (F:/code-other vs F:/code)', () => {
		const sibling = realpathSync(mkdtempSync(join(tmpdir(), 'scanner-sibling-')));
		try {
			expect(() => confineToRoot(sibling, codeRoot)).toThrow(PathConfinementError);
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it('fails closed on an unresolvable target', () => {
		expect(() => confineToRoot(join(codeRoot, 'nope', 'still-nope'), codeRoot)).toThrow(
			PathConfinementError
		);
	});
});
