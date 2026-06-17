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
	type CanUseToolResult,
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
	readGauntletKeyForScoring,
	WorkforceInputError,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import { activateGauntletFixture, newSentinelUlid } from './activation';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH } from './scorer';
import { seedRecruiterRole, RECRUITER_DRAFT_KEYS, type DraftKeySpec } from './launch-fixtures';
import type { GauntletDeps } from './gauntlet';
import {
	classifyCertificationFail,
	draftCertificationSet,
	runCertificationGauntlet,
	certLifecycleOf,
	RecruiterIntegrityError,
	RECRUITER_SLUG
} from './recruiter';

// HR-3 VERIFY (real throwaway SurrealDB + the REAL ClaudeCodeRuntime over a scripted
// backend — the gauntlet.test.ts discipline; logic real, only the LLM scripted; every
// assertion reads rows the engine actually wrote, F-008):
//   • draftCertificationSet PREPARES the operator approve-surface (PROPOSE-ONLY, B2) and
//     NEVER writes gauntlet_key;
//   • runCertificationGauntlet REFUSES without operatorApprovedKeySet (B2) and REFUSES a
//     recruiter-self target (B1), then reuses runGauntlet on approval;
//   • on a forced FAIL: classifyCertificationFail re-versions (reversionFailedRole) + emits
//     a KEY-DEFECT vs candidate-miss classification + a propose-only key-fix; ASSERT it
//     NEVER confirms a key (B2) and NEVER flips a cert (B4 — no transitionLifecycle).

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
	wsRoot = mkdtempSync(join(tmpdir(), 'recruiter-ws-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'recruiter-harness-'));
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	rmSync(wsRoot, { recursive: true, force: true });
	rmSync(harnessRoot, { recursive: true, force: true });
});

// ── Config (operator-trigger budget is irrelevant — never auto-spends) ──────────────

function testConfig(): WorkforceConfig {
	return {
		pm: { provider: 'claude', model_id: 'claude-opus-4-8', triggers: { failure_threshold: null } },
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

/** Count all gauntlet_key rows (the B2 no-write probe). */
async function countGauntletKeys(): Promise<number> {
	const [rows] = await db.query<[Array<{ n: number }>]>(`SELECT count() AS n FROM gauntlet_key GROUP ALL;`);
	return rows?.[0]?.n ?? 0;
}

// ── Seed a TARGET role with a TWO-plant fixture (the key-defect substrate) ───────────

let seedCount = 0;

interface TargetSeed {
	role: RoleRow;
	version: RoleVersionRow;
	defectSlug: string;
	controlSlug: string;
}

/**
 * Seed a (non-recruiter) target role with ONE planted_defect fixture carrying TWO plants:
 *   • p-real     — a genuine platform bug (process.kill) on a.ts:3 (the substantive defect);
 *   • p-redundant — a SECOND required plant on a.ts:5 (the OVER-STRICT / redundant required
 *     finding — the authoritative-port-18789 class). A behaviorally-correct candidate flags
 *     only p-real → the key over-constrains → a key_defect classification.
 * Plus a scorer_control fixture so runGauntlet's per-batch positive control passes.
 */
async function seedTarget(): Promise<TargetSeed> {
	const n = ++seedCount;
	const role = await createRole(db, {
		slug: `cert-target-${n}`,
		name: `Cert Target ${n}`,
		purpose: 'HR-3 orchestrator test bed'
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
		plants: [
			{
				id: 'p-real',
				class: 'platform-bug',
				location: 'a.ts:3',
				severity: 'high',
				detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'process\\.kill' }
			},
			{
				// The OVER-STRICT redundant required plant — a correct candidate omits it.
				id: 'p-redundant',
				class: 'redundant-citation',
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
		plants: [{ id: 'c1', detection: { file: 'c.ts', lines: [3, 3], evidence_pattern: 'eval\\(' } }]
	});
	await activateGauntletFixture(db, control.id);

	return { role, version, defectSlug, controlSlug };
}

// ── Scripted candidate backend (a behaviorally-correct candidate: finds p-real only) ─

interface ScriptedBackend extends CcBackend {
	plans: CcSpawnPlan[];
	probes: { inside?: CanUseToolResult };
}

type FindingsWriter = (cwd: string, seed: TargetSeed) => void;

function candidateBackend(write: FindingsWriter | null, seed: TargetSeed): ScriptedBackend {
	const plans: CcSpawnPlan[] = [];
	const probes: ScriptedBackend['probes'] = {};
	return {
		plans,
		probes,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: `cc_cert_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					yield { type: 'log', message: 'candidate reviewing fixtures' } as RuntimeEvent;
					if (plan.canUseTool) {
						probes.inside = await plan.canUseTool('Write', { file_path: join(plan.cwd, 'findings.json') });
					}
					if (write) write(plan.cwd, seed);
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

/** A behaviorally-correct candidate: flags ONLY p-real (the substantive defect), omitting the
 *  redundant p-redundant. With pass_recall 1.0 this FAILS the over-strict key — the key-defect
 *  signature (some found, some missed in the SAME fixture). */
const correctButOverStrictFail: FindingsWriter = (cwd, seed) => {
	writeFileSync(
		join(cwd, 'findings.json'),
		JSON.stringify([
			{ fixture: seed.defectSlug, file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' }
		]),
		'utf8'
	);
};

/** A candidate that finds NOTHING — the genuine candidate-miss shape. */
const emptyFindings: FindingsWriter = (cwd) => {
	writeFileSync(join(cwd, 'findings.json'), JSON.stringify([]), 'utf8');
};

// ── Step 1 — draftCertificationSet (PROPOSE-ONLY, B2) ────────────────────────────────

describe('draftCertificationSet — prepares the operator approve-surface (B2)', () => {
	it('assembles drafted keys WITHOUT writing any gauntlet_key', async () => {
		const seed = await seedTarget();
		const draftKeys: DraftKeySpec[] = [
			{
				fixtureSlug: seed.defectSlug,
				plants: [{ id: 'p-real', class: 'platform-bug', detection: { mode: 'presence', file: 'a.ts', lines: [3, 3], evidence_pattern: 'process\\.kill' } }],
				fp_tolerance: 0,
				fp_justification: 'precise evidence'
			}
		];
		// B2 — count gauntlet_key rows before/after: drafting writes ZERO keys.
		const keysBefore = await countGauntletKeys();
		const draft = await draftCertificationSet(db, { roleVersionId: seed.version.id, draftKeys });
		const keysAfter = await countGauntletKeys();
		expect(keysAfter).toBe(keysBefore);

		expect(draft.roleSlug).toBe(seed.role.slug);
		expect(draft.roleVersion).toBe(seed.version.id);
		expect(draft.tier).toBe('sonnet');
		expect(draft.keyCount).toBe(1);
		expect(draft.draftedKeys[0].fixtureSlug).toBe(seed.defectSlug);
		// The draft carries the proposed plants verbatim (operator reviews this SET).
		expect(draft.draftedKeys[0].plants).toHaveLength(1);
	}, 30_000);

	it('honest EMPTY set when no draft keys (F-008 — nothing to approve, not an error)', async () => {
		const seed = await seedTarget();
		const draft = await draftCertificationSet(db, { roleVersionId: seed.version.id, draftKeys: [] });
		expect(draft.keyCount).toBe(0);
		expect(draft.draftedKeys).toEqual([]);
	}, 30_000);

	it('REFUSES the recruiter as a self-cert target (B1)', async () => {
		await seedRecruiterRole(db);
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT VALUE id FROM role_version WHERE role.slug = $s LIMIT 1;`,
			{ s: RECRUITER_SLUG }
		);
		const recruiterVersionId = String(rows[0]);
		await expect(
			draftCertificationSet(db, { roleVersionId: recruiterVersionId, draftKeys: RECRUITER_DRAFT_KEYS })
		).rejects.toBeInstanceOf(RecruiterIntegrityError);
	}, 30_000);

	it('names a missing target (shadow path: nil input)', async () => {
		await expect(
			draftCertificationSet(db, { roleVersionId: 'role_version:does_not_exist', draftKeys: [] })
		).rejects.toBeInstanceOf(WorkforceInputError);
	});
});

// ── Step 2 — runCertificationGauntlet (B2 gate, B1, reuses runGauntlet) ──────────────

describe('runCertificationGauntlet — operator-gated run (B2/B1)', () => {
	it('REFUSES without operatorApprovedKeySet (B2 — recruiter never confirms keys)', async () => {
		const seed = await seedTarget();
		await expect(
			runCertificationGauntlet(depsFor(candidateBackend(null, seed)), {
				roleVersionId: seed.version.id,
				tier: 'sonnet',
				provider: 'claude',
				modelId: 'claude-sonnet-x',
				operatorApprovedKeySet: false
			})
		).rejects.toBeInstanceOf(RecruiterIntegrityError);
	}, 30_000);

	it('REFUSES a recruiter-self run target (B1)', async () => {
		await seedRecruiterRole(db);
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT VALUE id FROM role_version WHERE role.slug = $s LIMIT 1;`,
			{ s: RECRUITER_SLUG }
		);
		await expect(
			runCertificationGauntlet(depsFor(candidateBackend(null, { defectSlug: 'x' } as TargetSeed)), {
				roleVersionId: String(rows[0]),
				tier: 'opus',
				provider: 'claude',
				modelId: 'claude-opus-4-8',
				operatorApprovedKeySet: true
			})
		).rejects.toBeInstanceOf(RecruiterIntegrityError);
	}, 30_000);

	it('runs the gauntlet on approval (operator trigger — reuses runGauntlet)', async () => {
		const seed = await seedTarget();
		// A perfect candidate (finds BOTH plants) → passes; proves the run path + operator trigger.
		const perfect: FindingsWriter = (cwd, s) => {
			writeFileSync(
				join(cwd, 'findings.json'),
				JSON.stringify([
					{ fixture: s.defectSlug, file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' },
					{ fixture: s.defectSlug, file: 'a.ts', lines: [5, 5], class: 'redundant-citation', evidence: 'const p = 18789;' }
				]),
				'utf8'
			);
		};
		const out = await runCertificationGauntlet(depsFor(candidateBackend(perfect, seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			operatorApprovedKeySet: true
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('passed');
		// B4: the orchestrator did NOT flip the cert — runGauntlet's own finalizer drove
		// interviewing→passed (the campaign mechanism), not the recruiter. certLifecycleOf
		// only READS it.
		const cert = await certLifecycleOf(db, seed.version.id);
		expect(cert.lifecycle).toBe('passed');
	}, 30_000);
});

// ── Step 4 — classifyCertificationFail (the loop the operator hand-ran) ──────────────

describe('classifyCertificationFail — KEY-DEFECT vs candidate-miss + re-version (B2/B3/B4)', () => {
	it('KEY-DEFECT: over-strict key failed a correct candidate → re-version + propose key fix', async () => {
		const seed = await seedTarget();
		// Behaviorally-correct candidate finds p-real, omits the redundant p-redundant → FAIL.
		const out = await runCertificationGauntlet(depsFor(candidateBackend(correctButOverStrictFail, seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			operatorApprovedKeySet: true
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('failed');
		// The failed run drove the version terminal-failed (the campaign mechanism).
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('failed');

		const result = await classifyCertificationFail(db, out.run.id, { higherTier: 'opus' });
		expect(result.classification).toBe('key_defect');
		expect(result.keyFix).not.toBeNull();
		expect(result.keyFix!.fixtureSlug).toBe(seed.defectSlug);
		expect(result.keyFix!.suspectPlants).toContain('p-redundant');
		// The fix is a NEW-fixture recommendation — NEVER a silent re-key (B2, §2.1 immutable).
		expect(result.keyFix!.recommendation).toMatch(/new fixture|DO NOT re-key/i);
		expect(result.candidateRemedy).toBeNull();
		// Evidence is read-only from the run results (B3 — never rescored).
		const fxEvidence = result.evidence.find((e) => e.fixture === seed.defectSlug);
		expect(fxEvidence?.found).toContain('p-real');
		expect(fxEvidence?.missed).toContain('p-redundant');

		// §2.2 RECOVERY — a NEW draft version cloning the failed content (NOT an un-fail).
		expect(result.reversion.reversioned).toBe(true);
		expect(result.reversion.version).not.toBeNull();
		expect(result.reversion.version!.lifecycle).toBe('draft');
		expect(result.reversion.version!.id).not.toBe(seed.version.id);
		// B4: the FAILED version is untouched (still terminal-failed — never laundered).
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('failed');

		// B2: the orchestrator confirmed NO key — the original key is unchanged (2 plants,
		// operator-authored), and no new gauntlet_key was written for the suspect fixture.
		const [fxRows] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT VALUE id FROM gauntlet_fixture WHERE role = $r AND slug = $s LIMIT 1;`,
			{ r: new StringRecordId(seed.role.id), s: seed.defectSlug }
		);
		const key = await readGauntletKeyForScoring(db, String(fxRows[0]));
		expect(key?.plants).toHaveLength(2);
		expect(key?.author).toBe('operator');
	}, 40_000);

	it('candidate_miss: candidate found nothing → re-version + remedy, NO key fix', async () => {
		const seed = await seedTarget();
		const out = await runCertificationGauntlet(depsFor(candidateBackend(emptyFindings, seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			operatorApprovedKeySet: true
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('failed');

		const result = await classifyCertificationFail(db, out.run.id, { higherTier: 'opus' });
		expect(result.classification).toBe('candidate_miss');
		expect(result.keyFix).toBeNull();
		expect(result.candidateRemedy).toMatch(/candidate miss/i);
		expect(result.candidateRemedy).toMatch(/higher tier|opus/i);
		// Re-version still happens (fresh drivable draft).
		expect(result.reversion.reversioned).toBe(true);
		expect(result.reversion.version!.lifecycle).toBe('draft');
	}, 40_000);

	it('names a non-failed run (shadow path: wrong status)', async () => {
		const seed = await seedTarget();
		const perfect: FindingsWriter = (cwd, s) => {
			writeFileSync(
				join(cwd, 'findings.json'),
				JSON.stringify([
					{ fixture: s.defectSlug, file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' },
					{ fixture: s.defectSlug, file: 'a.ts', lines: [5, 5], class: 'redundant-citation', evidence: 'const p = 18789;' }
				]),
				'utf8'
			);
		};
		const out = await runCertificationGauntlet(depsFor(candidateBackend(perfect, seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			operatorApprovedKeySet: true
		});
		if (out.kind !== 'ran') throw new Error('expected ran');
		expect(out.run.status).toBe('passed');
		// A 'passed' run has no fail to classify.
		await expect(classifyCertificationFail(db, out.run.id)).rejects.toBeInstanceOf(WorkforceInputError);
	}, 40_000);

	it('names a missing run (shadow path: nil input)', async () => {
		await expect(classifyCertificationFail(db, 'interview_run:nope')).rejects.toBeInstanceOf(WorkforceInputError);
	});
});

// ── certLifecycleOf — read-only cert state (B4) ──────────────────────────────────────

describe('certLifecycleOf — reports cert state, never flips it (B4)', () => {
	it('reads a fresh draft version lifecycle without mutating it', async () => {
		const seed = await seedTarget();
		const before = await getRoleVersion(db, seed.version.id);
		const cert = await certLifecycleOf(db, seed.version.id);
		expect(cert.roleVersion).toBe(seed.version.id);
		expect(cert.lifecycle).toBe('draft');
		// Read-only: lifecycle unchanged after the report.
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe(before?.lifecycle);
	}, 30_000);
});
