import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
	ensureHarvestScope,
	harvestScope,
	harvestScopeDir,
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

// SH-5: pin the harness-owned harvest scope to a hermetic temp dir for the whole file so the
// reconcile pass (which now also ensures the harvest scope) never writes into the worktree's
// real `.harness/` tree. Restored in afterAll.
let harvestRoot: string;
const prevHarvestEnv = process.env.HARVEST_SCOPE_ROOT;

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

	// Pin the harvest scope to a temp dir BEFORE any reconcile runs (env read at call time).
	harvestRoot = mkdtempSync(join(tmpdir(), 'cc-harvest-'));
	process.env.HARVEST_SCOPE_ROOT = harvestRoot;

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
	if (harvestRoot) rmSync(harvestRoot, { recursive: true, force: true });
	if (prevHarvestEnv === undefined) delete process.env.HARVEST_SCOPE_ROOT;
	else process.env.HARVEST_SCOPE_ROOT = prevHarvestEnv;
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

// SH-5 (SKILL-HARVEST-SPEC §5) — the load-bearing fix for F-045: one harness-owned, synced
// harvest scope so a freshly-written SKILL.md actually reaches `cc_skill` / `catalogIds` and
// becomes a referenceable capability id. These tests run against the REAL temp `.claude` dir
// pinned via HARVEST_SCOPE_ROOT in the top-level beforeAll.
describe('harvest scope (SH-5) — harness-owned synced scope so a promoted skill reaches catalogIds', () => {
	function writeHarvestSkill(name: string, description: string) {
		const dir = join(harvestScopeDir(), 'skills', name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
	}

	it('harvestScopeDir is deterministic + honors HARVEST_SCOPE_ROOT, and harvestScope is global-kind', () => {
		// Pinned to the temp root in this file → <root>/.claude.
		expect(harvestScopeDir()).toBe(join(harvestRoot, '.claude'));
		// Env override resolves explicitly (injectable env).
		expect(harvestScopeDir({ HARVEST_SCOPE_ROOT: 'X:/h' } as NodeJS.ProcessEnv)).toBe(
			join('X:/h', '.claude')
		);
		// Falls back to the harness-config-root sibling when only HARNESS_CONFIG_ROOT is set.
		expect(harvestScopeDir({ HARNESS_CONFIG_ROOT: 'Y:/cfg/claude-config' } as NodeJS.ProcessEnv)).toBe(
			join('Y:/cfg', 'harvest', '.claude')
		);
		const sc = harvestScope();
		expect(sc.kind).toBe('global');
		expect(sc.project).toBeUndefined(); // no owning project — exempt from confinement
		expect(sc.claudeDir).toBe(join(harvestRoot, '.claude'));
	});

	it('ensureHarvestScope creates the .claude/skills tree on disk + registers a global cc_scope (idempotent)', async () => {
		const id1 = await ensureHarvestScope(db);
		expect(existsSync(join(harvestScopeDir(), 'skills'))).toBe(true);
		// Deterministic id, same on re-run (no duplicate row).
		const id2 = await ensureHarvestScope(db);
		expect(id2).toBe(id1);
		const catalog = await readCatalog(db);
		const rows = catalog.filter((c) => c.scopeId === id1);
		expect(rows).toHaveLength(1); // exactly one — UPSERT, not a second CREATE
		expect(rows[0].kind).toBe('global');
		expect(rows[0].path.toLowerCase()).toBe(join(harvestRoot, '.claude').toLowerCase());
	});

	it('a SKILL.md written into the harvest scope then synced APPEARS in catalogIds (the F-045 fix)', async () => {
		writeHarvestSkill('replay-fix', 'a harvested reusable procedure');
		await ensureHarvestScope(db); // re-sync picks up the new skill on disk
		const ids = await catalogIds(db);
		expect(ids.skills.has('replay-fix')).toBe(true); // ← referenceable capability id
	});

	it('reconcileScopes covers the harvest scope and is idempotent (run twice → no duplicate)', async () => {
		const r1 = await reconcileScopes(db);
		expect(r1.harvestScopeId).toBe(scopeIdOf('global', harvestScopeDir()));
		const r2 = await reconcileScopes(db);
		expect(r2.harvestScopeId).toBe(r1.harvestScopeId);
		// Exactly one harvest row in the catalog after two reconciles.
		const catalog = await readCatalog(db);
		expect(catalog.filter((c) => c.scopeId === r1.harvestScopeId)).toHaveLength(1);
		// classifyScopes keeps it VALID (global is exempt from project confinement) — never removed.
		const cls = await classifyScopes(db);
		expect(cls.valid.map((v) => v.id)).toContain(r1.harvestScopeId);
		expect(cls.invalid.map((v) => v.id)).not.toContain(r1.harvestScopeId);
	});

	// REGRESSION (SH-5 review MEDIUM): the loader re-invalidates reconcileScopes on every
	// `project` DB event, so multi-tab / event-burst concurrency drives N PARALLEL reconciles.
	// The old per-scope cc_settings write was a non-atomic DELETE-then-CREATE: all DELETEs ran,
	// then all CREATEs → cc_settings=N orphan rows for ONE scope. The fix (deterministic-id
	// UPSERT + digest-gated re-sync) must keep it at exactly ONE row under concurrency.
	it('concurrent ensureHarvestScope writes converge on exactly ONE cc_settings row (no duplicate-orphan race)', async () => {
		const id = scopeIdOf('global', harvestScopeDir());
		const scopeRid = `cc_scope:${id.split(':')[1]}`;
		// Force a digest change so ALL 8 parallel ensures see drift and race the WRITE path
		// (not the steady-state read short-circuit) — this is the interleave the review proved
		// produced cc_settings=8 under the old DELETE-then-CREATE.
		writeHarvestSkill('race-probe', 'forces a digest change for the concurrency test');
		// 8 parallel ensures (the probe count from the review) — the worst-case interleave.
		await Promise.all(Array.from({ length: 8 }, () => ensureHarvestScope(db)));
		const [settings] = await db.query<[unknown[]]>(
			`SELECT id FROM cc_settings WHERE scope = ${scopeRid};`
		);
		expect(settings).toHaveLength(1); // deterministic id + UPSERT — never duplicated

		// And exactly one cc_scope row (UPSERT-deduped, the part the review confirmed already held).
		const [scopes] = await db.query<[unknown[]]>(`SELECT id FROM cc_scope WHERE id = ${scopeRid};`);
		expect(scopes).toHaveLength(1);
	});

	// REGRESSION (SH-5 re-review MEDIUM — the CHILD-table race, the prior fix missed): the same
	// non-atomic DELETE-then-CREATE that duplicated cc_settings ALSO lived in replaceSkills/Hooks/
	// Agents/McpServers. The review's instrumented probe (8 parallel ensureHarvestScope under
	// forced drift) produced cc_skill=6 then =16 rows for 2 skills. The fix (deterministic
	// per-child ids + guarded-sweep UPSERT) must hold every child table at exactly the on-disk
	// count under the SAME 8-parallel forced-drift interleave.
	it('concurrent ensureHarvestScope writes converge — child tables (cc_skill etc.) never duplicate under forced drift', async () => {
		const id = scopeIdOf('global', harvestScopeDir());
		const scopeRid = `cc_scope:${id.split(':')[1]}`;
		// Two skills on disk + a new one forces a digest change so ALL 8 parallel ensures take the
		// WRITE path (not the steady-state read short-circuit) and race replaceSkills concurrently.
		writeHarvestSkill('child-probe-a', 'first skill to force the child-table concurrency path');
		writeHarvestSkill('child-probe-b', 'second skill to force the child-table concurrency path');
		await Promise.all(Array.from({ length: 8 }, () => ensureHarvestScope(db)));

		// Exactly the on-disk skill count — no per-writer duplicate orphans. (replay-fix + race-probe
		// from earlier tests in this scope are also on disk; assert by deterministic-id uniqueness
		// instead of a brittle absolute count: distinct ids == total rows means zero duplication.)
		const [skillRows] = await db.query<[Array<{ id: unknown; name: unknown }>]>(
			`SELECT id, name FROM cc_skill WHERE scope = ${scopeRid};`
		);
		const distinctIds = new Set(skillRows.map((r) => String(r.id)));
		expect(distinctIds.size).toBe(skillRows.length); // no duplicate-id rows at all
		// And every skill name appears exactly once (the user-visible /claude-code catalog is honest).
		const names = skillRows.map((r) => String(r.name));
		expect(new Set(names).size).toBe(names.length);
		expect(names).toContain('child-probe-a');
		expect(names).toContain('child-probe-b');

		// catalogIds (Set) was always immune; the rendered catalog (readCatalog, no dedup) is the
		// honesty surface — it must show each skill ONCE now that rows can't duplicate (F-008/D-010).
		const catalog = await readCatalog(db);
		const harvest = catalog.find((c) => c.scopeId === id);
		expect(harvest).toBeTruthy();
		const catNames = harvest!.skills.map((k) => k.name);
		expect(new Set(catNames).size).toBe(catNames.length); // mirror is disk-exact, no dup rows
	});

	it('steady-state ensureHarvestScope is write-free — unchanged disk does NOT touch cc_settings (digest gate)', async () => {
		const id = scopeIdOf('global', harvestScopeDir());
		const scopeRid = `cc_scope:${id.split(':')[1]}`;
		await ensureHarvestScope(db); // land the mirror
		// Capture the settings row id; a re-sync would CONTENT-replace it (here: same id, but a
		// DELETE-then-CREATE would have churned a NEW random id). With the digest gate, the row
		// is not rewritten at all when disk is unchanged.
		const [before] = await db.query<[Array<{ id: unknown; synced_at: unknown }>]>(
			`SELECT id, synced_at FROM cc_settings WHERE scope = ${scopeRid};`
		);
		expect(before).toHaveLength(1);
		const beforeStamp = String(before[0].synced_at);

		// Steady state: disk unchanged → no write. synced_at is set on every write, so an
		// unchanged stamp proves the gate skipped syncScope.
		await ensureHarvestScope(db);
		const [after] = await db.query<[Array<{ id: unknown; synced_at: unknown }>]>(
			`SELECT id, synced_at FROM cc_settings WHERE scope = ${scopeRid};`
		);
		expect(after).toHaveLength(1);
		expect(String(after[0].id)).toBe(String(before[0].id)); // same row, not re-created
		expect(String(after[0].synced_at)).toBe(beforeStamp); // NOT re-written (write-free)
	});

	it('the harvest scope carries ONLY harvested skills — no operator-plugin agents bleed in (D-002)', async () => {
		// The dir is harness-created empty + only skills are written into it; it has no agents/.
		const catalog = await readCatalog(db);
		const harvest = catalog.find((c) => c.scopeId === scopeIdOf('global', harvestScopeDir()));
		expect(harvest).toBeTruthy();
		expect(harvest!.agents).toEqual([]);
		expect(harvest!.mcpServers).toEqual([]);
	});
});
