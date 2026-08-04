/**
 * FLEET FILTER — LIVE contract against a REAL SurrealDB (not a stub).
 *
 * The unit test (`fleet-view.test.ts`) proves the pure view model against hand-built rows; a
 * hand-built row can only agree with itself. This test seeds REAL `session` rows across REAL
 * projects, reads them back through the SAME projection the /claude-code loader uses
 * (`listFleetAcrossProjects`, analytics/fleet.ts), and asserts the filters partition the LIVE
 * rows correctly. That is what pins the honest failure/project notions to the actual stored
 * shape — the `status` ASSERT set, the `project` FETCH, the option<string> `note`.
 *
 * It also nails the F-013 class from the FILTER side: a row whose `note` column is NONE must
 * read back as `null` and therefore NOT count as "needs attention" — a `str(undefined)` leak
 * there would silently flag every clean session.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject, deleteProject } from '$lib/server/projects/repo';
import { listFleetAcrossProjects } from '$lib/server/analytics';
import {
	FLEET_NO_PROJECT,
	filterFleet,
	fleetNeedsAttention,
	fleetProjectOptions,
	fleetStateCounts,
	resolveFleetView
} from './fleet-view';

let tdb: TestDb;
let db: Db;
let atelierId: string;
let roundsId: string;

/** Seed one REAL session row. `note` omitted ⇒ the column stays NONE (the F-013 shadow path). */
async function seedSession(input: {
	status: string;
	project?: string;
	note?: string;
	startedAt: string;
}): Promise<void> {
	// An option<string>/option<record> field must be OMITTED to stay NONE — binding an explicit
	// NULL is rejected by the schema ("Found NULL … but expected a option<string>"), which is
	// exactly the honest-absent shape the filter has to survive.
	const content: Record<string, unknown> = {
		kind: 'task',
		model: { provider: 'claude', model_id: 'claude-opus-4-8', tier: 'opus' },
		status: input.status,
		started_at: new Date(input.startedAt)
	};
	if (input.project) content.project = new StringRecordId(input.project);
	if (input.note) content.note = input.note;
	await db.query(`CREATE session CONTENT $content;`, { content });
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

	atelierId = (await createProject(db, { slug: 'fleetfilter_a', name: 'Atelier', root_path: 'F:/code/a' })).id;
	roundsId = (await createProject(db, { slug: 'fleetfilter_b', name: 'ROUNDS', root_path: 'F:/code/b' })).id;

	// The live window: 2 projects + a bare (project-less) chat, spanning every status the
	// schema ASSERT allows, with and without a note.
	await seedSession({ status: 'running', project: atelierId, startedAt: '2026-07-26T10:00:00Z' });
	await seedSession({
		status: 'failed',
		project: atelierId,
		note: 'spawn failed: CLAUDE_CODE_OAUTH_TOKEN stale',
		startedAt: '2026-07-26T09:00:00Z'
	});
	await seedSession({ status: 'failed', project: atelierId, startedAt: '2026-07-26T08:30:00Z' }); // failed, NO note
	await seedSession({ status: 'done', project: atelierId, startedAt: '2026-07-26T08:00:00Z' });
	await seedSession({
		status: 'done',
		project: roundsId,
		note: 'work preserved on branch atelier/session/x; merge needed',
		startedAt: '2026-07-26T07:00:00Z'
	});
	await seedSession({ status: 'cancelled', project: roundsId, startedAt: '2026-07-26T06:00:00Z' });
	await seedSession({ status: 'running', startedAt: '2026-07-26T05:00:00Z' }); // no project link
}, 90_000);

afterAll(async () => {
	await deleteProject(db, atelierId).catch(() => {});
	await deleteProject(db, roundsId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('/claude-code fleet filters against LIVE rows', () => {
	it('the loader projection feeds the project options — real ids, real names, real counts', async () => {
		const fleet = await listFleetAcrossProjects(db, 40);
		expect(fleet).toHaveLength(7);

		const opts = fleetProjectOptions(fleet);
		expect(opts.map((o) => `${o.label}:${o.count}`)).toEqual(['Atelier:4', 'ROUNDS:2', 'no project:1']);
		// Every offered value really selects rows — no dead option (the operator requirement).
		for (const o of opts) {
			expect(filterFleet(fleet, { project: o.value, state: 'all', open: true })).toHaveLength(o.count);
		}
	});

	it('the failure filter selects exactly the live status="failed" rows', async () => {
		const fleet = await listFleetAcrossProjects(db, 40);
		const failed = filterFleet(fleet, { project: null, state: 'failed', open: true });
		expect(failed).toHaveLength(2);
		expect(new Set(failed.map((s) => s.status))).toEqual(new Set(['failed']));
		expect(new Set(failed.map((s) => s.projectName))).toEqual(new Set(['Atelier']));
	});

	it('F-013 shadow path: a NONE note reads back null and does NOT flag a clean session', async () => {
		const fleet = await listFleetAcrossProjects(db, 40);
		const cleanDone = fleet.find((s) => s.status === 'done' && s.projectName === 'Atelier');
		expect(cleanDone).toBeTruthy();
		// The column is NONE ⇒ null, never the string "undefined" (which would be truthy and
		// would silently flag every clean session as needing attention).
		expect(cleanDone!.note).toBeNull();
		expect(fleetNeedsAttention(cleanDone!)).toBe(false);

		const cancelled = fleet.find((s) => s.status === 'cancelled');
		expect(cancelled!.note).toBeNull();
		expect(fleetNeedsAttention(cancelled!)).toBe(false); // an operator stop is not a failure
	});

	it('"needs attention" == failed ∪ noted, on live rows (the set this page already banners)', async () => {
		const fleet = await listFleetAcrossProjects(db, 40);
		const attention = filterFleet(fleet, { project: null, state: 'attention', open: true });
		// 2 failed + the done-with-merge-advisory row.
		expect(attention).toHaveLength(3);
		expect(attention.some((s) => s.status === 'done' && !!s.note)).toBe(true);
		const counts = fleetStateCounts(fleet);
		expect(counts).toMatchObject({ all: 7, running: 2, failed: 2, attention: 3 });
	});

	it('the no-project sentinel selects the live session with a NONE project link', async () => {
		const fleet = await listFleetAcrossProjects(db, 40);
		const bare = filterFleet(fleet, { project: FLEET_NO_PROJECT, state: 'all', open: true });
		expect(bare).toHaveLength(1);
		expect(bare[0].projectId).toBeNull();
		expect(bare[0].projectName).toBeNull();
	});

	it('a project with no failures is NOT offered under the failure filter (no dead combination)', async () => {
		const fleet = await listFleetAcrossProjects(db, 40);
		const opts = fleetProjectOptions(fleet, 'failed');
		expect(opts.map((o) => o.label)).toEqual(['Atelier']);
		// …and picking it anyway (a stale/shared link) is the NAMED honest state, not a blank list.
		const r = resolveFleetView(fleet, { project: roundsId, state: 'failed', open: true });
		expect(r.staleProject).toBe(true);
		expect(r.filteredEmpty).toBe(true);
		expect(r.projectOptions.find((o) => o.value === roundsId)?.label).toBe('ROUNDS');
	});

	it('the WINDOW is bounded — options describe the window only, and the page must say so', async () => {
		// The loader reads a bounded, newest-first window (`listFleetAcrossProjects(db, LIMIT)`).
		// Narrow it to 1 and the options honestly shrink to what is IN the window: "ROUNDS has no
		// failures" and "ROUNDS' failures are older than the window" are different facts, so the
		// section renders the window bound next to the filters rather than implying portfolio-wide
		// coverage (F-008).
		const narrow = await listFleetAcrossProjects(db, 1);
		expect(narrow).toHaveLength(1);
		const opts = fleetProjectOptions(narrow);
		expect(opts).toHaveLength(1);
		// A project that really has rows in the DB but none in the WINDOW resolves as stale, not
		// as a silent blank list.
		const r = resolveFleetView(narrow, { project: roundsId, state: 'all', open: true });
		expect(r.total).toBe(1);
		expect(r.staleProject).toBe(true);
		expect(r.filteredEmpty).toBe(true);
	});
});
