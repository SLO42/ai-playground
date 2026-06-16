import { StringRecordId } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	createInterviewRun,
	createRole,
	createRoleVersion,
	finalizeInterviewRun,
	listRoleEvents,
	swapActiveVersion,
	transitionLifecycle,
	withdrawRoleVersion,
	type Tier
} from './repo';
import {
	getProjectStaff,
	listProjectStaff,
	resolveStaff,
	staffRole,
	unstaffRole,
	type TierModelResolver
} from './staff';

// WORKFORCE-SPEC §6 project_staff data plane (wave v2.3) VERIFY — against a REAL throwaway
// SurrealDB (namespace dropped per run): migration pair discipline (apply-twice + half-applied
// recovery, F-015), normalizers asserted on SET rows (F-013), dedup (D-008), the fail-closed
// resolveStaff resolver (no row / disabled / non-deployable / pinned / tier_override / four
// shadow paths), staff→unstaff→re-staff idempotency + audit, and the red-team integrity
// properties (resolveStaff can NEVER spawn an unstaffed/disabled/non-deployable version;
// charter_note is screened; the migrations don't mutate existing workforce rows).

let tdb: TestDb;
let db: Db;

const REVIEW_PROPOSAL_MIG = '0046_review_proposal';
const PROJECT_STAFF_MIG = '0047_project_staff';

// Deterministic tier→model stub (D-003 seam). 'local' is intentionally UNMAPPED → fail-closed test.
const MODELS: Record<string, { provider: string; model_id: string }> = {
	haiku: { provider: 'claude', model_id: 'claude-haiku-test' },
	sonnet: { provider: 'claude', model_id: 'claude-sonnet-test' },
	opus: { provider: 'claude', model_id: 'claude-opus-test' }
};
const resolveTierModel: TierModelResolver = (tier: Tier) => MODELS[tier] ?? null;

const RUN_BASE = { provider: 'claude', fixture_set_sha: 'fsha-staff-1' };

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
	expect(applied).toContain(REVIEW_PROPOSAL_MIG);
	expect(applied).toContain(PROJECT_STAFF_MIG);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let seq = 0;
async function freshProject(): Promise<string> {
	const n = ++seq;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/x' } RETURN id;`,
		{ id: `staff_proj_${n}`, slug: `staff-proj-${n}` }
	);
	return String(rows[0].id);
}

async function freshRole(prefix = 'staff-role') {
	const slug = `${prefix}-${++seq}`;
	return createRole(db, { slug, name: `Role ${slug}`, purpose: 'test the staffing plane' });
}

async function freshVersion(roleId: string, tier: Tier = 'sonnet', core = 'Review everything.') {
	return createRoleVersion(db, { role: roleId, prompt_core: core, default_tier: tier });
}

/** Drive a fresh version to lifecycle 'passed' with a passing interview_run at `tier`'s model,
 *  swap it in as the role's active_version, and return the version id. */
async function staffedDeployableRole(prefix: string, tier: Tier = 'sonnet') {
	const role = await freshRole(prefix);
	const v = await freshVersion(role.id, tier);
	const run = await createInterviewRun(db, {
		role_version: v.id,
		tier,
		model_id: MODELS[tier].model_id,
		...RUN_BASE
	});
	await finalizeInterviewRun(db, run.id, { status: 'passed', planted_total: 4, planted_found: 4 });
	await swapActiveVersion(db, role.id, v.id);
	return { role, version: v, runId: run.id };
}

// ── migration pair discipline (F-015) ─────────────────────────────────────────────

describe('0046/0047 migrations — tables, indexes, apply-twice, half-applied', () => {
	it('defines review_proposal + project_staff with their indexes', async () => {
		const [info] = await db.query<[{ tables: Record<string, string> }]>('INFO FOR DB;');
		expect(Object.keys(info.tables)).toContain('review_proposal');
		expect(Object.keys(info.tables)).toContain('project_staff');

		const [rp] = await db.query<[{ indexes: Record<string, string> }]>(
			'INFO FOR TABLE review_proposal;'
		);
		expect(Object.keys(rp.indexes)).toContain('review_proposal_by_role');
		const [ps] = await db.query<[{ indexes: Record<string, string> }]>(
			'INFO FOR TABLE project_staff;'
		);
		expect(Object.keys(ps.indexes)).toContain('project_staff_dedup');
		expect(Object.keys(ps.indexes)).toContain('project_staff_by_project');
	});

	it('resolves the dangling role_version.proposal forward-ref — a review_proposal row is creatable', async () => {
		const role = await freshRole('rp-fk');
		const [rows] = await db.query<[Array<{ id: unknown; kind: string; status: string }>]>(
			`CREATE review_proposal CONTENT { role: $role, kind: 'prompt_revision' } RETURN AFTER;`,
			{ role: new StringRecordId(role.id) }
		);
		expect(rows[0].kind).toBe('prompt_revision');
		expect(rows[0].status).toBe('proposed'); // DEFAULT armed
	});

	it('apply-twice: runner skips both AND the raw DDL re-applies cleanly (OVERWRITE)', async () => {
		const again = await runMigrations(db, schemaMigrations);
		expect(again).toEqual([]);
		for (const id of [REVIEW_PROPOSAL_MIG, PROJECT_STAFF_MIG]) {
			const mig = schemaMigrations.find((m) => m.id === id);
			expect(mig).toBeDefined();
			await expect(db.query(mig!.up)).resolves.toBeDefined();
		}
	});

	it('half-applied recovery: a bare half-applied project_staff is absorbed by the re-run', async () => {
		const half = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: `${tdb.namespace}_half`,
			database: tdb.database
		});
		try {
			const without = schemaMigrations.filter(
				(m) => m.id !== REVIEW_PROPOSAL_MIG && m.id !== PROJECT_STAFF_MIG
			);
			await runMigrations(half, without);
			// The wedge shape that broke m0025: a bare (non-OVERWRITE) DEFINE TABLE.
			await half.query(`DEFINE TABLE project_staff SCHEMAFULL;`);

			const applied = await runMigrations(half, schemaMigrations);
			expect(applied).toEqual([REVIEW_PROPOSAL_MIG, PROJECT_STAFF_MIG]);

			// Recovered table is fully functional: fields + the UNIQUE dedup survived.
			const [p] = await half.query<[Array<{ id: unknown }>]>(
				`CREATE type::thing('project', 'half_p') CONTENT { slug: 'h', name: 'h', root_path: '/x' } RETURN id;`
			);
			const [r] = await half.query<[Array<{ id: unknown }>]>(
				`CREATE type::thing('role', 'half_r') CONTENT { slug: 'half-r', name: 'X', purpose: 'p' } RETURN id;`
			);
			const proj = new StringRecordId(String(p[0].id));
			const role = new StringRecordId(String(r[0].id));
			await half.query(
				`CREATE project_staff CONTENT { project: $proj, role: $role, enabled: true } RETURN AFTER;`,
				{ proj, role }
			);
			await expect(
				half.query(
					`CREATE project_staff CONTENT { project: $proj, role: $role, enabled: true };`,
					{ proj, role }
				)
			).rejects.toThrow(); // project_staff_dedup UNIQUE survived recovery
		} finally {
			await half
				.query('REMOVE NAMESPACE IF EXISTS type::namespace($ns);', {
					ns: `${tdb.namespace}_half`
				})
				.catch(() => {});
			await half.close().catch(() => {});
		}
	}, 60_000);
});

// ── DDL defaults + normalizer honesty (F-013) ─────────────────────────────────────

describe('project_staff — fail-closed default polarity + normalizers (F-013)', () => {
	it('enabled DEFAULTs to FALSE on a bare row (data-layer fail-closed)', async () => {
		const project = await freshProject();
		const role = await freshRole('polarity');
		const [rows] = await db.query<[Array<{ enabled: boolean }>]>(
			`CREATE project_staff CONTENT { project: $p, role: $r } RETURN AFTER;`,
			{ p: new StringRecordId(project), r: new StringRecordId(role.id) }
		);
		expect(rows[0].enabled).toBe(false);
	});

	it('staffRole stamps ISO datetimes (SET rows) and omits absent optionals → null', async () => {
		const project = await freshProject();
		const role = await freshRole('norm');
		const row = await staffRole(db, project, role.id);
		expect(typeof row.created_at).toBe('string'); // F-013: ISO on SET row, never 'undefined'
		expect(typeof row.updated_at).toBe('string');
		expect(row.pinned_version).toBeNull(); // absent option → null
		expect(row.tier_override).toBeNull();
		expect(row.charter_note).toBeNull();
		expect(row.enabled).toBe(true);
		expect(row.source).toBe('operator'); // DEFAULT
	});
});

// ── CRUD: staff → unstaff → re-staff, idempotent + audited ─────────────────────────

describe('staffRole / unstaffRole — soft, auditable, idempotent (D-008)', () => {
	it('staff creates ONE row + role_event{op:staffed}; re-staff UPSERTs the SAME row', async () => {
		const project = await freshProject();
		const role = await freshRole('crud');
		const first = await staffRole(db, project, role.id, { charterNote: 'guard the gate' });
		const second = await staffRole(db, project, role.id, { tierOverride: 'opus' });
		expect(second.id).toBe(first.id); // dedup: one row per (project, role)
		expect(second.tier_override).toBe('opus');
		expect(second.charter_note).toBe('guard the gate'); // MERGE kept the prior charter
		const all = await listProjectStaff(db, project);
		expect(all.filter((s) => s.role === role.id)).toHaveLength(1);
		const events = await listRoleEvents(db, role.id);
		expect(events.filter((e) => e.op === 'staffed')).toHaveLength(2);
	});

	it('unstaff sets enabled=false + role_event{op:unstaffed} — soft, not a hard delete', async () => {
		const project = await freshProject();
		const role = await freshRole('unstaff');
		const staffed = await staffRole(db, project, role.id);
		const off = await unstaffRole(db, project, role.id);
		expect(off).not.toBeNull();
		expect(off!.id).toBe(staffed.id); // SAME row — history preserved
		expect(off!.enabled).toBe(false);
		// Row still exists (soft delete).
		const still = await getProjectStaff(db, project, role.id);
		expect(still).not.toBeNull();
		expect(still!.enabled).toBe(false);
		const events = await listRoleEvents(db, role.id);
		expect(events.filter((e) => e.op === 'unstaffed')).toHaveLength(1);
	});

	it('staff → unstaff → re-staff reuses the SAME row and re-enables', async () => {
		const project = await freshProject();
		const role = await freshRole('cycle');
		const a = await staffRole(db, project, role.id);
		await unstaffRole(db, project, role.id);
		const c = await staffRole(db, project, role.id);
		expect(c.id).toBe(a.id);
		expect(c.enabled).toBe(true);
		const all = await listProjectStaff(db, project);
		expect(all.filter((s) => s.role === role.id)).toHaveLength(1); // never duplicated
	});

	it('unstaff on a never-staffed (project, role) is a null no-op (not an error)', async () => {
		const project = await freshProject();
		const role = await freshRole('noop');
		await expect(unstaffRole(db, project, role.id)).resolves.toBeNull();
	});

	it('shadow path — empty charter_note stores empty (screened), not undefined', async () => {
		const project = await freshProject();
		const role = await freshRole('empty-charter');
		const row = await staffRole(db, project, role.id, { charterNote: '' });
		expect(row.charter_note).toBe('');
	});
});

// ── resolveStaff — the fail-closed resolver (§6) + four shadow paths ────────────────

describe('resolveStaff — fail-closed staffing resolution (§6)', () => {
	it('returns null for an UNSTAFFED (project, role) — default polarity (fail-closed)', async () => {
		const project = await freshProject();
		const { role } = await staffedDeployableRole('rs-unstaffed');
		// role is deployable but NOT staffed to this project.
		await expect(resolveStaff(db, project, role.id, resolveTierModel)).resolves.toBeNull();
	});

	it('returns null for a DISABLED (enabled=false) row', async () => {
		const project = await freshProject();
		const { role } = await staffedDeployableRole('rs-disabled');
		await staffRole(db, project, role.id);
		await unstaffRole(db, project, role.id);
		await expect(resolveStaff(db, project, role.id, resolveTierModel)).resolves.toBeNull();
	});

	it('resolves the deployable incumbent version for a staffed role', async () => {
		const project = await freshProject();
		const { role, version, runId } = await staffedDeployableRole('rs-happy');
		await staffRole(db, project, role.id);
		const res = await resolveStaff(db, project, role.id, resolveTierModel);
		expect(res).not.toBeNull();
		expect(res!.version).toBe(version.id);
		expect(res!.provider).toBe('claude');
		expect(res!.model_id).toBe('claude-sonnet-test'); // default_tier sonnet → model
		expect(res!.certifiedBy).toBe(runId);
		expect(res!.stale).toBe(false);
		expect(res!.retired).toBe(false);
	});

	it('honest null when the staffed role has NO active_version and NO pin', async () => {
		const project = await freshProject();
		const role = await freshRole('rs-noincumbent'); // never swapped in a version
		await staffRole(db, project, role.id);
		await expect(resolveStaff(db, project, role.id, resolveTierModel)).resolves.toBeNull();
	});

	it('honest null when the staffed version is NON-DEPLOYABLE at the resolved model', async () => {
		const project = await freshProject();
		// Role certified at SONNET, but staff overrides to OPUS where no passing run exists.
		const { role } = await staffedDeployableRole('rs-wrongmodel', 'sonnet');
		await staffRole(db, project, role.id, { tierOverride: 'opus' });
		await expect(resolveStaff(db, project, role.id, resolveTierModel)).resolves.toBeNull();
	});

	it('honest null when the resolved tier is UNKNOWN to config (no fabricated model — F-008)', async () => {
		const project = await freshProject();
		const { role } = await staffedDeployableRole('rs-localtier', 'sonnet');
		await staffRole(db, project, role.id, { tierOverride: 'local' }); // 'local' unmapped in stub
		await expect(resolveStaff(db, project, role.id, resolveTierModel)).resolves.toBeNull();
	});

	it('respects pinned_version: resolves the pin even when it is NOT the active incumbent', async () => {
		const project = await freshProject();
		const { role, version: v1 } = await staffedDeployableRole('rs-pin', 'sonnet');
		// Certify a v2 and swap it in as the new incumbent.
		const v2 = await freshVersion(role.id, 'sonnet', 'v2 methodology');
		const run2 = await createInterviewRun(db, {
			role_version: v2.id,
			tier: 'sonnet',
			model_id: 'claude-sonnet-test',
			...RUN_BASE
		});
		await finalizeInterviewRun(db, run2.id, { status: 'passed', planted_total: 4, planted_found: 4 });
		await swapActiveVersion(db, role.id, v2.id);
		// Pin the project to v1 — the pin must survive the global swap (§2.4).
		await staffRole(db, project, role.id, { pinnedVersion: v1.id });
		const res = await resolveStaff(db, project, role.id, resolveTierModel);
		expect(res!.version).toBe(v1.id); // the PIN, not the v2 incumbent
	});

	it('respects tier_override: a sonnet-default role resolves at opus when certified there', async () => {
		const project = await freshProject();
		const { role, version } = await staffedDeployableRole('rs-tieroverride', 'sonnet');
		// Add a passing OPUS interview for the SAME version (same prompt_sha).
		const opusRun = await createInterviewRun(db, {
			role_version: version.id,
			tier: 'opus',
			model_id: 'claude-opus-test',
			...RUN_BASE
		});
		await finalizeInterviewRun(db, opusRun.id, { status: 'passed', planted_total: 4, planted_found: 4 });
		await staffRole(db, project, role.id, { tierOverride: 'opus' });
		const res = await resolveStaff(db, project, role.id, resolveTierModel);
		expect(res!.model_id).toBe('claude-opus-test');
		expect(res!.certifiedBy).toBe(opusRun.id);
	});

	it('tier precedence: tier_override > preferred_tier > default_tier', async () => {
		const project = await freshProject();
		// default_tier=sonnet; set preferred_tier=haiku on the role; certify both.
		const { role, version } = await staffedDeployableRole('rs-precedence', 'sonnet');
		await db.query(`UPDATE $rid SET preferred_tier = 'haiku';`, {
			rid: new StringRecordId(role.id)
		});
		const haikuRun = await createInterviewRun(db, {
			role_version: version.id,
			tier: 'haiku',
			model_id: 'claude-haiku-test',
			...RUN_BASE
		});
		await finalizeInterviewRun(db, haikuRun.id, {
			status: 'passed',
			planted_total: 4,
			planted_found: 4
		});
		// No tier_override → preferred_tier (haiku) wins over default_tier (sonnet).
		await staffRole(db, project, role.id);
		const res = await resolveStaff(db, project, role.id, resolveTierModel);
		expect(res!.model_id).toBe('claude-haiku-test');
	});
});

// ── RED-TEAM: fail-closed + integrity properties ───────────────────────────────────

describe('RED-TEAM — fail-closed invariants + integrity', () => {
	it('resolveStaff NEVER returns a version for a FAILED staffed version', async () => {
		const project = await freshProject();
		const role = await freshRole('rt-failed');
		const v = await freshVersion(role.id, 'sonnet');
		const run = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'sonnet',
			model_id: 'claude-sonnet-test',
			...RUN_BASE
		});
		await finalizeInterviewRun(db, run.id, { status: 'failed' }); // version → failed (terminal)
		// Pin directly to the failed version (swapActiveVersion would refuse it).
		await staffRole(db, project, role.id, { pinnedVersion: v.id });
		await expect(resolveStaff(db, project, role.id, resolveTierModel)).resolves.toBeNull();
	});

	it('resolveStaff NEVER returns a version for a WITHDRAWN staffed version', async () => {
		const project = await freshProject();
		const role = await freshRole('rt-withdrawn');
		const v = await freshVersion(role.id, 'sonnet');
		await withdrawRoleVersion(db, v.id); // draft → withdrawn
		await staffRole(db, project, role.id, { pinnedVersion: v.id });
		await expect(resolveStaff(db, project, role.id, resolveTierModel)).resolves.toBeNull();
	});

	it('resolveStaff NEVER returns a version whose prompt_sha is uncertified at the model (sha mismatch / never-interviewed draft)', async () => {
		const project = await freshProject();
		const role = await freshRole('rt-uncertified');
		const v = await freshVersion(role.id, 'sonnet'); // draft, never interviewed
		await staffRole(db, project, role.id, { pinnedVersion: v.id });
		await expect(resolveStaff(db, project, role.id, resolveTierModel)).resolves.toBeNull();
	});

	it('a RETIRED pinned version stays pin-deployable (annotated), surviving global retirement (§2.4/§4.6)', async () => {
		const project = await freshProject();
		const { role, version } = await staffedDeployableRole('rt-retired', 'sonnet');
		await transitionLifecycle(db, version.id, 'retired'); // operator retire
		await staffRole(db, project, role.id, { pinnedVersion: version.id });
		const res = await resolveStaff(db, project, role.id, resolveTierModel);
		expect(res).not.toBeNull(); // pins are a stability contract — retire does NOT break them
		expect(res!.retired).toBe(true); // honest annotation, not an alarm
	});

	it('charter_note is SCREENED — a planted secret is not stored raw (D-026)', async () => {
		const project = await freshProject();
		const role = await freshRole('rt-secret');
		const secret = 'use this key sk-ant-abcdefghijklmnop to log in';
		const row = await staffRole(db, project, role.id, { charterNote: secret });
		expect(row.charter_note).not.toContain('sk-ant-abcdefghijklmnop');
		expect(row.charter_note).toContain('[REDACTED');
		// And the RAW value is not in the stored DB row either.
		const [rows] = await db.query<[Array<{ charter_note: string }>]>(
			`SELECT charter_note FROM $rid;`,
			{ rid: new StringRecordId(row.id) }
		);
		expect(rows[0].charter_note).not.toContain('sk-ant-abcdefghijklmnop');
	});

	it('staffing one project does NOT staff the role to another project (isolation)', async () => {
		const projectA = await freshProject();
		const projectB = await freshProject();
		const { role } = await staffedDeployableRole('rt-isolation');
		await staffRole(db, projectA, role.id);
		const a = await resolveStaff(db, projectA, role.id, resolveTierModel);
		const b = await resolveStaff(db, projectB, role.id, resolveTierModel);
		expect(a).not.toBeNull();
		expect(b).toBeNull(); // B never hired this role
	});

	it('the migrations do NOT mutate existing workforce rows (additive)', async () => {
		// A role + version created BEFORE this assertion still reads back intact after re-running
		// the full migration set (apply-twice already ran; re-derive the rows here).
		const role = await freshRole('rt-additive');
		const v = await freshVersion(role.id, 'sonnet', 'untouched methodology');
		const shaBefore = v.prompt_sha;
		await runMigrations(db, schemaMigrations); // no-op re-run
		const [rows] = await db.query<[Array<{ prompt_sha: string; prompt_core: string }>]>(
			`SELECT prompt_sha, prompt_core FROM $rid;`,
			{ rid: new StringRecordId(v.id) }
		);
		expect(rows[0].prompt_sha).toBe(shaBefore);
		expect(rows[0].prompt_core).toBe('untouched methodology');
	});
});
