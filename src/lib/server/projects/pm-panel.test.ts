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
import { createProject } from './repo';
import { getTask, setStatus } from '../tasks/repo';
import { listPanelVerdictsForArtifact } from '../workforce/repo';
import { createPm, listPmMemory } from './pm-repo';
import { listOpenBriefs } from './briefs';
import { proposeTask, type ProposeTaskInput } from './pm-proposals';
import {
	runValidationPanel,
	applyBriefDecision,
	parseValidatorVerdict,
	foldVerdictReasons,
	cadenceWindowMs,
	listProposalQueue,
	ValidatorContractError,
	PanelInputError,
	type PanelDeps
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
