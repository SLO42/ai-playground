import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { writeAgentEvent } from '../analytics/events';
import { runGameVerifyStep, type GameVerifyRunner } from './game-verify-step';
import type { GameVerifyVerdict } from './game-verify';
import { listGameVerifyVerdicts } from './game-verify-read';

// GAME-VERIFY read-side VERIFY (GV-4 — docs/GAME-VERIFY-SPEC.md §"Orchestrator integration"):
// the command-center surface reads what GV-3 persisted. Every assertion reads back from a real
// throwaway SurrealDB (F-008). The verdicts are persisted via the REAL step (with a fake RUNNER —
// NO real game, F-010/F-014), so the read path is tested against the production-shape rows the
// writer actually emits — plus the shadow paths (never-run, malformed/legacy detail, ordering, limit).

let tdb: TestDb;
let db: Db;
let gameProjectId: string;
let plainProjectId: string;

const GAME_CONFIG = {
	launch_command: 'steam://rungameid/1557740',
	process_name: 'GVRead.exe',
	log_path: 'C:/fake/BepInEx/LogOutput.log',
	ready_pattern: 'Chainloader startup complete',
	success_patterns: ['Rounds Unbound'],
	error_patterns: ['NullReferenceException']
};

const PASS: GameVerifyVerdict = {
	outcome: 'pass',
	ready: true,
	loaded: true,
	errorCount: 0,
	byPattern: { 'Rounds Unbound': 1 },
	stackTraces: [],
	logTail: 'Chainloader startup complete\nRounds Unbound loaded.',
	deployed: [{ source: 'UnboundLib.dll', target: 'C:/fake/BepInEx/plugins/unbound/' }]
};

const ERRORS: GameVerifyVerdict = {
	outcome: 'errors',
	ready: true,
	loaded: true,
	errorCount: 2,
	byPattern: { NullReferenceException: 2 },
	stackTraces: ['NullReferenceException at GM_ArmsRace.Start', 'NullReferenceException at Player.Update'],
	logTail: 'Chainloader startup complete\n...2x NRE...'
};

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
	const game = await createProject(db, {
		slug: 'gvr_game',
		name: 'gvr-game',
		root_path: 'F:/code/game',
		game_verify: GAME_CONFIG
	});
	gameProjectId = game.id;
	const plain = await createProject(db, {
		slug: 'gvr_plain',
		name: 'gvr-plain',
		root_path: 'F:/code/plain'
	});
	plainProjectId = plain.id;
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** A fake runner: returns a scripted verdict, NO real game (F-010/F-014). */
function fakeRunner(verdict: GameVerifyVerdict): GameVerifyRunner {
	return (async () => verdict) as GameVerifyRunner;
}

async function freshTask(projectId: string, title = 'build the mod'): Promise<string> {
	const t = await createTask(db, {
		project: projectId,
		title,
		description: 'gv read test',
		status: 'ready'
	});
	return t.id;
}

async function makeSession(projectId: string, taskId: string): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
		   project: $p, task: $t, kind: "task", runtime: "claude-code",
		   model: { provider: "claude", model_id: "claude-opus-4-8", tier: "opus" }
		 } RETURN AFTER;`,
		{ p: new StringRecordId(projectId), t: new StringRecordId(taskId) }
	);
	return String(rows[0].id);
}

/** Persist a verdict the way GV-3 does (the real step + a fake runner). Returns the task id. */
async function persistVerdict(projectId: string, verdict: GameVerifyVerdict): Promise<string> {
	const taskId = await freshTask(projectId);
	const sessionId = await makeSession(projectId, taskId);
	const res = await runGameVerifyStep(
		db,
		{ projectId, taskId, sessionId, cwd: 'F:/code/game', rawConfig: GAME_CONFIG },
		{ runner: fakeRunner(verdict) }
	);
	expect(res.ran).toBe(true);
	return taskId;
}

describe('GAME-VERIFY read-side — listGameVerifyVerdicts', () => {
	it('(empty) a project that NEVER ran game-verify returns [] (honest "not yet run")', async () => {
		const verdicts = await listGameVerifyVerdicts(db, plainProjectId);
		expect(verdicts).toEqual([]);
	});

	it('(pass) reads back a persisted PASS verdict, fully normalized + ISO `at` (F-013)', async () => {
		const taskId = await persistVerdict(gameProjectId, PASS);
		const verdicts = await listGameVerifyVerdicts(db, gameProjectId);
		expect(verdicts.length).toBeGreaterThanOrEqual(1);
		const v = verdicts[0];
		expect(v.outcome).toBe('pass');
		expect(v.ready).toBe(true);
		expect(v.loaded).toBe(true);
		expect(v.errorCount).toBe(0);
		expect(v.byPattern).toEqual({ 'Rounds Unbound': 1 });
		expect(v.stackTraces).toEqual([]);
		expect(v.logTail).toContain('Chainloader startup complete');
		expect(v.deployed).toEqual([
			{ source: 'UnboundLib.dll', target: 'C:/fake/BepInEx/plugins/unbound/' }
		]);
		expect(v.taskId).toBe(taskId);
		// F-013: `at` is a clean ISO string, never a raw SDK datetime.
		expect(v.at).not.toBeNull();
		expect(() => new Date(v.at as string).toISOString()).not.toThrow();
		expect(v.at).toBe(new Date(v.at as string).toISOString());
	});

	it('(errors) reads back an ERRORS verdict with screened stack traces + error count', async () => {
		await persistVerdict(gameProjectId, ERRORS);
		const verdicts = await listGameVerifyVerdicts(db, gameProjectId);
		const v = verdicts[0]; // newest first
		expect(v.outcome).toBe('errors');
		expect(v.errorCount).toBe(2);
		expect(v.byPattern).toEqual({ NullReferenceException: 2 });
		expect(v.stackTraces.length).toBe(2);
		// errors is NOT a pass (F-008).
		expect(v.outcome).not.toBe('pass');
	});

	it('(ordering+limit) newest first, bounded by the limit', async () => {
		// A fresh isolated project so the count is deterministic.
		const proj = await createProject(db, {
			slug: 'gvr_order',
			name: 'gvr-order',
			root_path: 'F:/code/order',
			game_verify: GAME_CONFIG
		});
		await persistVerdict(proj.id, PASS);
		await persistVerdict(proj.id, ERRORS);
		await persistVerdict(proj.id, PASS);
		const limited = await listGameVerifyVerdicts(db, proj.id, 2);
		expect(limited.length).toBe(2);
		// Descending by `at`: the two NEWEST. The last persisted was PASS.
		expect(limited[0].outcome).toBe('pass');
		const all = await listGameVerifyVerdicts(db, proj.id, 50);
		expect(all.length).toBe(3);
		// Sorted newest→oldest.
		const ats = all.map((v) => v.at ?? '');
		expect([...ats].sort((a, b) => b.localeCompare(a))).toEqual(ats);
	});

	it('(shadow: malformed) a legacy/malformed game-verify event normalizes to honest unknown, never throws', async () => {
		const proj = await createProject(db, {
			slug: 'gvr_malformed',
			name: 'gvr-malformed',
			root_path: 'F:/code/malformed'
		});
		// A row with reason='game-verify' but NO outcome / junk fields (a legacy/partial write).
		await writeAgentEvent(db, {
			type: 'completion',
			project: proj.id,
			detail: {
				reason: 'game-verify',
				// no outcome, no booleans, junk counts/arrays
				error_count: -5,
				by_pattern: 'not-an-object',
				stack_traces: 'not-an-array',
				deployed: [{ source: 'ok' /* no target */ }, 'junk'],
				log_tail: 42
			}
		});
		const verdicts = await listGameVerifyVerdicts(db, proj.id);
		expect(verdicts.length).toBe(1);
		const v = verdicts[0];
		// F-008: an absent outcome reads as 'unknown', never a fabricated pass.
		expect(v.outcome).toBe('unknown');
		expect(v.ready).toBe(false);
		expect(v.loaded).toBe(false);
		expect(v.errorCount).toBe(0); // negative junk → honest 0
		expect(v.byPattern).toEqual({});
		expect(v.stackTraces).toEqual([]);
		expect(v.deployed).toEqual([]); // both malformed entries dropped
		expect(v.logTail).toBe(''); // non-string → ''
		expect(v.note).toBeNull();
	});

	it('(shadow: malformed projectId) a bad id throws at the D-016 boundary (not a silent empty)', async () => {
		await expect(listGameVerifyVerdicts(db, 'not a valid id')).rejects.toThrow();
	});
});
