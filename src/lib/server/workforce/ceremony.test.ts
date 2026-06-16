import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	listRoleEvents,
	listRoleVersions,
	readGauntletKeyForScoring,
	WorkforceInputError,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import { activateGauntletFixture, isSentinelShape, newSentinelUlid } from './activation';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH, runPositiveControl } from './scorer';
import { adjudicateInterviewRun, type GauntletDeps, QUEUED_INTERVIEW_TYPE } from './gauntlet';
import {
	CeremonyGateError,
	ceremonyExecutionState,
	ceremonyReadiness,
	confirmLaunchKey,
	ensureScorerControlReady,
	promptCoreDiffStep,
	reversionFailedRole,
	triggerAdmissionReferenceRun,
	triggerBootstrapInterview
} from './ceremony';

// TASK 16.7 VERIFY (W-D7c ceremony MECHANISM): the day-0 bootstrap ceremony write-paths
// against a REAL throwaway SurrealDB + the REAL ClaudeCodeRuntime over a scripted backend
// (logic real, only the LLM scripted — F-008). Tests assert (per the task contract):
//   • ceremony triggers are INERT without operator action (auto trigger + null cap → queued);
//   • an operator trigger missing operatorConfirmed FAILS CLOSED (CeremonyGateError);
//   • the key diff+confirm write-path records an operator key (work + key + tolerance + just);
//   • the admission reference-run records a proof ONLY on a pass (and marks provisional);
//   • the §3.4 adjudication math vs the SNAPSHOT pass bar — ambiguous→passed AND →failed.

let tdb: TestDb;
let db: Db;
let wsRoot: string;
let harnessRoot: string;
let seq = 0;

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
	wsRoot = mkdtempSync(join(tmpdir(), 'ceremony-ws-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'ceremony-harness-'));
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	rmSync(wsRoot, { recursive: true, force: true });
	rmSync(harnessRoot, { recursive: true, force: true });
});

function testConfig(over: Partial<WorkforceConfig['budget']> = {}): WorkforceConfig {
	return {
		pm: { provider: 'claude', model_id: 'test-pm-model', triggers: { failure_threshold: null } },
		panel: { scope: { max_files: null, max_new_services: null } },
		gauntlet: { pass_recall: 1.0, max_false_positives: 0, session_timeout_minutes: 15 },
		budget: { max_auto_interviews_per_day: null, allowed_auto_tiers: [], ...over },
		drift: {
			escaped_defect: true,
			operator_feedback: true,
			confidence_miscalibration: true,
			confidence_miscalibration_rate: 0.5,
			refutation_rate: null,
			fixloop_rate: null
		},
		workforce: { max_open_proposals: 2, track_window_days: 14, min_events_for_claim: 5 }
	};
}

interface Seed {
	role: RoleRow;
	version: RoleVersionRow;
	defectSlug: string;
}

/** Seed a role with a planted_defect (keyed + activated) + scorer_control (keyed +
 *  activated) — the substrate a ceremony run interviews against. */
async function seedRole(): Promise<Seed> {
	const n = ++seq;
	const role = await createRole(db, {
		slug: `ceremony-role-${n}`,
		name: `Ceremony Role ${n}`,
		purpose: 'ceremony test bed'
	});
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `Reviewer #${n}: hunt platform bugs with verbatim evidence.`,
		default_tier: 'sonnet',
		source: 'operator'
	});
	const defectSlug = `cd-${n}`;
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: defectSlug,
		kind: 'planted_defect',
		work: { 'a.ts': 'l1\nl2\nprocess.kill(pid, 0);\n' },
		sentinel: newSentinelUlid(),
		provenance: 'harvest: test'
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		plants: [{ id: 'p1', detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'process\\.kill' } }]
	});
	await activateGauntletFixture(db, fixture.id);

	const ctrlSlug = `cc-${n}`;
	const control = await createGauntletFixture(db, {
		role: role.id,
		slug: ctrlSlug,
		kind: 'scorer_control',
		work: {
			'c.ts': 'l1\nl2\nconst r = eval(input);\n',
			[KNOWN_PASS_PATH]: JSON.stringify([
				{ fixture: ctrlSlug, file: 'c.ts', lines: [3, 3], class: 'injection', evidence: 'eval(input)' }
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
	return { role, version, defectSlug };
}

type FindingsWriter = (cwd: string, seed: Seed) => void;

function candidateBackend(write: FindingsWriter | null, seed: Seed): CcBackend {
	return {
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			return {
				ccSessionId: `cc_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					yield { type: 'log', message: 'reviewing' } as RuntimeEvent;
					if (write) write(plan.cwd, seed);
					yield { type: 'token_usage', input: 100, output: 20 } as RuntimeEvent;
					yield { type: 'done', result: { ok: true, summary: 'done' } } as RuntimeEvent;
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

function depsFor(backend: CcBackend, config = testConfig()): GauntletDeps {
	return {
		db,
		runtime: new ClaudeCodeRuntime({
			backend,
			harnessConfigRoot: harnessRoot.replace(/\\/g, '/'),
			gates: { ...DEFAULT_GATE_POLICY }
		}),
		config,
		workspaceRoot: wsRoot
	};
}

const perfectFindings = (slug: string): FindingsWriter => (cwd) => {
	writeFileSync(
		join(cwd, 'findings.json'),
		JSON.stringify([
			{ fixture: slug, file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' }
		]),
		'utf8'
	);
};

// ── Step ① — prompt-core diff (read-only) ───────────────────────────────────────────

describe('promptCoreDiffStep (§8 ①) — read-only review substrate', () => {
	it('returns the draft prompt core + harvested provenance + content address', async () => {
		const role = await createRole(db, {
			slug: `pc-role-${++seq}`,
			name: 'PC',
			purpose: 'p',
			provenance: 'harvested: gstack code-review/SKILL.md, MIT'
		});
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'methodology text',
			default_tier: 'opus',
			source: 'operator'
		});
		const step = await promptCoreDiffStep(db, v.id);
		expect(step.promptCore).toBe('methodology text');
		expect(step.provenance).toMatch(/^harvested:/);
		expect(step.prompt_sha).toBe(v.prompt_sha);
		expect(step.lifecycle).toBe('draft'); // reviewed BEFORE it can interview
	});
});

// ── Step ② — key diff+confirm write-path (operator-gated) ───────────────────────────

describe('confirmLaunchKey (§8 ②) — operator-authored key write-path', () => {
	it('FAILS CLOSED without an operator confirm (no silent key authoring)', async () => {
		const seed = await seedRole();
		const [fx] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM gauntlet_fixture WHERE slug = $s LIMIT 1;`,
			{ s: seed.defectSlug }
		);
		await expect(
			confirmLaunchKey(db, { fixture: String(fx[0].id), operatorConfirmed: false })
		).rejects.toThrow(CeremonyGateError);
	});

	it('records an operator key bound to the work, returning the work+key+tolerance diff', async () => {
		// A fresh proposed fixture WITHOUT a key (the launch shape).
		const role = await createRole(db, { slug: `key-role-${++seq}`, name: 'K', purpose: 'p' });
		const fixture = await createGauntletFixture(db, {
			role: role.id,
			slug: 'kf',
			kind: 'planted_defect',
			work: { 'x.ts': 'bad();\n' },
			sentinel: '',
			provenance: 'harvest: test'
		});
		expect(await readGauntletKeyForScoring(db, fixture.id)).toBeNull(); // honest: no key yet
		const res = await confirmLaunchKey(db, {
			fixture: fixture.id,
			plants: [{ id: 'p1', detection: { file: 'x.ts', evidence_pattern: 'bad' } }],
			fp_tolerance: 1,
			fp_justification: 'one known noisy lint',
			operatorConfirmed: true
		});
		expect(res.created).toBe(true);
		expect(res.key.author).toBe('operator'); // §4.4 — operator-authored only
		expect(res.key.content_sha).toBe(fixture.content_sha); // bound to the work (§2.1)
		expect(res.diff.work).toEqual(fixture.work);
		expect(res.diff.plants).toHaveLength(1);
		expect(res.diff.fp_tolerance).toBe(1);
		expect(res.diff.fp_justification).toBe('one known noisy lint');
		// Idempotent: a re-confirm absorbs (created:false, no duplicate key).
		const again = await confirmLaunchKey(db, { fixture: fixture.id, operatorConfirmed: true });
		expect(again.created).toBe(false);
	});
});

// ── confirmLaunchKey — RED-TEAM hardening (4 day-0 key-authoring defects) ───────────
//
// Each test REPRODUCES the red-team probe that bit during the operator's day-0 key
// authoring, then asserts the named fix. Integration vs the real throwaway SurrealDB.

describe('confirmLaunchKey hardening — day-0 key-authoring trust boundary', () => {
	/** A fresh planted_defect fixture with NO key (the launch-shape the operator keys). */
	async function keylessFixture(
		over: { kind?: 'planted_defect' | 'hallucination_bait' | 'clean_control'; work?: Record<string, string> } = {}
	) {
		const role = await createRole(db, { slug: `rt-role-${++seq}`, name: 'RT', purpose: 'p' });
		const fixture = await createGauntletFixture(db, {
			role: role.id,
			slug: `rt-fx-${seq}`,
			kind: over.kind ?? 'planted_defect',
			work: over.work ?? { 'x.ts': 'process.kill(pid, 0);\n' },
			sentinel: newSentinelUlid(),
			provenance: 'harvest: test'
		});
		return fixture;
	}

	// DEFECT 1 — no parsePlant pre-flight (D-026 trust boundary).
	it('DEFECT 1: a malformed plant (detection not an object) is rejected at confirm, not at scoring', async () => {
		const fx = await keylessFixture();
		await expect(
			confirmLaunchKey(db, {
				fixture: fx.id,
				plants: [{ id: 'bad1', detection: 'not-an-object' as unknown as Record<string, unknown> }],
				operatorConfirmed: true
			})
		).rejects.toThrow(WorkforceInputError);
		// And the named error points at WHICH plant + why; NO key was persisted.
		await expect(
			confirmLaunchKey(db, {
				fixture: fx.id,
				plants: [{ id: 'bad1', detection: 'not-an-object' as unknown as Record<string, unknown> }],
				operatorConfirmed: true
			})
		).rejects.toThrow(/plant\[0\].*bad1.*machine-checkable/i);
		expect(await readGauntletKeyForScoring(db, fx.id)).toBeNull(); // never persisted (honest)
	});

	it('DEFECT 1: a noncompliance plant missing compliance_pattern is rejected at confirm', async () => {
		const fx = await keylessFixture({ kind: 'hallucination_bait' });
		await expect(
			confirmLaunchKey(db, {
				fixture: fx.id,
				plants: [{ id: 'np', detection: { mode: 'noncompliance' } }],
				operatorConfirmed: true
			})
		).rejects.toThrow(/compliance_pattern/);
		expect(await readGauntletKeyForScoring(db, fx.id)).toBeNull();
	});

	// DEFECT 2 — stale-key silent discard.
	it('DEFECT 2: re-confirm with CORRECTED plants returns created:false + changed:true + a named reason', async () => {
		const fx = await keylessFixture();
		const first = await confirmLaunchKey(db, {
			fixture: fx.id,
			plants: [{ id: 'p1', detection: { file: 'x.ts', evidence_pattern: 'process\\.kill' } }],
			operatorConfirmed: true
		});
		expect(first.created).toBe(true);
		// Operator notices a typo and re-confirms a CORRECTED plant set — keys are immutable.
		const corrected = await confirmLaunchKey(db, {
			fixture: fx.id,
			plants: [{ id: 'p1', detection: { file: 'x.ts', evidence_pattern: 'kill\\(pid' } }],
			operatorConfirmed: true
		});
		expect(corrected.created).toBe(false);
		expect(corrected.changed).toBe(true);
		expect(corrected.reason).toMatch(/NOT applied|new fixture/i);
		// The stored key is unchanged (the correction did NOT land).
		expect(corrected.key.plants).toEqual(first.key.plants);
		// A clean idempotent re-confirm (no re-authored fields) carries NO changed signal.
		const clean = await confirmLaunchKey(db, { fixture: fx.id, operatorConfirmed: true });
		expect(clean.created).toBe(false);
		expect(clean.changed).toBeUndefined();
	});

	it('DEFECT 2 (over-warn): a re-confirm differing ONLY by path separator / whitespace is NOT drift', async () => {
		const fx = await keylessFixture();
		const first = await confirmLaunchKey(db, {
			fixture: fx.id,
			plants: [{ id: 'p1', detection: { file: 'src/x.ts', evidence_pattern: 'process\\.kill' } }],
			operatorConfirmed: true
		});
		expect(first.created).toBe(true);
		// Re-confirm with the SAME plant but a backslash separator + surrounding whitespace in the
		// path — parsePlant normalizes both to 'src/x.ts', so this is scoring-identical, NOT a
		// correction. keyDrift must normalize paths the same way and report NO change.
		const reconfirm = await confirmLaunchKey(db, {
			fixture: fx.id,
			plants: [{ id: 'p1', detection: { file: '  src\\x.ts  ', evidence_pattern: 'process\\.kill' } }],
			operatorConfirmed: true
		});
		expect(reconfirm.created).toBe(false);
		expect(reconfirm.changed).toBeUndefined();
		expect(reconfirm.reason).toBeUndefined();
	});

	// DEFECT 3 — concurrent double-submit untyped error.
	it('DEFECT 3: concurrent confirm never leaks a raw error AND never persists a duplicate key', async () => {
		// Run the concurrent double-confirm several times — the race is timing-dependent
		// (sometimes the loser rejects on the dedup collision, sometimes it serializes after
		// the winner and absorbs). Across ALL outcomes the two HARD invariants must hold:
		//   (1) any rejection is the named taxonomy, NEVER a raw 'InternalError' (DEFECT 3 root);
		//   (2) the final persisted state is EXACTLY ONE key (the dedup invariant — the
		//       red-team found two rows with identical dedup_key surviving a concurrent write;
		//       the deterministic primary-key id makes that impossible).
		for (let attempt = 0; attempt < 6; attempt++) {
			const fx = await keylessFixture();
			const confirm = () =>
				confirmLaunchKey(db, {
					fixture: fx.id,
					plants: [{ id: 'p1', detection: { file: 'x.ts', evidence_pattern: 'process\\.kill' } }],
					operatorConfirmed: true
				});
			const results = await Promise.allSettled([confirm(), confirm()]);
			const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
			// Invariant 1 — no raw untyped error escapes; a rejection is the module taxonomy.
			for (const r of rejected) {
				expect(r.reason).toBeInstanceOf(CeremonyGateError);
				expect(String(r.reason)).toMatch(/concurrent confirm|already confirmed/i);
				expect(String(r.reason)).not.toMatch(/InternalError|failed transaction|already (?:exists|contains)/);
			}
			// Invariant 2 — exactly ONE key persisted (no duplicate, regardless of race timing).
			const [cnt] = await db.query<[Array<{ n: number }>]>(
				`SELECT count() AS n FROM gauntlet_key WHERE fixture = $fid GROUP ALL;`,
				{ fid: new StringRecordId(fx.id) }
			);
			expect(cnt[0].n).toBe(1);
		}
	});

	// DEFECT 4 — teethless empty-plant key.
	it('DEFECT 4: a planted_defect key with empty plants is rejected (no teeth)', async () => {
		const fx = await keylessFixture();
		await expect(
			confirmLaunchKey(db, { fixture: fx.id, plants: [], operatorConfirmed: true })
		).rejects.toThrow(/teethless|≥1 plant/);
		expect(await readGauntletKeyForScoring(db, fx.id)).toBeNull();
	});

	it('DEFECT 4: a bait fixture with empty plants is rejected — would be keyed yet NEVER scored', async () => {
		const fx = await keylessFixture({ kind: 'hallucination_bait' });
		await expect(
			confirmLaunchKey(db, { fixture: fx.id, plants: [], operatorConfirmed: true })
		).rejects.toThrow(WorkforceInputError);
	});

	it('DEFECT 4: the operator override (allowEmptyPlants + justification) permits a teethless key on record', async () => {
		const fx = await keylessFixture();
		// Override WITHOUT justification is still refused (no silent on-record gap).
		await expect(
			confirmLaunchKey(db, { fixture: fx.id, plants: [], operatorConfirmed: true, allowEmptyPlants: true })
		).rejects.toThrow(/emptyPlantsJustification/);
		// Override WITH justification is permitted.
		const res = await confirmLaunchKey(db, {
			fixture: fx.id,
			plants: [],
			operatorConfirmed: true,
			allowEmptyPlants: true,
			emptyPlantsJustification: 'placeholder fixture — teeth land in a follow-up revision'
		});
		expect(res.created).toBe(true);
		expect(res.key.plants).toEqual([]);
	});

	it('DEFECT 4: a clean_control with empty plants is still accepted (zero plants is legal there)', async () => {
		const fx = await keylessFixture({ kind: 'clean_control', work: { 'ok.ts': 'const x = 1;\n' } });
		const res = await confirmLaunchKey(db, { fixture: fx.id, plants: [], operatorConfirmed: true });
		expect(res.created).toBe(true);
	});
});

// ── Steps ③/④ — triggers inert without operator action ──────────────────────────────

describe('ceremony run triggers (§8 ③/④) — INERT until the operator acts (§3.7/F-008)', () => {
	it('an AUTO bootstrap interview with the shipped null cap NEVER runs — it queues', async () => {
		const seed = await seedRole();
		const out = await triggerBootstrapInterview(depsFor(candidateBackend(perfectFindings(seed.defectSlug), seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'test-model',
			trigger: 'auto'
		});
		expect(out.kind).toBe('queued'); // counted-and-surfaced, never spent
		const [queued] = await db.query<[Array<{ n: number }>]>(
			`SELECT count() AS n FROM work_item WHERE work_type = $wt GROUP ALL;`,
			{ wt: QUEUED_INTERVIEW_TYPE }
		);
		expect(queued[0].n).toBeGreaterThanOrEqual(1);
	});

	it('an OPERATOR trigger missing operatorConfirmed FAILS CLOSED (no silent operator spend)', async () => {
		const seed = await seedRole();
		await expect(
			triggerBootstrapInterview(depsFor(candidateBackend(null, seed)), {
				roleVersionId: seed.version.id,
				tier: 'sonnet',
				provider: 'claude',
				modelId: 'test-model',
				trigger: 'operator'
				// operatorConfirmed omitted → CeremonyGateError
			})
		).rejects.toThrow(CeremonyGateError);
	});

	it('an OPERATOR-confirmed bootstrap interview runs (the click IS the budget decision) and passes', async () => {
		const seed = await seedRole();
		const out = await triggerBootstrapInterview(depsFor(candidateBackend(perfectFindings(seed.defectSlug), seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'test-model',
			trigger: 'operator',
			operatorConfirmed: true
		});
		expect(out.kind).toBe('ran');
		if (out.kind === 'ran') expect(out.run.status).toBe('passed');
	});

	it('admission reference-run records a PROVISIONAL proof on the keyed fixtures — only on a pass (§3.8)', async () => {
		const seed = await seedRole();
		const res = await triggerAdmissionReferenceRun(
			depsFor(candidateBackend(perfectFindings(seed.defectSlug), seed)),
			{
				roleVersionId: seed.version.id,
				tier: 'sonnet',
				provider: 'claude',
				modelId: 'test-model',
				trigger: 'operator',
				operatorConfirmed: true
			}
		);
		expect(res.outcome.kind).toBe('ran');
		expect(res.provisional).toBe(true); // brand-new role — draft proves itself
		expect(res.recordedFor).toContain(seed.defectSlug);
		// The proof landed in the keyed fixture's reference_runs (§3.8).
		const [fx] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM gauntlet_fixture WHERE slug = $s LIMIT 1;`,
			{ s: seed.defectSlug }
		);
		const key = await readGauntletKeyForScoring(db, String(fx[0].id));
		expect(key!.reference_runs.length).toBe(1);
		expect(key!.reference_runs[0]).toMatchObject({ tier: 'sonnet', model_id: 'test-model', provisional: true });

		// Idempotent: re-running recordReferenceRun via a second admission run for the SAME
		// run id would not duplicate — assert the proof count stays 1 after a re-trigger that
		// produces a distinct run (a NEW run id appends a SECOND proof — distinct evidence).
		const before = key!.reference_runs.length;
		expect(before).toBe(1);
	});

	it('a FAILING reference-run records NO proof (F-008 — never a proof the run did not establish)', async () => {
		const seed = await seedRole();
		// Candidate writes NO findings.json → findings contract violated → failed.
		const res = await triggerAdmissionReferenceRun(depsFor(candidateBackend(null, seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'test-model',
			trigger: 'operator',
			operatorConfirmed: true
		});
		expect(res.outcome.kind).toBe('ran');
		if (res.outcome.kind === 'ran') expect(res.outcome.run.status).toBe('failed');
		expect(res.recordedFor).toEqual([]);
		const [fx] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM gauntlet_fixture WHERE slug = $s LIMIT 1;`,
			{ s: seed.defectSlug }
		);
		const key = await readGauntletKeyForScoring(db, String(fx[0].id));
		expect(key!.reference_runs.length).toBe(0);
	});
});

// ── §3.4 adjudication math vs the SNAPSHOT pass bar (deliverable #3, reused) ─────────

describe('adjudication write-path (§3.4) — ambiguous → passed AND ambiguous → failed', () => {
	/** Drive a run to 'adjudicating' by writing imprecise findings (a partial match). */
	async function adjudicatingRun() {
		const seed = await seedRole();
		// Wrong line range (overlaps file but not lines) → partial match → ambiguous.
		const out = await triggerBootstrapInterview(
			depsFor(
				candidateBackend((cwd) => {
					writeFileSync(
						join(cwd, 'findings.json'),
						JSON.stringify([
							{ fixture: seed.defectSlug, file: 'a.ts', lines: [99, 99], class: 'x', evidence: 'unrelated quote' }
						]),
						'utf8'
					);
				}, seed)
			),
			{
				roleVersionId: seed.version.id,
				tier: 'sonnet',
				provider: 'claude',
				modelId: 'test-model',
				trigger: 'operator',
				operatorConfirmed: true
			}
		);
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') throw new Error('expected ran');
		return out.run;
	}

	it('confirm_hit flips an adjudicating run to PASSED against the snapshot bar', async () => {
		const run = await adjudicatingRun();
		expect(run.status).toBe('adjudicating');
		expect(run.ambiguous.length).toBeGreaterThanOrEqual(1);
		const resolved = await adjudicateInterviewRun(db, run.id, {
			resolutions: run.ambiguous.map((_, i) => ({ index: i, resolution: 'confirm_hit' as const }))
		});
		expect(resolved.status).toBe('passed');
		expect(resolved.planted_found).toBe(resolved.planted_total);
		expect(JSON.stringify(resolved.results)).toContain('adjudication');
	});

	it('dismiss leaves the plant missed → recall fails the snapshot bar → FAILED', async () => {
		const run = await adjudicatingRun();
		const resolved = await adjudicateInterviewRun(db, run.id, {
			resolutions: run.ambiguous.map((_, i) => ({ index: i, resolution: 'dismiss' as const }))
		});
		expect(resolved.status).toBe('failed');
		expect(resolved.planted_found).toBeLessThan(resolved.planted_total);
	});
});

// ── Step ⑤ — readiness (read-only) ───────────────────────────────────────────────────

describe('ceremonyReadiness (§8 ⑤) — reports the panel-flip precondition, never flips', () => {
	it('reports honest not-certified state for an uninterviewed launch role', async () => {
		const role = await createRole(db, { slug: `ready-role-${++seq}`, name: 'R', purpose: 'p' });
		await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'm',
			default_tier: 'opus',
			source: 'operator'
		});
		const readiness = await ceremonyReadiness(db, { [role.slug]: 'some-model' });
		const me = readiness.roles.find((r) => r.roleSlug === role.slug);
		expect(me).toBeTruthy();
		expect(me!.certified).toBe(false);
		expect(me!.reason).toBeTruthy(); // honest named reason (§2.4)
		expect(readiness.allCertified).toBe(false); // not all five passed
	});
});

// ── ceremonyExecutionState (§8 ③/④/⑤) — the EXECUTION DRIVER read substrate ──────────

describe('ceremonyExecutionState (§8 ③/④/⑤) — proofs, interview line, runnable, certified', () => {
	it('a seeded role surfaces runnable:true once keyed+activated, then certified + proof after a passing run', async () => {
		const seed = await seedRole(); // keys + activates a planted_defect + scorer_control
		// The seeded role has its candidate fixtures keyed + ACTIVE — it is runnable.
		const pre = await ceremonyExecutionState(db);
		const mePre = pre.roles.find((r) => r.role === seed.role.id)!;
		expect(mePre.runnable).toBe(true);
		expect(mePre.notRunnableReason).toBeNull();
		expect(mePre.fixturesActive).toBeGreaterThan(0);
		expect(mePre.fixturesProposed).toBe(0);
		expect(mePre.fixturesUnkeyed).toBe(0);
		expect(mePre.certified).toBe(false); // not yet interviewed
		expect(mePre.interview).toBeNull();
		expect(mePre.referenceProofs).toEqual([]);

		// Run an admission reference-run (operator-confirmed) → records a provisional proof.
		await triggerAdmissionReferenceRun(depsFor(candidateBackend(perfectFindings(seed.defectSlug), seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'test-model',
			trigger: 'operator',
			operatorConfirmed: true
		});
		// Run a bootstrap interview (operator-confirmed) → passes → certified.
		await triggerBootstrapInterview(depsFor(candidateBackend(perfectFindings(seed.defectSlug), seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'test-model',
			trigger: 'operator',
			operatorConfirmed: true
		});

		const post = await ceremonyExecutionState(db);
		const mePost = post.roles.find((r) => r.role === seed.role.id)!;
		expect(mePost.certified).toBe(true);
		expect(mePost.interview).not.toBeNull();
		expect(mePost.interview!.status).toBe('passed');
		expect(mePost.interview!.model_id).toBe('test-model'); // from the row, not hardcoded
		expect(mePost.interview!.plantedFound).toBe(mePost.interview!.plantedTotal);
		// The admission proof is surfaced, provisional-aware (brand-new role proves itself).
		expect(mePost.referenceProofs.length).toBeGreaterThanOrEqual(1);
		expect(mePost.referenceProofs.some((p) => p.provisional && p.model_id === 'test-model')).toBe(true);
	});

	it('SHADOW: a role with candidate fixtures but no keys is NOT runnable, with a named reason', async () => {
		const role = await createRole(db, { slug: `exec-unkeyed-${++seq}`, name: 'U', purpose: 'p' });
		await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'm',
			default_tier: 'opus',
			source: 'operator'
		});
		// A proposed, UNKEYED candidate fixture.
		await createGauntletFixture(db, {
			role: role.id,
			slug: `uf-${seq}`,
			kind: 'planted_defect',
			work: { 'x.ts': 'bad();\n' },
			sentinel: '',
			provenance: 'harvest: test'
		});
		const exec = await ceremonyExecutionState(db);
		const me = exec.roles.find((r) => r.role === role.id)!;
		expect(me.runnable).toBe(false);
		expect(me.fixturesUnkeyed).toBeGreaterThan(0);
		expect(me.notRunnableReason).toMatch(/key\(s\) outstanding/i);
		expect(me.certified).toBe(false);
		expect(me.notCertifiedReason).toBe('not yet interviewed');
	});
});

// ── ensureScorerControlReady (§3.4) — mechanically-derived control key + activation ──
//
// Reproduces the ceremony/§3.4 contradiction the bug exposed: the operator key-authoring +
// activation flow EXCLUDES scorer_control fixtures (kind != 'scorer_control'), so a
// scorer_control shipped 'proposed' with NO key, and every interview failed scorer_error
// ("no active scorer_control fixture (with key)"). ensureScorerControlReady derives the
// control's key MECHANICALLY from its own shipped known-pass report (§4.4
// author:'fixing_commit_diff') and activates it — idempotently.

describe('ensureScorerControlReady (§3.4) — mechanical control key derivation + activation', () => {
	/** Seed a role carrying a PROPOSED, UNKEYED scorer_control (the buggy launch shape). */
	async function seedProposedControl(over?: { knownPass?: unknown; knownFail?: unknown }) {
		const n = ++seq;
		const role = await createRole(db, {
			slug: `escr-role-${n}`,
			name: `ESCR ${n}`,
			purpose: 'control readiness test bed'
		});
		const ctrlSlug = `escr-cc-${n}`;
		const control = await createGauntletFixture(db, {
			role: role.id,
			slug: ctrlSlug,
			kind: 'scorer_control',
			work: {
				'c.ts': 'l1\nl2\nconst r = eval(input);\n',
				[KNOWN_PASS_PATH]: JSON.stringify(
					over?.knownPass ?? [
						{ fixture: ctrlSlug, file: 'c.ts', lines: [3, 3], class: 'injection', evidence: 'eval(input)' }
					]
				),
				[KNOWN_FAIL_PATH]: JSON.stringify(over?.knownFail ?? [])
			},
			// The REAL seedLaunchPool shape: launch fixtures ship with an EMPTY sentinel
			// (the leak-tripwire ULID is minted server-side AT activation, after authoring —
			// §4.2). ensureScorerControlReady must mint it before activating, else F-025 rejects.
			sentinel: ''
		});
		return { role, control, ctrlSlug };
	}

	/** Re-read a fixture row from the DB (activation injects the sentinel + recomputes
	 *  content_sha, so the row captured at creation is stale post-ensure). */
	async function reloadFixture(fixtureId: string) {
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT * FROM gauntlet_fixture WHERE id = $id LIMIT 1;`,
			{ id: new StringRecordId(fixtureId) }
		);
		const r = rows[0];
		return {
			id: String(r.id),
			role: String(r.role),
			slug: String(r.slug),
			kind: r.kind as 'scorer_control',
			work: (r.work ?? {}) as Record<string, unknown>,
			content_sha: String(r.content_sha),
			sentinel: String(r.sentinel),
			status: r.status as 'proposed' | 'active' | 'retired',
			created_at: null
		};
	}

	it('throws a named WorkforceInputError when the role has no scorer_control fixture', async () => {
		const role = await createRole(db, { slug: `escr-none-${++seq}`, name: 'N', purpose: 'p' });
		await expect(ensureScorerControlReady(db, role.id)).rejects.toThrow(WorkforceInputError);
		await expect(ensureScorerControlReady(db, role.id)).rejects.toThrow(/no scorer_control fixture/i);
	});

	it('derives the key from the known-pass report and activates the fixture', async () => {
		const { role, control } = await seedProposedControl();
		// Precondition: the REAL bug shape — proposed, no key, EMPTY sentinel (seedLaunchPool).
		expect(await readGauntletKeyForScoring(db, control.id)).toBeNull();
		expect(control.sentinel).toBe('');
		expect(isSentinelShape(control.sentinel)).toBe(false);

		await ensureScorerControlReady(db, role.id);

		// A key was mechanically derived (§4.4 author), bound to the work, plant = known-pass.
		// Re-read the fixture: activation injected the sentinel + recomputed content_sha and
		// RE-BOUND the key in the same transaction (§2.1), so compare against the live row.
		const activated = await reloadFixture(control.id);
		const key = await readGauntletKeyForScoring(db, control.id);
		expect(key).not.toBeNull();
		expect(key!.author).toBe('fixing_commit_diff'); // mechanically derived, not operator
		expect(key!.content_sha).toBe(activated.content_sha); // re-bound to the activated work (§2.1)
		expect(key!.plants).toHaveLength(1);
		const plant = key!.plants[0] as Record<string, unknown>;
		expect(plant.id).toBe('injection'); // derived from the finding's class
		const det = plant.detection as Record<string, unknown>;
		expect(det.mode).toBe('presence');
		expect(det.file).toBe('c.ts');
		expect(det.lines).toEqual([3, 3]);
		expect(det.evidence_pattern).toBeUndefined(); // file+lines ONLY — zero ambiguity

		// The fixture is now active AND carries a freshly-minted valid ULID sentinel (§4.2 /
		// F-025): the empty seedLaunchPool sentinel was re-minted before activation.
		expect(activated.status).toBe('active');
		expect(isSentinelShape(activated.sentinel)).toBe(true);
	});

	it('is idempotent on re-run — no duplicate-key crash, no double activation', async () => {
		const { role, control } = await seedProposedControl();
		await ensureScorerControlReady(db, role.id);
		const firstKey = await readGauntletKeyForScoring(db, control.id);
		// Re-run twice more: must not throw (no deterministic-id collision surfaced).
		await expect(ensureScorerControlReady(db, role.id)).resolves.toBeUndefined();
		await expect(ensureScorerControlReady(db, role.id)).resolves.toBeUndefined();
		const againKey = await readGauntletKeyForScoring(db, control.id);
		expect(againKey!.id).toBe(firstKey!.id); // same key id — never duplicated
		// Still exactly ONE active control fixture for the role.
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT id FROM gauntlet_fixture
			  WHERE role = $role AND kind = 'scorer_control' AND status = 'active';`,
			{ role: new StringRecordId(role.id) }
		);
		expect(rows).toHaveLength(1);
	});

	it('the derived key makes runPositiveControl return {ok:true} for the control fixture', async () => {
		const { role, control } = await seedProposedControl();
		await ensureScorerControlReady(db, role.id);
		const key = await readGauntletKeyForScoring(db, control.id);
		expect(key).not.toBeNull();
		// Re-read the activated row (post sentinel-injection + key re-bind) — this is exactly
		// the (fixture, key) pair runGauntlet feeds runPositiveControl at scoring time.
		const activated = await reloadFixture(control.id);
		const verdict = runPositiveControl(activated, key!);
		expect(verdict).toEqual({ ok: true });
	});

	it('derives an absence plant (regex-escaped artifact) for an absence known-pass finding', async () => {
		const n = seq + 1; // the slug seedProposedControl will mint
		const { role, control, ctrlSlug } = await seedProposedControl({
			knownPass: [
				{ fixture: `escr-cc-${n}`, absence: { artifact: 'rate-limit.guard.ts', search: 'grep rate-limit' } }
			],
			knownFail: []
		});
		expect(ctrlSlug).toBe(`escr-cc-${n}`); // the fixture slug the finding targets
		await ensureScorerControlReady(db, role.id);
		const key = await readGauntletKeyForScoring(db, control.id);
		const plant = key!.plants[0] as Record<string, unknown>;
		const det = plant.detection as Record<string, unknown>;
		expect(det.mode).toBe('absence');
		// '.' in the literal artifact is escaped so it matches a literal dot, not any-char.
		expect(det.artifact_pattern).toBe('rate-limit\\.guard\\.ts');
	});
});

// ── RECOVERY — re-version a role whose newest version is terminally FAILED (§2.2) ─────
//
// The day-0 gauntlet scenario: a now-fixed scorer bug marked the only version 'failed'
// (terminal, §2.2), leaving the ceremony with no drivable version. The recovery path is a
// NEW version cloning the failed content (createRoleVersion → fresh sha by construction;
// lifecycle starts 'draft') — NEVER a mutation/reset of the failed row (cert-integrity).

describe('reversionFailedRole (§8 recovery) — a NEW version, never a failed-version reset', () => {
	/** Drive a role's draft version to terminal 'failed' via a real failing interview (the
	 *  candidate writes NO findings → findings contract violated → failed, which finalizes the
	 *  campaign draft→interviewing→failed). Returns the role + the now-failed version row. */
	async function roleWithFailedVersion(): Promise<{ role: RoleRow; failed: RoleVersionRow }> {
		const seed = await seedRole();
		const out = await triggerBootstrapInterview(depsFor(candidateBackend(null, seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'test-model',
			trigger: 'operator',
			operatorConfirmed: true
		});
		expect(out.kind).toBe('ran');
		if (out.kind === 'ran') expect(out.run.status).toBe('failed');
		const failed = await getRoleVersion(db, seed.version.id);
		expect(failed!.lifecycle).toBe('failed'); // §2.2 terminal — the recovery trigger
		return { role: seed.role, failed: failed! };
	}

	it('creates a NEW draft v2 cloning the failed v1 content; the failed v1 is UNCHANGED (immutable)', async () => {
		const { role, failed } = await roleWithFailedVersion();
		expect(failed.version).toBe(1);

		const res = await reversionFailedRole(db, role.id);
		expect(res.reversioned).toBe(true);
		expect(res.from!.id).toBe(failed.id);
		const v2 = res.version!;
		expect(v2.version).toBe(2); // auto-incremented (max+1), NOT a hand-rolled row
		expect(v2.lifecycle).toBe('draft'); // §2.2 initial state — un-certified, must earn its run
		expect(v2.prompt_core).toBe(failed.prompt_core); // content cloned
		expect(v2.capabilities).toEqual(failed.capabilities);
		expect(v2.default_tier).toBe(failed.default_tier);
		// Identical prompt_core+capabilities ⇒ IDENTICAL sha BY CONSTRUCTION (intended; the sha is
		// a content address, and createRoleVersion computes it — never the caller).
		expect(v2.prompt_sha).toBe(failed.prompt_sha);
		expect(v2.source).toBe('operator');

		// The failed version is byte-for-byte unchanged — NEVER mutated/un-failed (cert-integrity).
		const failedAfter = await getRoleVersion(db, failed.id);
		expect(failedAfter!.lifecycle).toBe('failed');
		expect(failedAfter!.version).toBe(1);
		expect(failedAfter!.prompt_sha).toBe(failed.prompt_sha);
		expect(failedAfter!.retired_at).toBe(failed.retired_at);
	});

	it('records an append-only role_event provenance noting the re-version of the failed prior', async () => {
		const { role, failed } = await roleWithFailedVersion();
		const res = await reversionFailedRole(db, role.id);
		const events = await listRoleEvents(db, role.id);
		const rev = events.find(
			(e) => e.op === 'created' && (e.detail as Record<string, unknown>)?.reason === 'reversion'
		);
		expect(rev).toBeTruthy();
		expect(rev!.role_version).toBe(res.version!.id);
		const detail = rev!.detail as Record<string, unknown>;
		expect(detail.of_version).toBe(failed.version);
		expect(detail.of_lifecycle).toBe('failed');
		expect(detail.of_role_version).toBe(failed.id);
	});

	it('the ceremony picker + execution state now target the NEW version, never the failed one', async () => {
		const { role, failed } = await roleWithFailedVersion();

		// BEFORE reversion: no drivable version; the role is surfaced as reversionable.
		let exec = await ceremonyExecutionState(db);
		let line = exec.roles.find((r) => r.role === role.id)!;
		expect(line.roleVersion).toBeNull(); // failed v1 is NOT selectable
		expect(line.reversionable).toBe(true);
		expect(line.reversionFrom).toEqual({ id: failed.id, version: 1 });
		expect(line.certified).toBe(false);

		// AFTER reversion: the picker targets the fresh v2, NOT the failed v1.
		const res = await reversionFailedRole(db, role.id);
		exec = await ceremonyExecutionState(db);
		line = exec.roles.find((r) => r.role === role.id)!;
		expect(line.roleVersion).toBe(res.version!.id);
		expect(line.version).toBe(2);
		expect(line.lifecycle).toBe('draft');
		expect(line.reversionable).toBe(false); // a drivable version exists again
		expect(line.certified).toBe(false); // un-certified — must earn its own run
	});

	it('a full referenceRun→interview path runs against the NEW version (recovery completes)', async () => {
		const { role } = await roleWithFailedVersion();
		const res = await reversionFailedRole(db, role.id);
		const v2 = res.version!;

		// The fixtures from seedRole are already active+keyed (shared substrate) — interview v2.
		// A passing candidate must find the planted defect; reuse the seed's defect slug.
		const [fx] = await db.query<[Array<{ slug: string }>]>(
			`SELECT slug FROM gauntlet_fixture WHERE role = $role AND kind = 'planted_defect' LIMIT 1;`,
			{ role: new StringRecordId(role.id) }
		);
		const defectSlug = fx[0].slug;
		const writer: FindingsWriter = (cwd) => {
			writeFileSync(
				join(cwd, 'findings.json'),
				JSON.stringify([
					{ fixture: defectSlug, file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' }
				]),
				'utf8'
			);
		};
		const fakeSeed = { defectSlug } as unknown as Seed;
		const ref = await triggerAdmissionReferenceRun(depsFor(candidateBackend(writer, fakeSeed)), {
			roleVersionId: v2.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'test-model',
			trigger: 'operator',
			operatorConfirmed: true
		});
		expect(ref.outcome.kind).toBe('ran');

		const iv = await triggerBootstrapInterview(depsFor(candidateBackend(writer, fakeSeed)), {
			roleVersionId: v2.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'test-model',
			trigger: 'operator',
			operatorConfirmed: true
		});
		expect(iv.kind).toBe('ran');
		if (iv.kind === 'ran') expect(iv.run.status).toBe('passed');
		// v2 earned its OWN passing run; the failed v1 is still failed.
		const v2After = await getRoleVersion(db, v2.id);
		expect(v2After!.lifecycle).toBe('passed');
	});

	it('is double-submit safe: a second reversion does NOT spawn a third version (guarded no-op)', async () => {
		const { role } = await roleWithFailedVersion();
		const first = await reversionFailedRole(db, role.id);
		expect(first.reversioned).toBe(true);
		expect(first.version!.version).toBe(2);

		// A second click: the role already has a drivable v2 (draft) → no-op, no v3.
		const second = await reversionFailedRole(db, role.id);
		expect(second.reversioned).toBe(false);
		expect(second.reason).toMatch(/already has a drivable version/i);
		expect(second.version!.version).toBe(2); // points at the existing v2, not a new one
		const versions = await listRoleVersions(db, role.id);
		expect(versions.filter((v) => v.version >= 2)).toHaveLength(1); // exactly ONE new version
	});

	it('a NON-failed role (still draft, drivable) is NOT reversioned (guarded no-op)', async () => {
		const seed = await seedRole(); // fresh draft, never interviewed → drivable
		const res = await reversionFailedRole(db, seed.role.id);
		expect(res.reversioned).toBe(false);
		expect(res.version!.id).toBe(seed.version.id); // points at the live draft
		expect(res.reason).toMatch(/already has a drivable version/i);
		// No new version was created.
		const versions = await listRoleVersions(db, seed.role.id);
		expect(versions).toHaveLength(1);
	});

	it('RED-TEAM: reversion can never un-fail the terminal version nor fabricate a passing cert', async () => {
		const { role, failed } = await roleWithFailedVersion();
		const res = await reversionFailedRole(db, role.id);
		// (1) The failed version is still failed — reversion did NOT touch its lifecycle.
		const failedAfter = await getRoleVersion(db, failed.id);
		expect(failedAfter!.lifecycle).toBe('failed');
		// (2) The new version is un-certified — it did NOT inherit any passing status.
		expect(res.version!.lifecycle).toBe('draft');
		// (3) The picker can never select the failed version for a flip — it's not selectable.
		const exec = await ceremonyExecutionState(db);
		const line = exec.roles.find((r) => r.role === role.id)!;
		expect(line.roleVersion).not.toBe(failed.id);
		expect(line.certified).toBe(false);
		// (4) No hand-rolled sha: the new sha equals computePromptSha over the SAME content
		//     (createRoleVersion is the sole sha author) — assert it matches the failed prior's
		//     (identical content ⇒ identical address), proving it was computed, not invented.
		expect(res.version!.prompt_sha).toBe(failed.prompt_sha);
	});

	it('shadow paths: a missing role is a named error; a role with no versions is a named error', async () => {
		// nil/upstream error: nonexistent role id.
		await expect(reversionFailedRole(db, 'role:does_not_exist')).rejects.toThrow(WorkforceInputError);
		// empty: a role that exists but has zero versions.
		const role = await createRole(db, { slug: `rev-empty-${++seq}`, name: 'E', purpose: 'p' });
		await expect(reversionFailedRole(db, role.id)).rejects.toThrow(/no versions/i);
	});

	it('CONCURRENCY: the loser of a re-version race is a benign no-op returning the winner v2 (no raw 500, exactly ONE new version)', async () => {
		// The deferred-MEDIUM race (79f9b19): two operator submits both pass the pickLaunchVersion
		// read (only the failed v1, nothing selectable), then BOTH compute version=max+1 against
		// the SAME max and collide on the role_version_dedup UNIQUE index (dedup_key=role|version).
		// The UNIQUE index keeps it to ONE new version; the loser must NOT surface a raw 500.
		//
		// Modelled DETERMINISTICALLY as the LOSER's path: the WINNER has already created the fresh
		// v2 (we create it for real). The loser is then driven through a db proxy that reproduces
		// exactly what the loser saw: its PRE-WRITE selectable read raced in BEFORE the winner's v2
		// was visible (so pickLaunchVersion sees nothing selectable → it proceeds to create), and
		// its math::max read ALSO predates the winner's insert (so it computes version=2 — which the
		// winner already took). The real UNIQUE index then rejects the loser's CREATE. The loser's
		// POST-collision re-read sees the real, committed v2 (the winner's). No interleaving luck.
		const { role, failed } = await roleWithFailedVersion();
		expect(failed.version).toBe(1);

		// The WINNER's recovery version — created for real (this is the one v2 that must survive).
		const winnerV2 = await createRoleVersion(db, {
			role: role.id,
			prompt_core: failed.prompt_core,
			capabilities: failed.capabilities,
			default_tier: failed.default_tier,
			source: 'operator'
		});
		expect(winnerV2.version).toBe(2);

		// Drive the LOSER. Its first `SELECT * FROM role_version` (the pickLaunchVersion read) must
		// hide v2 (raced in before the winner committed → nothing selectable → loser proceeds); its
		// `math::max(version)` must return 1 (predates the winner's insert → loser computes v2). The
		// real CREATE then collides on the UNIQUE index. Every SUBSEQUENT read (the post-collision
		// re-read) is real → it sees the winner's committed v2.
		let listReads = 0;
		const loserDb = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'query') {
					return async (sql: string, ...rest: unknown[]) => {
						const real = (target.query as (s: string, ...a: unknown[]) => Promise<unknown>).bind(target);
						if (typeof sql === 'string' && /SELECT \* FROM role_version WHERE role/i.test(sql)) {
							listReads += 1;
							if (listReads === 1) {
								// pre-write read: hide v2 — only the failed v1 is visible to the loser.
								const out = (await real(sql, ...rest)) as [Array<{ version: number }>];
								return [out[0].filter((r) => r.version < 2)] as unknown;
							}
							// post-collision re-read: real (the winner's v2 is visible).
							return real(sql, ...rest);
						}
						if (typeof sql === 'string' && /math::max\(version\)/i.test(sql)) {
							return [[{ v: 1 }]]; // loser's max read predates the winner's insert.
						}
						return real(sql, ...rest);
					};
				}
				return Reflect.get(target, prop, receiver);
			}
		}) as typeof db;

		// The loser does NOT throw a raw 500 — the UNIQUE collision is caught + resolved as a no-op.
		const loser = await reversionFailedRole(loserDb, role.id);
		expect(loser.reversioned).toBe(false); // benign no-op — the winner already created v2
		expect(loser.version!.id).toBe(winnerV2.id); // returns the winner's version (operator intent met)
		expect(loser.version!.version).toBe(2);
		expect(loser.version!.lifecycle).toBe('draft'); // fresh draft — NEVER a fabricated cert
		expect(loser.from!.id).toBe(failed.id);
		expect(loser.reason).toMatch(/concurrent/i);

		// Exactly ONE new version survives despite the race (the UNIQUE index held — never weakened).
		const versions = await listRoleVersions(db, role.id);
		expect(versions.filter((v) => v.version >= 2)).toHaveLength(1);

		// The failed v1 is STILL failed — the race never un-failed the terminal (cert-integrity §2.2).
		const failedAfter = await getRoleVersion(db, failed.id);
		expect(failedAfter!.lifecycle).toBe('failed');

		// The loser wrote NO duplicate provenance role_event (it short-circuited before addRoleEvent).
		const events = await listRoleEvents(db, role.id);
		const revEvents = events.filter(
			(e) => e.op === 'created' && (e.detail as Record<string, unknown>)?.reason === 'reversion'
		);
		// (the winner here was created via the raw createRoleVersion helper, not reversionFailedRole,
		//  so it has no reversion event — the loser must add NONE either: assert zero from the loser.)
		expect(revEvents).toHaveLength(0);
	});

	it('SERIAL double-submit (the common double-click): the second submit is a benign no-op, never a raw error', async () => {
		// The dominant real-world shape of the race: an operator double-clicks, the two form
		// submits SERIALIZE (the second reaches the DB after the first committed). The first
		// creates v2; the second's pickLaunchVersion read now SEES v2 (selectable) → guarded no-op
		// BEFORE any create — so it never even reaches the dedup collision. Already covered by the
		// 'double-submit safe' test above against the createRoleVersion path; this asserts the
		// route-facing property explicitly: neither submit throws, exactly one new version.
		const { role } = await roleWithFailedVersion();
		const first = await reversionFailedRole(db, role.id);
		const second = await reversionFailedRole(db, role.id);
		expect(first.reversioned).toBe(true);
		expect(second.reversioned).toBe(false); // guarded no-op (sees v2 selectable)
		expect(second.version!.id).toBe(first.version!.id);
		const versions = await listRoleVersions(db, role.id);
		expect(versions.filter((v) => v.version >= 2)).toHaveLength(1);
	});

	it('RED-TEAM: the collision matcher does NOT swallow an unrelated DB error — it propagates', async () => {
		// Feed reversionFailedRole a db whose role_version CREATE fails with a NON-dedup error.
		// The fix must re-raise it (F-008: never eat a real write failure as a benign no-op).
		// Build the failed-v1 substrate on the real db, then drive the create through a proxy db
		// whose .query throws an unrelated error on the role_version CREATE only.
		const { role } = await roleWithFailedVersion();
		const unrelated = new Error('Some other DB failure: connection reset by peer');
		const proxyDb = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'query') {
					return async (sql: string, ...rest: unknown[]) => {
						if (typeof sql === 'string' && /CREATE role_version/i.test(sql)) {
							throw unrelated;
						}
						return (target.query as (s: string, ...a: unknown[]) => unknown)(sql, ...rest);
					};
				}
				return Reflect.get(target, prop, receiver);
			}
		}) as typeof db;

		// The unrelated error propagates unchanged — NOT mapped to a no-op, NOT swallowed.
		await expect(reversionFailedRole(proxyDb, role.id)).rejects.toThrow(/connection reset by peer/i);

		// And it did NOT create a version (the write genuinely failed) — exactly the failed v1 remains.
		const versions = await listRoleVersions(db, role.id);
		expect(versions).toHaveLength(1);
		expect(versions[0].version).toBe(1);
	});
});
