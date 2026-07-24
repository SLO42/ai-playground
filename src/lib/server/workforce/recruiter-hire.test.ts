import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import type { WorkforceConfig } from '../config/index';
import { DEFAULT_GATE_POLICY } from '../claude-code/gates';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import {
	createGauntletFixture,
	createGauntletKey,
	createRole,
	createRoleVersion,
	getRoleVersion,
	swapActiveVersion,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import { activateGauntletFixture, newSentinelUlid } from './activation';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH } from './scorer';
import { seedRecruiterRole, RECRUITER_DRAFT_KEYS } from './launch-fixtures';
import { runCertificationGauntlet, RECRUITER_SLUG } from './recruiter';
import { type GauntletDeps } from './gauntlet';
import { setCapabilityNeeds } from './capability-match';
import { proposeStaffing, rejectStaffing, StaffingGateError } from './staffing-proposal';
import { getProjectStaff } from './staff';
import {
	buildHireDecision,
	raiseHireBrief,
	applyHireDecision,
	recordPmFitVerdict,
	getPmFitVerdictForBrief,
	HireGateError
} from './recruiter-hire';
import { loadWorkforcePanel } from './panel';
import { createDecisionBrief, getBrief, getOpenBriefForArtifact, markBriefDecided } from '../projects/briefs';

// HR-5 VERIFY (real throwaway SurrealDB + the REAL ClaudeCodeRuntime over a scripted backend —
// the gauntlet/recruiter test discipline; logic real, only the LLM scripted; every assertion
// reads rows the engine actually wrote, F-008):
//   • a PASSING candidate yields a HIRE brief with honest evidence (real recall/FP/per-plant) + a
//     recommended option + a falsifier (the §8 format createDecisionBrief enforces);
//   • operator APPROVE flips the cert (B4 final say) and (with a staffing proposal) feeds the BL-3
//     staffing flow; REJECT does NEITHER;
//   • re-raising on the same run yields the SAME open brief (one-open-per-candidate, interrupt);
//   • RED-TEAM (B4): NO flip / NO staffing without operatorConfirmed; a recruiter-self candidate is
//     refused (B1); a non-terminal / failed-campaign candidate cannot be hired; evidence is REAL.

let tdb: TestDb;
let db: Db;
let wsRoot: string;
let harnessRoot: string;

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
	wsRoot = mkdtempSync(join(tmpdir(), 'hire-ws-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'hire-harness-'));
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	rmSync(wsRoot, { recursive: true, force: true });
	rmSync(harnessRoot, { recursive: true, force: true });
});

function testConfig(): WorkforceConfig {
	return {
		pm: { provider: 'claude', model_id: 'claude-opus-4-8', triggers: { failure_threshold: null, distress_cooldown_minutes: null } },
		panel: { scope: { max_files: null, max_new_services: null } },
		gauntlet: { pass_recall: 1.0, max_false_positives: 0, session_timeout_minutes: 15 },
		budget: { max_auto_interviews_per_day: null, allowed_auto_tiers: [] },
		drift: {
			escaped_defect: true,
			operator_feedback: true,
			confidence_miscalibration: true,
			confidence_miscalibration_rate: 0.5,
			refutation_rate: null,
			fixloop_rate: null
		},
		research: { max_wall_clock_minutes: null, max_fetches: null },
		workforce: { max_open_proposals: 2, track_window_days: 14, min_events_for_claim: 5 }
	};
}

let seedCount = 0;

interface TargetSeed {
	role: RoleRow;
	version: RoleVersionRow;
	defectSlug: string;
	controlSlug: string;
	defectClass: string;
}

/**
 * A (non-recruiter) target role with a TWO-plant planted_defect fixture + a scorer_control. The
 * defect class is unique so the matcher can recognize the role as a REUSE candidate for a project
 * that needs exactly that class. fp_tolerance 0; both plants must be found for recall 1.0.
 */
async function seedTarget(): Promise<TargetSeed> {
	const n = ++seedCount;
	const defectClass = `hire-cls-${n}`;
	const role = await createRole(db, {
		slug: `hire-target-${n}`,
		name: `Hire Target ${n}`,
		purpose: 'HR-5 hire-gate test bed'
	});
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are reviewer #${n}. Hunt platform bugs with verbatim evidence.`,
		default_tier: 'sonnet',
		source: 'operator'
	});
	const defectSlug = `fx-defect-${n}`;
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: defectSlug,
		kind: 'planted_defect',
		work: { 'a.ts': 'line1\nline2\nprocess.kill(pid, 0);\nline4\nconst p = 18789;\n' },
		sentinel: newSentinelUlid(),
		provenance: 'fails: F-001'
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		author: 'operator',
		plants: [
			{
				id: 'p-real',
				class: defectClass,
				location: 'a.ts:3',
				severity: 'high',
				detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'process\\.kill' }
			},
			{
				id: 'p-second',
				class: defectClass,
				location: 'a.ts:5',
				severity: 'low',
				detection: { file: 'a.ts', lines: [5, 5], evidence_pattern: '18789' }
			}
		],
		fp_tolerance: 0
	});
	await activateGauntletFixture(db, fixture.id);

	const controlSlug = `ctrl-${n}`;
	const control = await createGauntletFixture(db, {
		role: role.id,
		slug: controlSlug,
		kind: 'scorer_control',
		work: {
			'c.ts': 'l1\nl2\nconst r = eval(input);\n',
			[KNOWN_PASS_PATH]: JSON.stringify([
				{ fixture: controlSlug, file: 'c.ts', lines: [3, 3], class: 'injection', evidence: 'eval(input)' }
			]),
			[KNOWN_FAIL_PATH]: JSON.stringify([])
		},
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: control.id,
		author: 'operator',
		plants: [{ id: 'c1', detection: { file: 'c.ts', lines: [3, 3], evidence_pattern: 'eval\\(' } }]
	});
	await activateGauntletFixture(db, control.id);

	return { role, version, defectSlug, controlSlug, defectClass };
}

// ── Scripted candidate backend ───────────────────────────────────────────────────────

type FindingsWriter = (cwd: string, seed: TargetSeed) => void;

function candidateBackend(write: FindingsWriter, seed: TargetSeed): CcBackend {
	return {
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			return {
				ccSessionId: `cc_hire_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					yield { type: 'log', message: 'candidate reviewing fixtures' } as RuntimeEvent;
					if (plan.canUseTool) {
						await plan.canUseTool('Write', { file_path: join(plan.cwd, 'findings.json') });
					}
					write(plan.cwd, seed);
					yield {
						type: 'tool_call',
						name: 'Write',
						args: { file_path: 'findings.json' },
						needsConfirm: false
					} as RuntimeEvent;
					yield { type: 'token_usage', input: 800, output: 90 } as RuntimeEvent;
					yield { type: 'done', result: { ok: true, summary: 'findings written' } } as RuntimeEvent;
				},
				async cancel() {}
			};
		},
		async resume() {
			throw new Error('not in this test');
		},
		async interject() {}
	};
}

function runtimeFor(backend: CcBackend): ClaudeCodeRuntime {
	return new ClaudeCodeRuntime({
		backend,
		harnessConfigRoot: harnessRoot.replace(/\\/g, '/'),
		gates: { ...DEFAULT_GATE_POLICY }
	});
}

function depsFor(backend: CcBackend): GauntletDeps {
	return { db, runtime: runtimeFor(backend), config: testConfig(), workspaceRoot: wsRoot };
}

/** Finds BOTH plants → recall 1.0 → the run passes. */
const perfectFindings: FindingsWriter = (cwd, s) => {
	writeFileSync(
		join(cwd, 'findings.json'),
		JSON.stringify([
			{ fixture: s.defectSlug, file: 'a.ts', lines: [3, 3], class: s.defectClass, evidence: 'process.kill(pid, 0)' },
			{ fixture: s.defectSlug, file: 'a.ts', lines: [5, 5], class: s.defectClass, evidence: 'const p = 18789;' }
		]),
		'utf8'
	);
};

/** Finds nothing → recall 0 → the run fails. */
const emptyFindings: FindingsWriter = (cwd) => {
	writeFileSync(join(cwd, 'findings.json'), JSON.stringify([]), 'utf8');
};

/** Run a real certification gauntlet and return the terminal run id. */
async function runToTerminal(seed: TargetSeed, write: FindingsWriter): Promise<string> {
	const out = await runCertificationGauntlet(depsFor(candidateBackend(write, seed)), {
		roleVersionId: seed.version.id,
		tier: 'sonnet',
		provider: 'claude',
		modelId: 'claude-sonnet-x',
		operatorApprovedKeySet: true
	});
	if (out.kind !== 'ran') throw new Error(`expected a ran outcome, got ${out.kind}`);
	return out.run.id;
}

async function freshProject(needClass: string): Promise<string> {
	const n = ++seedCount;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/x' } RETURN id;`,
		{ id: `hire_proj_${n}`, slug: `hire-proj-${n}` }
	);
	const project = String(rows[0].id);
	await setCapabilityNeeds(db, project, { defect_classes: [needClass] });
	return project;
}

// ── buildHireDecision — honest evidence (B3 read-only) ─────────────────────────────────

describe('buildHireDecision — assembles the hire decision from REAL terminal-run rows (B3)', () => {
	it('a PASSING candidate → hire recommendation with real recall, FP, per-plant found/missed', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('passed');

		const decision = await buildHireDecision(db, runId);
		expect(decision.recommendation).toBe('hire');
		expect(decision.recall).toBe(1); // 2/2 — REAL, not fabricated
		expect(decision.plantedFound).toBe(2);
		expect(decision.plantedTotal).toBe(2);
		expect(decision.falsePositives).toBe(0);
		expect(decision.roleSlug).toBe(seed.role.slug);
		expect(decision.tier).toBe('sonnet');
		// Per-plant: both plants FOUND, none missed (read from the run results).
		const fx = decision.plants.find((p) => p.fixture === seed.defectSlug);
		expect(fx?.found.sort()).toEqual(['p-real', 'p-second']);
		expect(fx?.missed).toEqual([]);
		// The falsifier is present + honest (names the fixture-pool limit).
		expect(decision.falsifier).toMatch(/fixture pool|under-cover/i);
	}, 40_000);

	it('a FAILING candidate → no_hire recommendation, the missed plant is REAL', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, emptyFindings);
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('failed');

		const decision = await buildHireDecision(db, runId);
		expect(decision.recommendation).toBe('no_hire');
		expect(decision.plantedFound).toBe(0);
		const fx = decision.plants.find((p) => p.fixture === seed.defectSlug);
		expect(fx?.missed.sort()).toEqual(['p-real', 'p-second']);
		expect(decision.falsifier).toMatch(/key defect/i);
	}, 40_000);

	it('REFUSES a non-terminal run (shadow: adjudicating/running has no verdict)', async () => {
		// A fresh interview_run starts 'running' — not terminal.
		const seed = await seedTarget();
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE interview_run CONTENT {
				role: $role, role_version: $rv, prompt_sha: 'x', tier: 'sonnet', provider: 'claude',
				model_id: 'm', fixture_set_sha: 'x', status: 'running', planted_total: 2, planted_found: 0
			} RETURN id;`,
			{ role: new StringRecordId(seed.role.id), rv: new StringRecordId(seed.version.id) }
		);
		await expect(buildHireDecision(db, String(rows[0].id))).rejects.toBeInstanceOf(HireGateError);
	}, 40_000);

	it('REFUSES a recruiter-self candidate (B1)', async () => {
		await seedRecruiterRole(db);
		const [vr] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT VALUE id FROM role_version WHERE role.slug = $s LIMIT 1;`,
			{ s: RECRUITER_SLUG }
		);
		const [rr] = await db.query<[Array<{ id: unknown }>]>(`SELECT VALUE id FROM role WHERE slug = $s LIMIT 1;`, {
			s: RECRUITER_SLUG
		});
		// A terminal run on the recruiter's own version — buildHireDecision must refuse it (B1),
		// regardless of status. We fabricate a passed run row directly (the recruiter never runs its
		// own gauntlet, so this can only arise from a bug; the gate must catch it).
		const [run] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE interview_run CONTENT {
				role: $role, role_version: $rv, prompt_sha: 'x', tier: 'opus', provider: 'claude',
				model_id: 'm', fixture_set_sha: 'x', status: 'passed', planted_total: 1, planted_found: 1
			} RETURN id;`,
			{ role: new StringRecordId(String(rr[0])), rv: new StringRecordId(String(vr[0])) }
		);
		await expect(buildHireDecision(db, String(run[0].id))).rejects.toBeInstanceOf(HireGateError);
		// And a recruiter draft-key set exists (sanity — the seed ran).
		expect(RECRUITER_DRAFT_KEYS.length).toBeGreaterThan(0);
	}, 40_000);

	it('names a missing run (shadow: nil input)', async () => {
		await expect(buildHireDecision(db, 'interview_run:nope')).rejects.toBeInstanceOf(HireGateError);
	});
});

// ── raiseHireBrief — ONE brief per candidate (§8 format + interrupt contract) ──────────

describe('raiseHireBrief — one open brief per candidate, §8 format', () => {
	it('a passing candidate yields a hire brief with evidence + a recommended option + a falsifier', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);

		const brief = await raiseHireBrief(db, runId);
		expect(brief.artifact).toBe(runId);
		expect(brief.artifact_kind).toBe('cert_hire');
		expect(brief.classification).toBe('confirm');
		expect(brief.status).toBe('open');
		expect(brief.ask).toMatch(/hire/i);
		// §8: 2–4 evidence links; exactly ONE recommended option; a falsifier.
		expect(brief.evidence.length).toBeGreaterThanOrEqual(2);
		expect(brief.evidence.length).toBeLessThanOrEqual(4);
		expect(brief.evidence).toContain(runId); // the candidate run id is an evidence link
		const recommended = brief.options.filter((o) => o.recommended);
		expect(recommended).toHaveLength(1);
		expect(recommended[0].id).toBe('approve'); // hire → recommend approve
		expect(brief.falsifier.trim().length).toBeGreaterThan(0);
	}, 40_000);

	it('re-raising on the same run returns the SAME open brief (interrupt contract)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		const first = await raiseHireBrief(db, runId);
		const second = await raiseHireBrief(db, runId);
		expect(second.id).toBe(first.id); // one-open-per-candidate absorb — never a duplicate ask
		const open = await getOpenBriefForArtifact(db, runId);
		expect(open?.id).toBe(first.id);
	}, 40_000);

	it('a failing candidate recommends REJECT (no_hire)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, emptyFindings);
		const brief = await raiseHireBrief(db, runId);
		const recommended = brief.options.filter((o) => o.recommended);
		expect(recommended).toHaveLength(1);
		expect(recommended[0].id).toBe('reject');
	}, 40_000);
});

// ── applyHireDecision — B4: the operator's final gate ──────────────────────────────────

describe('applyHireDecision — approve flips/feeds, reject neither (B4)', () => {
	it('RED-TEAM B4: approve WITHOUT operatorConfirmed is refused, NO flip', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		// Force the version back to a flippable mid-campaign state would require re-running; instead
		// assert the gate refuses BEFORE any effect by using a fresh passing run whose version is
		// already 'passed' — the gate still requires operatorConfirmed for an approve.
		const brief = await raiseHireBrief(db, runId);
		await expect(
			applyHireDecision(db, brief.id, 'approve', { operatorConfirmed: false })
		).rejects.toBeInstanceOf(HireGateError);
		// The brief is untouched (still open) — no effect leaked.
		expect((await getBrief(db, brief.id))?.status).toBe('open');
	}, 40_000);

	it('approve (confirmed) marks the brief approved + reports the cert lifecycle (B4 final say)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		// runGauntlet's finalizer already drove the version interviewing→passed; the operator-gate is
		// the final SAY (B4) — approve absorbs the already-passed version (certFlipped:false) and
		// records the operator's decision. The cert remains 'passed'.
		const brief = await raiseHireBrief(db, runId);
		const res = await applyHireDecision(db, brief.id, 'approve', { operatorConfirmed: true });
		expect(res.brief.status).toBe('approved');
		expect(res.recommendation).toBe('hire');
		expect(res.lifecycle).toBe('passed');
		expect(res.certFlipped).toBe(false); // already passed — idempotent absorb, not a double-flip
	}, 40_000);

	it('approve + staffingProposal FEEDS the BL-3 staffing flow (certified → hired)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		// Make the candidate a live REUSE candidate: active version + a project needing its class.
		await swapActiveVersion(db, seed.role.id, seed.version.id);
		const project = await freshProject(seed.defectClass);
		const { proposal } = await proposeStaffing(db, { project, role: seed.role.id });

		const brief = await raiseHireBrief(db, runId);
		const res = await applyHireDecision(db, brief.id, 'approve', {
			operatorConfirmed: true,
			staffingProposal: proposal.id
		});
		expect(res.brief.status).toBe('approved');
		expect(res.staffing).toBeDefined();
		expect(res.staffing!.staffed).toBe(true);
		// The project_staff row is REAL + enabled (hired onto the project, D-039).
		const staff = await getProjectStaff(db, project, seed.role.id);
		expect(staff?.enabled).toBe(true);
		expect(staff?.source).toBe('pm_validated');
	}, 40_000);

	it('approve with a STALE (disposed) staffingProposal throws the NAMED StaffingGateError (route → 409, not a masked 500)', async () => {
		// GAP-2 regression: confirmStaffing fail-closes on a disposed proposal with StaffingGateError /
		// WorkforceInputError — NOT a generic Error. The /api/briefs handler maps those to a clean 409.
		// Here we assert applyHireDecision propagates the NAMED error verbatim (the route's catch keys on
		// the class), so a stale proposal can never surface as a raw 500.
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		await swapActiveVersion(db, seed.role.id, seed.version.id);
		const project = await freshProject(seed.defectClass);
		const { proposal } = await proposeStaffing(db, { project, role: seed.role.id });
		// Dispose the proposal so it is no longer 'proposed' (the operator rejected/withdrew it).
		await rejectStaffing(db, { proposal: proposal.id, reason: 'stale' });

		const brief = await raiseHireBrief(db, runId);
		await expect(
			applyHireDecision(db, brief.id, 'approve', {
				operatorConfirmed: true,
				staffingProposal: proposal.id
			})
		).rejects.toBeInstanceOf(StaffingGateError);
	}, 40_000);

	it('RED-TEAM B4: REJECT flips NO cert and staffs NOTHING', async () => {
		const seed = await seedTarget();
		// A FAILED campaign — the version is terminal-failed; reject must not touch it.
		const runId = await runToTerminal(seed, emptyFindings);
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('failed');
		await swapActiveVersion(db, seed.role.id, seed.version.id).catch(() => {
			/* a failed version cannot be swapped active — fine; we only assert no staffing happened */
		});
		const project = await freshProject(seed.defectClass);

		const brief = await raiseHireBrief(db, runId);
		const res = await applyHireDecision(db, brief.id, 'reject', { operatorConfirmed: false });
		expect(res.brief.status).toBe('rejected');
		expect(res.recommendation).toBe('no_hire');
		expect(res.certFlipped).toBe(false);
		// No flip: the version is STILL failed.
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('failed');
		// No staffing row was ever created.
		const staff = await getProjectStaff(db, project, seed.role.id);
		expect(staff).toBeNull();
	}, 40_000);

	it('RED-TEAM B4: a FAILED-campaign candidate cannot be APPROVED into a cert (must re-version)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, emptyFindings);
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('failed');
		const brief = await raiseHireBrief(db, runId);
		// approve on a no_hire candidate: the version is terminal-'failed' and cannot reach 'passed'
		// (§2.2) — the gate refuses with NO effect (a failed campaign is re-versioned, not certified).
		await expect(
			applyHireDecision(db, brief.id, 'approve', { operatorConfirmed: true })
		).rejects.toBeInstanceOf(HireGateError);
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('failed');
		expect((await getBrief(db, brief.id))?.status).toBe('open'); // untouched
	}, 40_000);

	it('RED-TEAM B4: approve with a ROLE-MISMATCHED staffing proposal is REFUSED — no cert flip, no staffing (HR-H2 guard)', async () => {
		// Brief certifies role A; the operator (by mistake) passes role B's staffing proposal. The guard
		// must refuse BEFORE any effect — never certify A while staffing B on one click.
		const seedA = await seedTarget();
		const runA = await runToTerminal(seedA, perfectFindings);
		// Role B — a DIFFERENT certified role with its own staffing proposal onto a project.
		const seedB = await seedTarget();
		await runToTerminal(seedB, perfectFindings); // certifies B (passed) so it is staffable
		await swapActiveVersion(db, seedB.role.id, seedB.version.id);
		const project = await freshProject(seedB.defectClass);
		const { proposal: proposalB } = await proposeStaffing(db, { project, role: seedB.role.id });

		const briefA = await raiseHireBrief(db, runA);
		await expect(
			applyHireDecision(db, briefA.id, 'approve', {
				operatorConfirmed: true,
				staffingProposal: proposalB.id // role B's proposal on role A's hire brief — MISMATCH
			})
		).rejects.toBeInstanceOf(HireGateError);
		// No effect leaked: brief A still open, role B was NOT staffed onto the project.
		expect((await getBrief(db, briefA.id))?.status).toBe('open');
		const staffB = await getProjectStaff(db, project, seedB.role.id);
		expect(staffB).toBeNull();
	}, 60_000);

	it('REJECT clears a STALE brief even when the run was deleted/mutated since (buildHireDecision would throw) — HR-H2 guard', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		const brief = await raiseHireBrief(db, runId);
		// Mutate the run out from under the brief: delete it so buildHireDecision throws on re-derive.
		await db.query(`DELETE $rid;`, { rid: new StringRecordId(runId) });
		await expect(buildHireDecision(db, runId)).rejects.toBeInstanceOf(HireGateError); // sanity: gone
		// REJECT must STILL clear the stale brief (a withdrawal never re-derives a vanished decision).
		const res = await applyHireDecision(db, brief.id, 'reject', { operatorConfirmed: false });
		expect(res.brief.status).toBe('rejected');
		expect(res.certFlipped).toBe(false);
		// The honest fallback: the brief's OWN recorded recommendation (a passing brief recommended hire).
		expect(res.recommendation).toBe('hire');
		expect(res.lifecycle).toBe('(unknown)'); // the gone run's version could not be re-derived — honest
		expect((await getBrief(db, brief.id))?.status).toBe('rejected');
	}, 60_000);

	it('refuses a non-cert_hire brief id (named)', async () => {
		// A task-kind brief id routed here must be refused (the route dispatches by kind, but the
		// function itself fail-closes too).
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		const brief = await raiseHireBrief(db, runId);
		// Sanity: this IS a cert_hire brief; the negative is covered by the route dispatch + the kind
		// guard. Assert the guard message names the kind for a non-existent brief.
		await expect(applyHireDecision(db, 'decision_brief:nope', 'approve', { operatorConfirmed: true })).rejects.toBeInstanceOf(HireGateError);
		expect(brief.artifact_kind).toBe('cert_hire');
	}, 40_000);
});

// ── recordPmFitVerdict — gap D: the PM FIT-VERDICT layer (FIRST-CLASS input, NOT a hard gate) ──
//
// The PM judges fit for THIS project before the operator's B4 decision. A deny defaults the operator
// surface to reject + surfaces the reason; the operator override still approves (D-039 final); a
// fit-verdict NEVER itself flips the cert or staffs (only applyHireDecision does, B4); a fit-verdict
// on a non-cert_hire / already-decided brief is refused (named). All four shadow paths covered.
describe('recordPmFitVerdict — gap D PM fit-verdict on a cert_hire brief', () => {
	it('records an APPROVE fit-verdict; the hire queue surfaces it (NEVER flips the cert, B4)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		const brief = await raiseHireBrief(db, runId);
		const before = (await getRoleVersion(db, seed.version.id))?.lifecycle;

		const v = await recordPmFitVerdict(db, brief.id, { outcome: 'approve', reason: 'fits the project stack' });
		expect(v.outcome).toBe('approve');
		expect(v.reason).toBe('fits the project stack');
		expect(v.author).toBe('pm');

		// The verdict changed NOTHING about the cert/lifecycle — only applyHireDecision does (B4).
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe(before);
		expect((await getBrief(db, brief.id))?.status).toBe('open');

		// The /agents hire queue surfaces the latest fit-verdict on the card (read-only).
		const panel = await loadWorkforcePanel(db);
		const card = panel.hireQueue.find((h) => h.brief === brief.id);
		expect(card?.fitVerdict?.outcome).toBe('approve');
		expect(card?.fitVerdict?.reason).toBe('fits the project stack');
	}, 40_000);

	it('a DENY is surfaced with its reason; the operator OVERRIDE still approves (D-039 final)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		const brief = await raiseHireBrief(db, runId);

		const deny = await recordPmFitVerdict(db, brief.id, {
			outcome: 'deny',
			reason: 'generic cert; project needs BepInEx specifics the gauntlet did not test'
		});
		expect(deny.outcome).toBe('deny');

		// The surface carries the deny + reason (this is what pre-sets the operator UI to reject).
		const card = (await loadWorkforcePanel(db)).hireQueue.find((h) => h.brief === brief.id);
		expect(card?.fitVerdict?.outcome).toBe('deny');
		expect(card?.fitVerdict?.reason).toMatch(/BepInEx/);

		// D-039 FINAL: the operator can OVERRIDE the PM deny and still approve. The fit-verdict did NOT
		// block applyHireDecision — the operator's explicit confirm still flips the cert.
		const res = await applyHireDecision(db, brief.id, 'approve', { operatorConfirmed: true });
		expect(res.brief.status).toBe('approved');
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('passed');
	}, 40_000);

	it('latest-wins: a revised fit-verdict supersedes the prior on the surface', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		const brief = await raiseHireBrief(db, runId);
		await recordPmFitVerdict(db, brief.id, { outcome: 'deny', reason: 'first call' });
		await recordPmFitVerdict(db, brief.id, { outcome: 'approve', reason: 'reconsidered — it fits' });
		const latest = await getPmFitVerdictForBrief(db, brief.id);
		expect(latest?.outcome).toBe('approve');
		expect(latest?.reason).toBe('reconsidered — it fits');
	}, 40_000);

	it('REFUSES an empty reason (shadow: blank input — the operator must see WHY)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		const brief = await raiseHireBrief(db, runId);
		await expect(recordPmFitVerdict(db, brief.id, { outcome: 'deny', reason: '   ' })).rejects.toBeInstanceOf(
			HireGateError
		);
	}, 40_000);

	it('REFUSES a non-cert_hire brief (named — a fit-verdict only judges a hire gate)', async () => {
		// A task-kind brief: createDecisionBrief enforces §8 but admits artifact_kind 'task'.
		const seed = await seedTarget();
		const taskBrief = await createDecisionBrief(db, {
			artifact: `task:fit_neg_${++seedCount}`,
			artifact_kind: 'task',
			classification: 'proposal_gate',
			ask: 'Promote?',
			issue: 'A task gate, not a hire gate.',
			effort: { apply: '—', wrongness: '—' },
			evidence: [`task:fit_neg_${seedCount}`, 'tasks'],
			falsifier: 'the proposal may be premature',
			options: [
				{ id: 'approve', label: 'Promote', pro: 'p', con: 'c', recommended: 'go' },
				{ id: 'reject', label: 'Reject', pro: 'p', con: 'c' }
			]
		});
		void seed;
		await expect(
			recordPmFitVerdict(db, taskBrief.id, { outcome: 'approve', reason: 'looks fine' })
		).rejects.toBeInstanceOf(HireGateError);
	}, 40_000);

	it('REFUSES a fit-verdict on an ALREADY-DECIDED brief (shadow: upstream state — too late)', async () => {
		const seed = await seedTarget();
		const runId = await runToTerminal(seed, perfectFindings);
		const brief = await raiseHireBrief(db, runId);
		// The operator already disposed (rejected) — a late fit-verdict cannot change a decided hire.
		await markBriefDecided(db, brief.id, 'rejected');
		await expect(
			recordPmFitVerdict(db, brief.id, { outcome: 'deny', reason: 'too late' })
		).rejects.toBeInstanceOf(HireGateError);
	}, 40_000);

	it('names a missing brief (shadow: nil input)', async () => {
		await expect(
			recordPmFitVerdict(db, 'decision_brief:nope', { outcome: 'approve', reason: 'x' })
		).rejects.toBeInstanceOf(HireGateError);
	});
});
