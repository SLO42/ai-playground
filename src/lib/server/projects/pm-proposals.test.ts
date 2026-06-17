import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from './repo';
import { createTask, getTask, setStatus, type TaskProvenance } from '../tasks/repo';
import { writeFindings } from '../scanner/findings-repo';
import {
	addPanelVerdict,
	listPanelVerdictsForArtifact,
	closeOpenPanelVerdictsForArtifact
} from '../workforce/repo';
import { createPm, listPmMemory, updatePmAuthority } from './pm-repo';
import { runPmReview } from './pm-review';
import { createDecisionBrief, getOpenBriefForArtifact, markBriefDecided, BriefError } from './briefs';
import {
	proposeTask,
	revisePmProposal,
	withdrawPmProposal,
	proposalFingerprint,
	ProposalContractError,
	type ProposeTaskInput
} from './pm-proposals';

// TASK 16.4 VERIFY — the proposed-task pipeline against a REAL throwaway SurrealDB:
// migration 0032 pair discipline (apply-twice + half-applied recovery, F-015), the
// §4.1 Act-with-Purpose contract (schema-enforcement rejects — missing purpose =
// honest fail), the anti-spam ladder (duplicate absorb / defer suppression / cap →
// pm_memory), the revise/withdraw loop with §2.2 mechanical verdict closure, the
// upheld-on-done closure through the setStatus chokepoint, and the runPmReview
// Act-with-Purpose derivation (real signals only).

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
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied).toContain('0032_proposed_tasks');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db
		.query(
			'DELETE panel_verdict; DELETE decision_brief; DELETE pm; DELETE pm_review; DELETE pm_memory; DELETE security_finding; DELETE task; DELETE session; DELETE project;'
		)
		.catch(() => {});
	const p = await createProject(db, {
		slug: `proptest${++seq}`,
		name: 'Proposal Host',
		root_path: 'F:/code/proptest'
	});
	projectId = p.id;
});

function provenance(evidence: string[] = ['security_finding:ev1'], kind = 'finding'): TaskProvenance {
	return { kind, evidence };
}

function validInput(over: Partial<ProposeTaskInput> = {}): ProposeTaskInput {
	return {
		project: projectId,
		title: 'Triage the open finding',
		objective: 'Resolve the open critical finding before release.',
		purpose: 'Severe findings gate the plan Definition of Done.',
		acceptance_criteria: ['The finding is resolved or suppressed with justification.'],
		provenance: provenance(),
		...over
	};
}

async function hire(authority?: 'observe' | 'propose' | 'act') {
	const pm = await createPm(db, { project: projectId, name: 'Vesper', ...(authority ? { authority } : {}) });
	return pm;
}

async function freshSession(): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session SET kind = 'review', model = { provider: 'claude', model_id: 'claude-test' } RETURN id;`
	);
	return String(rows[0].id);
}

// ── 0032 migration pair discipline (F-015) ─────────────────────────────────────────

describe('0032_proposed_tasks migration — apply-twice + half-applied recovery', () => {
	it('defines the decision_brief table + indexes and the task additive fields', async () => {
		const [info] = await db.query<[{ tables: Record<string, string> }]>('INFO FOR DB;');
		expect(Object.keys(info.tables)).toContain('decision_brief');
		const [briefInfo] = await db.query<[{ indexes: Record<string, string> }]>(
			'INFO FOR TABLE decision_brief;'
		);
		for (const idx of ['brief_by_status', 'brief_by_artifact', 'brief_by_fingerprint']) {
			expect(Object.keys(briefInfo.indexes)).toContain(idx);
		}
		const [taskInfo] = await db.query<[{ fields: Record<string, string>; indexes: Record<string, string> }]>(
			'INFO FOR TABLE task;'
		);
		for (const f of [
			'objective',
			'purpose',
			'acceptance_criteria',
			'provenance',
			'proposed_by',
			'revision_of',
			'superseded_by',
			'proposal_fingerprint'
		]) {
			expect(Object.keys(taskInfo.fields), `missing task field ${f}`).toContain(f);
		}
		expect(Object.keys(taskInfo.indexes)).toContain('task_by_fingerprint');
		// The widened enums took (full sets — m0022 lesson).
		expect(taskInfo.fields.status).toContain('proposed');
		expect(taskInfo.fields.status).toContain('withdrawn');
		expect(taskInfo.fields.origin).toContain("'pm'");
		// panel_verdict gained the §4.5 classification column.
		const [pvInfo] = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE panel_verdict;');
		expect(Object.keys(pvInfo.fields)).toContain('classification');
	});

	it('applies twice cleanly (every DEFINE is OVERWRITE) and data survives', async () => {
		await hire();
		const created = await proposeTask(db, validInput());
		expect(created.outcome).toBe('created');
		const m0032 = schemaMigrations.find((m) => m.id === '0032_proposed_tasks');
		expect(m0032).toBeDefined();
		await db.query(m0032!.up); // re-apply the raw DDL over live data
		const back = await getTask(db, created.task!.id);
		expect(back?.status).toBe('proposed');
		expect(back?.objective).toBe(validInput().objective);
	});

	it('RECOVERS a half-applied state: bare decision_brief table, then the migration applies clean', async () => {
		// Reproduce the m0025 wedge class: the table exists BARE (no fields/indexes).
		await db.query('REMOVE TABLE decision_brief;');
		await db.query('DEFINE TABLE decision_brief SCHEMAFULL;');
		const m0032 = schemaMigrations.find((m) => m.id === '0032_proposed_tasks');
		await db.query(m0032!.up); // must not throw "table already exists"
		const [briefInfo] = await db.query<[{ fields: Record<string, string> }]>(
			'INFO FOR TABLE decision_brief;'
		);
		expect(Object.keys(briefInfo.fields)).toContain('ask');
		expect(Object.keys(briefInfo.fields)).toContain('falsifier');
	});
});

// ── §4.1 contract enforcement (schema-enforced at the chokepoint) ──────────────────

describe('proposeTask — the Act-with-Purpose contract (PM-SPEC §4.1)', () => {
	it('creates a task BORN proposed/origin pm with the full contract + fingerprint', async () => {
		const pm = await hire();
		const res = await proposeTask(db, validInput());
		expect(res.outcome).toBe('created');
		const t = res.task!;
		expect(t.status).toBe('proposed');
		expect(t.origin).toBe('pm');
		expect(t.objective).toBeTruthy();
		expect(t.purpose).toBeTruthy();
		expect(t.acceptance_criteria).toHaveLength(1);
		expect(t.provenance?.kind).toBe('finding');
		expect(t.provenance?.evidence).toEqual(['security_finding:ev1']);
		expect(t.provenance?.authority).toBe(pm.authority);
		expect(t.proposed_by).toBe(pm.id);
		expect(t.proposal_fingerprint).toBe(proposalFingerprint(projectId, provenance()));
		// The immutable description (D-008) composes the contract fields.
		expect(t.description).toContain('Objective:');
		expect(t.description).toContain('Acceptance criteria:');
	});

	it.each([
		['missing purpose', { purpose: '' }],
		['missing objective', { objective: '   ' }],
		['empty criteria', { acceptance_criteria: [] }],
		['blank criterion', { acceptance_criteria: ['  '] }],
		['missing provenance evidence', { provenance: { kind: 'finding', evidence: [] } }],
		['missing provenance kind', { provenance: { kind: '', evidence: ['x:1'] } }]
	] as Array<[string, Partial<ProposeTaskInput>]>)(
		'rejects %s — honest named fail, no half-created row (shadow paths)',
		async (_label, over) => {
			await hire();
			await expect(proposeTask(db, validInput(over))).rejects.toBeInstanceOf(ProposalContractError);
			const [rows] = await db.query<[unknown[]]>(`SELECT id FROM task;`);
			expect(rows).toHaveLength(0);
		}
	);

	it('refuses without a hired PM (the hired identity is required, PM-SPEC §1)', async () => {
		await expect(proposeTask(db, validInput())).rejects.toBeInstanceOf(ProposalContractError);
	});

	it('refuses under observe authority (an observe-only PM does not propose)', async () => {
		await hire('observe');
		await expect(proposeTask(db, validInput())).rejects.toBeInstanceOf(ProposalContractError);
	});
});

// ── Anti-spam ladder (PM-SPEC §4 (d) / WORKFORCE-SPEC §5) ──────────────────────────

describe('proposeTask — anti-spam (structural fingerprints, caps, defer windows)', () => {
	it('the fingerprint is STRUCTURAL: rewording does not change it; evidence does', () => {
		const a = proposalFingerprint(projectId, provenance(['x:1', 'x:2']));
		const b = proposalFingerprint(projectId, provenance(['x:2', 'x:1'])); // order-insensitive
		const c = proposalFingerprint(projectId, provenance(['x:3']));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it('absorbs a structural duplicate while one is open (interrupt-contract re-run)', async () => {
		await hire();
		const first = await proposeTask(db, validInput());
		const again = await proposeTask(db, validInput({ title: 'Reworded title, same trigger' }));
		expect(again.outcome).toBe('duplicate_open');
		expect(again.task?.id).toBe(first.task?.id);
		const [rows] = await db.query<[unknown[]]>(`SELECT id FROM task WHERE status = 'proposed';`);
		expect(rows).toHaveLength(1);
	});

	it('at the open-proposal cap (default 2) the PM records to pm_memory instead', async () => {
		await hire();
		await proposeTask(db, validInput({ provenance: provenance(['a:1']) }));
		await proposeTask(db, validInput({ provenance: provenance(['a:2']) }));
		const third = await proposeTask(db, validInput({ provenance: provenance(['a:3']) }));
		expect(third.outcome).toBe('capped');
		expect(third.task).toBeUndefined();
		expect(third.memory?.content).toContain('open-proposal cap');
		const mem = await listPmMemory(db, projectId);
		expect(mem.some((m) => m.source === 'pm-proposals')).toBe(true);
	});

	it('honors a custom cap from config/workforce.yaml (operator-tunable)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wf-cap-'));
		try {
			writeFileSync(
				join(dir, 'workforce.yaml'),
				'pm:\n  model_id: claude-opus-4-8\nworkforce:\n  max_open_proposals: 1\n'
			);
			await hire();
			await proposeTask(db, validInput({ provenance: provenance(['b:1']) }), { configDir: dir });
			const second = await proposeTask(db, validInput({ provenance: provenance(['b:2']) }), {
				configDir: dir
			});
			expect(second.outcome).toBe('capped');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a deferred fingerprint is suppressed until the window lapses (defer is structural)', async () => {
		await hire();
		const prov = provenance(['c:1']);
		const fp = proposalFingerprint(projectId, prov);
		// An operator-deferred brief stands for this structural matter.
		const seed = await proposeTask(db, validInput({ provenance: prov }));
		const brief = await createDecisionBrief(db, {
			project: projectId,
			artifact: seed.task!.id,
			artifact_kind: 'task',
			classification: 'proposal_gate',
			ask: 'Promote?',
			issue: 'test brief',
			effort: { apply: '—', wrongness: '—' },
			evidence: [seed.task!.id, 'panel_verdict:x'],
			falsifier: 'none recorded',
			options: [
				{ id: 'approve', label: 'a', pro: 'p', con: 'c', recommended: 'r' },
				{ id: 'reject', label: 'b', pro: 'p', con: 'c' }
			],
			fingerprint: fp
		});
		await markBriefDecided(db, brief.id, 'deferred', {
			deferUntil: new Date(Date.now() + 60 * 60 * 1000)
		});
		// Withdraw the open duplicate so only the defer window can suppress.
		await withdrawPmProposal(db, seed.task!.id);
		const re = await proposeTask(db, validInput({ provenance: prov, title: 'Cosmetically different' }));
		expect(re.outcome).toBe('defer_suppressed');
		expect(re.memory?.content).toContain('defer');
	});
});

// ── Revise / withdraw loop + §2.2 mechanical closure ────────────────────────────────

describe('revise / withdraw — §2.2 outcome closure + supersession links', () => {
	it('withdraw: proposed → withdrawn; open verdicts close "withdrawn"; brief superseded', async () => {
		await hire();
		const res = await proposeTask(db, validInput());
		const taskId = res.task!.id;
		const session = await freshSession();
		const v = await addPanelVerdict(db, {
			project: projectId,
			artifact: taskId,
			artifact_kind: 'task',
			validator_session: session,
			verdict: 'pushback',
			reasons: ['too broad'],
			classification: 'mechanical'
		});
		expect(v.outcome).toBeNull();
		await createDecisionBrief(db, {
			project: projectId,
			artifact: taskId,
			artifact_kind: 'task',
			classification: 'proposal_gate',
			ask: 'Promote?',
			issue: 'i',
			effort: { apply: '—', wrongness: '—' },
			evidence: [taskId, v.id],
			falsifier: 'f',
			options: [
				{ id: 'approve', label: 'a', pro: 'p', con: 'c', recommended: 'r' },
				{ id: 'reject', label: 'b', pro: 'p', con: 'c' }
			]
		});
		const out = await withdrawPmProposal(db, taskId);
		expect(out.task.status).toBe('withdrawn');
		expect(out.verdictsClosed).toBe(1);
		const verdicts = await listPanelVerdictsForArtifact(db, taskId);
		expect(verdicts[0].outcome).toBe('withdrawn');
		// The open brief was mechanically superseded — never an operator decision.
		expect(await getOpenBriefForArtifact(db, taskId)).toBeNull();
		const [superseded] = await db.query<[Array<{ status: string; decided_at: unknown }>]>(
			`SELECT status, decided_at FROM decision_brief WHERE artifact = $aid;`,
			{ aid: new StringRecordId(taskId) }
		);
		expect(superseded[0]?.status).toBe('superseded');
		expect(superseded[0]?.decided_at ?? null).toBeNull();
	});

	it('revise: successor born proposed with revision_of; predecessor withdrawn+superseded_by; verdicts close "revised"', async () => {
		await hire();
		const res = await proposeTask(db, validInput());
		const oldId = res.task!.id;
		const session = await freshSession();
		await addPanelVerdict(db, {
			project: projectId,
			artifact: oldId,
			artifact_kind: 'task',
			validator_session: session,
			verdict: 'pushback',
			reasons: ['criteria not executable'],
			classification: 'mechanical'
		});
		const out = await revisePmProposal(db, oldId, {
			objective: 'Resolve the finding with a narrower scope.',
			purpose: 'Same trigger, tightened after panel pushback.',
			acceptance_criteria: ['The single named finding is resolved.', 'A regression test exists.']
		});
		expect(out.successor.status).toBe('proposed');
		expect(out.successor.revision_of).toBe(oldId);
		expect(out.predecessor.status).toBe('withdrawn');
		expect(out.verdictsClosed).toBe(1);
		const pred = await getTask(db, oldId);
		expect(pred?.superseded_by).toBe(out.successor.id);
		const verdicts = await listPanelVerdictsForArtifact(db, oldId);
		expect(verdicts[0].outcome).toBe('revised');
	});

	it('a retried revise after a crash ABSORBS the already-created successor — never a double-create (16.4 re-review gap 5)', async () => {
		// Code-read defect: the comment claimed proposeTask's duplicate_open absorb made
		// the re-run converge, but revisePmProposal calls createTask DIRECTLY — a retry
		// after a crash between the successor CREATE and the predecessor retirement
		// created a second identical-fingerprint successor.
		const pm = await hire();
		const res = await proposeTask(db, validInput());
		const oldId = res.task!.id;
		const revision = {
			objective: 'Resolve the finding with a narrower scope.',
			purpose: 'Same trigger, tightened after panel pushback.',
			acceptance_criteria: ['The single named finding is resolved.']
		};
		// Simulate the crash window exactly: the successor row landed (revision_of +
		// fingerprint stamped), the retirement steps never ran.
		const orphan = await createTask(db, {
			project: projectId,
			title: res.task!.title,
			description: 'crashed-run successor',
			origin: 'pm',
			status: 'proposed',
			objective: revision.objective,
			purpose: revision.purpose,
			acceptance_criteria: revision.acceptance_criteria,
			provenance: { ...provenance(), authority: pm.authority },
			proposed_by: pm.id,
			revision_of: oldId,
			proposal_fingerprint: proposalFingerprint(projectId, provenance())
		});
		// The RE-RUN of the same revise must absorb the orphan and finish the retirement.
		const out = await revisePmProposal(db, oldId, revision);
		expect(out.successor.id).toBe(orphan.id);
		expect(out.predecessor.status).toBe('withdrawn');
		expect((await getTask(db, oldId))?.superseded_by).toBe(orphan.id);
		const [proposed] = await db.query<[unknown[]]>(`SELECT id FROM task WHERE status = 'proposed';`);
		expect(proposed).toHaveLength(1); // exactly ONE successor — the absorbed one
	});

	it('revise enforces the full §4.1 contract on the successor (missing purpose = fail)', async () => {
		await hire();
		const res = await proposeTask(db, validInput());
		await expect(
			revisePmProposal(db, res.task!.id, {
				objective: 'x',
				purpose: '',
				acceptance_criteria: ['y']
			})
		).rejects.toBeInstanceOf(ProposalContractError);
		// Predecessor untouched (no half-revision).
		expect((await getTask(db, res.task!.id))?.status).toBe('proposed');
	});

	it('refuses the loop on a non-proposed task (named error)', async () => {
		await hire();
		const t = await createTask(db, { project: projectId, title: 'plain', description: 'd' });
		await expect(withdrawPmProposal(db, t.id)).rejects.toBeInstanceOf(ProposalContractError);
	});

	it('done closes open verdicts "upheld" through the ONE setStatus chokepoint (§2.2)', async () => {
		await hire();
		const res = await proposeTask(db, validInput());
		const taskId = res.task!.id;
		const session = await freshSession();
		await addPanelVerdict(db, {
			project: projectId,
			artifact: taskId,
			artifact_kind: 'task',
			validator_session: session,
			verdict: 'approve',
			reasons: ['sound'],
			classification: 'mechanical'
		});
		await setStatus(db, taskId, 'ready');
		await setStatus(db, taskId, 'in_progress');
		await setStatus(db, taskId, 'done');
		const verdicts = await listPanelVerdictsForArtifact(db, taskId);
		expect(verdicts[0].outcome).toBe('upheld');
	});

	it('a crash between the done-commit and the §2.2 closure converges on re-run (16.4 DoD-review fix)', async () => {
		// Defect: closeOpenPanelVerdictsForArtifact ran AFTER the committed status
		// transaction, and the identity no-op early-return made the closure
		// unreachable on a re-run — a crash in that window orphaned open verdicts on
		// a done task forever (invisible: the queue lists 'proposed' tasks only).
		await hire();
		const res = await proposeTask(db, validInput());
		const taskId = res.task!.id;
		const session = await freshSession();
		await addPanelVerdict(db, {
			project: projectId,
			artifact: taskId,
			artifact_kind: 'task',
			validator_session: session,
			verdict: 'approve',
			reasons: ['sound'],
			classification: 'mechanical'
		});
		// Simulate the crash window: the transition committed (raw write — exactly
		// what the transaction persists), the process died before the closure ran.
		await db.query(`UPDATE $rid SET status = 'done', updated_at = time::now();`, {
			rid: new StringRecordId(taskId)
		});
		expect((await listPanelVerdictsForArtifact(db, taskId))[0].outcome).toBeNull(); // orphaned
		// Interrupt contract: the RE-RUN of the same operation absorbs the prior
		// partial work — the identity-done path now reaches the closure.
		const same = await setStatus(db, taskId, 'done');
		expect(same?.status).toBe('done');
		expect((await listPanelVerdictsForArtifact(db, taskId))[0].outcome).toBe('upheld');
		// …and a second re-run stays a clean absorb (no relabel, no error).
		await setStatus(db, taskId, 'done');
		expect((await listPanelVerdictsForArtifact(db, taskId))[0].outcome).toBe('upheld');
	});

	it('closeOpenPanelVerdictsForArtifact is idempotent over a re-run (interrupt contract)', async () => {
		await hire();
		const res = await proposeTask(db, validInput());
		const session = await freshSession();
		await addPanelVerdict(db, {
			project: projectId,
			artifact: res.task!.id,
			artifact_kind: 'task',
			validator_session: session,
			verdict: 'pushback',
			reasons: ['r'],
			classification: 'mechanical'
		});
		expect(await closeOpenPanelVerdictsForArtifact(db, res.task!.id, 'withdrawn')).toBe(1);
		expect(await closeOpenPanelVerdictsForArtifact(db, res.task!.id, 'withdrawn')).toBe(0);
	});
});

// ── Brief format invariants (WORKFORCE §8) ─────────────────────────────────────────

describe('createDecisionBrief — §8 canonical-format invariants', () => {
	it.each([
		['no falsifier', { falsifier: ' ' }],
		['one evidence link', { evidence: ['only:one'] }],
		['five evidence links', { evidence: ['a:1', 'a:2', 'a:3', 'a:4', 'a:5'] }],
		['zero recommended options', { options: [{ id: 'approve', label: 'a', pro: 'p', con: 'c' }, { id: 'reject', label: 'r', pro: 'p', con: 'c' }] }],
		[
			'two recommended options',
			{
				options: [
					{ id: 'approve', label: 'a', pro: 'p', con: 'c', recommended: 'x' },
					{ id: 'reject', label: 'r', pro: 'p', con: 'c', recommended: 'y' }
				]
			}
		]
	] as Array<[string, Record<string, unknown>]>)('rejects %s (named BriefError)', async (_l, over) => {
		await hire();
		const res = await proposeTask(db, validInput());
		await expect(
			createDecisionBrief(db, {
				project: projectId,
				artifact: res.task!.id,
				artifact_kind: 'task',
				classification: 'proposal_gate',
				ask: 'Promote?',
				issue: 'i',
				effort: { apply: '—', wrongness: '—' },
				evidence: [res.task!.id, 'panel_verdict:x'],
				falsifier: 'f',
				options: [
					{ id: 'approve', label: 'a', pro: 'p', con: 'c', recommended: 'r' },
					{ id: 'reject', label: 'b', pro: 'p', con: 'c' }
				],
				...over
			} as never)
		).rejects.toBeInstanceOf(BriefError);
	});

	it('absorbs an existing OPEN brief for the same artifact (one open question per artifact)', async () => {
		await hire();
		const res = await proposeTask(db, validInput());
		const input = {
			project: projectId,
			artifact: res.task!.id,
			artifact_kind: 'task' as const,
			classification: 'proposal_gate' as const,
			ask: 'Promote?',
			issue: 'i',
			effort: { apply: '—', wrongness: '—' },
			evidence: [res.task!.id, 'panel_verdict:x'],
			falsifier: 'f',
			options: [
				{ id: 'approve' as const, label: 'a', pro: 'p', con: 'c', recommended: 'r' },
				{ id: 'reject' as const, label: 'b', pro: 'p', con: 'c' }
			]
		};
		const first = await createDecisionBrief(db, input);
		const second = await createDecisionBrief(db, input);
		expect(second.id).toBe(first.id);
	});

	it('decided briefs are append-once: same re-decision absorbs, relabel refused', async () => {
		await hire();
		const res = await proposeTask(db, validInput());
		const brief = await createDecisionBrief(db, {
			project: projectId,
			artifact: res.task!.id,
			artifact_kind: 'task',
			classification: 'proposal_gate',
			ask: 'Promote?',
			issue: 'i',
			effort: { apply: '—', wrongness: '—' },
			evidence: [res.task!.id, 'panel_verdict:x'],
			falsifier: 'f',
			options: [
				{ id: 'approve', label: 'a', pro: 'p', con: 'c', recommended: 'r' },
				{ id: 'reject', label: 'b', pro: 'p', con: 'c' }
			]
		});
		const decided = await markBriefDecided(db, brief.id, 'approved');
		expect(decided.status).toBe('approved');
		expect(decided.decided_at).not.toBeNull(); // F-013: a SET datetime reads back as a string
		expect((await markBriefDecided(db, brief.id, 'approved')).status).toBe('approved');
		await expect(markBriefDecided(db, brief.id, 'rejected')).rejects.toBeInstanceOf(BriefError);
	});
});

// ── runPmReview — Act-with-Purpose derivation (real signals only) ──────────────────

describe('runPmReview — §4 proposal derivation', () => {
	it('skips honestly with no hired PM (named reason, no rows)', async () => {
		const res = await runPmReview(db, projectId);
		expect(res.proposals).toEqual([]);
		expect(res.proposalsSkipped).toContain('no hired PM');
	});

	it('skips honestly for an observe-only PM', async () => {
		await hire();
		await updatePmAuthority(db, projectId, 'observe');
		const res = await runPmReview(db, projectId);
		expect(res.proposals).toEqual([]);
		expect(res.proposalsSkipped).toContain("'observe'");
	});

	it('a blocked task yields ONE unblock proposal with the real task id as evidence; re-review absorbs', async () => {
		await hire();
		const t = await createTask(db, { project: projectId, title: 'Stuck', description: 'd', status: 'ready' });
		await setStatus(db, t.id, 'in_progress');
		await setStatus(db, t.id, 'blocked');
		const res = await runPmReview(db, projectId);
		const created = res.proposals.filter((p) => p.outcome === 'created');
		expect(created).toHaveLength(1);
		expect(created[0].task?.provenance?.kind).toBe('task_blocked');
		expect(created[0].task?.provenance?.evidence).toContain(t.id);
		expect(created[0].task?.status).toBe('proposed');
		// The same signal on the next pass ABSORBS the open proposal (no spam).
		const again = await runPmReview(db, projectId);
		expect(again.proposals.filter((p) => p.outcome === 'created')).toHaveLength(0);
		expect(again.proposals.some((p) => p.outcome === 'duplicate_open')).toBe(true);
	});

	it('severe findings yield a triage proposal carrying the finding ids', async () => {
		await hire();
		await writeFindings(db, projectId, [
			{ rule: 'sec.test', severity: 'critical', detail: 'planted', file: 'x.ts', line: 1 }
		]);
		const res = await runPmReview(db, projectId);
		const created = res.proposals.filter((p) => p.outcome === 'created');
		expect(created).toHaveLength(1);
		expect(created[0].task?.provenance?.kind).toBe('finding');
		expect(created[0].task?.provenance?.evidence.length).toBeGreaterThan(0);
	});

	it('a FAILED release provenance yields the diagnose proposal (event ④ retro)', async () => {
		await hire();
		const res = await runPmReview(db, projectId, 'event', {
			kind: 'release',
			evidence: ['workflow_run:r1'],
			detail: { status: 'failed' }
		});
		const created = res.proposals.filter((p) => p.outcome === 'created');
		expect(created).toHaveLength(1);
		expect(created[0].task?.title).toContain('Diagnose failed release');
		expect(created[0].task?.provenance?.evidence).toEqual(['workflow_run:r1']);
	});

	it('a healthy project proposes NOTHING (F-008 — no fabricated work)', async () => {
		await hire();
		const res = await runPmReview(db, projectId);
		expect(res.proposals).toEqual([]);
		expect(res.proposalsSkipped).toBeUndefined();
	});
});
