import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	createProject,
	getProject,
	listProjects,
	updateProject,
	updateProjectPlan,
	deleteProject,
	createRelease,
	getRelease,
	listReleases,
	updateRelease,
	deleteRelease,
	createPhase,
	getPhase,
	listPhases,
	updatePhase,
	deletePhase,
	createFeature,
	getFeature,
	listFeatures,
	updateFeature,
	deleteFeature,
	createSprint,
	getSprint,
	listSprints,
	updateSprint,
	deleteSprint,
	parseGameVerifyConfig,
	type GameVerifyConfig
} from './repo';

// The ROUNDS reference game-verify config (GAME-VERIFY-SPEC §"ROUNDS reference config",
// all values proven live this session). Used to assert a full descriptor round-trips
// through the FLEXIBLE option<object> column intact (m0068) and that the validator accepts it.
const ROUNDS_GAME_VERIFY: GameVerifyConfig = {
	launch_command: 'steam://rungameid/1557740',
	process_name: 'ROUNDS.exe',
	log_path: 'E:\\SteamLibrary\\steamapps\\common\\ROUNDS\\BepInEx\\LogOutput.log',
	ready_pattern: 'Chainloader startup complete',
	deploy: [
		{
			source: '**/bin/**/UnboundLib.dll',
			target: 'E:\\SteamLibrary\\steamapps\\common\\ROUNDS\\BepInEx\\plugins\\unbound\\'
		}
	],
	success_patterns: ['Loading \\[Rounds Unbound', 'loaded\\.'],
	error_patterns: ['MissingMethodException', 'AmbiguousMatch', 'NullReferenceException', 'Fatal'],
	timeout_ms: 120000,
	stack_capture_lines: 20
};

// TASK 1.2 VERIFY: plan CRUD round-trips — create→read→update→delete at EVERY
// level (project + release/phase/feature/sprint), against the throwaway test DB
// (namespace dropped per run). All values flow through $param bindings; record
// ids are validated at the D-016 chokepoint inside repo.ts. No fake runtime data
// — every assertion reads back what the live DB persisted (F-008).

let tdb: TestDb;
let db: Db;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied.length).toBeGreaterThan(0);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('project — CRUD round-trip (§4.1)', () => {
	it('create→read→update→delete a project with all defaults', async () => {
		const created = await createProject(db, {
			slug: 'demo',
			name: 'Demo Project',
			root_path: 'F:/code/demo'
		});
		expect(created.id).toBe('project:demo');
		expect(created.slug).toBe('demo');
		expect(created.name).toBe('Demo Project');
		expect(created.status).toBe('active'); // schema DEFAULT fired
		expect(created.ecosystem).toEqual([]); // DEFAULT []

		const read = await getProject(db, 'project:demo');
		expect(read?.name).toBe('Demo Project');

		const updated = await updateProject(db, 'project:demo', {
			name: 'Renamed',
			status: 'paused',
			ecosystem: ['typescript']
		});
		expect(updated?.name).toBe('Renamed');
		expect(updated?.status).toBe('paused');
		expect(updated?.ecosystem).toEqual(['typescript']);
		// MERGE preserves untouched fields.
		expect(updated?.root_path).toBe('F:/code/demo');

		const list = await listProjects(db);
		expect(list.some((p) => p.id === 'project:demo')).toBe(true);

		const gone = await deleteProject(db, 'project:demo');
		expect(gone).toBe(true);
		expect(await getProject(db, 'project:demo')).toBeNull();
	});

	it('omits absent optional fields (no explicit NULL into option<> — §6.1)', async () => {
		const p = await createProject(db, {
			slug: 'minimal',
			name: 'Minimal',
			root_path: 'F:/code/minimal'
		});
		expect(p.build_tool).toBeUndefined();
		expect(p.repo_url).toBeUndefined();
		await deleteProject(db, 'project:minimal');
	});

	it('updates the embedded plan v3 object (purpose/vision/role/DoD)', async () => {
		await createProject(db, { slug: 'planned', name: 'Planned', root_path: 'F:/code/planned' });
		const withPlan = await updateProjectPlan(db, 'project:planned', {
			purpose: 'Ship the thing',
			long_term_vision: 'Own the niche',
			role: 'platform',
			definition_of_done: 'All green'
		});
		expect(withPlan?.plan?.purpose).toBe('Ship the thing');
		expect(withPlan?.plan?.long_term_vision).toBe('Own the niche');
		expect(withPlan?.plan?.role).toBe('platform');
		expect(withPlan?.plan?.definition_of_done).toBe('All green');

		// Partial plan update merges into the existing plan object.
		const repurposed = await updateProjectPlan(db, 'project:planned', {
			purpose: 'Ship faster'
		});
		expect(repurposed?.plan?.purpose).toBe('Ship faster');
		expect(repurposed?.plan?.role).toBe('platform'); // preserved
		await deleteProject(db, 'project:planned');
	});
});

describe('project.game_verify — FLEXIBLE config round-trip + validator (m0068, GAME-VERIFY)', () => {
	it('round-trips a SET game_verify descriptor through the FLEXIBLE column intact', async () => {
		// Assert on a row where the field IS set (F-013 — a NONE-everywhere row would hide the gap).
		const created = await createProject(db, {
			slug: 'gvset',
			name: 'GV Set',
			root_path: 'F:/code/gvset',
			game_verify: ROUNDS_GAME_VERIFY
		});
		expect(created.game_verify).toEqual(ROUNDS_GAME_VERIFY);

		// Re-read from the DB: FLEXIBLE preserved every nested sub-key (without FLEXIBLE the
		// SCHEMAFULL object would have stored {} and the deploy/patterns would be gone, m0068).
		const read = await getProject(db, 'project:gvset');
		expect(read?.game_verify).toEqual(ROUNDS_GAME_VERIFY);
		expect(read?.game_verify?.deploy?.[0]?.target).toContain('plugins');
		expect(read?.game_verify?.error_patterns).toHaveLength(4);
		// The persisted descriptor is a plain POJO that the validator accepts.
		expect(parseGameVerifyConfig(read?.game_verify)).toEqual(ROUNDS_GAME_VERIFY);

		await deleteProject(db, 'project:gvset');
	});

	it('omits game_verify when absent (option<object> stays NONE — §6.1 / F-008)', async () => {
		const created = await createProject(db, {
			slug: 'gvabsent',
			name: 'GV Absent',
			root_path: 'F:/code/gvabsent'
		});
		expect('game_verify' in created).toBe(false);
		const read = await getProject(db, 'project:gvabsent');
		expect(read?.game_verify).toBeUndefined();
		await deleteProject(db, 'project:gvabsent');
	});

	it('parseGameVerifyConfig accepts the ROUNDS reference config', () => {
		expect(parseGameVerifyConfig(ROUNDS_GAME_VERIFY)).toEqual(ROUNDS_GAME_VERIFY);
	});

	it('parseGameVerifyConfig accepts the minimal required-only config + an exe-object launch', () => {
		expect(
			parseGameVerifyConfig({
				launch_command: { exe: 'C:\\Games\\ROUNDS\\ROUNDS.exe', args: ['--no-vr'] },
				process_name: 'ROUNDS.exe',
				log_path: 'C:\\Games\\ROUNDS\\BepInEx\\LogOutput.log',
				ready_pattern: 'Chainloader startup complete'
			})
		).toEqual({
			launch_command: { exe: 'C:\\Games\\ROUNDS\\ROUNDS.exe', args: ['--no-vr'] },
			process_name: 'ROUNDS.exe',
			log_path: 'C:\\Games\\ROUNDS\\BepInEx\\LogOutput.log',
			ready_pattern: 'Chainloader startup complete'
		});
	});

	it('parseGameVerifyConfig rejects a missing-required-field object (disabled, not thrown)', () => {
		// Drop process_name from the otherwise-valid ROUNDS config.
		const missing: Partial<GameVerifyConfig> = { ...ROUNDS_GAME_VERIFY };
		delete missing.process_name;
		expect(parseGameVerifyConfig(missing)).toBeNull();
	});

	it('parseGameVerifyConfig returns null on the shadow paths (nil / empty / wrong-typed)', () => {
		expect(parseGameVerifyConfig(null)).toBeNull(); // nil
		expect(parseGameVerifyConfig(undefined)).toBeNull(); // nil
		expect(parseGameVerifyConfig({})).toBeNull(); // empty object — no required fields
		expect(parseGameVerifyConfig([])).toBeNull(); // array, not an object
		expect(parseGameVerifyConfig('steam://x')).toBeNull(); // primitive, not an object
		// empty-string required field
		expect(
			parseGameVerifyConfig({ ...ROUNDS_GAME_VERIFY, process_name: '' })
		).toBeNull();
		// launch_command an empty-args-less malformed object (no exe)
		expect(
			parseGameVerifyConfig({ ...ROUNDS_GAME_VERIFY, launch_command: { args: ['x'] } })
		).toBeNull();
		// deploy entry missing target
		expect(
			parseGameVerifyConfig({ ...ROUNDS_GAME_VERIFY, deploy: [{ source: 'a.dll' }] })
		).toBeNull();
		// error_patterns not a string array
		expect(
			parseGameVerifyConfig({ ...ROUNDS_GAME_VERIFY, error_patterns: [1, 2] })
		).toBeNull();
		// non-positive timeout_ms
		expect(parseGameVerifyConfig({ ...ROUNDS_GAME_VERIFY, timeout_ms: 0 })).toBeNull();
	});
});

describe('release / phase / feature / sprint — CRUD round-trip (§4.1)', () => {
	let projectId: string;

	beforeAll(async () => {
		const p = await createProject(db, {
			slug: 'parent',
			name: 'Parent',
			root_path: 'F:/code/parent'
		});
		projectId = p.id;
	});

	afterAll(async () => {
		await deleteProject(db, 'project:parent');
	});

	it('release: create→read→update→delete', async () => {
		const r = await createRelease(db, { project: projectId, version: 'v0.1', title: 'First' });
		expect(r.project).toBe(projectId);
		expect(r.version).toBe('v0.1');
		expect(r.status).toBe('planned'); // DEFAULT

		expect((await getRelease(db, r.id))?.version).toBe('v0.1');

		const up = await updateRelease(db, r.id, { status: 'active', title: 'First Cut' });
		expect(up?.status).toBe('active');
		expect(up?.title).toBe('First Cut');
		expect(up?.version).toBe('v0.1'); // preserved

		const list = await listReleases(db, projectId);
		expect(list.some((x) => x.id === r.id)).toBe(true);

		expect(await deleteRelease(db, r.id)).toBe(true);
		expect(await getRelease(db, r.id)).toBeNull();
	});

	it('phase: create→read→update→delete (incl. release link + order)', async () => {
		const rel = await createRelease(db, { project: projectId, version: 'v0.2' });
		const ph = await createPhase(db, {
			project: projectId,
			release: rel.id,
			name: 'Foundations',
			order: 1
		});
		expect(ph.name).toBe('Foundations');
		expect(ph.order).toBe(1);
		expect(ph.release).toBe(rel.id);
		expect(ph.status).toBe('todo'); // DEFAULT

		expect((await getPhase(db, ph.id))?.name).toBe('Foundations');

		const up = await updatePhase(db, ph.id, { status: 'in_progress', order: 2 });
		expect(up?.status).toBe('in_progress');
		expect(up?.order).toBe(2);
		expect(up?.name).toBe('Foundations');

		const list = await listPhases(db, projectId);
		expect(list.some((x) => x.id === ph.id)).toBe(true);

		expect(await deletePhase(db, ph.id)).toBe(true);
		expect(await getPhase(db, ph.id)).toBeNull();
		await deleteRelease(db, rel.id);
	});

	it('feature: create→read→update→delete', async () => {
		const f = await createFeature(db, {
			project: projectId,
			title: 'Login',
			detail: 'OAuth + email'
		});
		expect(f.title).toBe('Login');
		expect(f.detail).toBe('OAuth + email');
		expect(f.status).toBe('planned'); // DEFAULT

		expect((await getFeature(db, f.id))?.title).toBe('Login');

		const up = await updateFeature(db, f.id, { status: 'done' });
		expect(up?.status).toBe('done');
		expect(up?.title).toBe('Login');

		const list = await listFeatures(db, projectId);
		expect(list.some((x) => x.id === f.id)).toBe(true);

		expect(await deleteFeature(db, f.id)).toBe(true);
		expect(await getFeature(db, f.id)).toBeNull();
	});

	it('sprint: create→read→update→delete', async () => {
		const s = await createSprint(db, { project: projectId, name: 'Sprint 1' });
		expect(s.name).toBe('Sprint 1');

		expect((await getSprint(db, s.id))?.name).toBe('Sprint 1');

		const up = await updateSprint(db, s.id, { name: 'Sprint One' });
		expect(up?.name).toBe('Sprint One');

		const list = await listSprints(db, projectId);
		expect(list.some((x) => x.id === s.id)).toBe(true);

		expect(await deleteSprint(db, s.id)).toBe(true);
		expect(await getSprint(db, s.id)).toBeNull();
	});
});

describe('guards & edge cases', () => {
	it('getProject on a missing id returns null (not throw)', async () => {
		expect(await getProject(db, 'project:nope')).toBeNull();
	});

	it('deleteProject on a missing id returns false', async () => {
		expect(await deleteProject(db, 'project:nope')).toBe(false);
	});

	it('rejects a malformed record id at the D-016 boundary', async () => {
		await expect(getProject(db, 'project:Bad-Id; DROP')).rejects.toThrow();
	});

	it('rejects a bad project slug at create (D-016 record-id guard)', async () => {
		await expect(
			createProject(db, { slug: 'Bad Slug', name: 'x', root_path: 'F:/code/x' })
		).rejects.toThrow();
	});
});
