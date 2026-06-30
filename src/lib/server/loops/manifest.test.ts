// LOOP MANIFEST + ARM-GATE VERIFY — the declared layer (migration 0072) + the readiness arm gate, against
// a REAL throwaway SurrealDB. Covers: upsert idempotency (one row per identifier), checklist set, the PURE
// reconcile declared-vs-running (the three buckets), and the arm gate (blocks when not ready, allows when
// green, and the override path). The arm gate composes setPmAutonomous, so a hired PM is set up per case.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createPm, getPm } from '../projects/pm-repo';
import {
	upsertLoopManifest,
	getLoopManifest,
	listLoopManifest,
	setLoopChecklistItem,
	setLoopPhase,
	setLoopOverride,
	reconcileLoops,
	manifestByIdentifier,
	type LoopManifestRow
} from './manifest';
import { armAutonomousLoop, pmAutonomousLoopIdentifier } from './arm-gate';
import { READINESS_CHECKLIST } from '../../components/loops/readiness-core';
import type { LoopView } from './read';

let tdb: TestDb;
let db: Db;
let n = 0;

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

async function freshProjectWithPm(): Promise<string> {
	const slug = `loop_man_${++n}_${Date.now()}`;
	const project = await createProject(db, { slug, name: `Loop Man ${n}`, root_path: `F:/code/${slug}` });
	await createPm(db, { project: project.id, name: `PM ${n}`, persona: 'PM' });
	return project.id;
}

async function tickAll(identifier: string): Promise<void> {
	for (const item of READINESS_CHECKLIST) await setLoopChecklistItem(db, identifier, item.id, true);
}

/** A minimal honest LoopView for the pure reconcile tests. */
function view(id: string, kind: LoopView['kind'], scope: LoopView['scope'], projectId?: string): LoopView {
	return {
		id,
		name: id,
		kind,
		scope,
		projectId,
		tone: 'idle',
		stateLabel: 'idle',
		phase: 'unknown',
		cadenceLabel: 'event-driven',
		recentRuns: []
	};
}

describe('loop manifest CRUD (migration 0072)', () => {
	it('upsert is idempotent — one row per identifier; re-upsert UPDATEs, preserving checklist', async () => {
		const projectId = await freshProjectWithPm();
		const identifier = `pm-cadence:${projectId}`;
		const a = await upsertLoopManifest(db, { identifier, kind: 'pm-cadence', label: 'L', projectId });
		await setLoopChecklistItem(db, identifier, 'single_goal', true);
		const b = await upsertLoopManifest(db, { identifier, kind: 'pm-cadence', label: 'L2', projectId });
		expect(b.id).toBe(a.id); // same row, not a duplicate
		expect(b.label).toBe('L2'); // identity fields update
		expect(b.checklist.single_goal).toBe(true); // checklist preserved across re-declare

		const all = await listLoopManifest(db, { projectId });
		expect(all.filter((r) => r.identifier === identifier).length).toBe(1);
	}, 60_000);

	it('datetimes round-trip as ISO strings (F-013) and project link is set', async () => {
		const projectId = await freshProjectWithPm();
		const identifier = `pm-auto:${projectId}`;
		const row = await upsertLoopManifest(db, {
			identifier,
			kind: 'pm-autonomous',
			label: 'drive',
			projectId
		});
		expect(typeof row.createdAt).toBe('string');
		expect(row.createdAt).not.toBe('undefined');
		expect(row.projectId).toBe(projectId);
		expect(row.phase).toBe('L1'); // default
		expect(row.enabled).toBe(true);
	}, 60_000);

	it('setLoopPhase / setLoopOverride mutate only their fields', async () => {
		const projectId = await freshProjectWithPm();
		const identifier = `pm-auto:${projectId}`;
		await upsertLoopManifest(db, { identifier, kind: 'pm-autonomous', label: 'd', projectId });
		const phased = await setLoopPhase(db, identifier, 'L3');
		expect(phased?.phase).toBe('L3');
		const over = await setLoopOverride(db, identifier, true, 'operator says go');
		expect(over?.override).toBe(true);
		expect(over?.overrideReason).toBe('operator says go');
		expect(over?.overrideAt).toBeTruthy();
		const cleared = await setLoopOverride(db, identifier, false);
		expect(cleared?.override).toBe(false);
		expect(cleared?.overrideReason).toBeNull();
	}, 60_000);

	it('setters return null for an undeclared loop (no fabricated row)', async () => {
		expect(await setLoopChecklistItem(db, 'nope:nothing', 'single_goal', true)).toBeNull();
		expect(await getLoopManifest(db, 'nope:nothing')).toBeNull();
	}, 60_000);
});

describe('reconcileLoops (pure declared-vs-running)', () => {
	it('classifies the three buckets and joins on identifier === LoopView.id', () => {
		const running = [view('orch:drain', 'orchestrator', 'global'), view('pm-auto:project:x', 'pm-autonomous', 'project', 'project:x')];
		const manifest: LoopManifestRow[] = [
			{
				id: 'loop:1',
				identifier: 'orch:drain',
				kind: 'orchestrator',
				label: 'Orchestrator drain',
				projectId: null,
				cadence: null,
				phase: 'L1',
				enabled: true,
				checklist: {},
				override: false,
				overrideReason: null,
				overrideAt: null,
				createdAt: null,
				updatedAt: null
			},
			{
				id: 'loop:2',
				identifier: 'pm-auto:project:y', // declared but NOT running
				kind: 'pm-autonomous',
				label: 'Y drive',
				projectId: 'project:y',
				cadence: null,
				phase: 'L3',
				enabled: true,
				checklist: { single_goal: true },
				override: false,
				overrideReason: null,
				overrideAt: null,
				createdAt: null,
				updatedAt: null
			}
		];
		const out = reconcileLoops(manifest, running);
		const byId = Object.fromEntries(out.map((r) => [r.identifier, r]));
		expect(byId['orch:drain'].status).toBe('declared-and-running');
		expect(byId['orch:drain'].manifest?.id).toBe('loop:1');
		expect(byId['pm-auto:project:x'].status).toBe('running-undeclared');
		expect(byId['pm-auto:project:x'].manifest).toBeNull();
		expect(byId['pm-auto:project:y'].status).toBe('declared-not-running');
		expect(byId['pm-auto:project:y'].running).toBeNull();
		// readiness is computed from the manifest checklist
		expect(byId['pm-auto:project:y'].readiness.checked).toBe(1);
	});

	it('manifestByIdentifier indexes by identifier', () => {
		const m = manifestByIdentifier([
			{ identifier: 'a' } as LoopManifestRow,
			{ identifier: 'b' } as LoopManifestRow
		]);
		expect(Object.keys(m).sort()).toEqual(['a', 'b']);
	});
});

describe('armAutonomousLoop — the readiness gate (LOOP-ENGINEERING step 5)', () => {
	it('BLOCKS when the loop is not ready (no override) — nothing armed, missing surfaced', async () => {
		const projectId = await freshProjectWithPm();
		const res = await armAutonomousLoop(db, projectId);
		expect(res.ok).toBe(false);
		if (res.ok === false && res.reason === 'not-ready') {
			expect(res.missing.length).toBe(READINESS_CHECKLIST.length);
		} else {
			throw new Error('expected not-ready');
		}
		// The PM was NOT armed.
		expect((await getPm(db, projectId))?.autonomous).toBe(false);
	}, 60_000);

	it('ALLOWS when the checklist is green — arms the PM, not overridden', async () => {
		const projectId = await freshProjectWithPm();
		const identifier = pmAutonomousLoopIdentifier(projectId);
		await upsertLoopManifest(db, { identifier, kind: 'pm-autonomous', label: 'd', projectId });
		await tickAll(identifier);
		const res = await armAutonomousLoop(db, projectId);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.autonomous).toBe(true);
			expect(res.overridden).toBe(false);
		}
		expect((await getPm(db, projectId))?.autonomous).toBe(true);
	}, 60_000);

	it('OVERRIDE path arms a not-ready loop and records the override', async () => {
		const projectId = await freshProjectWithPm();
		const res = await armAutonomousLoop(db, projectId, { override: true, overrideReason: 'launch window' });
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.autonomous).toBe(true);
			expect(res.overridden).toBe(true);
		}
		expect((await getPm(db, projectId))?.autonomous).toBe(true);
		const row = await getLoopManifest(db, pmAutonomousLoopIdentifier(projectId));
		expect(row?.override).toBe(true);
		expect(row?.overrideReason).toBe('launch window');
		// A persisted override satisfies the gate on a later arm with no fresh override.
		const again = await armAutonomousLoop(db, projectId);
		expect(again.ok).toBe(true);
	}, 60_000);

	it('no hired PM ⇒ no-pm (arming never auto-hires), even when not ready', async () => {
		const slug = `loop_nopm_${++n}_${Date.now()}`;
		const project = await createProject(db, { slug, name: `No PM ${n}`, root_path: `F:/code/${slug}` });
		const res = await armAutonomousLoop(db, project.id, { override: true });
		expect(res.ok).toBe(false);
		if (res.ok === false) expect(res.reason).toBe('no-pm');
	}, 60_000);
});
