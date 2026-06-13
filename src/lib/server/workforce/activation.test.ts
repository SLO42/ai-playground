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
	isSentinelShape,
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

describe('isSentinelShape (pure 26-char Crockford guard)', () => {
	it('accepts every freshly-minted ULID', () => {
		for (let i = 0; i < 50; i++) expect(isSentinelShape(newSentinelUlid())).toBe(true);
		expect(isSentinelShape('01JXJ0000000000000000TEST1')).toBe(true);
	});
	it('rejects empty / whitespace / wrong-length / non-Crockford / non-string', () => {
		expect(isSentinelShape('')).toBe(false); // empty
		expect(isSentinelShape('                          ')).toBe(false); // 26 spaces
		expect(isSentinelShape('01JXJ')).toBe(false); // too short
		expect(isSentinelShape('01JXJ0000000000000000TEST123')).toBe(false); // too long
		expect(isSentinelShape('01jxj0000000000000000test1')).toBe(false); // lowercase
		expect(isSentinelShape('01JXJ000000000000000ILOU01')).toBe(false); // I/L/O/U not in Crockford
		expect(isSentinelShape('01JXJ-000000000000000TEST1')).toBe(false); // hyphen
		// nil / non-string shadow paths
		expect(isSentinelShape(undefined)).toBe(false);
		expect(isSentinelShape(null)).toBe(false);
		expect(isSentinelShape(42)).toBe(false);
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

// ── F-025: empty-sentinel match-all defense-in-depth (3 layers) ─────────────────────

describe('F-025 — an active/retired fixture can never carry an empty sentinel (3-layer defense)', () => {
	it('LAYER (a) activation boundary: activating an empty-sentinel fixture is refused (named)', async () => {
		// A fixture authored with an empty sentinel (proposed state — legal at rest).
		const fixture = await createGauntletFixture(db, {
			role: roleId,
			slug: 'f025-empty-activate',
			kind: 'clean_control',
			work: { 'g.ts': 'clean\n' },
			sentinel: ''
		});
		expect(fixture.status).toBe('proposed'); // proposed + empty sentinel is legal
		await expect(activateGauntletFixture(db, fixture.id)).rejects.toThrow(WorkforceInputError);
		await expect(activateGauntletFixture(db, fixture.id)).rejects.toThrow(/malformed sentinel/i);
		// It stayed proposed — the boundary refused the transition, no half-state.
		const [after] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM $f;`, {
			f: rid(fixture.id)
		});
		expect(after[0].status).toBe('proposed');
	});

	it('LAYER (a) activation boundary: a NON-EMPTY but MALFORMED sentinel is refused too (len>0 is not enough)', async () => {
		// The shadow path m0034 missed: a sentinel that passes `len>0` but is whitespace /
		// short / non-Crockford still near-match-alls the §4.2 sweep (same F-025 class).
		// Each must be refused at the activation boundary with the SAME named error.
		const cases: Array<[string, string]> = [
			['whitespace', '                          '], // 26 spaces — len OK, all non-Crockford
			['short', '01JXJ'], // valid chars, wrong length
			['lowercase', '01jxj0000000000000000test1'], // 26 chars but lowercase (not Crockford caps)
			['non-crockford-ILOU', '01JXJ000000000000000ILOU01'], // 26 chars, contains I/L/O/U
			['too-long', '01JXJ0000000000000000TEST123'] // 28 chars
		];
		for (const [label, bad] of cases) {
			const fx = await createGauntletFixture(db, {
				role: roleId,
				slug: `f025-malformed-${label}`,
				kind: 'clean_control',
				work: { 'g.ts': 'clean\n' },
				sentinel: bad
			});
			await expect(activateGauntletFixture(db, fx.id), label).rejects.toThrow(/malformed sentinel/i);
			const [after] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM $f;`, {
				f: rid(fx.id)
			});
			expect(after[0].status, `${label} stayed proposed`).toBe('proposed');
		}
		// A genuine ULID activates cleanly — proves the guard accepts the mint-shape (no
		// behavior change for valid ULIDs, day-0-safe).
		const good = await createGauntletFixture(db, {
			role: roleId,
			slug: 'f025-malformed-control-valid',
			kind: 'clean_control',
			work: { 'g.ts': 'clean\n' },
			sentinel: newSentinelUlid()
		});
		const res = await activateGauntletFixture(db, good.id);
		expect(res.activated).toBe(true);
	});

	it('LAYER (b) schema assert: proposed+empty is allowed; active/retired+empty is rejected by the DDL', async () => {
		// proposed + empty sentinel: the DDL assert permits it (empty by design pre-activation).
		const ok = await createGauntletFixture(db, {
			role: roleId,
			slug: 'f025-schema-proposed',
			kind: 'clean_control',
			work: { 'h.ts': 'clean\n' },
			sentinel: ''
		});
		expect(ok.sentinel).toBe('');
		// Forcing status='active' while sentinel stays '' must be rejected by the field assert
		// (the write re-validates every SCHEMAFULL field — §6.5). Bypasses the activation
		// boundary deliberately to prove the schema layer stands on its own.
		await expect(
			db.query(`UPDATE $f SET status = 'active';`, { f: rid(ok.id) })
		).rejects.toThrow();
		// retired + empty is likewise rejected.
		await expect(
			db.query(`UPDATE $f SET status = 'retired';`, { f: rid(ok.id) })
		).rejects.toThrow();
		// The row stayed proposed (the rejected writes did not partially apply the status).
		const [after] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM $f;`, {
			f: rid(ok.id)
		});
		expect(after[0].status).toBe('proposed');
		// A non-empty sentinel write to active is accepted (the assert only blocks empty).
		await db.query(`UPDATE $f SET sentinel = $s, status = 'active';`, {
			f: rid(ok.id),
			s: newSentinelUlid()
		});
		const [active] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM $f;`, {
			f: rid(ok.id)
		});
		expect(active[0].status).toBe('active');
	});

	it('LAYER (b) schema assert (m0035 shape): a NON-EMPTY but MALFORMED sentinel is rejected by the DDL', async () => {
		// proposed + a malformed sentinel is legal at rest (assert only fires on active/
		// retired). Forcing active while the sentinel is whitespace/short/non-Crockford must
		// be rejected by the m0035 shape assert — the DB layer stands on its own (a direct
		// ROOT write that bypasses the activation boundary cannot arm a match-all sweep).
		const malformed = [
			'                          ', // 26 spaces
			'01JXJ', // too short
			'01jxj0000000000000000test1', // lowercase
			'01JXJ000000000000000ILOU01' // contains I/L/O/U
		];
		for (const bad of malformed) {
			const row = await createGauntletFixture(db, {
				role: roleId,
				slug: `f025-ddl-malformed-${bad.trim().slice(0, 6) || 'ws'}-${Math.random().toString(36).slice(2, 6)}`,
				kind: 'clean_control',
				work: { 'm.ts': 'clean\n' },
				sentinel: bad
			});
			await expect(
				db.query(`UPDATE $f SET status = 'active';`, { f: rid(row.id) }),
				`active+${JSON.stringify(bad)} rejected`
			).rejects.toThrow();
			await expect(
				db.query(`UPDATE $f SET status = 'retired';`, { f: rid(row.id) }),
				`retired+${JSON.stringify(bad)} rejected`
			).rejects.toThrow();
			const [after] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM $f;`, {
				f: rid(row.id)
			});
			expect(after[0].status).toBe('proposed');
		}
	});

	it('LAYER (c) sweep: an empty sentinel is SKIPPED, never string::contains-matched against all rows', async () => {
		// Force an empty-sentinel active fixture into the DB BY-PASSING both guards above —
		// the only way to reach this state is a direct ROOT write with the assert dropped.
		// We simulate the dangerous legacy row by temporarily removing the field assert,
		// writing the row, then restoring the assert. The sweep must still not match-all.
		const checkedBefore = (await sentinelSweep(db)).checked;
		await db.query(`DEFINE FIELD OVERWRITE sentinel ON gauntlet_fixture TYPE string;`);
		const leaked = await createGauntletFixture(db, {
			role: roleId,
			slug: 'f025-sweep-empty',
			kind: 'planted_defect',
			work: { 'i.ts': 'x\n' },
			sentinel: ''
		});
		await db.query(`UPDATE $f SET status = 'active';`, { f: rid(leaked.id) });
		// Restore the real assert immediately (leave the schema as the migration defines it).
		await db.query(
			`DEFINE FIELD OVERWRITE sentinel ON gauntlet_fixture TYPE string
				ASSERT status = NONE OR status = "proposed" OR string::len($value) > 0;`
		);
		// Ensure there is at least one row on each surface that the empty needle WOULD match.
		const v = new Array(1024).fill(0);
		v[0] = 1;
		await db.query(`CREATE memory SET content = $c, namespace = 'default', embedding = $v;`, {
			c: 'unrelated memory row that an empty needle would falsely match',
			v
		});

		const result = await sentinelSweep(db);
		// The empty-sentinel fixture contributes ZERO hits (skipped), so no surface is
		// match-alled by it. Defect would have produced a hit for every memory row.
		expect(result.hits.filter((h) => h.fixtureSlug === 'f025-sweep-empty')).toEqual([]);
		// And it was NOT counted as `checked` — an uncheckable (skipped) sentinel was never
		// swept, so the count is unchanged by adding it (no proposed/uninjected over-count).
		expect(result.checked).toBe(checkedBefore);

		// Cleanup: retire-by-delete the synthetic row so it never pollutes later sweeps.
		await db.query(`DELETE $f;`, { f: rid(leaked.id) });
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

// ── m0035 — sentinel ULID-shape assert migration (idempotency, F-015) ───────────────

describe('m0035_gauntlet_sentinel_ulid_shape — apply-twice + half-applied recovery (F-015)', () => {
	const MIG = '0035_gauntlet_sentinel_ulid_shape';

	it('the migration is registered and ordered after m0034', () => {
		const ids = schemaMigrations.map((m) => m.id);
		expect(ids).toContain(MIG);
		expect(ids.indexOf(MIG)).toBeGreaterThan(ids.indexOf('0034_gauntlet_sentinel_nonempty'));
	});

	it('apply-twice: the runner skips it AND the raw OVERWRITE DDL re-applies cleanly', async () => {
		const again = await runMigrations(db, schemaMigrations);
		expect(again).toEqual([]); // already applied in beforeAll — runner is idempotent
		const mig = schemaMigrations.find((m) => m.id === MIG);
		expect(mig).toBeDefined();
		// The F-015 hard case: the DDL itself re-runs over the already-applied state.
		await expect(db.query(mig!.up)).resolves.toBeDefined();
		await expect(db.query(mig!.up)).resolves.toBeDefined(); // third apply — still clean
		// And the shape assert is still in force after the re-applies.
		const probe = await createGauntletFixture(db, {
			role: roleId,
			slug: `m0035-reapply-${Math.random().toString(36).slice(2, 8)}`,
			kind: 'clean_control',
			work: { 'r.ts': 'clean\n' },
			sentinel: '01JXJ' // malformed
		});
		await expect(db.query(`UPDATE $f SET status = 'active';`, { f: rid(probe.id) })).rejects.toThrow();
	});

	it('half-applied recovery: a fresh namespace with the pre-m0035 (m0034) field is absorbed by the full re-run', async () => {
		// Simulate the mid-apply death: a brand-new namespace that has the EARLIER (m0034,
		// len>0) sentinel field defined but m0035 never recorded. Running the full set must
		// recover — re-define the field with the tighter shape assert, idempotently.
		const half = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: `${tdb.namespace}_m0035half`,
			database: tdb.database
		});
		try {
			// Apply everything EXCEPT m0035 (the state right before the death).
			const withoutShape = schemaMigrations.filter((m) => m.id !== MIG);
			await runMigrations(half, withoutShape);
			// Under m0034 a non-empty-but-malformed active sentinel is ALLOWED (the bug).
			const role = await createRole(half, {
				slug: 'm0035-half-role',
				name: 'H',
				purpose: 'half-applied recovery bed'
			});
			const fx = await createGauntletFixture(half, {
				role: role.id,
				slug: 'm0035-half-fx',
				kind: 'clean_control',
				work: { 'h.ts': 'clean\n' },
				sentinel: '01JXJ' // short — passes m0034's len>0
			});
			await expect(
				half.query(`UPDATE $f SET status = 'active';`, { f: new StringRecordId(fx.id) })
			).resolves.toBeDefined(); // m0034 lets this through

			// Reset that row to proposed so the recovery re-define doesn't have to scan/heal
			// existing rows (asserts fire only on writes — the migration is a pure redefine).
			await half.query(`UPDATE $f SET status = 'proposed';`, { f: new StringRecordId(fx.id) });

			// Now run the FULL set — m0035 lands and tightens the assert.
			const applied = await runMigrations(half, schemaMigrations);
			expect(applied).toContain(MIG);
			// The malformed sentinel can no longer be activated.
			await expect(
				half.query(`UPDATE $f SET status = 'active';`, { f: new StringRecordId(fx.id) })
			).rejects.toThrow();
			// A re-run is a no-op (recorded), and re-applying the raw DDL is still clean.
			expect(await runMigrations(half, schemaMigrations)).toEqual([]);
			const mig = schemaMigrations.find((m) => m.id === MIG)!;
			await expect(half.query(mig.up)).resolves.toBeDefined();
		} finally {
			await half.query('REMOVE NAMESPACE IF EXISTS type::namespace($ns);', {
				ns: `${tdb.namespace}_m0035half`
			}).catch(() => {});
			await half.close().catch(() => {});
		}
	});
});
