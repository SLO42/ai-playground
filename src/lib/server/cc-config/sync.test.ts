import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import {
	catalogIds,
	classifyScopes,
	projectScopeOf,
	readCatalog,
	reconcileScopes,
	scopeIdOf,
	syncScope,
	syncState,
	type SyncScope
} from './sync';

// TASK 1.8 VERIFY (D-010, DATA-MODEL §4.10; UI-SPEC §214/§313): config-sync mirrors
// a project's .claude/ + .mcp.json into the cc_* tables, and the catalog read backs
// it. The headline checks:
//   (1) editing a CC config file on disk → after re-sync the MIRROR reflects it.
//   (2) before re-sync, the state is reported "out_of_sync" (file edited on disk).
// Everything read back comes from the LIVE DB (F-008); the .claude tree on disk is
// a fixture (test input), and the mirror rows we assert on are real.

let tdb: TestDb;
let db: Db;

let root: string;
let claudeDir: string;
let scope: SyncScope;

function writeSettings(obj: unknown) {
	writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(obj, null, 2));
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

	// A fixture project `.claude` tree on disk.
	root = mkdtempSync(join(tmpdir(), 'cc-sync-'));
	claudeDir = join(root, '.claude');
	mkdirSync(join(claudeDir, 'agents'), { recursive: true });
	mkdirSync(join(claudeDir, 'skills', 'demo'), { recursive: true });
	writeSettings({
		permissions: { allow: ['Bash'], deny: ['mcp__x__:*'] },
		env: { FOO: 'bar' },
		hooks: {
			PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 10 }] }]
		}
	});
	writeFileSync(
		join(root, '.mcp.json'),
		JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'mcp-fs'] } } })
	);
	writeFileSync(
		join(claudeDir, 'agents', 'coder.md'),
		'---\nname: coder\ndescription: writes code\ncategory: dev\n---\nbody'
	);
	writeFileSync(
		join(claudeDir, 'skills', 'demo', 'SKILL.md'),
		'---\nname: demo\ndescription: a demo skill\n---\n'
	);

	scope = { kind: 'project', claudeDir };
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (root) rmSync(root, { recursive: true, force: true });
});

describe('syncScope — disk → cc_* mirror (D-010)', () => {
	it('populates cc_scope/settings/hook/agent/skill/mcp from disk', async () => {
		const res = await syncScope(db, scope);
		expect(res.counts).toEqual({ hooks: 1, agents: 1, skills: 1, mcpServers: 1 });

		const catalog = await readCatalog(db);
		expect(catalog).toHaveLength(1);
		const sc = catalog[0];
		expect(sc.kind).toBe('project');
		expect(sc.hooks[0]).toMatchObject({ event: 'PreToolUse', matcher: 'Bash', command: 'guard.sh' });
		expect(sc.agents[0]).toMatchObject({ name: 'coder', category: 'dev' });
		expect(sc.skills[0]).toMatchObject({ name: 'demo', description: 'a demo skill' });
		expect(sc.mcpServers[0]).toMatchObject({ name: 'fs', type: 'stdio', command: 'npx' });
	});

	// TASK 5.1 (D-036): the catalog id allow-list backing per-task capability validation.
	it('catalogIds reads the live skill/agent/mcp id allow-list from the mirror', async () => {
		await syncScope(db, scope);
		const ids = await catalogIds(db);
		expect(ids.skills.has('demo')).toBe(true);
		expect(ids.agents.has('coder')).toBe(true);
		expect(ids.mcp.has('fs')).toBe(true);
		// Fail-closed source: an id NOT on disk is absent from the allow-list.
		expect(ids.skills.has('no-such-skill')).toBe(false);
	});

	it('is idempotent — re-sync does not duplicate scope or child rows', async () => {
		await syncScope(db, scope);
		await syncScope(db, scope);
		const [scopes] = await db.query<[unknown[]]>(`SELECT id FROM cc_scope;`);
		const [hooks] = await db.query<[unknown[]]>(`SELECT id FROM cc_hook;`);
		const [settings] = await db.query<[unknown[]]>(`SELECT id FROM cc_settings;`);
		expect(scopes).toHaveLength(1);
		expect(hooks).toHaveLength(1);
		expect(settings).toHaveLength(1); // exactly one cc_settings per scope
	});

	it('initial state after sync is "synced"', async () => {
		await syncScope(db, scope);
		const st = await syncState(db, scope);
		expect(st.status).toBe('synced');
		expect(st.diskDigest).toBe(st.mirrorDigest);
	});
});

describe('drift — editing a file on disk shows out-of-sync, re-sync reflects it', () => {
	it('editing settings.json on disk flips state to out_of_sync', async () => {
		await syncScope(db, scope);
		expect((await syncState(db, scope)).status).toBe('synced');

		// Edit the config file on disk (add a permission) WITHOUT re-syncing.
		writeSettings({
			permissions: { allow: ['Bash', 'Read'], deny: ['mcp__x__:*'] },
			env: { FOO: 'bar' },
			hooks: {
				PreToolUse: [
					{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 10 }] }
				]
			}
		});

		const drifted = await syncState(db, scope);
		expect(drifted.status).toBe('out_of_sync');
		expect(drifted.diskDigest).not.toBe(drifted.mirrorDigest);

		// The mirror still holds the OLD permissions (not yet re-synced).
		const [before] = await db.query<[Array<{ permissions?: Record<string, unknown> }>]>(
			`SELECT permissions FROM cc_settings;`
		);
		expect((before[0].permissions?.allow as string[]) ?? []).toEqual(['Bash']);
	});

	it('re-syncing reflects the on-disk edit in the mirror + returns to synced', async () => {
		await syncScope(db, scope);
		const st = await syncState(db, scope);
		expect(st.status).toBe('synced');

		const [after] = await db.query<[Array<{ permissions?: Record<string, unknown> }>]>(
			`SELECT permissions FROM cc_settings;`
		);
		expect((after[0].permissions?.allow as string[]) ?? []).toEqual(['Bash', 'Read']);
	});

	it('removing an agent on disk removes it from the mirror after re-sync', async () => {
		rmSync(join(claudeDir, 'agents', 'coder.md'));
		await syncScope(db, scope);
		const [agents] = await db.query<[unknown[]]>(`SELECT id FROM cc_agent;`);
		expect(agents).toHaveLength(0);
	});

	it('a never-synced scope reports "unsynced"', async () => {
		const other = mkdtempSync(join(tmpdir(), 'cc-unsynced-'));
		mkdirSync(join(other, '.claude'), { recursive: true });
		writeFileSync(join(other, '.claude', 'settings.json'), '{}');
		const st = await syncState(db, { kind: 'project', claudeDir: join(other, '.claude') });
		expect(st.status).toBe('unsynced');
		expect(st.mirrorDigest).toBeNull();
		rmSync(other, { recursive: true, force: true });
	});
});

// ── TASK 14.4d — fail-closed scope catalog (audit-confirmed F-008/D-018 finding) ──────
//
// The live catalog carried a cc_scope row claiming to mirror a project's config while its
// path pointed at a DIFFERENT repo's .claude. These tests prove the structural fix:
// classifyScopes fails such rows closed (so the edit allow-list never trusts them),
// reconcileScopes removes them WITH their child mirror rows, and the project's scope is
// re-derived from its OWN registered root — never from an arbitrary ingested path.
describe('reconcileScopes / classifyScopes — scope provenance anchored to project roots (14.4d)', () => {
	let goodRoot: string;
	let evilRoot: string;
	let projectId: string;

	beforeAll(async () => {
		// The project's REAL root, with its own .claude on disk.
		goodRoot = mkdtempSync(join(tmpdir(), 'cc-good-'));
		mkdirSync(join(goodRoot, '.claude', 'agents'), { recursive: true });
		writeFileSync(join(goodRoot, '.claude', 'settings.json'), '{}');
		writeFileSync(
			join(goodRoot, '.claude', 'agents', 'own.md'),
			'---\nname: own\ndescription: this project’s agent\n---\n'
		);
		// A real directory OUTSIDE the project root — the "v1 repo" of the audit finding.
		evilRoot = mkdtempSync(join(tmpdir(), 'cc-evil-'));
		mkdirSync(join(evilRoot, '.claude', 'agents'), { recursive: true });
		writeFileSync(join(evilRoot, '.claude', 'settings.json'), '{}');
		writeFileSync(
			join(evilRoot, '.claude', 'agents', 'foreign.md'),
			'---\nname: foreign\ndescription: someone else’s agent\n---\n'
		);

		const p = await createProject(db, { slug: 'cc_recon', name: 'Recon', root_path: goodRoot });
		projectId = p.id;
	});

	afterAll(() => {
		rmSync(goodRoot, { recursive: true, force: true });
		rmSync(evilRoot, { recursive: true, force: true });
	});

	it('removes a project-kind scope whose path lives OUTSIDE its project root — children included — and keeps the confined one', async () => {
		// Poison: a scope row claiming projectId but pointing at the OTHER repo's .claude
		// (the exact audit shape), synced so it has child mirror rows.
		const evilDir = join(evilRoot, '.claude');
		await syncScope(db, { kind: 'project', claudeDir: evilDir, project: projectId });
		// Legit: the project's own scope, derived from its own root.
		await syncScope(db, projectScopeOf(projectId, goodRoot));

		// classifyScopes fails the poisoned row CLOSED (this is the edit allow-list source).
		const cls = await classifyScopes(db);
		expect(cls.invalid.map((r) => r.id)).toContain(scopeIdOf('project', evilDir));
		expect(cls.valid.map((r) => r.id)).toContain(scopeIdOf('project', join(goodRoot, '.claude')));

		const res = await reconcileScopes(db);
		expect(res.removed).toContain(scopeIdOf('project', evilDir));

		// The poisoned scope AND its children are gone; the project's own scope remains.
		const catalog = await readCatalog(db);
		const paths = catalog.map((c) => c.path.toLowerCase());
		expect(paths).not.toContain(evilDir.toLowerCase());
		expect(paths).toContain(join(goodRoot, '.claude').toLowerCase());
		const ids = await catalogIds(db);
		expect(ids.agents.has('foreign')).toBe(false); // child rows cascaded
		expect(ids.agents.has('own')).toBe(true);
	});

	it('a project-kind scope with NO registered project is unverifiable → fail-closed removed', async () => {
		// A scope synced WITHOUT a project link (the legacy 1.8 shape): its provenance
		// cannot be verified against any registered root → fail closed.
		const orphanRoot = mkdtempSync(join(tmpdir(), 'cc-orphan-'));
		const orphanDir = join(orphanRoot, '.claude');
		mkdirSync(orphanDir, { recursive: true });
		writeFileSync(join(orphanDir, 'settings.json'), '{}');
		await syncScope(db, { kind: 'project', claudeDir: orphanDir });

		const orphanId = scopeIdOf('project', orphanDir);
		const cls = await classifyScopes(db);
		expect(cls.invalid.map((r) => r.id)).toContain(orphanId);

		const res = await reconcileScopes(db);
		expect(res.removed).toContain(orphanId);
		const catalog = await readCatalog(db);
		expect(catalog.map((c) => c.scopeId)).not.toContain(orphanId);
		rmSync(orphanRoot, { recursive: true, force: true });
	});

	it('derives a MISSING scope from the project’s OWN root (<root>/.claude)', async () => {
		const root2 = mkdtempSync(join(tmpdir(), 'cc-derive-'));
		mkdirSync(join(root2, '.claude'), { recursive: true });
		writeFileSync(join(root2, '.claude', 'settings.json'), '{}');
		const p2 = await createProject(db, { slug: 'cc_derive', name: 'Derive', root_path: root2 });

		const res = await reconcileScopes(db);
		const expected = scopeIdOf('project', join(root2, '.claude'));
		expect(res.synced).toContain(expected);

		const catalog = await readCatalog(db);
		const sc = catalog.find((c) => c.scopeId === expected);
		expect(sc).toBeTruthy();
		expect(sc!.project).toBe(p2.id);

		// Steady state: a second reconcile performs no writes (idempotent).
		const again = await reconcileScopes(db);
		expect(again.removed).toEqual([]);
		expect(again.synced).toEqual([]);

		rmSync(root2, { recursive: true, force: true });
	});

	it('a project whose root has NO .claude on disk gets NO fabricated scope (F-008)', async () => {
		const root3 = mkdtempSync(join(tmpdir(), 'cc-none-'));
		await createProject(db, { slug: 'cc_none', name: 'None', root_path: root3 });
		const res = await reconcileScopes(db);
		expect(res.synced).toEqual([]);
		const catalog = await readCatalog(db);
		expect(catalog.map((c) => c.path.toLowerCase())).not.toContain(
			join(root3, '.claude').toLowerCase()
		);
		rmSync(root3, { recursive: true, force: true });
	});
});
