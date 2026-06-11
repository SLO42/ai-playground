import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import {
	activateGauntletFixture,
	injectSentinel,
	newSentinelUlid,
	runSentinelSweep,
	sentinelMarker,
	sentinelSweep,
	REINTERVIEW_PROPOSAL_TYPE,
	SENTINEL_SWEEP_TYPE
} from './activation';
import {
	createGauntletFixture,
	createGauntletKey,
	createInterviewRun,
	createRole,
	createRoleVersion,
	finalizeInterviewRun,
	getInterviewRun,
	listRoleEvents,
	readGauntletKeyForScoring,
	WorkforceInputError
} from './repo';

// TASK 16.6 VERIFY — fixture ACTIVATION (server-side sentinel injection AFTER agent
// authoring, atomic content re-address + key re-bind, §3.7 stale-marking + the ONE
// batched re-interview proposal) and the §4.2 SENTINEL SWEEP red-green (memory /
// pm_memory / non-interview transcripts; interview transcripts legitimately exempt).
// All against a REAL throwaway SurrealDB.

let tdb: TestDb;
let db: Db;
let roleId: string;

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
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
	const role = await createRole(db, {
		slug: 'activation-host',
		name: 'Activation Host',
		purpose: 'fixture activation + sweep test bed'
	});
	roleId = role.id;
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

// ── ULIDs + injection (pure) ─────────────────────────────────────────────────────

describe('newSentinelUlid + injectSentinel', () => {
	it('generates 26-char Crockford ULIDs, unique across calls', () => {
		const a = newSentinelUlid();
		const b = newSentinelUlid();
		expect(a).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
		expect(b).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
		expect(a).not.toBe(b);
	});

	it('appends the marker to non-JSON files; .json files are exempt; idempotent', () => {
		const ulid = newSentinelUlid();
		const work = { 'a.ts': 'const x = 1;\n', 'report.json': '[]' };
		const once = injectSentinel(work, ulid);
		expect(once['a.ts']).toContain(sentinelMarker(ulid));
		expect(once['report.json']).toBe('[]'); // still valid JSON
		// Idempotent: re-injection over already-injected work changes nothing.
		expect(injectSentinel(once, ulid)).toEqual(once);
	});

	it('refuses non-string work content (named)', () => {
		expect(() => injectSentinel({ 'a.ts': 42 }, newSentinelUlid())).toThrow(WorkforceInputError);
	});
});

// ── Activation ───────────────────────────────────────────────────────────────────

describe('activateGauntletFixture — atomic injection + re-address + key re-bind (§3.7/§4.2)', () => {
	it('proposed → active: sentinel embedded, content_sha recomputed, key re-bound, event appended', async () => {
		const sentinel = newSentinelUlid();
		const fixture = await createGauntletFixture(db, {
			role: roleId,
			slug: 'act-basic',
			kind: 'planted_defect',
			work: { 'a.ts': 'process.kill(pid, 0);\n' },
			sentinel
		});
		// The key is authored against the PRE-injection work (the real ceremony order).
		await createGauntletKey(db, {
			fixture: fixture.id,
			plants: [{ id: 'p1', detection: { file: 'a.ts', evidence_pattern: 'process\\.kill' } }]
		});

		const result = await activateGauntletFixture(db, fixture.id);
		expect(result.activated).toBe(true);
		expect(result.fixture.status).toBe('active');
		expect(String(result.fixture.work['a.ts'])).toContain(sentinel);
		expect(result.fixture.content_sha).not.toBe(fixture.content_sha);

		// The key is RE-BOUND to the post-injection content address (same transaction).
		const key = await readGauntletKeyForScoring(db, fixture.id);
		expect(key?.content_sha).toBe(result.fixture.content_sha);

		const events = await listRoleEvents(db, roleId);
		expect(events.some((e) => e.op === 'fixture_activated')).toBe(true);
	});

	it('re-activation ABSORBS (idempotent — no double sentinel, no second event)', async () => {
		const fixture = await createGauntletFixture(db, {
			role: roleId,
			slug: 'act-idem',
			kind: 'clean_control',
			work: { 'b.ts': 'clean code\n' },
			sentinel: newSentinelUlid()
		});
		const first = await activateGauntletFixture(db, fixture.id);
		const eventsBefore = (await listRoleEvents(db, roleId)).filter((e) => e.op === 'fixture_activated').length;
		const second = await activateGauntletFixture(db, fixture.id);
		expect(second.activated).toBe(false);
		expect(second.fixture.content_sha).toBe(first.fixture.content_sha);
		const eventsAfter = (await listRoleEvents(db, roleId)).filter((e) => e.op === 'fixture_activated').length;
		expect(eventsAfter).toBe(eventsBefore);
	});

	it('a retired fixture is never re-activated (named refusal)', async () => {
		const fixture = await createGauntletFixture(db, {
			role: roleId,
			slug: 'act-retired',
			kind: 'planted_defect',
			work: { 'c.ts': 'x\n' },
			sentinel: newSentinelUlid()
		});
		await db.query(`UPDATE $fid SET status = 'retired';`, { fid: rid(fixture.id) });
		await expect(activateGauntletFixture(db, fixture.id)).rejects.toThrow(/retired/);
	});

	it('§3.7: activation marks passing runs stale + queues ONE batched re-interview; repeats coalesce', async () => {
		// A separate role so the stale-marking scope is isolated.
		const role = await createRole(db, { slug: 'stale-host', name: 'Stale Host', purpose: 'stale test' });
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'review things',
			default_tier: 'sonnet'
		});
		const run = await createInterviewRun(db, {
			role_version: version.id,
			tier: 'sonnet',
			provider: 'claude',
			model_id: 'claude-sonnet-x',
			fixture_set_sha: 'shaA',
			planted_total: 1
		});
		await finalizeInterviewRun(db, run.id, { status: 'passed', planted_found: 1 });

		const fx1 = await createGauntletFixture(db, {
			role: role.id,
			slug: 'stale-fx1',
			kind: 'planted_defect',
			work: { 'd.ts': 'defect\n' },
			sentinel: newSentinelUlid()
		});
		const r1 = await activateGauntletFixture(db, fx1.id);
		expect(r1.staleMarked).toBe(1);
		expect(r1.reinterviewQueued).toBe(true);
		expect((await getInterviewRun(db, run.id))?.stale).toBe(true);

		// Second activation while the proposal is open: stale already marked (0 fresh),
		// and the work_item COALESCES — still exactly ONE pending proposal (§3.7).
		const fx2 = await createGauntletFixture(db, {
			role: role.id,
			slug: 'stale-fx2',
			kind: 'planted_defect',
			work: { 'e.ts': 'defect2\n' },
			sentinel: newSentinelUlid()
		});
		const r2 = await activateGauntletFixture(db, fx2.id);
		expect(r2.staleMarked).toBe(0);
		expect(r2.reinterviewQueued).toBe(false);
		const [items] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM work_item
			  WHERE work_type = $wt AND status = 'pending' AND dedup_scope = $scope GROUP ALL;`,
			{ wt: REINTERVIEW_PROPOSAL_TYPE, scope: role.id }
		);
		expect(items[0]?.c ?? 0).toBe(1);

		// role_event audit: stale_marked appended for the affected version.
		const events = await listRoleEvents(db, role.id);
		expect(events.some((e) => e.op === 'stale_marked')).toBe(true);
	});
});

// ── Sentinel sweep (§4.2) — the CI red-green tripwire ───────────────────────────────

describe('sentinelSweep — fixture ULIDs absent from every leak surface (§4.2)', () => {
	it('GREEN: a clean DB sweeps clean (activated sentinels checked, zero hits)', async () => {
		const result = await sentinelSweep(db);
		expect(result.checked).toBeGreaterThan(0); // the activated fixtures above
		expect(result.hits).toEqual([]);
	});

	it('RED→GREEN: a leaked sentinel trips memory / pm_memory / non-interview transcript; interview transcripts are exempt', async () => {
		const sentinel = newSentinelUlid();
		const fixture = await createGauntletFixture(db, {
			role: roleId,
			slug: 'sweep-fx',
			kind: 'planted_defect',
			work: { 'f.ts': 'leaky\n' },
			sentinel
		});
		await activateGauntletFixture(db, fixture.id);

		// Plant leaks on all three surfaces + the exempt one.
		const v = new Array(1024).fill(0);
		v[0] = 1;
		await db.query(
			`CREATE memory SET content = $c, namespace = 'default', embedding = $v;`,
			{ c: `mined fixture text ${sentinel}`, v }
		);
		const project = await createProject(db, { slug: 'sweephost', name: 'S', root_path: 'F:/x' });
		await db.query(`CREATE pm_memory SET project = $p, content = $c;`, {
			p: rid(project.id),
			c: `pm noted ${sentinel}`
		});
		const [task] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT { kind: "task", model: { provider: "x", model_id: "y" }, runtime: "claude-code" } RETURN AFTER;`
		);
		await db.query(`CREATE message SET session = $s, role = 'assistant', content = $c;`, {
			s: rid(String(task[0].id)),
			c: `briefing carried ${sentinel}`
		});
		const [interview] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT { kind: "interview", model: { provider: "x", model_id: "y" }, runtime: "claude-code" } RETURN AFTER;`
		);
		await db.query(`CREATE message SET session = $s, role = 'assistant', content = $c;`, {
			s: rid(String(interview[0].id)),
			c: `the interview transcript legitimately contains ${sentinel}`
		});

		// RED: three surfaces trip; the interview transcript does NOT.
		const red = await sentinelSweep(db);
		const surfaces = red.hits.filter((h) => h.sentinel === sentinel).map((h) => h.surface).sort();
		expect(surfaces).toEqual(['memory', 'pm_memory', 'transcript']);
		const transcriptHit = red.hits.find((h) => h.sentinel === sentinel && h.surface === 'transcript');
		expect(transcriptHit?.rows).toHaveLength(1); // ONLY the task-session message

		// runSentinelSweep records the audit work_item + the operator notification
		// (no auto-burn: the fixture row is untouched).
		const recorded = await runSentinelSweep(db);
		expect(recorded.hits.length).toBeGreaterThan(0);
		const [audits] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM work_item WHERE work_type = $wt GROUP ALL;`,
			{ wt: SENTINEL_SWEEP_TYPE }
		);
		expect(audits[0]?.c ?? 0).toBeGreaterThan(0);
		const [notes] = await db.query<[Array<{ message: string }>]>(
			`SELECT message FROM notification LIMIT 50;`
		);
		expect(notes.some((n) => /sentinel LEAK/i.test(n.message))).toBe(true);
		const [fxAfter] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM $f;`, {
			f: rid(fixture.id)
		});
		expect(fxAfter[0].status).toBe('active'); // operator decides retirement — no auto-burn

		// GREEN again: remove the leaks, the sweep is clean for this sentinel.
		await db.query(`DELETE memory WHERE string::contains(content, $s);`, { s: sentinel });
		await db.query(`DELETE pm_memory WHERE string::contains(content, $s);`, { s: sentinel });
		await db.query(
			`DELETE message WHERE string::contains(content, $s) AND session.kind != 'interview';`,
			{ s: sentinel }
		);
		const green = await sentinelSweep(db);
		expect(green.hits.filter((h) => h.sentinel === sentinel)).toEqual([]);
	});
});
