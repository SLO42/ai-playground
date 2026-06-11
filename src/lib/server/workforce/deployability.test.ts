import { StringRecordId } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { checkDeployability, resolveActiveDeployability } from './deployability';
import {
	addPanelVerdict,
	closePanelVerdictOutcome,
	createInterviewRun,
	createRole,
	createRoleVersion,
	finalizeInterviewRun,
	markInterviewRunStale,
	retireRoleVersion,
	swapActiveVersion,
	withdrawRoleVersion,
	WorkforceInputError
} from './repo';
import { roleTrackRecord } from './track-record';

// TASK 16.3 VERIFY — the §2.4 fail-closed resolver matrix (certified / uncertified /
// pinned-after-swap / retired-pinned / sha-mismatch / stale / failed / withdrawn) and
// the §2.5 roleTrackRecord null-honesty, against a REAL throwaway SurrealDB.

let tdb: TestDb;
let db: Db;

const MODEL = 'claude-sonnet-test-1';
const OTHER_MODEL = 'claude-haiku-test-1';
const RUN_BASE = {
	tier: 'sonnet' as const,
	provider: 'claude',
	model_id: MODEL,
	fixture_set_sha: 'fsha-1'
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
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied).toContain('0031_workforce');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let seq = 0;
async function freshRole() {
	const slug = `dep-role-${++seq}`;
	return createRole(db, { slug, name: slug, purpose: 'resolver matrix' });
}

async function freshVersion(roleId: string, core = `core ${++seq}`) {
	return createRoleVersion(db, { role: roleId, prompt_core: core, default_tier: 'sonnet' });
}

/** Run + pass one certification campaign at MODEL (the §2.4 existence proof). */
async function certify(versionId: string, modelId = MODEL) {
	const run = await createInterviewRun(db, {
		role_version: versionId,
		...RUN_BASE,
		model_id: modelId
	});
	return finalizeInterviewRun(db, run.id, {
		status: 'passed',
		planted_total: 4,
		planted_found: 4,
		false_positives: 0
	});
}

describe('checkDeployability — the §2.4 matrix', () => {
	it('CERTIFIED: a passing (prompt_sha × model_id) interview makes the pair spawnable', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const run = await certify(v.id);
		const verdict = await checkDeployability(db, v.id, MODEL);
		expect(verdict).toEqual({
			deployable: true,
			reason: null,
			certifiedBy: run.id,
			stale: false,
			retired: false
		});
	});

	it('UNCERTIFIED: no interview at all → fail-closed with the honest reason', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const verdict = await checkDeployability(db, v.id, MODEL);
		expect(verdict.deployable).toBe(false);
		expect(verdict.reason).toContain('never certified');
		expect(verdict.certifiedBy).toBeNull();
	});

	it("MODEL SWAP: certified on another model_id → honest 'certified on <old model_id>'", async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		await certify(v.id, OTHER_MODEL);
		const verdict = await checkDeployability(db, v.id, MODEL);
		expect(verdict.deployable).toBe(false);
		expect(verdict.reason).toContain(`no passing interview at ${MODEL}`);
		expect(verdict.reason).toContain(`certified on ${OTHER_MODEL}`);
	});

	it('a FAILED campaign run does not certify (only status=passed counts)', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const run = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await finalizeInterviewRun(db, run.id, { status: 'failed' });
		const verdict = await checkDeployability(db, v.id, MODEL);
		expect(verdict.deployable).toBe(false);
		// the version is now lifecycle 'failed' → the hard block names it
		expect(verdict.reason).toContain("'failed'");
	});

	it('PINNED SURVIVES SWAP: the old incumbent stays deployable after the pointer moves', async () => {
		const role = await freshRole();
		const v1 = await freshVersion(role.id, 'pin v1');
		const v2 = await freshVersion(role.id, 'pin v2');
		await certify(v1.id);
		await certify(v2.id);
		await swapActiveVersion(db, role.id, v1.id);
		await swapActiveVersion(db, role.id, v2.id); // v1 swapped OUT
		const pinned = await checkDeployability(db, v1.id, MODEL);
		expect(pinned.deployable).toBe(true); // pins never consult active_version
	});

	it('RETIRED-PINNED: an explicitly retired version stays pinnable-spawnable, annotated', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		await certify(v.id);
		await retireRoleVersion(db, v.id);
		const verdict = await checkDeployability(db, v.id, MODEL);
		expect(verdict.deployable).toBe(true);
		expect(verdict.retired).toBe(true); // 'produced by retiring vN' annotation source
	});

	it('SHA MISMATCH: a passing run vouching for different prompt text = hard fail', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const run = await certify(v.id);
		// Simulate tamper/import drift (content fields are immutable in product code).
		await db.query(`UPDATE $rid SET prompt_sha = 'deadbeef' RETURN AFTER;`, {
			rid: new StringRecordId(run.id)
		});
		const verdict = await checkDeployability(db, v.id, MODEL);
		expect(verdict.deployable).toBe(false);
		expect(verdict.reason).toContain('prompt_sha mismatch');
		expect(verdict.reason).toContain('re-interview required');
	});

	it('STALE STILL CERTIFIES: all-stale certifications deploy with the honest flag (§3.7)', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const run = await certify(v.id);
		await markInterviewRunStale(db, run.id);
		const verdict = await checkDeployability(db, v.id, MODEL);
		expect(verdict.deployable).toBe(true);
		expect(verdict.stale).toBe(true);

		// A fresh re-certification clears the flag (latest fresh run preferred).
		const rerun = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await finalizeInterviewRun(db, rerun.id, { status: 'passed' });
		const fresh = await checkDeployability(db, v.id, MODEL);
		expect(fresh).toMatchObject({ deployable: true, stale: false, certifiedBy: rerun.id });
	});

	it('WITHDRAWN hard-blocks even with a passing interview on record', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		await certify(v.id);
		await withdrawRoleVersion(db, v.id);
		const verdict = await checkDeployability(db, v.id, MODEL);
		expect(verdict.deployable).toBe(false);
		expect(verdict.reason).toContain("'withdrawn'");
	});

	it('shadow paths: missing version and empty model_id fail closed with named reasons', async () => {
		const missing = await checkDeployability(db, 'role_version:nope', MODEL);
		expect(missing.deployable).toBe(false);
		expect(missing.reason).toContain('not found');

		const role = await freshRole();
		const v = await freshVersion(role.id);
		const noModel = await checkDeployability(db, v.id, '');
		expect(noModel.deployable).toBe(false);
		expect(noModel.reason).toContain('no resolved model_id');
	});
});

describe('resolveActiveDeployability — the unpinned consumer path (§2.3/§2.4)', () => {
	it('no active version → fail-closed honest empty (NONE = not deployable)', async () => {
		const role = await freshRole();
		await freshVersion(role.id);
		const verdict = await resolveActiveDeployability(db, role.id, MODEL);
		expect(verdict.deployable).toBe(false);
		expect(verdict.reason).toContain('no active version');
		expect(verdict.roleVersion).toBeNull();
	});

	it('resolves through role.active_version and certifies against (prompt_sha × model_id)', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		await certify(v.id);
		await swapActiveVersion(db, role.id, v.id);
		const ok = await resolveActiveDeployability(db, role.id, MODEL);
		expect(ok.deployable).toBe(true);
		expect(ok.roleVersion).toBe(v.id);
		// …and the same incumbent at an uncertified model fails closed.
		const wrongModel = await resolveActiveDeployability(db, role.id, OTHER_MODEL);
		expect(wrongModel.deployable).toBe(false);
	});

	it('a missing role fails closed', async () => {
		const verdict = await resolveActiveDeployability(db, 'role:ghost', MODEL);
		expect(verdict.deployable).toBe(false);
		expect(verdict.reason).toContain('not found');
	});
});

// ── §2.5 roleTrackRecord — null-honest rollup skeleton ───────────────────────────

describe('roleTrackRecord — null-honesty (§2.5, F-008)', () => {
	it('a version with NO data: empty interview plane, zero counts, null metrics, pre-B2 literally null', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const tr = await roleTrackRecord(db, v.id);
		expect(tr.roleVersion).toBe(v.id);
		expect(tr.interviews).toEqual([]); // 'no interviews yet'
		expect(tr.panel.total).toBe(0);
		expect(tr.panel.calibration).toEqual([]);
		expect(tr.field).toEqual({
			sessions: 0,
			events: 0,
			costUsd: null, // never a dressed-up $0
			tokensIn: null,
			tokensOut: null,
			avgDurationMs: null,
			errors: 0
		});
		// §2.5 B2 boundary — declared null NOW; UI renders '— (needs B2)'.
		expect(tr.refutationRate).toBeNull();
		expect(tr.fixLoopRate).toBeNull();
		expect(tr.costPerCertifiedFeature).toBeNull();
		expect(tr.suppressionCount).toBeNull();
	});

	it('interview plane: recall/FP from the latest terminal run; cost from PRICED runs only', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const r1 = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		// UNPRICED pass: figures land, cost stays null (F-008).
		await finalizeInterviewRun(db, r1.id, {
			status: 'passed',
			planted_total: 4,
			planted_found: 3,
			false_positives: 1
		});
		let tr = await roleTrackRecord(db, v.id);
		expect(tr.interviews).toHaveLength(1);
		expect(tr.interviews[0]).toMatchObject({
			model_id: MODEL,
			runs: 1,
			passed: 1,
			recall: 0.75,
			falsePositives: 1,
			costUsd: null, // ran, but nothing was priced — null, not $0
			stale: false
		});

		// A PRICED evidence run at the same model sums into the cell.
		const r2 = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await finalizeInterviewRun(db, r2.id, {
			status: 'passed',
			planted_total: 4,
			planted_found: 4,
			false_positives: 0,
			cost_usd: 0.42
		});
		tr = await roleTrackRecord(db, v.id);
		expect(tr.interviews[0].runs).toBe(2);
		expect(tr.interviews[0].costUsd).toBeCloseTo(0.42);
		expect(tr.interviews[0].recall).toBe(1); // latest terminal run
	});

	it('recall is null (never 0%) when the terminal run had planted_total = 0', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const run = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await finalizeInterviewRun(db, run.id, { status: 'passed' }); // no counts recorded
		const tr = await roleTrackRecord(db, v.id);
		expect(tr.interviews[0].recall).toBeNull();
	});

	it('panel plane: approve/pushback split, open vs closed outcomes, real calibration cells', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		const s1 = await sessionId();
		const s2 = await sessionId();
		const s3 = await sessionId();
		const a = await addPanelVerdict(db, {
			artifact: role.id,
			artifact_kind: 'review_proposal',
			validator_session: s1,
			role_version: v.id,
			role: role.id,
			validator_kind: 'catalog_role',
			verdict: 'approve',
			confidence: 'high'
		});
		await addPanelVerdict(db, {
			artifact: role.id,
			artifact_kind: 'review_proposal',
			validator_session: s2,
			role_version: v.id,
			role: role.id,
			validator_kind: 'catalog_role',
			verdict: 'pushback',
			confidence: 'low'
		});
		await addPanelVerdict(db, {
			artifact: role.id,
			artifact_kind: 'task',
			validator_session: s3,
			role_version: v.id,
			role: role.id,
			validator_kind: 'catalog_role',
			verdict: 'approve'
		});
		await closePanelVerdictOutcome(db, a.id, 'upheld');

		const tr = await roleTrackRecord(db, v.id);
		expect(tr.panel.total).toBe(3);
		expect(tr.panel.approve).toBe(2);
		expect(tr.panel.pushback).toBe(1);
		expect(tr.panel.outcomes.upheld).toBe(1);
		expect(tr.panel.outcomes.open).toBe(2);
		// Calibration only from rows carrying BOTH confidence and a closed outcome.
		expect(tr.panel.calibration).toEqual([{ confidence: 'high', outcome: 'upheld', count: 1 }]);
	});

	it('field plane: agent_event ⋈ session.role_version — priced cost only, honest token nulls', async () => {
		const role = await freshRole();
		const v = await freshVersion(role.id);
		// One session linked to the version, one unrelated (must not leak in).
		const [linked] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT {
				kind: 'interview', model: { provider: 'claude', model_id: $m },
				role: $role, role_version: $vid
			} RETURN id;`,
			{ m: MODEL, role: new StringRecordId(role.id), vid: new StringRecordId(v.id) }
		);
		const unrelated = await sessionId();
		await db.query(
			`CREATE agent_event CONTENT { session: $sid, type: 'completion', tokens_in: 100, tokens_out: 50, duration_ms: 1200 };
			 CREATE agent_event CONTENT { session: $sid, type: 'error' };
			 CREATE agent_event CONTENT { session: $other, type: 'completion', cost_usd: 9.99 };`,
			{ sid: linked[0].id, other: new StringRecordId(unrelated) }
		);
		const tr = await roleTrackRecord(db, v.id);
		expect(tr.field.sessions).toBe(1);
		expect(tr.field.events).toBe(2); // the unrelated session's event never leaks in
		expect(tr.field.tokensIn).toBe(100);
		expect(tr.field.tokensOut).toBe(50);
		expect(tr.field.costUsd).toBeNull(); // no PRICED row on the linked session
		expect(tr.field.avgDurationMs).toBe(1200);
		expect(tr.field.errors).toBe(1);
	});

	it('a missing version is a caller bug (named error), not an empty state', async () => {
		await expect(roleTrackRecord(db, 'role_version:ghost')).rejects.toThrow(WorkforceInputError);
	});
});

async function sessionId(): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session SET kind = 'review', model = { provider: 'claude', model_id: 'claude-test' } RETURN id;`
	);
	return String(rows[0].id);
}
