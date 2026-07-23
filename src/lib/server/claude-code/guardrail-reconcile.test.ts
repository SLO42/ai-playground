import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { reconcileProjectGuardrails } from './guardrail-reconcile';
import { CONFIG_PROTECTION_DENY, DANGEROUS_BASH_DENY } from './guardrails';

// CCH-2 (CLAUDE-CODE-HARNESS-SPEC §5) — the BOOT-TIME reconcile of the D-024 PRIMARY guardrail
// boundary (per-project .claude/settings.json permissions.deny). Real SurrealDB (listProjects is a
// real query — DoD): create real project rows over real temp dirs, run the reconcile, and assert
// the settings.json is seeded, hand edits are preserved (D-010), a missing root is skipped without
// a phantom .claude tree (F-008/F-014), and a re-run is idempotent.

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
	codeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'reconcile-root-')));
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (codeRoot) rmSync(codeRoot, { recursive: true, force: true });
});

beforeEach(async () => {
	// Clean slate per test so seeded/skipped counts are deterministic.
	await db.query('DELETE project;');
});

/** Make a real project dir under codeRoot and register a `project` row pointing at it. */
async function registerProject(slug: string, opts: { makeDir?: boolean } = {}): Promise<string> {
	const dir = join(codeRoot, slug);
	if (opts.makeDir !== false) mkdirSync(dir, { recursive: true });
	await createProject(db, { slug, name: slug, root_path: dir });
	return dir;
}

function settingsPath(dir: string): string {
	return join(dir, '.claude', 'settings.json');
}

describe('reconcileProjectGuardrails — boot-time seed of the D-024 primary boundary', () => {
	it('seeds .claude/settings.json permissions.deny for a registered project', async () => {
		const dir = await registerProject('recon_happy');

		const res = await reconcileProjectGuardrails(db, { codeRoot });

		expect(res.seeded).toBe(1);
		expect(res.skipped).toBe(0);
		expect(res.warnings).toEqual([]);
		const written = JSON.parse(readFileSync(settingsPath(dir), 'utf8'));
		expect(written.permissions.deny).toEqual(
			expect.arrayContaining([...CONFIG_PROTECTION_DENY, ...DANGEROUS_BASH_DENY])
		);
		expect(written.permissions.additionalDirectories).toEqual([dir]);
	});

	it('SKIPS a project whose root_path no longer exists — a named warning, NO phantom .claude tree', async () => {
		const dir = await registerProject('recon_ghost', { makeDir: false });
		expect(existsSync(dir)).toBe(false);

		const res = await reconcileProjectGuardrails(db, { codeRoot });

		expect(res.seeded).toBe(0);
		expect(res.skipped).toBe(1);
		expect(res.warnings).toHaveLength(1);
		expect(res.warnings[0]).toContain('project:recon_ghost');
		// The missing root was NEVER materialized (writeProjectGuardrails' mkdirSync did not run).
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(settingsPath(dir))).toBe(false);
	});

	it('does NOT clobber a hand-edited settings.json — unrelated keys survive, deny is unioned (D-010)', async () => {
		const dir = await registerProject('recon_handedit');
		const claudeDir = join(dir, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, 'settings.json'),
			JSON.stringify({ model: 'opus', permissions: { allow: ['Read(./src/**)'] } })
		);

		const res = await reconcileProjectGuardrails(db, { codeRoot });

		expect(res.seeded).toBe(1);
		const written = JSON.parse(readFileSync(settingsPath(dir), 'utf8'));
		// Hand-edited keys survive…
		expect(written.model).toBe('opus');
		expect(written.permissions.allow).toEqual(['Read(./src/**)']);
		// …and the guardrail deny rules are now present (union).
		expect(written.permissions.deny).toEqual(
			expect.arrayContaining([...CONFIG_PROTECTION_DENY, ...DANGEROUS_BASH_DENY])
		);
	});

	it('is idempotent — a second reconcile adds no duplicate deny entries', async () => {
		const dir = await registerProject('recon_idem');

		await reconcileProjectGuardrails(db, { codeRoot });
		const res2 = await reconcileProjectGuardrails(db, { codeRoot });

		expect(res2.seeded).toBe(1);
		const deny: string[] = JSON.parse(readFileSync(settingsPath(dir), 'utf8')).permissions.deny;
		expect(new Set(deny).size).toBe(deny.length);
	});

	it('reconciles a MIX: seeds the live projects, skips the missing one, over one pass', async () => {
		const a = await registerProject('recon_mix_a');
		await registerProject('recon_mix_missing', { makeDir: false });
		const c = await registerProject('recon_mix_c');

		const res = await reconcileProjectGuardrails(db, { codeRoot });

		expect(res.seeded).toBe(2);
		expect(res.skipped).toBe(1);
		expect(existsSync(settingsPath(a))).toBe(true);
		expect(existsSync(settingsPath(c))).toBe(true);
	});

	it('returns an honest empty result when there are no registered projects', async () => {
		const res = await reconcileProjectGuardrails(db, { codeRoot });
		expect(res).toEqual({ seeded: 0, skipped: 0, exempted: 0, warnings: [] });
	});

	// CCH-2 red-team fix: the platform's OWN worktree, if registered as a project row, must be
	// EXEMPTED — never seed a self-clamping .claude/settings.json into the control-plane repo.
	it('EXEMPTS the platform self-host worktree — no .claude written, counted as exempted not a fault-skip', async () => {
		const selfRoot = await registerProject('recon_self');

		const res = await reconcileProjectGuardrails(db, { codeRoot, selfRoot });

		// Intentional no-op: exempted, NOT seeded, NOT a fault-skip.
		expect(res.exempted).toBe(1);
		expect(res.seeded).toBe(0);
		expect(res.skipped).toBe(0);
		expect(res.warnings).toHaveLength(1);
		expect(res.warnings[0]).toContain('EXEMPT');
		expect(res.warnings[0]).toContain('project:recon_self');
		// The measured defect: settings.json was written INTO the platform repo. It must NOT be now.
		expect(existsSync(settingsPath(selfRoot))).toBe(false);
	});

	// SF2-4b — a project row's root_path can escape CODE_ROOT (moved dir, imported/hand-edited row).
	// The reconcile must RE-CONFINE fail-closed: skip it with a named warning, never seed a guardrail
	// (whose additionalDirectories would grant fs access) outside the code root.
	it('RE-CONFINES a root_path that escapes CODE_ROOT — skipped, no guardrail seeded outside the code root', async () => {
		// A real, existing directory OUTSIDE codeRoot, registered as a project row.
		const outside = realpathSync(mkdtempSync(join(tmpdir(), 'reconcile-escape-')));
		try {
			await createProject(db, { slug: 'recon_escape', name: 'recon_escape', root_path: outside });

			const res = await reconcileProjectGuardrails(db, { codeRoot });

			expect(res.seeded).toBe(0);
			expect(res.skipped).toBe(1);
			expect(res.exempted).toBe(0);
			expect(res.warnings).toHaveLength(1);
			expect(res.warnings[0]).toContain('project:recon_escape');
			expect(res.warnings[0]).toMatch(/CODE_ROOT/);
			// The out-of-root path was NEVER seeded with a guardrail.
			expect(existsSync(settingsPath(outside))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('re-confines the escaping root while STILL seeding an in-root project in the same pass', async () => {
		const inRoot = await registerProject('recon_inroot');
		const outside = realpathSync(mkdtempSync(join(tmpdir(), 'reconcile-escape2-')));
		try {
			await createProject(db, { slug: 'recon_escape2', name: 'recon_escape2', root_path: outside });

			const res = await reconcileProjectGuardrails(db, { codeRoot });

			expect(res.seeded).toBe(1);
			expect(res.skipped).toBe(1);
			expect(existsSync(settingsPath(inRoot))).toBe(true);
			expect(existsSync(settingsPath(outside))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('exempts the self-root while STILL seeding the other projects in the same pass', async () => {
		const selfRoot = await registerProject('recon_self_mix');
		const other = await registerProject('recon_other');

		const res = await reconcileProjectGuardrails(db, { codeRoot, selfRoot });

		expect(res.exempted).toBe(1);
		expect(res.seeded).toBe(1);
		expect(existsSync(settingsPath(selfRoot))).toBe(false);
		expect(existsSync(settingsPath(other))).toBe(true);
	});
});
