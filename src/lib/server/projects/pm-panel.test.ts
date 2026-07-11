import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { createProject, getProject } from './repo';
import { getTask, setStatus } from '../tasks/repo';
import {
	listPanelVerdictsForArtifact,
	createRole,
	createRoleVersion,
	createInterviewRun,
	getRoleVersion
} from '../workforce/repo';
import { createPm, getPm, listPmMemory } from './pm-repo';
import { listOpenBriefs, getBrief, createDecisionBrief, BriefError } from './briefs';
import { proposeTask, type ProposeTaskInput } from './pm-proposals';
// PJH-1 — the per-kind decide effects the ONE dispatcher (applyBriefDecision) routes through.
import { raiseHireBrief, HireGateError } from '../workforce/recruiter-hire';
import { proposeRepoCreate, RepoCreateGateError } from './repo-create-proposal';
import type { GitHubClient, CreateRepoInput, CreateRepoOutcome, AuthStatus } from '../sync/gh-client';
import type { CommandResult, CommandRunner } from '../orchestrator/post-task';
import {
	runValidationPanel,
	applyBriefDecision,
	parseValidatorVerdict,
	foldVerdictReasons,
	cadenceWindowMs,
	listProposalQueue,
	ValidatorContractError,
	PanelInputError,
	type PanelDeps,
	type BriefDecisionResult
} from './pm-panel';

// TASK 16.4 VERIFY — the validation panel against a REAL throwaway SurrealDB and a
// SCRIPTED runtime (the 1.6b mock-backend pattern — a mocked runtime in a TEST is
// not fabricated product data; every row asserted below is read back from the live
// DB the runner actually wrote). Covers: the verdict output contract (shadow paths
// loud + named), inline verdict recording (§9 bridge), the §4.5 decision-
// classification MATRIX (operator-direction artifacts NEVER auto-decided against),
// pushback→pm_memory learning, the proposal gate for authority='propose', operator
// brief decisions (approve/reject/defer) with §2.2 mechanical closure, re-run
// absorption (interrupt contract) and brief-format assembly from real rows.

let tdb: TestDb;
let db: Db;
let projectId: string;
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
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db
		.query(
			'DELETE panel_verdict; DELETE decision_brief; DELETE notification; DELETE message; DELETE agent_event; DELETE routing_event; DELETE session; DELETE pm; DELETE pm_memory; DELETE pm_review; DELETE task; DELETE project;'
		)
		.catch(() => {});
	const p = await createProject(db, {
		slug: `paneltest${++seq}`,
		name: 'Panel Host',
		root_path: 'F:/code/paneltest'
	});
	projectId = p.id;
});

// ── Scripted backend: each spawn consumes the next scripted event stream ──────────

function queuedBackend(queue: RuntimeEvent[][]): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan) {
			plans.push(plan);
			const events = queue.shift();
			if (!events) throw new Error('queuedBackend: unexpected extra spawn');
			return {
				ccSessionId: `cc_panel_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return {
				ccSessionId: req.ccSessionId,
				async *stream() {
					yield { type: 'done', result: { ok: true, summary: 'resumed' } } as RuntimeEvent;
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
}

/** A scripted validator run ending in a verdict-contract summary. */
function verdictRun(verdict: Record<string, unknown>): RuntimeEvent[] {
	return [
		{ type: 'log', message: 'examining the artifact…' },
		{
			type: 'done',
			result: {
				ok: true,
				summary: `Examined purpose/spec/duplication/feasibility.\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``,
				ccSessionId: `cc_v_${Math.random().toString(36).slice(2, 10)}`
			}
		}
	];
}

function baseVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		verdict: 'approve',
		confidence: 'high',
		classification: 'mechanical',
		reasons: ['purpose ties to the plan DoD', 'criteria executable as written'],
		falsifier: 'the cited finding may already be resolved out-of-band',
		evidence: [
			{ claim: 'no duplicate found', kind: 'absence', artifact: 'open task list', search: 'scanned the duplication corpus in context' }
		],
		scope_findings: [],
		...over
	};
}

function deps(queue: RuntimeEvent[][]): PanelDeps {
	return {
		db,
		bus: new EventBus(),
		runtime: new ClaudeCodeRuntime({ backend: queuedBackend(queue) }),
		fallbackModel: { provider: 'claude', modelId: 'claude-test' },
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 }
	};
}

function proposalInput(over: Partial<ProposeTaskInput> = {}): ProposeTaskInput {
	return {
		project: projectId,
		title: 'Triage the open finding',
		objective: 'Resolve the open critical finding before release.',
		purpose: 'Severe findings gate the plan Definition of Done.',
		acceptance_criteria: ['The finding is resolved or suppressed with justification.'],
		provenance: { kind: 'finding', evidence: [`security_finding:ev${seq}`] },
		...over
	};
}

async function propose(authority: 'propose' | 'act' = 'act') {
	await createPm(db, { project: projectId, name: 'Vesper', authority });
	const res = await proposeTask(db, proposalInput());
	expect(res.outcome).toBe('created');
	return res.task!;
}

// ── The verdict output contract (pure shadow paths) ────────────────────────────────

describe('parseValidatorVerdict — contract shadow paths, each failure NAMED', () => {
	it('parses a fenced contract verdict', () => {
		const v = parseValidatorVerdict('preamble\n```json\n' + JSON.stringify(baseVerdict()) + '\n```');
		expect(v.verdict).toBe('approve');
		expect(v.classification).toBe('mechanical');
		expect(v.falsifier).toContain('resolved out-of-band');
	});

	it.each([
		['nil input', undefined, /EMPTY output/],
		['empty input', '   ', /EMPTY output/],
		['no JSON block', 'I approve this task wholeheartedly.', /no JSON verdict block/],
		['malformed JSON', '```json\n{nope\n```', /not valid JSON/],
		['wrong verdict enum', '```json\n' + JSON.stringify(baseVerdict({ verdict: 'maybe' })) + '\n```', /approve\|pushback/],
		['missing falsifier', '```json\n' + JSON.stringify(baseVerdict({ falsifier: '' })) + '\n```', /falsifier/],
		['empty reasons', '```json\n' + JSON.stringify(baseVerdict({ reasons: [] })) + '\n```', /reasons/],
		[
			'challenge without payload',
			'```json\n' + JSON.stringify(baseVerdict({ classification: 'operator_challenge' })) + '\n```',
			/operator_challenge/
		]
	] as Array<[string, string | undefined, RegExp]>)('%s fails loud', (_l, text, re) => {
		expect(() => parseValidatorVerdict(text)).toThrowError(re);
		try {
			parseValidatorVerdict(text);
		} catch (err) {
			expect(err).toBeInstanceOf(ValidatorContractError);
		}
	});

	it('folds evidence per the G1 rule; ungrounded claims are tagged "(unverified)", never dropped', () => {
		const v = parseValidatorVerdict(
			'```json\n' +
				JSON.stringify(
					baseVerdict({
						evidence: [
							{ claim: 'duplicates task X', kind: 'presence' }, // no quote → unverified
							{ claim: 'spec covered by Y', kind: 'presence', quote: 'the Y criteria text' },
							{ claim: 'no provenance gap', kind: 'absence' } // no artifact/search → unverified
						]
					})
				) +
				'\n```'
		);
		const folded = foldVerdictReasons(v);
		expect(folded.some((r) => r.includes('(presence, unverified): duplicates task X'))).toBe(true);
		expect(folded.some((r) => r.includes('"the Y criteria text"'))).toBe(true);
		expect(folded.some((r) => r.includes('(absence, unverified): no provenance gap'))).toBe(true);
		expect(folded[folded.length - 1]).toMatch(/^falsifier: /);
	});
});

// ── The runner against the real DB ─────────────────────────────────────────────────

describe('runValidationPanel — verdict recording + mechanical closure (§2.2/§4.5)', () => {
	it('refuses a non-proposed task and a contract-less proposal (named errors)', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const plain = await db.query<[Array<{ id: unknown }>]>(
			`CREATE task SET project = $p, title = 'plain', description = 'd', status = 'proposed' RETURN id;`,
			{ p: new StringRecordId(projectId) }
		);
		const bareId = String(plain[0][0].id);
		await expect(runValidationPanel(deps([]), bareId)).rejects.toThrowError(/§4.1 contract/);
		const real = await proposeTask(db, proposalInput());
		await setStatus(db, real.task!.id, 'ready');
		await expect(runValidationPanel(deps([]), real.task!.id)).rejects.toBeInstanceOf(PanelInputError);
	});

	it('all-approve + authority=act → ready; verdicts recorded inline with classification', async () => {
		const task = await propose('act');
		const result = await runValidationPanel(
			deps([verdictRun(baseVerdict()), verdictRun(baseVerdict({ confidence: 'medium' }))]),
			task.id
		);
		expect(result.decision).toBe('approved');
		expect(result.task.status).toBe('ready');
		const verdicts = await listPanelVerdictsForArtifact(db, task.id);
		expect(verdicts).toHaveLength(2);
		for (const v of verdicts) {
			expect(v.validator_kind).toBe('inline'); // §9 bridge
			expect(v.role).toBeUndefined(); // role fields NONE
			expect(v.classification).toBe('mechanical');
			expect(v.outcome).toBeNull(); // closes 'upheld' later, on done
			expect(v.validator_session).toMatch(/^session:/);
			expect(v.reasons.some((r) => r.startsWith('falsifier: '))).toBe(true);
		}
		// Independence is identity-keyed: two distinct validator sessions.
		expect(new Set(verdicts.map((v) => v.validator_session)).size).toBe(2);
		// …and the full done-path closure: done → upheld (§2.2, via setStatus).
		await setStatus(db, task.id, 'in_progress');
		await setStatus(db, task.id, 'done');
		const closed = await listPanelVerdictsForArtifact(db, task.id);
		expect(closed.every((v) => v.outcome === 'upheld')).toBe(true);
	});

	it('a taste-class approval proceeds DECIDED-BUT-VISIBLE (notification surfaced)', async () => {
		const task = await propose('act');
		const result = await runValidationPanel(
			deps([verdictRun(baseVerdict({ classification: 'taste' }))]),
			task.id,
			{ validators: 1 }
		);
		expect(result.decision).toBe('approved');
		const [notes] = await db.query<[Array<{ message: string }>]>(
			`SELECT message FROM notification;`
		);
		expect(notes.some((n) => n.message.includes('taste call'))).toBe(true);
	});

	it('pushback → returned to the PM; reasons become pm_memory (the PM learns its bar)', async () => {
		const task = await propose('act');
		const result = await runValidationPanel(
			deps([
				verdictRun(baseVerdict()),
				verdictRun(
					baseVerdict({
						verdict: 'pushback',
						reasons: ['duplicates the standing triage task', 'criteria not executable']
					})
				)
			]),
			task.id
		);
		expect(result.decision).toBe('pushback');
		expect(result.pushbackMemories).toBe(1);
		expect((await getTask(db, task.id))?.status).toBe('proposed'); // returned, not killed
		const mem = await listPmMemory(db, projectId, { kind: 'learning' });
		expect(mem.some((m) => m.source === 'validation-panel' && m.content.includes('duplicates the standing triage task'))).toBe(true);
	});

	it('MATRIX: an operator_challenge classification is NEVER auto-decided — even on an approve verdict', async () => {
		const task = await propose('act'); // act authority would auto-promote — the challenge must stop it
		const challenge = {
			operator_said: 'charter: never propose release work in June',
			recommendation: 'proceed anyway — the finding is critical',
			why: 'the security exposure outweighs the freeze',
			context_we_might_be_missing: 'the operator may have a compliance freeze we cannot see',
			cost_if_wrong: 'a release-freeze violation during the audit window'
		};
		const result = await runValidationPanel(
			deps([
				verdictRun(baseVerdict()),
				verdictRun(baseVerdict({ classification: 'operator_challenge', operator_challenge: challenge }))
			]),
			task.id
		);
		expect(result.decision).toBe('operator_challenge');
		// The task did NOT proceed (no auto-decide against the operator).
		expect((await getTask(db, task.id))?.status).toBe('proposed');
		// The §8 brief stands, carrying the full §4.5 payload; the operator's
		// direction is the recommended default.
		const brief = result.brief!;
		expect(brief.classification).toBe('operator_challenge');
		expect(brief.challenge?.operator_said).toBe(challenge.operator_said);
		expect(brief.challenge?.cost_if_wrong).toBe(challenge.cost_if_wrong);
		const recommended = brief.options.filter((o) => o.recommended);
		expect(recommended).toHaveLength(1);
		expect(recommended[0].id).toBe('reject'); // keep the operator's direction
		expect(brief.falsifier).toBe(challenge.context_we_might_be_missing);
		expect((await listOpenBriefs(db)).some((b) => b.id === brief.id)).toBe(true);
	});

	it('authority=propose: all-approve raises a proposal-gate brief instead of auto-ready', async () => {
		const task = await propose('propose');
		const result = await runValidationPanel(
			deps([verdictRun(baseVerdict()), verdictRun(baseVerdict())]),
			task.id
		);
		expect(result.decision).toBe('operator_gate');
		expect((await getTask(db, task.id))?.status).toBe('proposed'); // waits for the operator
		const brief = result.brief!;
		expect(brief.classification).toBe('proposal_gate');
		// §8 format from REAL rows: completeness counts the actual verdicts.
		expect(brief.completeness).toEqual({ validators: 2, expected: 2, approve: 2, pushback: 0 });
		expect(brief.evidence.length).toBeGreaterThanOrEqual(2);
		expect(brief.evidence.length).toBeLessThanOrEqual(4);
		expect(brief.evidence[0]).toBe(task.id);
		expect(brief.options.filter((o) => o.recommended)).toHaveLength(1);
		expect(brief.effort.apply).toBe('—'); // no cost history — honest dash, never 0
	});

	it('verdict-contract violation fails the run LOUD; no verdict row is written', async () => {
		const task = await propose('act');
		const badRun: RuntimeEvent[] = [
			{ type: 'done', result: { ok: true, summary: 'looks fine to me!', ccSessionId: 'cc_bad_1' } }
		];
		await expect(runValidationPanel(deps([badRun]), task.id, { validators: 1 })).rejects.toBeInstanceOf(
			ValidatorContractError
		);
		expect(await listPanelVerdictsForArtifact(db, task.id)).toHaveLength(0);
		expect((await getTask(db, task.id))?.status).toBe('proposed'); // unjudged, unharmed
	});

	it('panel re-run after a pushback decision does NOT duplicate the pm_memory learning rows (16.4 re-review DEFECT 3)', async () => {
		const task = await propose('act');
		const pushback = baseVerdict({
			verdict: 'pushback',
			reasons: ['duplicates the standing triage task', 'criteria not executable']
		});
		const first = await runValidationPanel(
			deps([verdictRun(baseVerdict()), verdictRun(pushback)]),
			task.id
		);
		expect(first.decision).toBe('pushback');
		expect(first.pushbackMemories).toBe(1);
		const panelMemories = async () =>
			(await listPmMemory(db, projectId, { kind: 'learning' })).filter(
				(m) => m.source === 'validation-panel'
			);
		expect(await panelMemories()).toHaveLength(1);
		// Operator re-click of pmPanel: zero scripted runs — every seat absorbs, the
		// closure re-derives. The ceremony must be idempotent (probe measured 2→4
		// duplicate rows here before the fix).
		const again = await runValidationPanel(deps([]), task.id);
		expect(again.decision).toBe('pushback');
		expect(again.pushbackMemories).toBe(0); // absorbed, not re-written
		expect(await panelMemories()).toHaveLength(1);
	});

	it('re-run ABSORBS recorded verdicts (interrupt contract): no new sessions spawn', async () => {
		const task = await propose('act');
		await runValidationPanel(deps([verdictRun(baseVerdict()), verdictRun(baseVerdict())]), task.id);
		// task is now 'ready'; a re-run must refuse (panel judges proposed only) —
		// the absorbed-seat path is exercised with a still-proposed artifact:
		const task2 = (await proposeTask(db, proposalInput({ provenance: { kind: 'finding', evidence: ['security_finding:other'] } }))).task!;
		// Seat 1 recorded, then the process "dies"; the re-run brings ZERO scripted
		// runs — it must absorb the standing verdict and launch only the missing seat.
		await runValidationPanel(deps([verdictRun(baseVerdict())]), task2.id, { validators: 1 });
		const again = await runValidationPanel(deps([]), task2.id, { validators: 1 }).catch((e) => e);
		// With 1 expected seat already recorded, NO spawn happens and the decision
		// re-derives — but the task already left 'proposed' (approved) so the runner
		// refuses honestly instead of double-deciding.
		expect(again).toBeInstanceOf(PanelInputError);
	});
});

// ── Operator brief decisions (the /api/briefs write path) ──────────────────────────

describe('applyBriefDecision — approve / reject / defer with §2.2 closure', () => {
	async function gateBrief() {
		const task = await propose('propose');
		const result = await runValidationPanel(
			deps([verdictRun(baseVerdict()), verdictRun(baseVerdict())]),
			task.id
		);
		return { task, brief: result.brief! };
	}

	it('approve → task ready; brief approved; approve-verdicts stay open for upheld-on-done', async () => {
		const { task, brief } = await gateBrief();
		const out = await applyBriefDecision(db, brief.id, 'approve');
		expect(out.brief.status).toBe('approved');
		expect(out.taskStatus).toBe('ready');
		const verdicts = await listPanelVerdictsForArtifact(db, task.id);
		expect(verdicts.every((v) => v.outcome === null)).toBe(true);
		// Idempotent re-apply (interrupt contract): same answer absorbs.
		expect((await applyBriefDecision(db, brief.id, 'approve')).brief.status).toBe('approved');
	});

	it('reject → task withdrawn; approve-verdicts close overridden_by_operator', async () => {
		const { task, brief } = await gateBrief();
		const out = await applyBriefDecision(db, brief.id, 'reject');
		expect(out.brief.status).toBe('rejected');
		expect(out.taskStatus).toBe('withdrawn');
		const verdicts = await listPanelVerdictsForArtifact(db, task.id);
		expect(verdicts).toHaveLength(2);
		expect(verdicts.every((v) => v.outcome === 'overridden_by_operator')).toBe(true);
	});

	it('effect-first ordering: a crash AFTER the task moved but BEFORE the ceremony converges on re-POST (16.4 DoD-review fix)', async () => {
		// Defect: applyBriefDecision wrote ceremony-before-effect (markBriefDecided →
		// setStatus); a crash between them stranded a DECIDED brief with an untouched
		// 'proposed' task — and the tray lists only OPEN briefs, so the decide
		// affordance vanished. Effect-first keeps the brief OPEN through every crash
		// window; the re-POST absorbs the moved task and completes the ceremony.
		const { task, brief } = await gateBrief();
		// Simulate the (new) crash window: the effect landed, the ceremony did not.
		await setStatus(db, task.id, 'ready');
		// The decide affordance is still there (the brief is still open).
		expect((await listOpenBriefs(db)).some((b) => b.id === brief.id)).toBe(true);
		// Re-POST converges: status guard absorbs, ceremony completes.
		const out = await applyBriefDecision(db, brief.id, 'approve');
		expect(out.brief.status).toBe('approved');
		expect(out.taskStatus).toBe('ready');
		expect((await listOpenBriefs(db)).some((b) => b.id === brief.id)).toBe(false);
	});

	it('effect-first ordering holds for reject too (withdrawn task + open brief re-POST converges)', async () => {
		const { task, brief } = await gateBrief();
		// Simulate the crash window: only the status effect landed.
		await setStatus(db, task.id, 'withdrawn');
		expect((await listOpenBriefs(db)).some((b) => b.id === brief.id)).toBe(true);
		const out = await applyBriefDecision(db, brief.id, 'reject');
		expect(out.brief.status).toBe('rejected');
		expect(out.taskStatus).toBe('withdrawn');
		const verdicts = await listPanelVerdictsForArtifact(db, task.id);
		expect(verdicts.every((v) => v.outcome === 'overridden_by_operator')).toBe(true);
	});

	it('a repeat defer POST absorbs WITHOUT a duplicate pm_memory observation (16.4 DoD-review fix)', async () => {
		const { brief } = await gateBrief();
		await applyBriefDecision(db, brief.id, 'defer');
		// Same answer re-POSTed (double-click / retry after a timeout): absorbed.
		const again = await applyBriefDecision(db, brief.id, 'defer');
		expect(again.brief.status).toBe('deferred');
		const mem = (await listPmMemory(db, projectId)).filter(
			(m) => m.source === 'decision-brief' && m.content.includes('DEFERRED')
		);
		expect(mem).toHaveLength(1); // exactly one — the ceremony happened once
	});

	it('a DIFFERENT action on a DEFERRED brief is refused with ZERO side-effects — the task is NOT promoted (16.4 re-review DEFECT 2)', async () => {
		// Probe-proven defect: approve-on-deferred ran setStatus BEFORE markBriefDecided's
		// relabel guard threw — a 409 to the operator, yet the refused task entered the
		// orchestrator's spawn-ready set ('ready') and got BUILT. The status pre-check
		// must refuse BEFORE any effect.
		const { task, brief } = await gateBrief();
		await applyBriefDecision(db, brief.id, 'defer');
		await expect(applyBriefDecision(db, brief.id, 'approve')).rejects.toBeInstanceOf(BriefError);
		// The refused approve effected NOTHING: still 'proposed', never 'ready'.
		expect((await getTask(db, task.id))?.status).toBe('proposed');
		expect((await getBrief(db, brief.id))?.status).toBe('deferred');
		// Reject on the same deferred brief is equally effect-free.
		await expect(applyBriefDecision(db, brief.id, 'reject')).rejects.toBeInstanceOf(BriefError);
		expect((await getTask(db, task.id))?.status).toBe('proposed');
	});

	it('reject on an already-APPROVED brief is refused with the approve-verdicts left OPEN — upheld-on-done survives (16.4 re-review DEFECT 1)', async () => {
		// Probe-proven defect: the verdict-closure loop ran before markBriefDecided threw,
		// closing the deliberately-still-open approve-verdicts 'overridden_by_operator' —
		// corrupting the §2.2/D-039 calibration record and killing the upheld-on-done path.
		const { task, brief } = await gateBrief();
		await applyBriefDecision(db, brief.id, 'approve');
		await expect(applyBriefDecision(db, brief.id, 'reject')).rejects.toBeInstanceOf(BriefError);
		expect((await getTask(db, task.id))?.status).toBe('ready'); // not withdrawn
		const verdicts = await listPanelVerdictsForArtifact(db, task.id);
		expect(verdicts).toHaveLength(2);
		expect(verdicts.every((v) => v.outcome === null)).toBe(true); // §2.2 record intact
		// The upheld-on-done closure the defect permanently disabled still fires.
		await setStatus(db, task.id, 'in_progress');
		await setStatus(db, task.id, 'done');
		const closed = await listPanelVerdictsForArtifact(db, task.id);
		expect(closed.every((v) => v.outcome === 'upheld')).toBe(true);
	});

	it('SIMULTANEOUS cross-action decides serialize: one wins, the loser is refused with ZERO effects (16.4 re-review gap 6)', async () => {
		// Probe-proven engine reality: SurrealDB runs concurrent same-connection queries
		// against snapshots, so two simultaneous decides could both read 'open' and both
		// run their (different!) effect sets. The per-brief ceremony lock serializes
		// them; the §2.2 record and the task always carry exactly the winner's decision.
		const { task, brief } = await gateBrief();
		const results = await Promise.allSettled([
			applyBriefDecision(db, brief.id, 'approve'),
			applyBriefDecision(db, brief.id, 'reject')
		]);
		const fulfilled = results.filter(
			(r): r is PromiseFulfilledResult<BriefDecisionResult> => r.status === 'fulfilled'
		);
		const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(refused).toHaveLength(1);
		expect(refused[0].reason).toBeInstanceOf(BriefError);
		const winner = fulfilled[0].value;
		expect((await getBrief(db, brief.id))?.status).toBe(winner.brief.status);
		// The task carries ONLY the winner's effect — never the loser's.
		const expectedTask = winner.brief.status === 'approved' ? 'ready' : 'withdrawn';
		expect((await getTask(db, task.id))?.status).toBe(expectedTask);
		// …and the §2.2 verdict record matches the winner.
		const verdicts = await listPanelVerdictsForArtifact(db, task.id);
		if (winner.brief.status === 'approved') {
			expect(verdicts.every((v) => v.outcome === null)).toBe(true);
		} else {
			expect(verdicts.every((v) => v.outcome === 'overridden_by_operator')).toBe(true);
		}
	});

	it('panel re-run on a DEFERRED matter raises NO new open brief inside the defer window (PM-SPEC §4(d); 16.4 re-review DEFECT 4)', async () => {
		const { task, brief } = await gateBrief();
		await applyBriefDecision(db, brief.id, 'defer');
		// Re-run the panel: verdicts absorb, the closure re-derives operator_gate — but
		// the operator's defer stands: the standing DEFERRED brief is absorbed, never a
		// fresh open ask during the active window (suppress-until-lapse).
		const rerun = await runValidationPanel(deps([]), task.id);
		expect(rerun.decision).toBe('operator_gate');
		expect(rerun.brief?.id).toBe(brief.id);
		expect(rerun.brief?.status).toBe('deferred');
		expect((await listOpenBriefs(db)).filter((b) => b.artifact === task.id)).toHaveLength(0);
	});

	it('defer → brief deferred with a real window; the structural fingerprint suppresses re-proposals', async () => {
		const { task, brief } = await gateBrief();
		const out = await applyBriefDecision(db, brief.id, 'defer');
		expect(out.brief.status).toBe('deferred');
		expect(out.brief.defer_until).not.toBeNull(); // F-013: a SET datetime reads back
		expect(out.taskStatus).toBe('proposed'); // the matter does not proceed
		// Defer feeds pm_memory (first-class, WORKFORCE §8).
		const mem = await listPmMemory(db, projectId);
		expect(mem.some((m) => m.source === 'decision-brief' && m.content.includes('DEFERRED'))).toBe(true);
		// The fingerprint is suppressed: withdraw the open one, re-propose the same matter.
		const { withdrawPmProposal } = await import('./pm-proposals');
		await withdrawPmProposal(db, task.id);
		const re = await proposeTask(db, proposalInput());
		expect(re.outcome).toBe('defer_suppressed');
	});
});

// ── PJH-1: per-kind decision-brief routing (the ONE operator-authority dispatcher) ─────────────
// Red-team surface: applyBriefDecision must route EACH artifact_kind through its EXISTING gate/effect
// (never re-implement inline, F-055), keep the B4 operator gate intact per kind, refuse an unbuilt kind
// honestly (typed, not a crash), and leave the task path byte-identical. Every assertion reads back a
// live row the effect actually wrote (real-surreal; F-008 — no stub).

// A controllable fake GitHubClient (NO network) — mirrors repo-create-proposal.test.ts.
class FakeGh implements GitHubClient {
	authed = true;
	createOutcome: CreateRepoOutcome = { kind: 'created', url: 'https://github.com/me/repo-host' };
	createCalls: Array<{ input: CreateRepoInput; cwd: string }> = [];
	async isAuthenticated(): Promise<AuthStatus> {
		return this.authed ? { ok: true } : { ok: false, reason: 'GitHub CLI is not authenticated.' };
	}
	async resolveRepo(): Promise<string | null> {
		return null;
	}
	async listIssues() {
		return [];
	}
	async createIssue() {
		return { number: 1, url: 'x' };
	}
	async updateIssue() {}
	async createRepo(input: CreateRepoInput, cwd: string): Promise<CreateRepoOutcome> {
		this.createCalls.push({ input, cwd });
		return this.createOutcome;
	}
}

function fakeGit() {
	const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
	const fn: CommandRunner = async (file, args, o): Promise<CommandResult> => {
		calls.push({ file, args: [...args], cwd: o.cwd });
		return { code: 0, stdout: '', stderr: '' };
	};
	return { fn, calls };
}

let hireSeq = 0;
/** Seed a role + interviewing version + a TERMINAL PASSED interview_run, then raise its cert_hire brief. */
async function seedCertHireBrief() {
	const role = await createRole(db, {
		slug: `hiretarget${++hireSeq}`,
		name: 'Hire Target',
		purpose: 'catch a specific defect class'
	});
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: 'find the planted defect and nothing else',
		default_tier: 'sonnet'
	});
	// createInterviewRun flips the draft version → 'interviewing' (the campaign coupling).
	const run = await createInterviewRun(db, {
		role_version: version.id,
		tier: 'sonnet',
		provider: 'claude',
		model_id: 'claude-test',
		fixture_set_sha: 'sha-test',
		planted_total: 2,
		pass_criteria: { pass_recall: 1.0, max_false_positives: 0 }
	});
	// Finalize to a terminal PASSED run (the fields buildHireDecision reads — a real green campaign).
	await db.query(`UPDATE $rid SET status = 'passed', planted_found = 2, false_positives = 0;`, {
		rid: new StringRecordId(run.id)
	});
	const brief = await raiseHireBrief(db, run.id);
	return { role, version, run, brief };
}

describe('applyBriefDecision — cert_hire routes through the workforce hire path (B4 intact)', () => {
	it('approve WITH operatorConfirmed flips the cert (routes to applyHireDecision)', async () => {
		const { version, brief } = await seedCertHireBrief();
		const out = await applyBriefDecision(db, brief.id, 'approve', { operatorConfirmed: true });
		expect(out.kind).toBe('cert_hire');
		expect(out.brief.status).toBe('approved');
		expect(out.hire?.certFlipped).toBe(true);
		expect(out.hire?.recommendation).toBe('hire');
		// The cert really flipped on the version (F-008 — read back the live lifecycle).
		expect((await getRoleVersion(db, version.id))?.lifecycle).toBe('passed');
	});

	it('approve WITHOUT operatorConfirmed fails CLOSED (B4) — no cert flip, brief stays open', async () => {
		const { version, brief } = await seedCertHireBrief();
		await expect(applyBriefDecision(db, brief.id, 'approve', { operatorConfirmed: false })).rejects.toBeInstanceOf(
			HireGateError
		);
		expect((await getRoleVersion(db, version.id))?.lifecycle).toBe('interviewing'); // untouched
		expect((await getBrief(db, brief.id))?.status).toBe('open'); // re-decidable
	});

	it('reject withholds (no cert flip); brief rejected', async () => {
		const { version, brief } = await seedCertHireBrief();
		const out = await applyBriefDecision(db, brief.id, 'reject');
		expect(out.kind).toBe('cert_hire');
		expect(out.brief.status).toBe('rejected');
		expect(out.hire?.certFlipped).toBe(false);
		expect((await getRoleVersion(db, version.id))?.lifecycle).toBe('interviewing'); // not certified
	});

	it('defer is a TYPED refusal — a hire-gate is approve/reject only (no crash, no effect)', async () => {
		const { brief } = await seedCertHireBrief();
		await expect(applyBriefDecision(db, brief.id, 'defer')).rejects.toBeInstanceOf(BriefError);
		expect((await getBrief(db, brief.id))?.status).toBe('open'); // untouched
	});
});

describe('applyBriefDecision — repo_create routes through the RC-2 outward gate (B4 intact)', () => {
	async function repoCreateBrief() {
		await createPm(db, { project: projectId, name: 'Vesper' }); // default authority 'act'
		const { brief } = await proposeRepoCreate(db, { project: projectId, name: 'repo-host' });
		return brief;
	}

	it('approve WITH operatorConfirmed drives the gate (stubbed gh): repo created, brief approved', async () => {
		const brief = await repoCreateBrief();
		const gh = new FakeGh();
		const git = fakeGit();
		const out = await applyBriefDecision(db, brief.id, 'approve', {
			operatorConfirmed: true,
			client: gh,
			gitRunner: git.fn
		});
		expect(out.kind).toBe('repo_create');
		expect(out.repo?.created).toBe(true);
		expect(out.repo?.repoUrl).toBe('https://github.com/me/repo-host');
		expect(out.brief.status).toBe('approved');
		expect(gh.createCalls.length).toBe(1); // the gate really called the (stubbed) outward create
		expect((await getProject(db, projectId))?.repo_url).toBe('https://github.com/me/repo-host');
	});

	it('approve WITHOUT operatorConfirmed fails CLOSED (B4 wall) — nothing created, brief open', async () => {
		const brief = await repoCreateBrief();
		const gh = new FakeGh();
		const git = fakeGit();
		await expect(
			applyBriefDecision(db, brief.id, 'approve', { operatorConfirmed: false, client: gh, gitRunner: git.fn })
		).rejects.toBeInstanceOf(RepoCreateGateError);
		expect(gh.createCalls.length).toBe(0);
		expect((await getPm(db, projectId))?.repo_create_preauthorized).toBe(false);
		expect((await getBrief(db, brief.id))?.status).toBe('open');
	});

	it('reject creates nothing; brief rejected', async () => {
		const brief = await repoCreateBrief();
		const out = await applyBriefDecision(db, brief.id, 'reject');
		expect(out.kind).toBe('repo_create');
		expect(out.repo?.created).toBe(false);
		expect(out.brief.status).toBe('rejected');
		expect((await getProject(db, projectId))?.repo_url).toBeFalsy();
	});

	it('defer is a TYPED refusal — repo_create is approve/reject only', async () => {
		const brief = await repoCreateBrief();
		await expect(applyBriefDecision(db, brief.id, 'defer')).rejects.toBeInstanceOf(BriefError);
		expect((await getBrief(db, brief.id))?.status).toBe('open');
	});
});

describe('applyBriefDecision — unbuilt / unknown kinds refuse honestly (fail-closed, never a crash)', () => {
	it.each(['review_proposal', 'fixture_proposal'] as const)(
		'%s brief → typed BriefError (panel-verdict kind, no decide-effect)',
		async (kind) => {
			// These kinds ARE admitted by the schema ASSERT but are NEVER minted as operator briefs (they
			// are panel_verdict artifact kinds). A brief carrying one has no decide-effect → honest refusal.
			const brief = await createDecisionBrief(db, {
				project: projectId,
				artifact: projectId, // any real record id; the refusal precedes any artifact read
				artifact_kind: kind,
				classification: 'confirm',
				ask: 'decide this?',
				issue: 'an unbuilt-kind brief that must refuse honestly',
				effort: { apply: '—', wrongness: '—' },
				evidence: [projectId, `${projectId}#2`],
				falsifier: 'the kind may gain a decide-effect later',
				options: [
					{ id: 'approve', label: 'Approve', pro: 'p', con: 'c', recommended: 'r' },
					{ id: 'reject', label: 'Reject', pro: 'p', con: 'c' }
				]
			});
			await expect(applyBriefDecision(db, brief.id, 'approve')).rejects.toBeInstanceOf(BriefError);
			await expect(applyBriefDecision(db, brief.id, 'reject')).rejects.toBeInstanceOf(BriefError);
			// No effect: the brief is left OPEN (the refusal never touched it).
			expect((await getBrief(db, brief.id))?.status).toBe('open');
		}
	);

	it('a nonexistent brief id → typed BriefError (not found), never a crash', async () => {
		await expect(applyBriefDecision(db, 'decision_brief:doesnotexist', 'approve')).rejects.toBeInstanceOf(
			BriefError
		);
	});
});

describe('applyBriefDecision — first-class DECISION analytics (kind/decision/outcome/why)', () => {
	async function gateBriefFor() {
		const task = await propose('propose');
		const result = await runValidationPanel(
			deps([verdictRun(baseVerdict()), verdictRun(baseVerdict())]),
			task.id
		);
		return { task, brief: result.brief! };
	}

	it('a task approve writes ONE pm_memory decision row carrying kind + decision + why', async () => {
		const { brief } = await gateBriefFor();
		await applyBriefDecision(db, brief.id, 'approve');
		const decisions = await listPmMemory(db, projectId, { kind: 'decision' });
		const row = decisions.find((m) => m.source === 'decision-brief' && m.content.includes(`brief ${brief.id}`));
		expect(row).toBeTruthy();
		expect(row!.content).toContain('decision=approve');
		expect(row!.content).toContain('task'); // the kind
		// Idempotent absorb: a re-POST of the SAME answer does NOT double-count the decision.
		await applyBriefDecision(db, brief.id, 'approve');
		expect(
			(await listPmMemory(db, projectId, { kind: 'decision' })).filter((m) =>
				m.content.includes(`brief ${brief.id}`)
			)
		).toHaveLength(1);
	});

	it('the task path stays byte-identical on the RESULT (kind:"task" + taskStatus preserved)', async () => {
		const { brief } = await gateBriefFor();
		const out = await applyBriefDecision(db, brief.id, 'approve');
		expect(out.kind).toBe('task');
		expect(out.taskStatus).toBe('ready');
		expect(out.brief.status).toBe('approved');
	});

	// Regression (re-review DEFECT 1): the DELEGATED kinds (repo_create/cert_hire) absorb an already-decided
	// brief INSIDE their delegate and return normally, so a re-POST reached the unconditional analytics write
	// and (for a CREATED repo) wrote a SECOND, factually-FALSE 'repo gate red at —' decision row. Analytics
	// must fire ONLY on the real open→decided transition — the same idempotence the task path already holds.
	it('a repo_create re-POST does NOT double-count OR write a false "gate red" decision row', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { brief } = await proposeRepoCreate(db, { project: projectId, name: 'repo-host' });
		const gh = new FakeGh();
		const git = fakeGit();
		const opts = { operatorConfirmed: true, client: gh, gitRunner: git.fn };

		const first = await applyBriefDecision(db, brief.id, 'approve', opts);
		expect(first.repo?.created).toBe(true); // the repo was really created on the first approve

		const rows1 = (await listPmMemory(db, projectId, { kind: 'decision' })).filter(
			(m) => m.source === 'decision-brief' && m.content.includes(`brief ${brief.id}`)
		);
		expect(rows1).toHaveLength(1);
		expect(rows1[0].content).toContain('repo created');

		// Re-POST the SAME approve — the delegate absorbs (gate:null, nothing ran); analytics must NOT re-fire.
		await applyBriefDecision(db, brief.id, 'approve', opts);
		const rows2 = (await listPmMemory(db, projectId, { kind: 'decision' })).filter(
			(m) => m.source === 'decision-brief' && m.content.includes(`brief ${brief.id}`)
		);
		expect(rows2).toHaveLength(1); // still exactly ONE row — no double-count
		expect(rows2.some((m) => m.content.includes('gate red'))).toBe(false); // no factually-false row
	});
});

// ── Read models + helpers ──────────────────────────────────────────────────────────

describe('listProposalQueue + cadence window', () => {
	it('composes proposals with their verdicts and open brief (live rows only)', async () => {
		const task = await propose('propose');
		expect(await listProposalQueue(db, projectId)).toHaveLength(1);
		await runValidationPanel(deps([verdictRun(baseVerdict()), verdictRun(baseVerdict())]), task.id);
		const queue = await listProposalQueue(db, projectId);
		expect(queue).toHaveLength(1);
		expect(queue[0].verdicts).toHaveLength(2);
		expect(queue[0].openBrief?.classification).toBe('proposal_gate');
	});

	it('cadenceWindowMs derives the gap between the next two cron fires; null when unparseable/absent', () => {
		expect(cadenceWindowMs('0 * * * *', new Date('2026-06-11T10:30:00'))).toBe(60 * 60 * 1000);
		expect(cadenceWindowMs('*/15 * * * *', new Date('2026-06-11T10:01:00'))).toBe(15 * 60 * 1000);
		expect(cadenceWindowMs('not a cron')).toBeNull();
		expect(cadenceWindowMs(undefined)).toBeNull();
	});
});
