// THE HIRING FEED — VERIFY listHiringActivity against a REAL SurrealDB.
//
// OPERATOR REVIEW 2026-07-26 §5 + §13. The /agents "hiring & certification activity" card rendered
// 36 near-identical `Gauntlet scored … recall —` rows. Three things were wrong and all three are
// asserted here against rows READ BACK from the database:
//
//   (i)  the recall/FP/tier/model numbers exist on the `interview_run` each ledger row already
//        pointed at via `detail.run` — they were simply never joined;
//   (ii) the feed was flat, so a ceremony's several events read as several unrelated rows;
//   (iii) 19 of the 36 runs BROKE (spawn_failure / scorer_error, 9 of them auto-retries), which is
//        dead noise in the default view — but it is REAL history, so it must be classified and
//        filterable, never deleted or silently dropped from the read model.
//
// A `stubDb` test cannot prove any of this: it does not parse SurrealQL, so the `WHERE id IN $ids`
// run hydration and the `role.name`/`role.slug` join would pass green while being broken live
// (F-020's lesson, three recurrences deep in this repo). Hence a real server.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	createRole,
	createRoleVersion,
	createInterviewRun,
	finalizeInterviewRun,
	listHiringActivity,
	listRecentRoleEvents,
	addRoleEvent,
	HIRING_RUN_FETCH_CAP,
	type HiringCeremony
} from './repo';

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
	await runMigrations(db, schemaMigrations);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let seq = 0;
async function freshRole(name?: string) {
	const slug = `hiring-feed-${++seq}`;
	return createRole(db, { slug, name: name ?? `Role ${slug}`, purpose: 'hiring feed read model' });
}

/** Open + finalize one gauntlet run, exercising the REAL write paths (not hand-built rows). */
async function seedRun(opts: {
	roleId: string;
	versionId: string;
	status: 'passed' | 'failed' | 'error' | 'adjudicating';
	errorReason?: 'env_timeout' | 'spawn_failure' | 'scorer_error';
	plantedTotal?: number;
	plantedFound?: number;
	falsePositives?: number;
	retryOf?: string;
	modelId?: string;
}): Promise<string> {
	const run = await createInterviewRun(db, {
		role_version: opts.versionId,
		tier: 'opus',
		provider: 'claude',
		model_id: opts.modelId ?? 'claude-opus-4-8',
		fixture_set_sha: 'sha-fixtures',
		...(opts.retryOf ? { retry_of: opts.retryOf } : {}),
		...(opts.plantedTotal !== undefined ? { planted_total: opts.plantedTotal } : {}),
		pass_criteria: { min_recall: 0.8, max_false_positives: 1 }
	});
	await finalizeInterviewRun(db, run.id, {
		status: opts.status,
		...(opts.errorReason ? { error_reason: opts.errorReason } : {}),
		...(opts.plantedTotal !== undefined ? { planted_total: opts.plantedTotal } : {}),
		...(opts.plantedFound !== undefined ? { planted_found: opts.plantedFound } : {}),
		...(opts.falsePositives !== undefined ? { false_positives: opts.falsePositives } : {})
	});
	return run.id;
}

/** The ceremony for one run id in a feed read. */
function ceremonyFor(feed: { ceremonies: HiringCeremony[] }, runId: string): HiringCeremony | undefined {
	return feed.ceremonies.find((c) => c.key === runId);
}

describe('listHiringActivity — the interview_run JOIN (§5.i: the numbers were one FETCH away)', () => {
	it('HAPPY PATH: recall, FP, tier and model_id all render from the joined run', async () => {
		const role = await freshRole('Code Reviewer');
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'Find the planted bugs.',
			default_tier: 'opus'
		});
		const runId = await seedRun({
			roleId: role.id,
			versionId: version.id,
			status: 'passed',
			plantedTotal: 10,
			plantedFound: 9,
			falsePositives: 1
		});

		const feed = await listHiringActivity(db, 100);
		const c = ceremonyFor(feed, runId);
		expect(c, 'the ceremony must exist — a silently empty feed IS the defect').toBeTruthy();
		expect(c!.run).toBeTruthy();
		expect(c!.runMissing).toBe(false);
		// The facts that used to read `recall —`.
		expect(c!.run!.planted_total).toBe(10);
		expect(c!.run!.planted_found).toBe(9);
		expect(c!.run!.false_positives).toBe(1);
		expect(c!.run!.recall).toBeCloseTo(0.9, 5);
		expect(c!.run!.tier).toBe('opus');
		expect(c!.run!.model_id).toBe('claude-opus-4-8');
		expect(c!.run!.provider).toBe('claude');
		expect(c!.run!.status).toBe('passed');
		expect(c!.run!.pass_criteria).toMatchObject({ min_recall: 0.8 });
		// F-013 — datetimes are ISO STRINGS, never a raw SDK datetime (devalue 500 in a load).
		expect(typeof c!.run!.started_at).toBe('string');
		expect(String(c!.run!.started_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(typeof c!.run!.ended_at).toBe('string');
		// …and so is the ceremony's own sort key.
		expect(String(c!.at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('recall is NULL when the run planted nothing — undefined, never a fabricated 0 or 1 (F-008)', async () => {
		const role = await freshRole();
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		const runId = await seedRun({
			roleId: role.id,
			versionId: version.id,
			status: 'passed',
			plantedTotal: 0,
			plantedFound: 0
		});
		const c = ceremonyFor(await listHiringActivity(db, 100), runId);
		expect(c!.run!.planted_total).toBe(0);
		expect(c!.run!.recall).toBeNull();
	});

	it('joins the ROLE identity so a dangling role never has to render as a raw record id', async () => {
		const role = await freshRole('Security Officer');
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		const runId = await seedRun({ roleId: role.id, versionId: version.id, status: 'failed' });
		const c = ceremonyFor(await listHiringActivity(db, 100), runId);
		expect(c!.role_name).toBe('Security Officer');
		expect(c!.role_slug).toBe(role.slug);
		expect(c!.role).toBe(role.id);
	});
});

describe('listHiringActivity — ceremony threads (§5.ii: 36 loose rows → threads)', () => {
	it('folds every event that points at the SAME run into ONE thread', async () => {
		const role = await freshRole();
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		const runId = await seedRun({
			roleId: role.id,
			versionId: version.id,
			status: 'passed',
			plantedTotal: 4,
			plantedFound: 4
		});
		// A second lifecycle moment against the SAME run (the shape a real ceremony has).
		await addRoleEvent(db, {
			role: role.id,
			op: 'adjudicated',
			detail: { run: runId, items: 2, confirmed_hits: 2, false_positives: 0, dismissed: 0 }
		});

		const feed = await listHiringActivity(db, 100);
		const mine = feed.ceremonies.filter((c) => c.role === role.id);
		expect(mine).toHaveLength(1); // ONE thread, not two loose rows
		expect(mine[0].events.length).toBeGreaterThanOrEqual(2);
		expect(mine[0].events.map((e) => e.op)).toEqual(
			expect.arrayContaining(['interviewed', 'adjudicated'])
		);
		// Threads are newest-first inside, so the head event drives the row's headline.
		expect(mine[0].at).toBe(mine[0].events[0].at);
	});

	it('an event with NO run pointer becomes its OWN singleton thread — never dropped or merged', async () => {
		const role = await freshRole();
		const ev = await addRoleEvent(db, {
			role: role.id,
			op: 'staffed',
			detail: { project: 'project:x', source: 'operator' }
		});
		const feed = await listHiringActivity(db, 200);
		const c = feed.ceremonies.find((x) => x.key === `event:${ev.id}`);
		expect(c).toBeTruthy();
		expect(c!.run).toBeNull();
		expect(c!.runMissing).toBe(false); // it never HAD a run — different from "the run is gone"
		expect(c!.events).toHaveLength(1);
	});

	it('totalEvents counts the RAW ledger rows, not the folded threads (an honest denominator)', async () => {
		const feed = await listHiringActivity(db, 200);
		const raw = await listRecentRoleEvents(db, 200, [
			'gauntlet_started',
			'interviewed',
			'adjudicated',
			'reversioned',
			'candidate_considered',
			'hired',
			'hire_rejected',
			'staffed'
		]);
		expect(feed.totalEvents).toBe(raw.length);
		expect(feed.ceremonies.length).toBeLessThanOrEqual(feed.totalEvents);
	});
});

describe('listHiringActivity — broken runs are CLASSIFIED, never deleted (§5.iii / §13)', () => {
	it('flags status=error as errored and carries the error_reason', async () => {
		const role = await freshRole();
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		const runId = await seedRun({
			roleId: role.id,
			versionId: version.id,
			status: 'error',
			errorReason: 'spawn_failure'
		});
		const feed = await listHiringActivity(db, 200);
		const c = ceremonyFor(feed, runId);
		expect(c!.errored).toBe(true);
		expect(c!.run!.error_reason).toBe('spawn_failure');
		// The row is STILL in the read model — filtering is a VIEW decision, not data loss.
		expect(feed.ceremonies.some((x) => x.key === runId)).toBe(true);
		expect(feed.erroredCount).toBeGreaterThanOrEqual(1);
	});

	it('flags an auto-retry (§3.6) so 9-of-19 duplicate re-runs are distinguishable', async () => {
		const role = await freshRole();
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		const first = await seedRun({
			roleId: role.id,
			versionId: version.id,
			status: 'error',
			errorReason: 'scorer_error'
		});
		const retry = await seedRun({
			roleId: role.id,
			versionId: version.id,
			status: 'error',
			errorReason: 'scorer_error',
			retryOf: first
		});
		const feed = await listHiringActivity(db, 200);
		expect(ceremonyFor(feed, first)!.isRetry).toBe(false);
		const r = ceremonyFor(feed, retry)!;
		expect(r.isRetry).toBe(true);
		expect(r.run!.retry_of).toBe(first);
		expect(feed.retryCount).toBeGreaterThanOrEqual(1);
	});

	it('a healthy run is NOT flagged (the classifier is not a blanket)', async () => {
		const role = await freshRole();
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		const runId = await seedRun({
			roleId: role.id,
			versionId: version.id,
			status: 'passed',
			plantedTotal: 2,
			plantedFound: 2
		});
		const c = ceremonyFor(await listHiringActivity(db, 200), runId)!;
		expect(c.errored).toBe(false);
		expect(c.isRetry).toBe(false);
	});
});

describe('listHiringActivity — shadow paths, all four, all named', () => {
	it('UPSTREAM ERROR: a `detail.run` pointing at a DELETED run → runMissing, thread still renders', async () => {
		const role = await freshRole();
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		const runId = await seedRun({ roleId: role.id, versionId: version.id, status: 'failed' });
		await db.query(`DELETE type::thing($rid);`, { rid: runId });

		const c = ceremonyFor(await listHiringActivity(db, 200), runId);
		expect(c, 'the thread must survive a dangling pointer, honestly labelled').toBeTruthy();
		expect(c!.run).toBeNull();
		expect(c!.runMissing).toBe(true);
		expect(c!.errored).toBe(false); // we do NOT claim it broke — we do not know
	});

	it('BOTH live pointer shapes join: pre-wave `detail.run` AND post-m0083 `detail.ref`', async () => {
		// The trap this pins: the operator review measured the 36 LIVE rows, which all carry the
		// pre-wave flat `detail.run`. But hire-events.ts emitHireEvent (m0083) stamps `detail.ref`
		// and never writes `run` — so a join on `run` alone would light up history and go DARK the
		// instant a gauntlet next runs. Both shapes must land on the SAME thread.
		const role = await freshRole();
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		// createInterviewRun emits gauntlet_started with detail.ref = the run; finalize emits
		// interviewed, also with detail.ref. Then we add a legacy-shaped row with detail.run.
		const runId = await seedRun({
			roleId: role.id,
			versionId: version.id,
			status: 'passed',
			plantedTotal: 3,
			plantedFound: 3
		});
		await addRoleEvent(db, {
			role: role.id,
			op: 'adjudicated',
			detail: { run: runId, items: 1, confirmed_hits: 1, false_positives: 0, dismissed: 0 }
		});

		const feed = await listHiringActivity(db, 200);
		const mine = feed.ceremonies.filter((c) => c.role === role.id);
		expect(mine, 'ref-shaped and run-shaped events must share ONE thread').toHaveLength(1);
		expect(mine[0].key).toBe(runId);
		expect(mine[0].run).toBeTruthy();
		const ops = mine[0].events.map((e) => e.op);
		expect(ops).toEqual(expect.arrayContaining(['gauntlet_started', 'interviewed', 'adjudicated']));
	});

	it('a non-interview_run `ref` groups the thread but is NOT reported as a broken link', async () => {
		const role = await freshRole();
		await addRoleEvent(db, {
			role: role.id,
			op: 'hired',
			detail: { ref: 'decision_brief:abc123', recommendation: 'hire', cert_flipped: true }
		});
		const c = (await listHiringActivity(db, 200)).ceremonies.find(
			(x) => x.key === 'decision_brief:abc123'
		);
		expect(c).toBeTruthy();
		expect(c!.run).toBeNull();
		// It never pointed at a run, so claiming the run is "missing" would be a fabricated fault.
		expect(c!.runMissing).toBe(false);
	});

	it('UPSTREAM ERROR: a non-string / malformed pointer is treated as absent, not fatal', async () => {
		const role = await freshRole();
		const ev = await addRoleEvent(db, {
			role: role.id,
			op: 'interviewed',
			// A number where a record-id string belongs — the shape an upstream bug would write.
			detail: { run: 12345, status: 'passed' }
		});
		const feed = await listHiringActivity(db, 200);
		const c = feed.ceremonies.find((x) => x.key === `event:${ev.id}`);
		expect(c).toBeTruthy();
		expect(c!.run).toBeNull();
		expect(c!.runMissing).toBe(false);
	});

	it('EMPTY: a limit of 1 still returns a bounded, well-formed feed (never an unbounded scan)', async () => {
		const feed = await listHiringActivity(db, 1);
		expect(feed.totalEvents).toBe(1);
		expect(feed.ceremonies).toHaveLength(1);
	});

	it('the queries actually PARSE on a real server — F-020 order-idiom + IN-binding smoke', async () => {
		// A stubDb passes this even with a mis-projected ORDER BY or an unbound IN list; only a real
		// server raises. Reaching a non-empty result IS the assertion (a best-effort catch that
		// silently yields [] is the exact defect the F-020 sweep exists to eliminate).
		const feed = await listHiringActivity(db, 200);
		expect(feed.ceremonies.length).toBeGreaterThan(0);
		expect(feed.ceremonies.some((c) => c.run != null)).toBe(true);
	});
});

// ── DEFECT #1: THE SILENT TRUNCATION ────────────────────────────────────────────────────────
//
// `if (runIds.length < HIRING_RUN_FETCH_CAP) runIds.push(p)` dropped every pointer past the cap
// with no marker anywhere in the returned shape. The dropped ceremonies then fell into the
// `runMissing` branch and rendered the chip `run not found` — an HONEST state produced by a
// DISHONEST cause, and therefore the most misleading outcome available: the operator reads a
// data-integrity problem (the ledger points at deleted runs) where the only fact is that this
// one read stopped fetching. Everything below runs against a REAL SurrealDB on a REAL cap.
describe('listHiringActivity — the run-hydration CAP is disclosed, never silent', () => {
	/** Seed N distinct roles each with one finalized run → N distinct run pointers in the window. */
	async function seedDistinctRuns(n: number): Promise<string[]> {
		const ids: string[] = [];
		for (let i = 0; i < n; i++) {
			const role = await freshRole();
			const version = await createRoleVersion(db, {
				role: role.id,
				prompt_core: 'p',
				default_tier: 'opus'
			});
			ids.push(
				await seedRun({
					roleId: role.id,
					versionId: version.id,
					status: 'passed',
					plantedTotal: 2,
					plantedFound: 2
				})
			);
		}
		return ids;
	}

	it('UNCAPPED: every pointer hydrates and the read says so (capped:false, unfetched:0)', async () => {
		await seedDistinctRuns(2);
		const feed = await listHiringActivity(db, 200);
		const withRuns = feed.ceremonies.filter((c) => c.run != null);
		expect(withRuns.length).toBeGreaterThan(0);
		expect(feed.runFetch.capped).toBe(false);
		expect(feed.runFetch.unfetched).toBe(0);
		expect(feed.runFetch.cap).toBe(HIRING_RUN_FETCH_CAP);
		expect(feed.runFetch.hydrated).toBe(feed.runFetch.pointers);
		// Nothing is flagged unfetched when nothing was skipped.
		expect(feed.ceremonies.some((c) => c.runUnfetched)).toBe(false);
	});

	it('THE DEFECT: a pointer past the cap is `runUnfetched`, NOT `runMissing` — the run EXISTS', async () => {
		const ids = await seedDistinctRuns(3);
		// Cap of 1: at least two of the three fresh pointers are pushed past it. The runs are all
		// present in the DB — read them back to prove the "not found" chip would have been a lie.
		const feed = await listHiringActivity(db, 200, { runFetchCap: 1 });
		expect(feed.runFetch.cap).toBe(1);
		expect(feed.runFetch.hydrated).toBe(1);
		expect(feed.runFetch.capped).toBe(true);
		expect(feed.runFetch.unfetched).toBe(feed.runFetch.pointers - 1);

		const skipped = feed.ceremonies.filter((c) => c.runUnfetched);
		expect(skipped.length).toBe(feed.runFetch.unfetched);
		expect(skipped.length).toBeGreaterThan(0);
		for (const c of skipped) {
			expect(c.run, 'an unfetched pointer carries no run facts — it was never queried').toBeNull();
			expect(
				c.runMissing,
				'THE REGRESSION GUARD: a capped-out pointer must NEVER masquerade as a dangling one'
			).toBe(false);
		}

		// And the rows really ARE in the database — the cap said nothing about their existence.
		// This is the assertion that makes `run not found` provably a lie for these ceremonies.
		for (const id of ids) {
			const [rows] = await db.query<[Array<{ id: unknown }>]>(
				`SELECT id FROM type::thing($rid);`,
				{ rid: id }
			);
			expect(rows?.[0]?.id, `${id} exists; only the FETCH was bounded`).toBeTruthy();
		}
	});

	it('`runMissing` still fires for a genuinely DANGLING pointer even under cap pressure', async () => {
		// The two states must stay independently reachable: a deleted run inside the fetched slice
		// is still `runMissing`. Collapsing them (either direction) is the defect.
		const role = await freshRole();
		const version = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'p',
			default_tier: 'opus'
		});
		const runId = await seedRun({ roleId: role.id, versionId: version.id, status: 'failed' });
		await db.query(`DELETE type::thing($rid);`, { rid: runId });

		// Newest-first, so this just-deleted run's events lead the window and land inside a cap of 1.
		const feed = await listHiringActivity(db, 200, { runFetchCap: 1 });
		const c = ceremonyFor(feed, runId);
		expect(c).toBeTruthy();
		expect(c!.runUnfetched).toBe(false);
		expect(c!.runMissing, 'a pointer we DID ask about and got nothing back for is missing').toBe(true);
	});

	it('the two flags are MUTUALLY EXCLUSIVE on every ceremony of every read', async () => {
		for (const cap of [1, 2, HIRING_RUN_FETCH_CAP]) {
			const feed = await listHiringActivity(db, 200, { runFetchCap: cap });
			for (const c of feed.ceremonies) {
				expect(
					c.runMissing && c.runUnfetched,
					`ceremony ${c.key} claims both missing AND unfetched at cap ${cap}`
				).toBe(false);
			}
		}
	});

	it('the cap can only be TIGHTENED — a caller cannot raise it past the F-014 ceiling', async () => {
		const wide = await listHiringActivity(db, 5, { runFetchCap: 10_000 });
		expect(wide.runFetch.cap).toBe(HIRING_RUN_FETCH_CAP);
		// nil-ish / nonsense overrides fall back to the ceiling rather than to 0 (which would mark
		// EVERY ceremony unfetched and turn a bad argument into a page full of false disclosure).
		for (const bad of [0, -5, Number.NaN, undefined]) {
			const f = await listHiringActivity(db, 5, { runFetchCap: bad as number });
			expect(f.runFetch.cap).toBeGreaterThanOrEqual(1);
			expect(f.runFetch.cap).toBeLessThanOrEqual(HIRING_RUN_FETCH_CAP);
		}
	});

	it('the totals still describe the FULL window — capping hydration never drops a ceremony', async () => {
		const full = await listHiringActivity(db, 200);
		const capped = await listHiringActivity(db, 200, { runFetchCap: 1 });
		expect(capped.ceremonies.length).toBe(full.ceremonies.length);
		expect(capped.totalEvents).toBe(full.totalEvents);
		expect(capped.runFetch.pointers).toBe(full.runFetch.pointers);
	});
});

describe('EMPTY-DB shadow path — an untouched ledger reads as an honest empty feed (F-008)', () => {
	it('returns zeroed counts and no ceremonies, never a fabricated row', async () => {
		const fresh = await startTestDb();
		const fdb = await Db.connect({
			url: fresh.wsUrl,
			username: fresh.root.username,
			password: fresh.root.password,
			namespace: fresh.namespace,
			database: fresh.database
		});
		try {
			await runMigrations(fdb, schemaMigrations);
			expect(await listHiringActivity(fdb, 50)).toEqual({
				ceremonies: [],
				totalEvents: 0,
				erroredCount: 0,
				retryCount: 0,
				// A read that fetched NOTHING must not claim it fetched to its cap.
				runFetch: { pointers: 0, hydrated: 0, cap: HIRING_RUN_FETCH_CAP, unfetched: 0, capped: false }
			});
		} finally {
			await fdb.close().catch(() => {});
			await fresh.teardown();
		}
	}, 90_000);
});
