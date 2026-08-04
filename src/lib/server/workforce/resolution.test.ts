import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { activateGauntletFixture, newSentinelUlid } from './activation';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH } from './scorer';
import {
	createGauntletFixture,
	createGauntletKey,
	createReviewProposal,
	createRole,
	createRoleVersion,
	getInterviewRun,
	getReviewProposal,
	getRole,
	getRoleVersion,
	listOpenProposals,
	swapActiveVersion,
	transitionLifecycle,
	WorkforceInputError,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import {
	authorChallenger,
	buildProposalCard,
	diffLines,
	proposalDiff,
	reconcileProposalFromRun,
	regauntletChallenger,
	rejectProposal,
	resolveRegauntletTarget,
	ResolutionGateError,
	swapFromProposal
} from './resolution';
import { adjudicateInterviewRun, type GauntletDeps } from './gauntlet';

// WORKFORCE-SPEC §5 RESOLUTION — the operator-gated half, end-to-end vs a REAL throwaway
// SurrealDB + the REAL ClaudeCodeRuntime over a scripted backend (gauntlet.test.ts
// discipline: the logic is real, only the LLM is scripted). Certifies:
//   • the full proposed → author(diff) → re-gauntlet → compared → swap path activates the
//     challenger; reject closes with reason + feeds cooldown;
//   • THE GOVERNANCE RED-TEAM (the locked invariants): no swap without an operator confirm
//     AND a passing challenger gauntlet; the challenger never inherits the incumbent's cert;
//     the diff shown matches the real prompt_core delta; D-026 screens shown/stored text.

let tdb: TestDb;
let db: Db;
let wsRoot: string;
let harnessRoot: string;

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

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
	wsRoot = mkdtempSync(join(tmpdir(), 'resolution-ws-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'resolution-harness-'));
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
const MODEL = 'claude-sonnet-x';

interface RoleSeed {
	role: RoleRow;
	incumbent: RoleVersionRow;
	defectSlug: string;
}

/** Seed a role with a planted_defect + scorer_control fixture (both activated). The
 *  incumbent version is created BUT left un-certified unless `certifyIncumbent` is set. */
async function seedRole(): Promise<RoleSeed> {
	const n = ++seedCount;
	const role = await createRole(db, {
		slug: `res-host-${n}`,
		name: `Resolution Host ${n}`,
		purpose: 'resolution test bed'
	});
	const incumbent = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are reviewer #${n}.\nHunt platform bugs.\nQuote verbatim evidence.`,
		default_tier: 'sonnet',
		source: 'operator'
	});
	const defectSlug = `fx-defect-${n}`;
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: defectSlug,
		kind: 'planted_defect',
		work: { 'a.ts': 'line1\nline2\nprocess.kill(pid, 0);\n' },
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		plants: [
			{
				id: 'p1',
				class: 'platform-bug',
				location: 'a.ts:3',
				severity: 'high',
				detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'process\\.kill' }
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
	return { role, incumbent, defectSlug };
}

// ── Scripted backend (writes a perfect findings.json for the seed's defect) ─────────

interface ScriptedBackend extends CcBackend {
	plans: CcSpawnPlan[];
	probes: { inside?: CanUseToolResult; outside?: CanUseToolResult };
}

function candidateBackend(defectSlug: string, write = true): ScriptedBackend {
	const plans: CcSpawnPlan[] = [];
	const probes: ScriptedBackend['probes'] = {};
	return {
		plans,
		probes,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: `cc_res_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					yield { type: 'log', message: 'challenger reviewing' } as RuntimeEvent;
					if (plan.canUseTool) {
						probes.inside = await plan.canUseTool('Write', { file_path: join(plan.cwd, 'findings.json') });
						probes.outside = await plan.canUseTool('Write', {
							file_path: resolve(plan.cwd, '..', '..', 'escape.txt')
						});
					}
					if (write) {
						writeFileSync(
							join(plan.cwd, 'findings.json'),
							JSON.stringify([
								{ fixture: defectSlug, file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' }
							]),
							'utf8'
						);
					}
					yield { type: 'tool_call', name: 'Write', args: { file_path: 'findings.json' }, needsConfirm: false } as RuntimeEvent;
					yield { type: 'token_usage', input: 800, output: 100 } as RuntimeEvent;
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

function depsFor(backend: CcBackend): GauntletDeps {
	const runtime = new ClaudeCodeRuntime({
		backend,
		harnessConfigRoot: harnessRoot.replace(/\\/g, '/'),
		gates: { ...DEFAULT_GATE_POLICY }
	});
	return { db, runtime, config: testConfig(), workspaceRoot: wsRoot };
}

/** Drive a freshly-seeded role's incumbent through a real PASSING gauntlet so it is
 *  certified at (prompt_sha × MODEL) — the §5 comparison baseline + the swap target source. */
async function certifyIncumbent(seed: RoleSeed): Promise<RoleVersionRow> {
	const { runGauntlet } = await import('./gauntlet');
	const out = await runGauntlet(depsFor(candidateBackend(seed.defectSlug)), {
		roleVersionId: seed.incumbent.id,
		tier: 'sonnet',
		provider: 'claude',
		modelId: MODEL,
		trigger: 'operator'
	});
	expect(out.kind).toBe('ran');
	if (out.kind !== 'ran') throw new Error('incumbent gauntlet did not run');
	expect(out.run.status).toBe('passed');
	const v = await getRoleVersion(db, seed.incumbent.id);
	await swapActiveVersion(db, seed.role.id, seed.incumbent.id);
	return v!;
}

/** Open a proposed prompt_revision proposal targeting the incumbent (mirrors drift auto-raise). */
async function openProposal(seed: RoleSeed) {
	return createReviewProposal(db, {
		role: seed.role.id,
		kind: 'prompt_revision',
		incumbent: seed.incumbent.id,
		trigger: { signal: 'confidence_miscalibration', evidence: [], reason: 'test' }
	});
}

// ── diffLines (pure) ────────────────────────────────────────────────────────────────

describe('diffLines — the D-010 substrate is computed over real text', () => {
	it('adds/dels/contexts line-for-line', () => {
		const d = diffLines('a\nb\nc', 'a\nB\nc');
		expect(d.filter((l) => l.op === 'context').map((l) => l.text)).toEqual(['a', 'c']);
		expect(d.filter((l) => l.op === 'del').map((l) => l.text)).toEqual(['b']);
		expect(d.filter((l) => l.op === 'add').map((l) => l.text)).toEqual(['B']);
	});
	it('handles empty before (all-add) and empty after (all-del)', () => {
		expect(diffLines('', 'x\ny').every((l) => l.op === 'add')).toBe(true);
		expect(diffLines('x\ny', '').every((l) => l.op === 'del')).toBe(true);
		expect(diffLines('', '')).toEqual([]);
	});

	// REGRESSION (review gap 3): diffLines emits structurally-DUPLICATE lines (same op+text)
	// for repeated blank lines. The surface keyed `{#each lines as l (l.text + l.op)}`, which
	// throws Svelte each_key_duplicate (client crash, dev+prod) once the block is reachable.
	// The fix keys by index; this asserts the duplicates that forced it actually occur, so the
	// (l.op + '·' + i) key is provably load-bearing — not a cosmetic change.
	it('emits non-unique (op,text) lines for repeated blanks → key must be index-based', () => {
		const lines = diffLines('head\n\n\ntail', 'head\n\n\n\ntail');
		const composite = lines.map((l) => l.text + l.op);
		expect(new Set(composite).size).toBeLessThan(composite.length); // duplicate composite keys exist
		const indexed = lines.map((l, i) => l.op + '·' + i);
		expect(new Set(indexed).size).toBe(indexed.length); // index key is unique → no crash
	});
});

// ── review_diff reachability (review gaps 1+2): the operator is NOT blind ────────────

describe('§5 review_diff stage — the D-010 diff is reachable BEFORE authoring', () => {
	it('proposed card carries no server diff, but the previewDiff path yields the real delta', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);

		// The card at the proposed/review_diff stage: challenger is null, so the server-card
		// `diff` is null and nextAction is the author/diff stage. (This is exactly why the old
		// `{#if p.diff}` block never rendered — the operator authored blind.)
		const card = await buildProposalCard(db, proposal);
		expect(card.nextAction).toBe('review_diff');
		expect(card.challenger).toBeNull();
		expect(card.diff).toBeNull();

		// The wired previewDiff path (resolution.proposalDiff with a draft) IS the honest diff the
		// operator now inspects before approving — non-empty, computed over the REAL incumbent text.
		const draft = `You are reviewer #X.\nHunt platform bugs AND injection.\nQuote verbatim evidence.`;
		const preview = await proposalDiff(db, proposal.id, draft);
		expect(preview.lines.length).toBeGreaterThan(0);
		expect(preview.added + preview.removed).toBeGreaterThan(0);
		expect(preview.incumbentPromptCore).toBe((await getRoleVersion(db, seed.incumbent.id))!.prompt_core);
	});
});

// ── The full happy path: proposed → author → re-gauntlet → compared → swap ──────────

describe('§5 full resolution path', () => {
	it('proposed → author(diff) → re-gauntlet → compared → operator swap activates the challenger', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		expect(proposal.status).toBe('proposed');

		// The diff the operator reviews matches the REAL incumbent text vs the draft challenger.
		const challengerText = `You are reviewer #X.\nHunt platform bugs AND injection.\nQuote verbatim evidence.`;
		const previewed = await proposalDiff(db, proposal.id, challengerText);
		expect(previewed.incumbentPromptCore).toBe((await getRoleVersion(db, seed.incumbent.id))!.prompt_core);
		expect(previewed.added).toBeGreaterThan(0);
		expect(previewed.challenger).toBeNull(); // not yet authored

		// ① author the challenger (D-010 confirm) → a NEW pm_proposal version, status interviewing.
		const authored = await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: challengerText,
			operatorConfirmed: true
		});
		expect(authored.created).toBe(true);
		expect(authored.challenger.source).toBe('pm_proposal');
		expect(authored.challenger.lifecycle).toBe('draft');
		expect(authored.challenger.prompt_sha).not.toBe(seed.incumbent.prompt_sha); // fresh sha
		expect(authored.proposal.status).toBe('interviewing');
		expect(authored.proposal.challenger).toBe(authored.challenger.id);

		// Now the diff reads the STORED challenger text (the certified bytes — no forgery).
		const storedDiff = await proposalDiff(db, proposal.id);
		expect(storedDiff.challengerPromptCore).toBe(challengerText);
		expect(storedDiff.challenger).toBe(authored.challenger.id);

		// ② re-gauntlet at the incumbent's certified (tier × model) → comparison + 'compared'.
		const re = await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug)), {
			proposal: proposal.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: MODEL,
			trigger: 'operator'
		});
		expect(re.outcome.kind).toBe('ran');
		if (re.outcome.kind !== 'ran') return;
		expect(re.outcome.run.status).toBe('passed');
		expect(re.proposal.status).toBe('compared');
		expect(re.comparison).toBeTruthy();
		// Same fixture pool + model → comparable, with a real delta.
		expect(re.comparison!.comparable).toBe(true);
		expect(re.comparison!.incumbent).toBeTruthy();
		expect(re.comparison!.delta).toBeTruthy();
		expect(re.comparison!.challenger.recall).toBe(1);

		// The challenger EARNED its own cert (a real passing run at prompt_sha × MODEL).
		const persisted = await getReviewProposal(db, proposal.id);
		expect(persisted!.comparison).toBeTruthy();

		// ③ operator swap (D-039 confirm) → challenger becomes active; proposal closes 'swapped'.
		const before = await getRole(db, seed.role.id);
		expect(before!.active_version).toBe(seed.incumbent.id);
		const swapped = await swapFromProposal(db, {
			proposal: proposal.id,
			modelId: MODEL,
			operatorConfirmed: true
		});
		expect(swapped.role!.active_version).toBe(authored.challenger.id);
		expect(swapped.proposal.status).toBe('swapped');
		expect(swapped.proposal.decided_at).not.toBeNull();
		// The old incumbent stays 'passed' (pinnable, §2.3).
		expect((await getRoleVersion(db, seed.incumbent.id))!.lifecycle).toBe('passed');
		// A role_event{op:'swap', operator_confirmed:true} was written.
		const [evs] = await db.query<[Array<{ op: string; detail?: { operator_confirmed?: boolean } }>]>(
			`SELECT op, detail FROM role_event WHERE role = $r AND op = 'swap' LIMIT 10;`,
			{ r: rid(seed.role.id) }
		);
		expect(evs.some((e) => e.detail?.operator_confirmed === true)).toBe(true);
	}, 60_000);
});

// ── Reject + cooldown ────────────────────────────────────────────────────────────────

describe('§5 reject', () => {
	it('closes rejected_by_operator with a screened reason + decided_at (feeds cooldown)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		const res = await rejectProposal(db, { proposal: proposal.id, reason: 'degradation looks environmental, not the prompt' });
		expect(res.proposal.status).toBe('rejected_by_operator');
		expect(res.proposal.decided_at).not.toBeNull();
		const persisted = await getReviewProposal(db, proposal.id);
		expect(persisted!.trigger.reject_reason).toContain('environmental');
	});

	it('D-026: a reject reason carrying a credential is screened before storage', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		const res = await rejectProposal(db, {
			proposal: proposal.id,
			reason: 'rejecting; api_key=SK12345supersecretvalue is in the prompt'
		});
		expect(res.screened.length).toBeGreaterThan(0);
		const persisted = await getReviewProposal(db, proposal.id);
		expect(String(persisted!.trigger.reject_reason)).not.toContain('SK12345supersecret');
		expect(String(persisted!.trigger.reject_reason)).toContain('[REDACTED');
	});

	it('a terminal proposal absorbs a re-reject idempotently', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		await rejectProposal(db, { proposal: proposal.id, reason: 'no' });
		const again = await rejectProposal(db, { proposal: proposal.id, reason: 'no again' });
		expect(again.proposal.status).toBe('rejected_by_operator');
	});
});

// ── TERMINALITY — the one place an ungated score PERSISTS ────────────────────────────

/** A candidate that reports the right FILE but the wrong lines + wrong evidence: a PARTIAL
 *  match, which the §3.4 scorer queues for the operator → the run finalizes 'adjudicating'.
 *  This is the non-terminal status `regauntletChallenger` must refuse to score. */
function partialMatchBackend(defectSlug: string): ScriptedBackend {
	const plans: CcSpawnPlan[] = [];
	const probes: ScriptedBackend['probes'] = {};
	return {
		plans,
		probes,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: `cc_res_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					writeFileSync(
						join(plan.cwd, 'findings.json'),
						JSON.stringify([
							{ fixture: defectSlug, file: 'a.ts', lines: [40, 41], class: 'platform-bug', evidence: 'different quote' }
						]),
						'utf8'
					);
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

/**
 * How many interview_runs exist for a proposal's challenger. The reconcile path's whole point is
 * that this number does NOT move — a spend assertion has to count rows, not trust a comment.
 * `role_version` is the durable proposal→run link the runner already writes.
 */
async function challengerRunCount(proposalId: string): Promise<number> {
	const p = await getReviewProposal(db, proposalId);
	if (!p?.challenger) return 0;
	const [rows] = await db.query<[Array<{ n: number }>]>(
		`SELECT count() AS n FROM interview_run WHERE role_version = $vid GROUP ALL;`,
		{ vid: new StringRecordId(p.challenger) }
	);
	return rows?.[0]?.n ?? 0;
}

describe('§5 re-gauntlet TERMINALITY — a non-terminal run never writes a score', () => {
	// THE DEFECT THIS PINS. `regauntletChallenger` read `outcome.run` straight into
	// buildComparison with no terminality gate, so an 'adjudicating' challenger — a run whose
	// planted_found is a LOWER BOUND the operator's queue can still raise, and whose
	// false_positives is an uninitialised DEFAULT 0 the pass bar never wrote — produced a
	// comparison stating `recall 0.5 · 0 FP` and PERSISTED it into review_proposal.comparison,
	// then advanced the proposal to 'compared' so the surface offered the D-039 swap decision on
	// it. Every other instance of this class merely RENDERED a wrong number; this one wrote a row
	// that everything downstream reads as fact.
	it('an ADJUDICATING challenger: nothing persisted, proposal stays interviewing, scores null', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: 'You are reviewer.\nAmbiguous evidence.',
			operatorConfirmed: true
		});

		const re = await regauntletChallenger(depsFor(partialMatchBackend(seed.defectSlug)), {
			proposal: proposal.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: MODEL,
			trigger: 'operator'
		});
		expect(re.outcome.kind).toBe('ran');
		if (re.outcome.kind !== 'ran') return;
		expect(re.outcome.run.status).toBe('adjudicating');

		// ① NOTHING WAS WRITTEN. The proposal stays where it honestly is: still interviewing,
		// because the interview is not over — the operator has queue items to resolve.
		expect(re.proposal.status).toBe('interviewing');
		const persisted = await getReviewProposal(db, proposal.id);
		expect(persisted!.status).toBe('interviewing');
		expect(persisted!.comparison ?? null).toBeNull();

		// ② AN EXPLICIT UNKNOWN WAS RETURNED. The spend happened and the run exists, so the caller
		// is told so — with every score field null rather than a fabricated zero, and a REASON.
		expect(re.comparison).toBeTruthy();
		expect(re.comparison!.comparable).toBe(false);
		expect(re.comparison!.challenger.recall).toBeNull();
		expect(re.comparison!.challenger.falsePositives).toBeNull();
		expect(re.comparison!.incumbent).toBeNull();
		expect(re.comparison!.delta).toBeNull();
		expect(re.comparison!.challenger.status).toBe('adjudicating');
		expect(re.comparison!.incomparableReason).toMatch(/adjudication queue/);
		expect(re.comparison!.incomparableReason).toMatch(/interviewing/);

		// ③ AND THE SWAP IS STILL SHUT. Belt and braces: even if a caller ignored all of the above,
		// swapFromProposal fail-closes on a proposal that never reached 'compared'.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 60_000);

	// THE SECOND DEFECT, found by the TERM-R independent review and CLOSED 2026-08-04: the gate
	// above is correct but used to leave no EXIT. `regauntletChallenger` was the only function
	// that records a comparison, and that write sits below an unconditional `runGauntlet` — so
	// when the operator resolved the queue, `adjudicateInterviewRun` finalized the RUN and nothing
	// reconciled the proposal. The paid, fully-scored run was stranded behind a SECOND real spend
	// for a verdict already on disk. The harm is money, which is what makes it the real defect of
	// the three. `reconcileProposalFromRun` is the exit; this walks the whole path.
	it('STRANDED → RECONCILED end to end: the queue verdict is consumed with NO second spend', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: 'You are reviewer.\nAmbiguous evidence, second run.',
			operatorConfirmed: true
		});

		const re = await regauntletChallenger(depsFor(partialMatchBackend(seed.defectSlug)), {
			proposal: proposal.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: MODEL,
			trigger: 'operator'
		});
		expect(re.outcome.kind).toBe('ran');
		if (re.outcome.kind !== 'ran') return;
		expect(re.outcome.run.status).toBe('adjudicating');
		const runId = re.outcome.run.id;

		// ① THE OPERATOR-FACING REASON POINTS AT THE FREE EXIT, in the words that matter for a
		// spend decision. Surfaced verbatim as `incomparableReason` by the regauntlet action in
		// routes/agents/proposals/+page.server.ts.
		const reason = re.comparison!.incomparableReason;
		expect(reason).toMatch(/adjudication queue/);
		expect(reason).toMatch(/reconcile/);
		expect(reason).toMatch(/costs NOTHING/);
		expect(reason).toMatch(/second real spend/);

		// ② WHILE THE RUN IS STILL PENDING, reconciling REFUSES and writes nothing. A run without
		// a verdict is never consumed as one — the withholding gate is not weakened by having an
		// exit behind it.
		const early = await reconcileProposalFromRun(db, { proposal: proposal.id });
		expect(early.outcome).toBe('still_pending');
		expect(early.run).toBe(runId);
		expect(early.comparison!.comparable).toBe(false);
		expect(early.comparison!.challenger.recall).toBeNull();
		expect((await getReviewProposal(db, proposal.id))!.status).toBe('interviewing');
		expect((await getReviewProposal(db, proposal.id))!.comparison ?? null).toBeNull();

		// The card the surface renders says the same: there IS a run, it is not ready yet.
		const parked = await buildProposalCard(db, (await getReviewProposal(db, proposal.id))!);
		expect(parked.reconcilable).toBeTruthy();
		expect(parked.reconcilable!.run).toBe(runId);
		expect(parked.reconcilable!.ready).toBe(false);

		// ③ THE OPERATOR RESOLVES THE QUEUE the way /agents does (the same adjudicateInterviewRun
		// the route action calls). The run goes TERMINAL — scored, and already paid for.
		const queued = await getInterviewRun(db, runId);
		const finalized = await adjudicateInterviewRun(db, runId, {
			resolutions: queued!.ambiguous.map((_, index) => ({ index, resolution: 'dismiss' as const }))
		});
		expect(['passed', 'failed']).toContain(finalized.status);

		// The card now offers the free path, naming the run and that it costs nothing.
		const ready = await buildProposalCard(db, (await getReviewProposal(db, proposal.id))!);
		expect(ready.reconcilable!.ready).toBe(true);
		expect(ready.reconcilable!.reason).toMatch(/NO second gauntlet spend/);

		// ④ RECONCILE — and COUNT the spend. `depsFor` is never handed to this call: the
		// function's signature cannot reach a runtime, so a new run is IMPOSSIBLE rather than
		// merely unlikely. The run count is asserted unchanged for belt and braces.
		const runsBefore = await challengerRunCount(proposal.id);
		const done = await reconcileProposalFromRun(db, { proposal: proposal.id });
		expect(done.outcome).toBe('reconciled');
		expect(done.run).toBe(runId);
		expect(done.proposal.status).toBe('compared');
		expect(
			await challengerRunCount(proposal.id),
			'RECONCILING MUST NOT SPEND: no new interview_run may exist'
		).toBe(runsBefore);

		// ⑤ THE COMPARISON IS THE ONE THE PAID PATH WOULD HAVE PRODUCED — same run, real scores.
		const persisted = await getReviewProposal(db, proposal.id);
		expect(persisted!.status).toBe('compared');
		expect(persisted!.comparison).toBeTruthy();
		expect(done.comparison!.challenger.run).toBe(runId);
		expect(done.comparison!.challenger.status).toBe(finalized.status);
		expect(done.comparison!.challenger.recall).not.toBeNull();
		expect(done.comparison!.challenger.falsePositives).not.toBeNull();

		// ⑥ IDEMPOTENT / INTERRUPT-SAFE: a re-run absorbs the prior work rather than erroring or
		// writing twice.
		const again = await reconcileProposalFromRun(db, { proposal: proposal.id });
		expect(again.outcome).toBe('not_waiting');
		expect(again.reason).toMatch(/'compared'/);
		expect((await getReviewProposal(db, proposal.id))!.status).toBe('compared');
	}, 90_000);

	// ── THE GATE MUST SURVIVE THE FIX ────────────────────────────────────────────────────
	//
	// 'compared' is a GATE-BEARING status: nextActionFor derives 'decide_swap' from it and the
	// surface then presents the D-039 swap ceremony. A reconcile path that reaches it is only
	// acceptable if the operator's approval point is intact on the other side.
	it('RECONCILING DOES NOT BYPASS THE D-039 SWAP APPROVAL', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: 'You are reviewer.\nAmbiguous evidence, gate check.',
			operatorConfirmed: true
		});
		const re = await regauntletChallenger(depsFor(partialMatchBackend(seed.defectSlug)), {
			proposal: proposal.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: MODEL,
			trigger: 'operator'
		});
		if (re.outcome.kind !== 'ran') throw new Error('expected a ran outcome');
		const runId = re.outcome.run.id;
		const queued = await getInterviewRun(db, runId);
		await adjudicateInterviewRun(db, runId, {
			// confirm_hit, not dismiss: the OTHER adjudication outcome, so the gate test does not
			// share the happy path's verdict shape.
			resolutions: queued!.ambiguous.map((_, index) => ({
				index,
				resolution: 'confirm_hit' as const
			}))
		});
		const done = await reconcileProposalFromRun(db, { proposal: proposal.id });
		expect(done.outcome).toBe('reconciled');
		expect(done.proposal.status).toBe('compared');

		// ① The role has NOT moved. Reconciling produced a decision POINT, never a decision.
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);

		// ② The surface asks for the swap confirm, exactly as after a paid re-gauntlet.
		const card = await buildProposalCard(db, (await getReviewProposal(db, proposal.id))!);
		expect(card.nextAction).toBe('decide_swap');

		// ③ A swap WITHOUT the operator's D-039 confirm is still refused — there is no auto-swap
		// path, and reconciling did not open one.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: false })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 90_000);

	// ── Shadow paths on the reconcile entry, all four, all named ─────────────────────────
	it('SHADOW PATHS: nil id throws; wrong status / no run each REFUSE by name, writing nothing', async () => {
		// nil-ish input — a proposal that does not exist is a caller bug, not a state.
		await expect(
			reconcileProposalFromRun(db, { proposal: 'review_proposal:doesnotexist' })
		).rejects.toThrow(WorkforceInputError);

		// WRONG STATUS: a freshly-raised proposal is 'proposed' — it has not reached the diff
		// ceremony, so reconcile must not be a side door into 'compared'.
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const fresh = await openProposal(seed);
		const wrongStatus = await reconcileProposalFromRun(db, { proposal: fresh.id });
		expect(wrongStatus.outcome).toBe('not_waiting');
		expect(wrongStatus.reason).toMatch(/'proposed'/);
		expect((await getReviewProposal(db, fresh.id))!.status).toBe('proposed');
		expect((await getReviewProposal(db, fresh.id))!.comparison ?? null).toBeNull();

		// EMPTY: the challenger is authored but NO gauntlet has ever run — nothing was paid for,
		// so there is no verdict to consume and the answer names the spend as the next move.
		const seed2 = await seedRole();
		await certifyIncumbent(seed2);
		const p2 = await openProposal(seed2);
		await authorChallenger(db, {
			proposal: p2.id,
			promptCore: 'You are reviewer.\nNever interviewed.',
			operatorConfirmed: true
		});
		const noRun = await reconcileProposalFromRun(db, { proposal: p2.id });
		expect(noRun.outcome).toBe('no_run');
		expect(noRun.run).toBeNull();
		expect(noRun.reason).toMatch(/nothing has been paid for yet/);
		expect((await getReviewProposal(db, p2.id))!.status).toBe('interviewing');
		// And the card offers nothing to reconcile rather than a dead control.
		expect(
			(await buildProposalCard(db, (await getReviewProposal(db, p2.id))!)).reconcilable
		).toBeNull();
	}, 90_000);

	it('reconcile is NOT a pass-machine — a proposal the paid path already advanced is declined', async () => {
		// The counterweight to the exit: once the paid path recorded a comparison (terminal run),
		// reconcile declines by name instead of re-writing it, and the §2.4 refusal for a FAILED
		// challenger still happens where it belongs — swapFromProposal, not a silent skip here.
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: 'You are reviewer.\nSilent, reconciled.',
			operatorConfirmed: true
		});
		const re = await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug, false)), {
			proposal: proposal.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: MODEL,
			trigger: 'operator'
		});
		if (re.outcome.kind !== 'ran') throw new Error('expected a ran outcome');
		expect(re.outcome.run.status).toBe('failed');
		const res = await reconcileProposalFromRun(db, { proposal: proposal.id });
		expect(res.outcome).toBe('not_waiting');
		expect(res.reason).toMatch(/'compared'/);
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 60_000);

	it('a TERMINAL challenger is unaffected — the gate withholds, it does not break the path', async () => {
		// The counterweight: the gate must not turn every re-gauntlet into an unknown. A 'failed'
		// run is TERMINAL and its score is real, so the comparison is built and persisted exactly
		// as before (this is the same shape asserted by the red-team block below, restated here so
		// a gate that fails CLOSED on everything would fail HERE by name).
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: 'You are reviewer.\nSilent.',
			operatorConfirmed: true
		});
		const re = await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug, false)), {
			proposal: proposal.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: MODEL,
			trigger: 'operator'
		});
		if (re.outcome.kind !== 'ran') throw new Error('expected a ran outcome');
		expect(re.outcome.run.status).toBe('failed');
		expect(re.proposal.status).toBe('compared');
		expect(re.comparison!.challenger.recall).toBe(0);
		expect(re.comparison!.challenger.falsePositives).toBe(0); // a REAL zero: the pass bar wrote it
		expect((await getReviewProposal(db, proposal.id))!.comparison).toBeTruthy();
	}, 60_000);
});

// ── GOVERNANCE RED-TEAM (the locked invariants) ──────────────────────────────────────

describe('§5 RED-TEAM — no swap without operator confirm AND a passing challenger gauntlet', () => {
	it('swapFromProposal REFUSES without an operator D-039 confirm (no auto-swap path)', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nNew text.', operatorConfirmed: true });
		await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug)), {
			proposal: proposal.id, tier: 'sonnet', provider: 'claude', modelId: MODEL, trigger: 'operator'
		});
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: false })
		).rejects.toThrow(ResolutionGateError);
		// The role is unchanged — incumbent still active.
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 60_000);

	it('swapFromProposal REFUSES a proposal that has not reached "compared" (re-gauntlet not run)', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nNew.', operatorConfirmed: true });
		// status is 'interviewing' — the re-gauntlet never ran.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 60_000);

	it('a challenger whose own gauntlet FAILED cannot be swapped (no inherited cert)', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nWeak.', operatorConfirmed: true });
		// The challenger writes NO findings → misses the plant → FAILS its own gauntlet.
		const re = await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug, false)), {
			proposal: proposal.id, tier: 'sonnet', provider: 'claude', modelId: MODEL, trigger: 'operator'
		});
		expect(re.outcome.kind).toBe('ran');
		if (re.outcome.kind !== 'ran') return;
		expect(re.outcome.run.status).toBe('failed');
		expect(re.proposal.status).toBe('compared'); // comparison still recorded (honest)
		expect(re.comparison!.challenger.recall).toBe(0);
		// The swap is refused — the challenger never earned a passing cert.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 60_000);

	it('a challenger passed at model A cannot be swapped at model B (cert is per prompt_sha × model_id)', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		const authored = await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nXYZ.', operatorConfirmed: true });
		await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug)), {
			proposal: proposal.id, tier: 'sonnet', provider: 'claude', modelId: MODEL, trigger: 'operator'
		});
		// Challenger passed at MODEL; ask to swap at a DIFFERENT model_id → §2.4 hard fail.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: 'claude-haiku-y', operatorConfirmed: true })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
		// Sanity: the challenger row exists and is passed, just not at the wrong model.
		expect((await getRoleVersion(db, authored.challenger.id))!.lifecycle).toBe('passed');
	}, 60_000);

	it('authorChallenger REFUSES without the D-010 diff confirm', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		await expect(
			authorChallenger(db, { proposal: proposal.id, promptCore: 'text', operatorConfirmed: false })
		).rejects.toThrow(ResolutionGateError);
		expect((await getReviewProposal(db, proposal.id))!.challenger).toBeNull();
	});

	it('D-026: authorChallenger SCREENS a prompt_core carrying a credential (redacted before storage)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		// A credential embedded in the methodology text is REDACTED in place (the screened
		// text is what gets stored + certified); the reasons are surfaced honestly.
		const authored = await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: 'You are reviewer.\nUse api_key=SK12345supersecretvalue when calling out.',
			operatorConfirmed: true
		});
		expect(authored.screened.length).toBeGreaterThan(0);
		const stored = await getRoleVersion(db, authored.challenger.id);
		expect(stored!.prompt_core).not.toContain('SK12345supersecret');
		expect(stored!.prompt_core).toContain('[REDACTED');
	});

	it('D-026: authorChallenger REFUSES a prompt_core carrying a quarantine-class payload (private key)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIfakekeymaterial\n-----END RSA PRIVATE KEY-----';
		await expect(
			authorChallenger(db, {
				proposal: proposal.id,
				promptCore: `You are reviewer.\n${pem}`,
				operatorConfirmed: true
			})
		).rejects.toThrow(WorkforceInputError);
		expect((await getReviewProposal(db, proposal.id))!.challenger).toBeNull();
	});
});

// ── Idempotency / interrupt contract ─────────────────────────────────────────────────

describe('§5 interrupt contract', () => {
	it('re-authoring an already-authored proposal absorbs (no second challenger)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		const first = await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nA.', operatorConfirmed: true });
		const second = await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nDIFFERENT.', operatorConfirmed: true });
		expect(second.created).toBe(false);
		expect(second.challenger.id).toBe(first.challenger.id); // same row, not a second version
	});

	it('a swapped proposal absorbs a re-swap idempotently', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		const authored = await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nQQ.', operatorConfirmed: true });
		await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug)), {
			proposal: proposal.id, tier: 'sonnet', provider: 'claude', modelId: MODEL, trigger: 'operator'
		});
		await swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true });
		const again = await swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true });
		expect(again.proposal.status).toBe('swapped');
		expect(again.role!.active_version).toBe(authored.challenger.id);
	}, 60_000);
});

// ── listOpenProposals (the §8 RightTray feed) ─────────────────────────────────────────

describe('listOpenProposals', () => {
	it('returns only non-terminal proposals across roles', async () => {
		const seed = await seedRole();
		const open = await openProposal(seed);
		const toReject = await openProposal(await seedRole());
		await rejectProposal(db, { proposal: toReject.id, reason: 'x' });
		const list = await listOpenProposals(db);
		expect(list.some((p) => p.id === open.id)).toBe(true);
		expect(list.some((p) => p.id === toReject.id)).toBe(false);
	});
});

// ── resolveRegauntletTarget (F-020: ORDER BY started_at must parse) ────────────────────

describe('resolveRegauntletTarget — the §5 certified (tier × model) target', () => {
	// The target query ORDER BYs interview_run.started_at; that field MUST be in the projection or
	// SurrealDB 2.x parse-errors "Missing order idiom" (F-020). No existing test exercised this path
	// (regauntletChallenger is handed tier/provider/model explicitly), so the parse gap was invisible.
	it('resolves the incumbent’s certified target from its most-recent passing interview', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed); // writes a passing interview_run at the incumbent prompt_sha × MODEL
		const proposal = await openProposal(seed);
		const res = await resolveRegauntletTarget(db, proposal.id);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.target.tier).toBe('sonnet');
			expect(res.target.modelId).toBe(MODEL);
		}
	}, 60_000);
});

// ── status machine guard (validated → swapped is illegal) ─────────────────────────────

describe('proposal status machine', () => {
	it('cannot leap proposed → swapped (skipping diff + gauntlet + comparison)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		// No challenger, status proposed → swapFromProposal refuses on the no-challenger guard.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true })
		).rejects.toThrow(WorkforceInputError);
	});

	it('transitionLifecycle still governs the version side (unaffected)', async () => {
		const seed = await seedRole();
		// draft → passed is illegal (must go through interviewing) — sanity the version machine holds.
		await expect(transitionLifecycle(db, seed.incumbent.id, 'passed')).rejects.toThrow();
	});
});
