import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { countByStatus } from './workqueue';
import {
	runGameVerifyStep,
	gameVerifyInFlightCount,
	type GameVerifyRunner
} from './game-verify-step';
import type { GameVerifyVerdict } from './game-verify';

// GAME-VERIFY orchestrator-step VERIFY (docs/GAME-VERIFY-SPEC.md §"Orchestrator integration").
//
// The step is INFRASTRUCTURE: GATE (opt-in) → SERIALIZE (per game) → RUN (injected fake — NO real
// game, F-010/F-014) → PERSIST (agent_event) → FEED-BACK (follow_up on non-pass). Every assertion is
// read back from a real throwaway SurrealDB (F-008; a mock RUNNER in a TEST is allowed). The four
// load-bearing proofs the wave requires + the serialization rail + the fault-absorption rail.

let tdb: TestDb;
let db: Db;
/** A project WITHOUT a game_verify block (the gated-off / non-game case). */
let plainProjectId: string;
/** A project WITH a valid game_verify block (the harness is on). */
let gameProjectId: string;

const GAME_CONFIG = {
	launch_command: 'steam://rungameid/1557740',
	process_name: 'FakeGame.exe',
	log_path: 'C:/fake/BepInEx/LogOutput.log',
	ready_pattern: 'Chainloader startup complete',
	success_patterns: ['Rounds Unbound'],
	error_patterns: ['NullReferenceException']
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
	const plain = await createProject(db, {
		slug: 'gvs_plain',
		name: 'gvs-plain (no game_verify)',
		root_path: 'F:/code/plain'
	});
	plainProjectId = plain.id;
	const game = await createProject(db, {
		slug: 'gvs_game',
		name: 'gvs-game (ROUNDS-style)',
		root_path: 'F:/code/game',
		game_verify: GAME_CONFIG
	});
	gameProjectId = game.id;
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** A fake game-verify runner: records every call, returns a scripted verdict. NO real game. */
function fakeRunner(
	verdict: GameVerifyVerdict
): GameVerifyRunner & { calls: { processName: string; cwd: string }[] } {
	const calls: { processName: string; cwd: string }[] = [];
	const fn = (async (cfg, ctx) => {
		calls.push({ processName: cfg.process_name, cwd: ctx.cwd });
		return verdict;
	}) as GameVerifyRunner & { calls: typeof calls };
	fn.calls = calls;
	return fn;
}

const PASS: GameVerifyVerdict = {
	outcome: 'pass',
	ready: true,
	loaded: true,
	errorCount: 0,
	byPattern: { 'Rounds Unbound': 1 },
	stackTraces: [],
	logTail: 'Chainloader startup complete\nRounds Unbound loaded.'
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

async function freshTask(projectId: string, title = 'build the mod'): Promise<string> {
	const t = await createTask(db, { project: projectId, title, description: 'game-verify step test', status: 'ready' });
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

async function gameVerifyEvents(
	sessionId: string
): Promise<Array<{ type: string; detail: Record<string, unknown> }>> {
	const [rows] = await db.query<[Array<{ type: string; detail: Record<string, unknown> }>]>(
		`SELECT type, detail FROM agent_event WHERE detail.reason = 'game-verify' AND session = $sid;`,
		{ sid: new StringRecordId(sessionId) }
	);
	return rows ?? [];
}

describe('GAME-VERIFY orchestrator step — gate / persist / feed-back / serialize', () => {
	it('(a) GATE: a project with NO game_verify block ⇒ the runner is NEVER invoked', async () => {
		const taskId = await freshTask(plainProjectId);
		const sessionId = await makeSession(plainProjectId, taskId);
		const runner = fakeRunner(PASS);

		const res = await runGameVerifyStep(
			db,
			{ projectId: plainProjectId, taskId, sessionId, cwd: 'F:/code/plain', rawConfig: undefined },
			{ runner }
		);

		expect(res.ran).toBe(false); // gated off — capability disabled
		expect(runner.calls.length).toBe(0); // the fake runner was untouched
		expect(res.verdict).toBeUndefined();
		// No game-verify event persisted for a non-game project.
		expect((await gameVerifyEvents(sessionId)).length).toBe(0);
	});

	it('(a2) GATE: a MALFORMED game_verify block ⇒ gated off (runner not invoked), no throw', async () => {
		const taskId = await freshTask(gameProjectId);
		const sessionId = await makeSession(gameProjectId, taskId);
		const runner = fakeRunner(PASS);
		// Missing required fields (process_name/log_path/ready_pattern) ⇒ parse returns null.
		const res = await runGameVerifyStep(
			db,
			{ projectId: gameProjectId, taskId, sessionId, cwd: 'F:/code/game', rawConfig: { launch_command: 'x' } },
			{ runner }
		);
		expect(res.ran).toBe(false);
		expect(runner.calls.length).toBe(0);
	});

	it('(b) PASS verdict: runner invoked, verdict persisted (completion), NO follow-up enqueued', async () => {
		await db.query(`DELETE work_item;`);
		const taskId = await freshTask(gameProjectId);
		const sessionId = await makeSession(gameProjectId, taskId);
		const runner = fakeRunner(PASS);

		const res = await runGameVerifyStep(
			db,
			{ projectId: gameProjectId, taskId, sessionId, cwd: 'F:/code/game', rawConfig: GAME_CONFIG },
			{ runner }
		);

		expect(res.ran).toBe(true);
		// (d) INJECTABLE — the injected fake ran (no real process), with the configured game + cwd.
		expect(runner.calls).toEqual([{ processName: 'FakeGame.exe', cwd: 'F:/code/game' }]);
		expect(res.verdict?.outcome).toBe('pass');
		expect(res.feedbackWorkId).toBeUndefined(); // a pass needs no fix follow-up

		// Verdict persisted where outcomes live — a completion event, honest detail.
		const evs = await gameVerifyEvents(sessionId);
		expect(evs.length).toBe(1);
		expect(evs[0].type).toBe('completion');
		expect(evs[0].detail.outcome).toBe('pass');
		expect(evs[0].detail.ok).toBe(true);

		// NO game-verify follow_up work_item.
		const [followUps] = await db.query<[Array<{ payload: Record<string, unknown> }>]>(
			`SELECT payload FROM work_item WHERE work_type = 'follow_up';`
		);
		expect(followUps.length).toBe(0);
	});

	it('(c) ERRORS verdict: NOT a hard fail — verdict persisted + a follow_up carries the SCREENED fix signal', async () => {
		await db.query(`DELETE work_item;`);
		const taskId = await freshTask(gameProjectId);
		const sessionId = await makeSession(gameProjectId, taskId);
		const runner = fakeRunner(ERRORS);

		const res = await runGameVerifyStep(
			db,
			{ projectId: gameProjectId, taskId, sessionId, cwd: 'F:/code/game', rawConfig: GAME_CONFIG },
			{ runner }
		);

		expect(res.ran).toBe(true);
		expect(res.verdict?.outcome).toBe('errors');
		// Persisted honestly — a non-pass is recorded, ok:false, but it is NOT an `error`-type hard fail.
		const evs = await gameVerifyEvents(sessionId);
		expect(evs.length).toBe(1);
		expect(evs[0].type).toBe('completion');
		expect(evs[0].detail.outcome).toBe('errors');
		expect(evs[0].detail.ok).toBe(false);
		expect(evs[0].detail.error_count).toBe(2);

		// FEED BACK — a follow_up work_item carries the screened stack traces + log tail (the next pass's input).
		expect(res.feedbackWorkId).toBeDefined();
		const [followUps] = await db.query<[Array<{ payload: Record<string, unknown> }>]>(
			`SELECT payload FROM work_item WHERE work_type = 'follow_up';`
		);
		expect(followUps.length).toBe(1);
		const payload = followUps[0].payload;
		expect(payload.parentTaskId).toBe(taskId);
		expect(payload.game_verify_outcome).toBe('errors');
		expect(Array.isArray(payload.stack_traces)).toBe(true);
		expect((payload.stack_traces as string[]).length).toBe(2);
		expect(payload.log_tail).toContain('Chainloader startup complete');
	});

	it('(c2) FEED-BACK dedup: a second errors verdict for the SAME task does not enqueue a duplicate follow-up', async () => {
		await db.query(`DELETE work_item;`);
		const taskId = await freshTask(gameProjectId);
		const sessionId = await makeSession(gameProjectId, taskId);
		const runner = fakeRunner(ERRORS);
		const input = { projectId: gameProjectId, taskId, sessionId, cwd: 'F:/code/game', rawConfig: GAME_CONFIG };

		const first = await runGameVerifyStep(db, input, { runner });
		const second = await runGameVerifyStep(db, input, { runner });

		expect(first.feedbackWorkId).toBeDefined();
		expect(second.feedbackWorkId).toBeUndefined(); // deduped (one open game-verify follow-up per task)
		expect(await countByStatus(db, 'pending')).toBe(1);
	});

	it('(fault) a persistence/DB fault is ABSORBED — the step never throws (F-014/F-048)', async () => {
		const taskId = await freshTask(gameProjectId);
		// An INVALID session id makes writeAgentEvent's D-016 link guard throw → the step must
		// catch it and return honestly, never propagate (a game-verify fault can't crash the drain).
		const runner = fakeRunner(ERRORS);
		const res = await runGameVerifyStep(
			db,
			{ projectId: gameProjectId, taskId, sessionId: 'not a record id', cwd: 'F:/code/game', rawConfig: GAME_CONFIG },
			{ runner }
		);
		expect(res.ran).toBe(true); // the runner ran
		expect(res.verdict?.outcome).toBe('errors'); // the verdict is honest
		expect(res.feedbackWorkId).toBeUndefined(); // persistence failed → no follow-up id
	});

	it('(serialize) two verifies for the SAME game never run concurrently (per-game lock)', async () => {
		await db.query(`DELETE work_item;`);
		let live = 0;
		let peak = 0;
		// A runner that holds "in flight" briefly so an overlap would be observable as peak>1.
		const overlapRunner: GameVerifyRunner = async (cfg) => {
			live++;
			peak = Math.max(peak, live);
			await new Promise((r) => setTimeout(r, 25));
			live--;
			return { ...PASS, byPattern: { [cfg.process_name]: 1 } };
		};
		const taskA = await freshTask(gameProjectId, 'game A');
		const taskB = await freshTask(gameProjectId, 'game B');
		const sa = await makeSession(gameProjectId, taskA);
		const sb = await makeSession(gameProjectId, taskB);

		await Promise.all([
			runGameVerifyStep(db, { projectId: gameProjectId, taskId: taskA, sessionId: sa, cwd: 'F:/code/game', rawConfig: GAME_CONFIG }, { runner: overlapRunner }),
			runGameVerifyStep(db, { projectId: gameProjectId, taskId: taskB, sessionId: sb, cwd: 'F:/code/game', rawConfig: GAME_CONFIG }, { runner: overlapRunner })
		]);

		expect(peak).toBe(1); // the per-game lock serialized them — never two launches at once
		expect(gameVerifyInFlightCount()).toBe(0); // the lock map drained (no leak, F-014)
	});
});
