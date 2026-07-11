import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { composeCapabilities, CapabilityValidationError } from '../runtime/index';
import {
	catalogIds,
	ensureHarvestScope,
	freshenCatalog,
	harvestScopeDir,
	reconcileScopes,
	syncScope,
	syncState,
	type SyncScope
} from './sync';

// CCF-1 (D-036 additive note, 2026-07-08) — spawn-time catalog freshness. D-036 is a fail-closed
// SECURITY allow-list: a skill DELETED from a scope between /claude-code visits must not keep
// passing validation via the runtime's per-boot snapshot. `freshenCatalog` probes each catalog-
// feeding scope's disk-vs-mirror digest and, ONLY on drift, runs the SAME reconcile the loader
// calls, then re-reads the id-set. These are real-surreal (F-020) where a query is involved.

let tdb: TestDb;
let db: Db;

let harvestRoot: string;
let harvestClaudeDir: string;
const prevHarvestEnv = process.env.HARVEST_SCOPE_ROOT;

// A project fixture scope for the F-045 regression (a catalogued skill id that must still pass).
let projectRoot: string;
let projectScope: SyncScope;

function writeSkill(claudeDir: string, name: string, description: string) {
	const dir = join(claudeDir, 'skills', name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
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

	// Pin the harness-owned harvest scope to a hermetic temp dir (env read at call time).
	harvestRoot = mkdtempSync(join(tmpdir(), 'ccf1-harvest-'));
	process.env.HARVEST_SCOPE_ROOT = harvestRoot;
	harvestClaudeDir = harvestScopeDir(process.env);

	// A project `.claude` with one skill — the catalogued id the F-045 regression proves stays valid.
	projectRoot = mkdtempSync(join(tmpdir(), 'ccf1-proj-'));
	const projClaude = join(projectRoot, '.claude');
	mkdirSync(projClaude, { recursive: true });
	writeFileSync(join(projClaude, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
	writeSkill(projClaude, 'wired-skill', 'a wired catalogued skill');
	projectScope = { kind: 'project', claudeDir: projClaude };
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (harvestRoot) rmSync(harvestRoot, { recursive: true, force: true });
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
	if (prevHarvestEnv === undefined) delete process.env.HARVEST_SCOPE_ROOT;
	else process.env.HARVEST_SCOPE_ROOT = prevHarvestEnv;
});

describe('freshenCatalog — CCF-1 spawn-time catalog freshness (D-036)', () => {
	// (a) THE decision test — a skill DELETED from a scope + syncState out_of_sync ⇒ freshenCatalog
	// reconciles the drift out of the catalog, so the spawn plan REFUSES the deleted capability id.
	it('deleted skill + out_of_sync scope ⇒ freshened catalog REFUSES the deleted id (fail closed)', async () => {
		// Establish a promoted skill in the harness-owned harvest scope (the promote destination, SH-5).
		writeSkill(harvestClaudeDir, 'ephemeral', 'a soon-to-be-deleted skill');
		await ensureHarvestScope(db);
		const ids = await catalogIds(db);
		expect(ids.skills.has('ephemeral')).toBe(true);
		// Sanity: the id validates while it exists (compose does not throw).
		expect(() =>
			composeCapabilities({ skills: ['ephemeral'], agents: [], mcp: [] }, ids, {})
		).not.toThrow();

		// DELETE the skill from disk — the scope now drifts (out_of_sync) but the mirror still lists it.
		rmSync(join(harvestClaudeDir, 'skills', 'ephemeral'), { recursive: true, force: true });
		const st = await syncState(db, { kind: 'global', claudeDir: harvestClaudeDir });
		expect(st.status).toBe('out_of_sync');
		// Before freshening, the STALE mirror still carries the deleted id (the permissive hole).
		expect((await catalogIds(db)).skills.has('ephemeral')).toBe(true);

		// Freshen at spawn time — drift is detected, the SAME reconcile the loader runs fires, and the
		// snapshot rebuilds WITHOUT the deleted id.
		const fresh = await freshenCatalog(db);
		expect(fresh.reconciled).toBe(true);
		expect(fresh.staleWarning).toBeUndefined();
		expect(fresh.catalog.skills.has('ephemeral')).toBe(false);

		// The spawn plan (composeCapabilities) now REFUSES the deleted id — fail closed (D-036).
		expect(() =>
			composeCapabilities({ skills: ['ephemeral'], agents: [], mcp: [] }, fresh.catalog, {})
		).toThrow(CapabilityValidationError);
	});

	// (b) In-sync scope ⇒ the validation path is byte-identical: NO reconcile call (asserted via spy).
	it('in-sync scopes take the fast path — reconcile is NOT called', async () => {
		// Bring every scope in-sync first (reconcile re-syncs the harvest scope; sync the project scope).
		await reconcileScopes(db);
		await syncScope(db, projectScope);
		// Guard: no scope is drifted now.
		expect((await syncState(db, { kind: 'global', claudeDir: harvestClaudeDir })).status).toBe('synced');

		const reconcileSpy = vi.fn(async () => reconcileScopes(db));
		const fresh = await freshenCatalog(db, { reconcile: reconcileSpy });
		expect(reconcileSpy).not.toHaveBeenCalled();
		expect(fresh.reconciled).toBe(false);
		expect(fresh.staleWarning).toBeUndefined();
		// The fast path still returns the live catalog id-set.
		expect(fresh.catalog.skills.has('wired-skill')).toBe(true);
	});

	// (c) Reconcile FAILURE ⇒ validate against the LAST-GOOD snapshot + an honest staleness warning.
	it('reconcile failure ⇒ last-good snapshot used + staleWarning recorded (never blocks the spawn)', async () => {
		const boom = new Error('surreal write refused');
		const reconcileThrows = vi.fn(async () => {
			throw boom;
		});
		// Force the drift branch deterministically so the reconcile is attempted (and throws).
		const fresh = await freshenCatalog(db, {
			probeStale: async () => true,
			reconcile: reconcileThrows
		});
		expect(reconcileThrows).toHaveBeenCalledTimes(1);
		expect(fresh.reconciled).toBe(false);
		expect(fresh.staleWarning).toBeTruthy();
		expect(fresh.staleWarning).toContain('surreal write refused');
		// Last-good id-set is still returned (a spawn proceeds; D-036 refusal stays closed against it).
		const lastGood = await catalogIds(db);
		expect(fresh.catalog.skills.size).toBe(lastGood.skills.size);
	});

	// (d) F-045 regression — a WIRED intent's catalogued id (and the reserved peer-send pass-through)
	// STILL validate after a freshen: freshening must tighten the deleted-id hole WITHOUT breaking the
	// intents the routing ladder actually sends.
	it('F-045: catalogued ids + reserved peer-send still pass after freshening; unknown id still refused', async () => {
		await reconcileScopes(db);
		await syncScope(db, projectScope);
		const fresh = await freshenCatalog(db);
		expect(fresh.catalog.skills.has('wired-skill')).toBe(true);

		// A catalogued skill + the RESERVED peer-send id (never catalogued, F-045-safe) both pass.
		expect(() =>
			composeCapabilities({ skills: ['wired-skill', 'peer-send'], agents: [], mcp: [] }, fresh.catalog, {})
		).not.toThrow();

		// A genuinely-unknown id STILL fails closed (the fail-closed boundary is not weakened).
		expect(() =>
			composeCapabilities({ skills: ['not-a-real-skill'], agents: [], mcp: [] }, fresh.catalog, {})
		).toThrow(CapabilityValidationError);
	});
});
