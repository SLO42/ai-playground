// LP-3 LOOPS TAB VERIFY — the /projects/[id] loader's per-project loops composition + the composed
// manifest actions, against a REAL throwaway SurrealDB. The Loops tab reuses the /loops surface
// (LoopList/LoopCard/LoopReadiness/LoopControls) scoped to ONE project, so the contract under test is:
//
//   • SCOPING — the loader returns ONLY this project's declared manifest rows (loopManifestMap /
//     loopDeclaredOnly); another project's declarations never bleed in (F-008);
//   • HONEST EMPTY — a project with no armed PM, no cadence and nothing declared returns
//     loops:[], loopManifestMap:{}, loopDeclaredOnly:[] (the tab renders "no loops … yet");
//   • ACTION WIRING — the /loops route's `loopChecklist`/`loopPhase` actions are COMPOSED onto this
//     route (the LoopReadiness forms POST to the CURRENT page), and a tick persists to the manifest;
//   • TAB REGISTRATION — 'loops' is in the page's TABS source-of-truth, so the `?tab=loops`
//     deep-link validator (which derives from TABS) accepts it.
//
// The loader/actions read tryGetDb() (the runtime singleton) — we init it with the test DB so the
// real route code runs unchanged. F-013: the returned rows carry ISO strings only (devalue-safe).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject } from '$lib/server/projects/repo';
import { upsertLoopManifest, getLoopManifest } from '$lib/server/loops/manifest';
import { pmAutonomousLoopIdentifier } from '$lib/server/loops/arm-gate';
import { READINESS_CHECKLIST } from '$lib/components/loops/readiness-core';
import { load, actions, type ProjectDetailData } from './+page.server';

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
	await db.close();
	// Re-init as the runtime singleton so the loader/actions' tryGetDb() returns this DB.
	db = await initDb({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});

	await createProject(db, { slug: 'loopsa', name: 'Loops A', root_path: '/tmp/loopsa' });
	await createProject(db, { slug: 'loopsb', name: 'Loops B', root_path: '/tmp/loopsb' });
	await createProject(db, { slug: 'loopsempty', name: 'Loops Empty', root_path: '/tmp/loopse' });
}, 90_000);

afterAll(async () => {
	await closeDb().catch(() => {});
	await tdb?.teardown();
});

/** Invoke the REAL project loader with a no-op depends + a bare URL (no ?session=). */
async function runLoad(slug: string): Promise<ProjectDetailData> {
	return (await load({
		params: { id: slug },
		depends: () => {},
		url: new URL(`http://localhost/projects/${slug}`)
	} as unknown as Parameters<typeof load>[0])) as ProjectDetailData;
}

function fd(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

describe('LP-3 loader — per-project loops manifest composition (scoped, honest)', () => {
	it('returns ONLY this project’s declared loops — another project’s manifest never bleeds in', async () => {
		const idA = pmAutonomousLoopIdentifier('project:loopsa');
		const idB = pmAutonomousLoopIdentifier('project:loopsb');
		await upsertLoopManifest(db, {
			identifier: idA,
			kind: 'pm-autonomous',
			label: 'A — autonomous drive',
			projectId: 'project:loopsa'
		});
		await upsertLoopManifest(db, {
			identifier: idB,
			kind: 'pm-autonomous',
			label: 'B — autonomous drive',
			projectId: 'project:loopsb'
		});

		const data = await runLoad('loopsa');
		expect(data.connected).toBe(true);
		// The declared row for A surfaces (no live counterpart ⇒ declared-not-running), B's does not.
		expect(data.loopDeclaredOnly.map((r) => r.identifier)).toContain(idA);
		expect(data.loopDeclaredOnly.map((r) => r.identifier)).not.toContain(idB);
		expect(Object.keys(data.loopManifestMap)).toContain(idA);
		expect(Object.keys(data.loopManifestMap)).not.toContain(idB);
		// No PM armed/scheduled ⇒ no RUNNING loops either (honest — the declared section carries A).
		expect(data.loops).toEqual([]);
	});

	it('a project with nothing armed, scheduled or declared is honestly empty (F-008)', async () => {
		const data = await runLoad('loopsempty');
		expect(data.connected).toBe(true);
		expect(data.loops).toEqual([]);
		expect(data.loopManifestMap).toEqual({});
		expect(data.loopDeclaredOnly).toEqual([]);
	});
});

describe('LP-3 actions — the /loops manifest actions are composed onto the project route', () => {
	it('loopChecklist is hosted here and a tick persists to the manifest (form-carried identity)', async () => {
		expect(typeof actions.loopChecklist).toBe('function');
		const identifier = pmAutonomousLoopIdentifier('project:loopsa');
		const item = READINESS_CHECKLIST[0];
		const request = {
			formData: async () =>
				fd({
					identifier,
					kind: 'pm-autonomous',
					label: 'A — autonomous drive',
					projectId: 'project:loopsa',
					itemId: item.id,
					checked: 'true'
				})
		} as unknown as Request;
		const res = (await actions.loopChecklist({ request } as unknown as Parameters<
			typeof actions.loopChecklist
		>[0])) as { loop?: { ok?: boolean; action?: string } };
		expect(res.loop?.ok).toBe(true);
		expect(res.loop?.action).toBe('checklist');
		const row = await getLoopManifest(db, identifier);
		expect(row?.checklist?.[item.id]).toBe(true);
	});

	it('loopPhase is hosted here too (LoopManageControls parity with /loops)', async () => {
		expect(typeof actions.loopPhase).toBe('function');
	});
});

describe('LP-3 tab registration — the loops tab is a KNOWN tab (deep-link ?tab=loops valid)', () => {
	it("the page's TABS source-of-truth contains 'loops' (the validator derives from TABS)", () => {
		const src = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');
		const tabsBlock = /const TABS = \[([\s\S]*?)\] as const;/.exec(src);
		expect(tabsBlock).not.toBeNull();
		expect(tabsBlock![1]).toContain("'loops'");
		// And the deep-link validator reads the SAME list (guards against a hand-rolled second list).
		expect(src).toContain('(TABS as readonly string[]).includes(requested)');
	});
});
