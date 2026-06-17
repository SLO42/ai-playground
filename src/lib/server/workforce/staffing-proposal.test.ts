import { StringRecordId } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { activateGauntletFixture, newSentinelUlid } from './activation';
import {
	createGauntletFixture,
	createGauntletKey,
	createInterviewRun,
	createRole,
	createRoleVersion,
	finalizeInterviewRun,
	swapActiveVersion,
	type Tier
} from './repo';
import { setCapabilityNeeds } from './capability-match';
import { getProjectStaff, resolveStaff, staffRole, type TierModelResolver } from './staff';
import {
	confirmStaffing,
	loadProjectStaffingView,
	proposeStaffing,
	rejectStaffing,
	StaffingGateError
} from './staffing-proposal';
import { unstaffRole } from './staff';

// CAPABILITY-MATCH-SPEC §4/§5 (BL-3) VERIFY — the operator-gated STAFFING PROPOSAL bridge +
// the staffRole concurrency no-op fold, against a REAL throwaway SurrealDB. Covers:
//   • PROPOSE-ONLY: proposeStaffing opens a review_proposal{kind:'staffing'} and writes NOTHING
//     to project_staff (the red-team invariant: no auto-staff at propose time).
//   • the matcher gate: a non-REUSE candidate (EXTEND / proves-none) is REFUSED a one-click propose.
//   • CONFIRM is D-039-gated: no operator confirm → StaffingGateError; with confirm → staffRole writes
//     the row + the proposal closes 'swapped'. NO auto-staff path.
//   • anti-spam + interrupt: a second propose returns the open proposal; a double-confirm is idempotent.
//   • staffRole concurrency: a concurrent double-staff collapses to ONE row (graceful no-op), and an
//     UNRELATED error is NOT swallowed.

let tdb: TestDb;
let db: Db;

const MODELS: Record<string, { provider: string; model_id: string }> = {
	haiku: { provider: 'claude', model_id: 'claude-haiku-test' },
	sonnet: { provider: 'claude', model_id: 'claude-sonnet-test' },
	opus: { provider: 'claude', model_id: 'claude-opus-test' }
};
const resolveTierModel: TierModelResolver = (tier: Tier) => MODELS[tier] ?? null;
const RUN_BASE = { provider: 'claude', fixture_set_sha: 'fsha-staffprop-1' };

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

async function freshProject(): Promise<string> {
	const n = ++seq;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/x' } RETURN id;`,
		{ id: `sp_proj_${n}`, slug: `sp-proj-${n}` }
	);
	return String(rows[0].id);
}

/** A role PROVEN on defect class `cls` (active version + passing run + active operator-keyed
 *  fixture) — the full §3.8 REUSE substrate. Returns role/version ids. */
async function provenRole(prefix: string, cls: string, tier: Tier = 'sonnet') {
	const slug = `${prefix}-${++seq}`;
	const role = await createRole(db, { slug, name: `Role ${slug}`, purpose: 'staffing-proposal test' });
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `Review for ${cls}.`,
		default_tier: tier
	});
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: `fx-${cls}-${++seq}`,
		kind: 'planted_defect',
		work: { 'a.ts': 'l1\nl2\nprocess.kill(pid, 0);\n' },
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		author: 'operator',
		plants: [{ id: 'p1', class: cls, detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'kill' } }]
	});
	await activateGauntletFixture(db, fixture.id);
	const run = await createInterviewRun(db, {
		role_version: version.id,
		tier,
		model_id: MODELS[tier].model_id,
		...RUN_BASE
	});
	await finalizeInterviewRun(db, run.id, { status: 'passed', planted_total: 4, planted_found: 4 });
	await swapActiveVersion(db, role.id, version.id);
	return { role, version, runId: run.id };
}

// ── PROPOSE-ONLY ─────────────────────────────────────────────────────────────────────

describe('proposeStaffing — PROPOSE-ONLY (no auto-staff)', () => {
	it('opens a review_proposal{kind:staffing} carrying the matcher evidence and writes NOTHING to project_staff', async () => {
		const project = await freshProject();
		const { role } = await provenRole('reuse', 'cls-a');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-a'] });

		const res = await proposeStaffing(db, { project, role: role.id });
		expect(res.created).toBe(true);
		expect(res.proposal.kind).toBe('staffing');
		expect(res.proposal.status).toBe('proposed');
		expect(res.proposal.role).toBe(role.id);
		// Evidence persisted in trigger (the operator reads it).
		expect(res.proposal.trigger.project).toBe(project);
		expect(res.proposal.trigger.match).toBe('reuse');
		expect(res.proposal.trigger.covered).toEqual(['cls-a']);
		// THE RED-TEAM INVARIANT: no project_staff row exists yet (propose ≠ staff).
		expect(await getProjectStaff(db, project, role.id)).toBeNull();
		expect(await resolveStaff(db, project, role.id, resolveTierModel)).toBeNull();
	});

	it('REFUSES a candidate that proves none of the needs (matcher gate, F-008)', async () => {
		const project = await freshProject();
		const { role } = await provenRole('noprove', 'cls-x');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-x'] });
		// Make a DIFFERENT role with no coverage of the need.
		const other = await createRole(db, { slug: `bare-${++seq}`, name: 'Bare', purpose: 'no coverage' });
		await expect(proposeStaffing(db, { project, role: other.id })).rejects.toBeInstanceOf(StaffingGateError);
		// the proven role IS a valid reuse though
		const ok = await proposeStaffing(db, { project, role: role.id });
		expect(ok.created).toBe(true);
	});

	it('REFUSES an EXTEND candidate (covers some, not all) at the one-click bridge', async () => {
		const project = await freshProject();
		const { role } = await provenRole('extend', 'cls-1');
		// A SECOND proven role establishes 'cls-2' in the operator-confirmed vocabulary so the
		// project can legitimately NEED it — but the candidate role only proves cls-1 → EXTEND.
		await provenRole('extend-other', 'cls-2');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-1', 'cls-2'] });
		await expect(proposeStaffing(db, { project, role: role.id })).rejects.toBeInstanceOf(StaffingGateError);
	});

	it('anti-spam: a second propose for the same (project, role) returns the OPEN one (created:false)', async () => {
		const project = await freshProject();
		const { role } = await provenRole('spam', 'cls-s');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-s'] });
		const first = await proposeStaffing(db, { project, role: role.id });
		const second = await proposeStaffing(db, { project, role: role.id });
		expect(second.created).toBe(false);
		expect(second.proposal.id).toBe(first.proposal.id);
	});
});

// ── CONFIRM (D-039-gated) ──────────────────────────────────────────────────────────────

describe('confirmStaffing — D-039 gated, NO auto-staff', () => {
	it('refuses without an operator confirm (fail-closed)', async () => {
		const project = await freshProject();
		const { role } = await provenRole('conf', 'cls-c');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-c'] });
		const { proposal } = await proposeStaffing(db, { project, role: role.id });
		await expect(
			confirmStaffing(db, { proposal: proposal.id, operatorConfirmed: false })
		).rejects.toBeInstanceOf(StaffingGateError);
		// still not staffed
		expect(await getProjectStaff(db, project, role.id)).toBeNull();
	});

	it('with confirm: staffRole writes the row (enabled) + the proposal closes swapped + resolveStaff now resolves', async () => {
		const project = await freshProject();
		const { role, version } = await provenRole('conf2', 'cls-d');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-d'] });
		const { proposal } = await proposeStaffing(db, { project, role: role.id });

		const res = await confirmStaffing(db, { proposal: proposal.id, operatorConfirmed: true });
		expect(res.staffed).toBe(true);
		expect(res.staff.enabled).toBe(true);
		expect(res.staff.source).toBe('pm_validated');
		expect(res.proposal.status).toBe('swapped');
		expect(res.proposal.decided_at).not.toBeNull();
		// The staffed (project, role) now resolves to the certified version's model (additive routing).
		const resolved = await resolveStaff(db, project, role.id, resolveTierModel);
		expect(resolved?.version).toBe(version.id);
		expect(resolved?.model_id).toBe(MODELS.sonnet.model_id);
	});

	it('double-confirm is an idempotent absorb (staffed:false the 2nd time, ONE row)', async () => {
		const project = await freshProject();
		const { role } = await provenRole('conf3', 'cls-e');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-e'] });
		const { proposal } = await proposeStaffing(db, { project, role: role.id });
		const first = await confirmStaffing(db, { proposal: proposal.id, operatorConfirmed: true });
		const second = await confirmStaffing(db, { proposal: proposal.id, operatorConfirmed: true });
		expect(first.staffed).toBe(true);
		expect(second.staffed).toBe(false);
		expect(second.staff.id).toBe(first.staff.id);
	});

	it('rejectStaffing closes the proposal terminally and confirm then refuses', async () => {
		const project = await freshProject();
		const { role } = await provenRole('rej', 'cls-r');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-r'] });
		const { proposal } = await proposeStaffing(db, { project, role: role.id });
		const closed = await rejectStaffing(db, { proposal: proposal.id, reason: 'not needed' });
		expect(['rejected_by_operator', 'withdrawn']).toContain(closed.status);
		await expect(
			confirmStaffing(db, { proposal: proposal.id, operatorConfirmed: true })
		).rejects.toBeInstanceOf(StaffingGateError);
		expect(await getProjectStaff(db, project, role.id)).toBeNull();
	});

	it('refuses to confirm a non-staffing proposal (kind guard)', async () => {
		const fresh = await getReviewProposalNonStaffing();
		await expect(
			confirmStaffing(db, { proposal: fresh, operatorConfirmed: true })
		).rejects.toBeInstanceOf(StaffingGateError);
	});
});

/** Create a kind:'prompt_revision' proposal directly (a non-staffing proposal) to prove the
 *  staffing surface refuses to act on it. */
async function getReviewProposalNonStaffing(): Promise<string> {
	const slug = `pr-role-${++seq}`;
	const role = await createRole(db, { slug, name: 'PR Role', purpose: 'kind guard' });
	const { createReviewProposal } = await import('./repo');
	const p = await createReviewProposal(db, { role: role.id, kind: 'prompt_revision' });
	return p.id;
}

// ── staffRole concurrency (the folded MEDIUM fix) ────────────────────────────────────

describe('staffRole — concurrent double-staff is a graceful no-op (ONE row)', () => {
	it('two concurrent staffRole calls for the same (project, role) collapse to ONE row', async () => {
		const project = await freshProject();
		const { role } = await provenRole('conc', 'cls-cc');
		// Fire both BEFORE either completes — they race past the getProjectStaff read and one
		// loses on the project_staff_dedup UNIQUE index; the loser absorbs gracefully.
		const [a, b] = await Promise.all([
			staffRole(db, project, role.id, { source: 'operator' }),
			staffRole(db, project, role.id, { source: 'pm_validated' })
		]);
		expect(a.id).toBe(b.id); // same row id — no duplicate
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM project_staff WHERE project = $p AND role = $r;`,
			{ p: new (await import('surrealdb')).StringRecordId(project), r: new (await import('surrealdb')).StringRecordId(role.id) }
		);
		expect(rows.length).toBe(1);
		const resolved = await resolveStaff(db, project, role.id, resolveTierModel);
		expect(resolved).not.toBeNull(); // enabled + deployable
	});

	it('does NOT swallow an unrelated error (a bad role id fails loud)', async () => {
		const project = await freshProject();
		// A malformed role id fails at the link() chokepoint BEFORE any dedup path — it must throw,
		// never be absorbed as a benign no-op.
		await expect(staffRole(db, project, 'not a record id at all', {})).rejects.toBeTruthy();
	});
});

// ── (3) confirmStaffing LIVE RE-VALIDATE (BL-3 LOW) ───────────────────────────────────

describe('confirmStaffing — live re-validate a STALE proposal fails closed', () => {
	it('a proposal whose role went UNMATCHED (needs changed) fails closed with no project_staff write', async () => {
		const project = await freshProject();
		const { role } = await provenRole('stale-need', 'cls-stale-a');
		// A second proven class so the project can legitimately need a DIFFERENT class later.
		await provenRole('stale-other', 'cls-stale-b');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-stale-a'] });
		const { proposal } = await proposeStaffing(db, { project, role: role.id });

		// The world moves on: the project no longer needs cls-stale-a (it now needs cls-stale-b,
		// which `role` does NOT prove) → `role` is no longer a candidate. The stored proposal is now
		// stale and MUST fail closed at confirm.
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-stale-b'] });
		await expect(
			confirmStaffing(db, { proposal: proposal.id, operatorConfirmed: true })
		).rejects.toBeInstanceOf(StaffingGateError);
		// FAIL-CLOSED: no project_staff row was written.
		expect(await getProjectStaff(db, project, role.id)).toBeNull();
	});

	it('a proposal whose role went NON-DEPLOYABLE (version withdrawn) fails closed', async () => {
		const project = await freshProject();
		const { role, version } = await provenRole('stale-dep', 'cls-stale-c');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-stale-c'] });
		const { proposal } = await proposeStaffing(db, { project, role: role.id });

		// Withdraw the role's active version → roleProvenCoverage returns [] (a role with no
		// deployable active version proves nothing) → no longer a candidate. NOTE: coverage keys on
		// a PASSING run at the active version; mark the version withdrawn so it is non-deployable.
		await db.query(`UPDATE $vid SET lifecycle = 'withdrawn';`, {
			vid: new StringRecordId(version.id)
		});
		await db.query(`UPDATE $rid SET active_version = NONE;`, {
			rid: new StringRecordId(role.id)
		});
		await expect(
			confirmStaffing(db, { proposal: proposal.id, operatorConfirmed: true })
		).rejects.toBeInstanceOf(StaffingGateError);
		expect(await getProjectStaff(db, project, role.id)).toBeNull();
	});
});

// ── (2) ORPHAN un-staff + (4) ORPHANED-PROPOSAL visibility (BL-3 MEDIUM/LOW) ──────────

describe('loadProjectStaffingView — orphan staffed roles + orphaned proposals', () => {
	it('a staffed role that is no longer a candidate is surfaced as orphanStaffed and can be un-staffed', async () => {
		const project = await freshProject();
		const { role } = await provenRole('orphan-staff', 'cls-orph-a');
		await provenRole('orphan-other', 'cls-orph-b');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-orph-a'] });
		// Staff it via the gated path (propose → confirm).
		const { proposal } = await proposeStaffing(db, { project, role: role.id });
		await confirmStaffing(db, { proposal: proposal.id, operatorConfirmed: true });

		// Sanity: while it is still a candidate, it is NOT an orphan (it shows on the candidate card).
		let view = await loadProjectStaffingView(db, project, 'orphan proj');
		expect(view.staffedRoles).toContain(role.id);
		expect(view.orphanStaffed.map((o) => o.role)).not.toContain(role.id);

		// Change the needs so `role` is no longer a candidate → it becomes an ORPHAN (staffed but
		// absent from the board).
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-orph-b'] });
		view = await loadProjectStaffingView(db, project, 'orphan proj');
		expect(view.match.candidates.map((c) => c.role)).not.toContain(role.id);
		const orphan = view.orphanStaffed.find((o) => o.role === role.id);
		expect(orphan).toBeDefined();
		expect(orphan?.roleName).toBeTruthy(); // honest name, not the bare id when the role exists

		// The existing unstaff action clears it.
		await unstaffRole(db, project, role.id);
		view = await loadProjectStaffingView(db, project, 'orphan proj');
		expect(view.orphanStaffed.map((o) => o.role)).not.toContain(role.id);
		expect(view.staffedRoles).not.toContain(role.id);
	});

	it('honest empty: no orphan staffed / no orphan proposals when none exist', async () => {
		const project = await freshProject();
		const { role } = await provenRole('no-orphan', 'cls-noorph');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-noorph'] });
		const view = await loadProjectStaffingView(db, project, 'clean proj');
		expect(view.orphanStaffed).toEqual([]);
		expect(view.orphanProposals).toEqual([]);
		// the proven role IS a normal candidate (sanity that the view isn't broken)
		expect(view.match.candidates.map((c) => c.role)).toContain(role.id);
	});

	it('an OPEN proposal whose role is no longer a candidate appears in orphanProposals', async () => {
		const project = await freshProject();
		const { role } = await provenRole('orphan-prop', 'cls-op-a');
		await provenRole('orphan-prop-other', 'cls-op-b');
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-op-a'] });
		const { proposal } = await proposeStaffing(db, { project, role: role.id });

		// While still a candidate, the open proposal rides on the candidate card (openProposals), NOT
		// the orphan surface.
		let view = await loadProjectStaffingView(db, project, 'orphan prop proj');
		expect(view.openProposals.map((p) => p.proposal)).toContain(proposal.id);
		expect(view.orphanProposals).toEqual([]);

		// Change the needs so `role` is no longer a candidate → the OPEN proposal is now invisible on
		// the board → it must surface as an orphaned proposal so the operator can reject it.
		await setCapabilityNeeds(db, project, { defect_classes: ['cls-op-b'] });
		view = await loadProjectStaffingView(db, project, 'orphan prop proj');
		expect(view.match.candidates.map((c) => c.role)).not.toContain(role.id);
		const orphanProp = view.orphanProposals.find((p) => p.proposal === proposal.id);
		expect(orphanProp).toBeDefined();
		expect(orphanProp?.role).toBe(role.id);
		expect(orphanProp?.roleName).toBeTruthy();

		// Rejecting it clears it from the orphaned surface.
		await rejectStaffing(db, { proposal: proposal.id, reason: 'no longer matched' });
		view = await loadProjectStaffingView(db, project, 'orphan prop proj');
		expect(view.orphanProposals.map((p) => p.proposal)).not.toContain(proposal.id);
	});
});
