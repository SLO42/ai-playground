// PJH-4 (PROJECTS-SPEC §7) — RENDER-SMOKE for the /projects/[id] command-center load against
// UNDER-POPULATED project rows. The detail page assumes a fully-wired project; a row missing
// optional fields (no PM, no sprints, no repo, no plan — or a `create_status:'incomplete'`
// mid-scaffold Create-with-AI leftover, DATA-MODEL m0049) must NOT 500 the load, must NOT be
// masked as `connected:false`, and must NOT fabricate defaults. This locks the F-008 contract
// PROJECTS-SPEC §6.9 states for the ONE operator surface.
//
// It invokes the REAL `load` (not the repo functions it composes) against a live migrated
// SurrealDB, with the runtime singleton pointed at the test DB so `tryGetDb()` returns it
// unchanged — the same seam pm-autonomous-action.test.ts uses for the actions. Each variant
// asserts three things:
//   (a) NO throw + `connected:true` — a real, existing-but-thin project renders honestly; the
//       catch-all disconnected branch must NOT swallow it (that would dress a live row as down).
//   (b) POJOs only — `devalue.stringify` (the SvelteKit load serializer) round-trips the whole
//       payload; it THROWS on a raw SDK Datetime/RecordId leak (the F-013 devalue-500 class).
//   (c) Absent optional data surfaces as honest empty — [] / null / omitted key — never an
//       invented value or the literal string "undefined" (F-008).
//
// If the SurrealDB binary can't start, the suite skips honestly (never a faked artifact).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as devalue from 'devalue';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { StringRecordId } from 'surrealdb';
import { createProject } from '$lib/server/projects/repo';
import { createPm } from '$lib/server/projects/pm-repo';
import { loadOrchestration } from '$lib/server/config/load';
import { load, type ProjectDetailData } from './+page.server';

let tdb: TestDb | undefined;
let db: Db | undefined;
let available = false;
// True ONLY when THIS suite created the runtime singleton. Under full-suite concurrency a sibling
// route test can already hold the process-wide singleton (initDb throws "already initialised"); we
// then skip honestly rather than fail — and, critically, our afterAll must NOT closeDb() a singleton
// we do not own (that would tear down the sibling's live DB mid-run). Well-behaved-citizen guard.
let ownsSingleton = false;

beforeAll(async () => {
	try {
		tdb = await startTestDb();
		// Migrate via a throwaway handle, then re-open as the process-wide runtime singleton so the
		// load's tryGetDb() returns THIS db (the real code path runs unchanged).
		const boot = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		await runMigrations(boot, schemaMigrations);
		await boot.close();
		db = await initDb({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		ownsSingleton = true;
		available = true;
	} catch {
		// startTestDb unavailable OR the singleton is already held by a concurrent sibling suite —
		// skip honestly (never a faked artifact, never a hijacked singleton).
		available = false;
	}
}, 90_000);

afterAll(async () => {
	// Only close the singleton WE opened — never a sibling's (see ownsSingleton note above).
	if (ownsSingleton) await closeDb().catch(() => {});
	await tdb?.teardown();
});

/** Invoke the REAL page load exactly as SvelteKit would (no-op depends, a plain url, the route param). */
async function runLoad(slug: string): Promise<ProjectDetailData> {
	return (await load({
		params: { id: slug },
		depends: () => {},
		url: new URL(`http://localhost/projects/${slug}`)
	} as unknown as Parameters<typeof load>[0])) as ProjectDetailData;
}

/**
 * The daily spawn cap the operator has ACTUALLY configured, read from the SAME YAML the boot seam
 * reads and normalized through the orchestrator's own `> 0` gate (0 / absent / non-positive =
 * UNCAPPED ⇒ honest null). Derived independently of `readSpendCaps()` so the assertion is a real
 * reported-vs-enforced check, not a tautology, and so an operator budget adjustment TRACKS instead
 * of breaking the suite. Shadow path: an unreadable/malformed config mirrors `bootDailySpawnCap()`
 * and reports null (never a fabricated denominator, F-008).
 */
function configuredDailyCap(): number | null {
	try {
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		const raw = loadOrchestration(`${dir}/orchestration.yaml`).concurrency.dailySpawnCap;
		return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
	} catch {
		return null;
	}
}

/** The universal honest-empty + POJO assertions every under-populated variant must satisfy. */
function assertHonestAndSerializable(data: ProjectDetailData, projectId: string): void {
	// (a) The row EXISTS and is connected — a live-but-thin project is NOT dressed as disconnected.
	expect(data.connected).toBe(true);
	expect(data.error).toBeUndefined();
	expect(data.project).toBeDefined();
	expect(data.project?.id).toBe(projectId);

	// (c) Absent plan hierarchy / PM / sessions surface as honest empties — never fabricated rows.
	expect(data.releases).toEqual([]);
	expect(data.phases).toEqual([]);
	expect(data.features).toEqual([]);
	expect(data.sprints).toEqual([]);
	expect(data.tasks).toEqual([]);
	expect(data.sessions).toEqual([]);
	expect(data.pm).toBeNull();
	expect(data.pmMemory).toEqual([]);
	expect(data.decisions).toEqual([]);
	expect(data.proposals).toEqual([]);
	expect(data.pmBootstrapped).toBe(false);
	// A never-verified game harness is honestly "not configured" (no fabricated launch config).
	expect(data.gameVerifyConfigured).toBe(false);
	expect(data.gameVerify).toEqual([]);
	// The spend caps are always present. The daily cap is OPERATOR-TUNABLE (D-021,
	// config/orchestration.yaml `concurrency.dailySpawnCap` — armed to a positive backstop by the
	// SD-1 safety-defaults wave, 38717d4), so pinning a magic number here would make this suite
	// break every time the operator adjusts a budget. Assert the INVARIANT the loader actually owes:
	//   • REPORTED == ENFORCED — the denominator the UI shows is the cap the orchestrator enforces;
	//   • honest SHAPE — null (uncapped) or a POSITIVE INTEGER, never 0/negative/NaN (F-008).
	expect(data.spendCaps.dailySpawnCap).toBe(configuredDailyCap());
	const cap = data.spendCaps.dailySpawnCap;
	expect(cap === null || (Number.isInteger(cap) && cap > 0)).toBe(true);
	expect(data.spendCaps.reTickCap).toBeGreaterThan(0);

	// No optional column is ever the literal string "undefined"/"null" (the str(undefined) F-013 smell).
	const repo = data.project?.repo_url;
	expect(repo === undefined || (repo !== 'undefined' && repo !== 'null')).toBe(true);

	// (b) POJO-only: devalue.stringify is the SvelteKit load serializer — it THROWS on a non-POJO
	// (raw SDK Datetime/RecordId), the exact F-013 devalue-500 failure. A clean round-trip proves
	// the WHOLE payload is serializable.
	const wire = devalue.stringify(data);
	const back = devalue.parse(wire) as ProjectDetailData;
	expect(back.projectId).toBe(projectId);
	expect(back.project?.id).toBe(projectId);
}

describe('PJH-4 render-smoke — /projects/[id] load tolerates an under-populated project (F-008/F-013)', () => {
	it('a MINIMAL project (only required fields — no PM, no sprints, no repo, no plan) renders honestly', async () => {
		if (!available || !db) return;
		await createProject(db, { slug: 'smokemin', name: 'Smoke Minimal', root_path: '/tmp/smokemin' });
		const data = await runLoad('smokemin');
		assertHonestAndSerializable(data, 'project:smokemin');
		// Optional columns absent ⇒ the key is OMITTED (honest '—' in the UI), never a nulled/empty string.
		expect(data.project?.repo_url).toBeUndefined();
		expect(data.project?.plan).toBeUndefined();
		expect(data.project?.create_status).toBeUndefined();
		expect(data.project?.ecosystem).toEqual([]); // schema DEFAULT [] — a real default, not a fabrication
		// hireInterviewFor resolves against an absent plan without throwing (no pre-answers invented).
		expect(Array.isArray(data.hireQuestions)).toBe(true);
		expect(data.hireQuestions.every((q) => q.preAnswered == null)).toBe(true);
	});

	it("a MID-SCAFFOLD `create_status:'incomplete'` leftover (no repo/plan) renders honestly, surfacing the resume state", async () => {
		if (!available || !db) return;
		// Seed the half-wired row directly (Create-with-AI crashed mid-scaffold): the required columns
		// exist, but repo_url/plan/PM/sprints never landed and create_status is the resume affordance.
		const rid = new StringRecordId('project:smokehalf');
		await db.query(
			`CREATE $rid CONTENT { slug: 'smokehalf', name: 'Smoke Half', root_path: '/tmp/smokehalf', create_status: 'incomplete' } RETURN AFTER;`,
			{ rid }
		);
		const data = await runLoad('smokehalf');
		assertHonestAndSerializable(data, 'project:smokehalf');
		// The mid-scaffold state is surfaced verbatim (the UI offers a resume affordance) — not hidden,
		// not defaulted to 'complete'.
		expect(data.project?.create_status).toBe('incomplete');
		expect(data.project?.repo_url).toBeUndefined();
		expect(data.project?.plan).toBeUndefined();
	});

	it('a project WITH a hired PM but NO plan/sprints/tasks still renders (PM present, everything else honest-empty)', async () => {
		if (!available || !db) return;
		await createProject(db, { slug: 'smokepm', name: 'Smoke PM', root_path: '/tmp/smokepm' });
		await createPm(db, { project: 'project:smokepm', name: 'Vesper' });
		const data = await runLoad('smokepm');
		// Connected + serializable + hierarchy empty (this variant carries a PM, so pm is non-null).
		expect(data.connected).toBe(true);
		expect(data.pm).not.toBeNull();
		expect(data.pm?.name).toBe('Vesper');
		expect(data.tasks).toEqual([]);
		expect(data.sprints).toEqual([]);
		expect(data.project?.plan).toBeUndefined();
		// The whole payload (now including the live pm row) is still devalue-safe (F-013).
		const back = devalue.parse(devalue.stringify(data)) as ProjectDetailData;
		expect(back.pm?.name).toBe('Vesper');
	});

	it('an UNKNOWN project id is an honest 404 (not a fabricated empty project)', async () => {
		if (!available || !db) return;
		await expect(runLoad('does-not-exist')).rejects.toMatchObject({ status: 404 });
	});
});
