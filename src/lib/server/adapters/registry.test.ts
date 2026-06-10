import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import {
	declareTarget,
	listTargets,
	getTarget,
	resolveDefaultTarget,
	removeTarget,
	listTargetRuns,
	lastRunFor,
	recordTargetRun
} from './registry';
import { runTargetAction, confirmTokenFor, GateConfirmError } from './driver';
import { resetAdapterRegistry } from './index';
import { resolvePublishTarget, buildReleaseSteps } from '../release/pipeline';

// TASK 12.1 VERIFY (D-038) — the registry/target store + the gated driver run against a REAL
// throwaway SurrealDB (real project_target + target_run + incident rows). No real external
// publish/deploy occurs (the built-ins honest-defer); the gate + recording machinery is fully
// exercised. Every row read back is one the code actually wrote (F-008).

let tdb: TestDb;
let db: Db;
let projectId: string;
let projectDir: string;

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

	projectDir = await mkdtemp(join(tmpdir(), 'atelier-proj-'));
	await writeFile(
		join(projectDir, 'package.json'),
		JSON.stringify({ name: 'atelier-demo', version: '0.4.0' }),
		'utf8'
	);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	await rm(projectDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	resetAdapterRegistry();
	await db.query('DELETE target_run; DELETE project_target; DELETE incident; DELETE project;').catch(() => {});
	const p = await createProject(db, { slug: 'demo', name: 'Demo', root_path: projectDir });
	projectId = p.id;
});

describe('per-project target store (project_target)', () => {
	it('declares, lists, and resolves a default target', async () => {
		const t = await declareTarget(db, {
			project: projectId,
			kind: 'publish',
			adapterId: 'npm',
			config: { registry: 'https://registry.npmjs.org' },
			isDefault: true
		});
		expect(t.adapter_id).toBe('npm');
		expect(t.is_default).toBe(true);
		expect(t.config.registry).toBe('https://registry.npmjs.org');

		const list = await listTargets(db, projectId);
		expect(list).toHaveLength(1);

		const def = await resolveDefaultTarget(db, projectId, 'publish');
		expect(def?.id).toBe(t.id);
	});

	it('upserts (no duplicate) on a re-declare of the same (project,kind,adapter)', async () => {
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm', label: 'first' });
		const second = await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm', label: 'second' });
		const list = await listTargets(db, projectId, 'publish');
		expect(list).toHaveLength(1);
		expect(list[0].label).toBe('second');
		expect(second.id).toBe(list[0].id);
	});

	it('keeps exactly one default per kind', async () => {
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm', isDefault: true });
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'thunderstore', isDefault: true });
		const list = await listTargets(db, projectId, 'publish');
		const defaults = list.filter((t) => t.is_default);
		expect(defaults).toHaveLength(1);
		expect(defaults[0].adapter_id).toBe('thunderstore');
	});

	it('removeTarget deletes the declaration', async () => {
		const t = await declareTarget(db, { project: projectId, kind: 'deploy', adapterId: 'static-host' });
		expect(await removeTarget(db, t.id)).toBe(true);
		expect(await getTarget(db, t.id)).toBeNull();
	});

	it('resolveDefaultTarget skips disabled targets', async () => {
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm', enabled: false });
		expect(await resolveDefaultTarget(db, projectId, 'publish')).toBeNull();
	});
});

describe('lastRunFor — per-target last run (13.4a regression)', () => {
	it('two targets sharing an adapter_id do NOT steal each other\'s runs', async () => {
		// The same CUSTOM adapter id declared for BOTH gated families — legal (the dedup index is
		// per (project, kind, adapter_id)), and exactly the shape the old adapter_id fallback
		// cross-attributed: a deploy run would show up as the publish target's lastRun.
		const pub = await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'my-cdn' });
		const dep = await declareTarget(db, { project: projectId, kind: 'deploy', adapterId: 'my-cdn' });
		expect(pub.id).not.toBe(dep.id);

		// One REAL run, recorded through the DEPLOY target only (the driver always stamps target.id).
		const run = await recordTargetRun(db, {
			project: projectId,
			target: dep.id,
			kind: 'deploy',
			adapterId: 'my-cdn',
			dryRun: true,
			ok: true,
			summary: 'deploy plan computed'
		});

		const runs = await listTargetRuns(db, projectId);
		expect(runs).toHaveLength(1);

		// The deploy target owns its run; the publish target has honestly NEVER run (null —
		// the adapter_id fallback would have stolen the deploy run here).
		expect(lastRunFor(runs, dep.id)?.id).toBe(run.id);
		expect(lastRunFor(runs, pub.id)).toBeNull();
	});

	it('a legacy run with NO target link is attributed to no target (never guessed)', async () => {
		const pub = await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm' });
		await recordTargetRun(db, {
			project: projectId,
			kind: 'publish',
			adapterId: 'npm',
			dryRun: true,
			ok: true,
			summary: 'legacy run without a target link'
		});
		const runs = await listTargetRuns(db, projectId);
		expect(runs).toHaveLength(1);
		expect(lastRunFor(runs, pub.id)).toBeNull();
	});
});

describe('gated driver — dry-run, confirm gate, recording (D-018/F-008)', () => {
	it('dry-run drives the chosen adapter + records a target_run + returns a confirm token', async () => {
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm', isDefault: true });
		const out = await runTargetAction({ db, env: {}, projectId, cwd: projectDir, kind: 'publish', dryRun: true });
		expect(out.result.dryRun).toBe(true);
		expect(out.result.ok).toBe(true);
		expect(out.result.target).toBe('npm:atelier-demo');
		expect(out.result.steps.length).toBeGreaterThan(0);
		expect(out.confirmToken).toBe(
			confirmTokenFor({ projectId, kind: 'publish', adapterId: 'npm', config: out.target.config })
		);
		const runs = await listTargetRuns(db, projectId);
		expect(runs).toHaveLength(1);
		expect(runs[0].dry_run).toBe(true);
		expect(runs[0].adapter_id).toBe('npm');
	});

	it('a REAL action with NO confirm token FAILS CLOSED (GateConfirmError)', async () => {
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm', isDefault: true });
		await expect(
			runTargetAction({ db, env: {}, projectId, cwd: projectDir, kind: 'publish', dryRun: false })
		).rejects.toBeInstanceOf(GateConfirmError);
	});

	it('a REAL action with a STALE/wrong token FAILS CLOSED', async () => {
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm', isDefault: true });
		await expect(
			runTargetAction({
				db,
				env: {},
				projectId,
				cwd: projectDir,
				kind: 'publish',
				dryRun: false,
				confirmToken: 'not-the-token'
			})
		).rejects.toBeInstanceOf(GateConfirmError);
	});

	it('a REAL action with the MATCHING token runs (honest-deferred) + records ok:false + an incident', async () => {
		const tgt = await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'npm', isDefault: true });
		const token = confirmTokenFor({ projectId, kind: 'publish', adapterId: 'npm', config: tgt.config });
		const out = await runTargetAction({
			db,
			env: { NPM_TOKEN: 'tok' },
			projectId,
			cwd: projectDir,
			kind: 'publish',
			dryRun: false,
			confirmToken: token
		});
		expect(out.result.dryRun).toBe(false);
		expect(out.result.ok).toBe(false); // honest-deferred, no real external call
		const runs = await listTargetRuns(db, projectId);
		expect(runs[0].dry_run).toBe(false);
		// A failed real action raises an incident (never silent — D-018/F-008).
		const [incidents] = await db.query<[Array<{ title: string }>]>('SELECT title FROM incident;');
		expect(incidents.length).toBeGreaterThan(0);
	});

	it('the confirm token is bound to the resolved config — a config EDIT invalidates it (D-018)', async () => {
		// Dry-run against config A → get the token the operator would carry into the confirm form.
		await declareTarget(db, {
			project: projectId,
			kind: 'publish',
			adapterId: 'npm',
			config: { registry: 'https://registry.npmjs.org' },
			isDefault: true
		});
		const dry = await runTargetAction({ db, env: {}, projectId, cwd: projectDir, kind: 'publish', dryRun: true });
		const staleToken = dry.confirmToken;

		// Operator edits the target config (B) between dry-run and confirm (re-declare upserts in place).
		await declareTarget(db, {
			project: projectId,
			kind: 'publish',
			adapterId: 'npm',
			config: { registry: 'https://evil.example.com' },
			isDefault: true
		});

		// The stale token no longer matches the re-derived (config-bound) token → fail CLOSED.
		await expect(
			runTargetAction({
				db,
				env: { NPM_TOKEN: 'tok' },
				projectId,
				cwd: projectDir,
				kind: 'publish',
				dryRun: false,
				confirmToken: staleToken
			})
		).rejects.toBeInstanceOf(GateConfirmError);
	});

	it('the token is stable across key-order — a re-serialised but equal config confirms (happy path)', async () => {
		await declareTarget(db, {
			project: projectId,
			kind: 'publish',
			adapterId: 'npm',
			config: { registry: 'https://registry.npmjs.org', access: 'public' },
			isDefault: true
		});
		const dry = await runTargetAction({ db, env: {}, projectId, cwd: projectDir, kind: 'publish', dryRun: true });
		// Same config values, different key order — the canonical hash is identical, so the token holds.
		const equivalent = confirmTokenFor({
			projectId,
			kind: 'publish',
			adapterId: 'npm',
			config: { access: 'public', registry: 'https://registry.npmjs.org' }
		});
		expect(dry.confirmToken).toBe(equivalent);
		// And the confirm with the dry-run token runs end-to-end (honest-deferred, not a gate error).
		const out = await runTargetAction({
			db,
			env: { NPM_TOKEN: 'tok' },
			projectId,
			cwd: projectDir,
			kind: 'publish',
			dryRun: false,
			confirmToken: dry.confirmToken
		});
		expect(out.result.dryRun).toBe(false);
	});

	it('fails CLOSED with an honest error when NO target is configured', async () => {
		await expect(
			runTargetAction({ db, env: {}, projectId, cwd: projectDir, kind: 'publish', dryRun: true })
		).rejects.toThrow(/no publish target configured/);
	});

	it('fails CLOSED on a target whose adapter id is UNKNOWN to the registry (D-037)', async () => {
		// Declare bypasses the registry check (the surface validates on declare); the driver
		// must still fail closed when it can't resolve the adapter.
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'totally-custom', isDefault: true });
		await expect(
			runTargetAction({ db, env: {}, projectId, cwd: projectDir, kind: 'publish', dryRun: true })
		).rejects.toThrow(/no publish adapter registered/);
	});
});

describe('release pipeline wiring (D-037)', () => {
	it('resolvePublishTarget returns the chosen target; null when none', async () => {
		expect(await resolvePublishTarget(db, projectId)).toBeNull();
		await declareTarget(db, { project: projectId, kind: 'publish', adapterId: 'thunderstore', label: 'TS', isDefault: true });
		const chosen = await resolvePublishTarget(db, projectId);
		expect(chosen).toEqual({ adapterId: 'thunderstore', label: 'TS' });
	});

	it('the publish STEP prompt names the chosen adapter when a target is set', async () => {
		const withTarget = buildReleaseSteps({
			version: 'v0.4',
			cwd: projectDir,
			model: { provider: 'anthropic', model_id: 'claude' } as never,
			publishTarget: { adapterId: 'thunderstore', label: 'Thunderstore' }
		});
		const publishStep = withTarget.find((s) => s.id === 'publish')!;
		expect(publishStep.prompt).toMatch(/Thunderstore/);
		expect(publishStep.prompt).toMatch(/DRY-RUN first/);

		const generic = buildReleaseSteps({
			version: 'v0.4',
			cwd: projectDir,
			model: { provider: 'anthropic', model_id: 'claude' } as never
		});
		expect(generic.find((s) => s.id === 'publish')!.prompt).not.toMatch(/Thunderstore/);
	});
});
