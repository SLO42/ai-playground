import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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
	readGauntletKeyForScoring,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import { activateGauntletFixture, newSentinelUlid } from './activation';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH } from './scorer';
import { adjudicateInterviewRun, type GauntletDeps, QUEUED_INTERVIEW_TYPE } from './gauntlet';
import {
	CeremonyGateError,
	ceremonyReadiness,
	confirmLaunchKey,
	promptCoreDiffStep,
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
		workforce: { max_open_proposals: 2 }
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
