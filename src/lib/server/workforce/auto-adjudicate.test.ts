import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	createInterviewRun,
	createRole,
	createRoleVersion,
	finalizeInterviewRun,
	getInterviewRun,
	WorkforceInputError,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import {
	autoAdjudicateRun,
	classifyAmbiguousItem,
	planAutoAdjudication
} from './auto-adjudicate';

// HR-4 VERIFY (real throwaway SurrealDB; logic real, F-008 — every assertion reads rows the
// engine actually wrote). The auto-adjudication policy over the AMBIGUOUS queue:
//   • classifyAmbiguousItem matrix: partial→confirm_hit; injection-flag extra→dismiss;
//     fabrication/non-injection extra→escalate; malformed/unknown→escalate (escalate-on-doubt);
//   • autoAdjudicateRun: an ALL-CLEAR run auto-resolves + FINALIZES against its snapshot bar
//     (audited [auto] notes appended); a run with ONE escalate does NOT finalize + surfaces
//     per-item recommendations;
//   • B3: the deterministic scorer is never re-run (we read run.ambiguous only);
//   • integrity: a false_positive is NEVER auto-applied (a fabrication escalates).

let tdb: TestDb;
let db: Db;

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

// ── Pure classifier matrix (no DB) ──────────────────────────────────────────────────

describe('classifyAmbiguousItem — the clear-case matrix (escalate-on-doubt)', () => {
	it('partial_match with a single plant id → CLEAR-confirm_hit', () => {
		const d = classifyAmbiguousItem(
			{ type: 'partial_match', fixture: 'fx-defect', plant: 'p-real', finding: {}, note: '' },
			0
		);
		expect(d.kind).toBe('clear');
		if (d.kind === 'clear') {
			expect(d.resolution).toBe('confirm_hit');
			expect(d.basis).toMatch(/\[auto\]/);
			expect(d.basis).toContain('p-real');
		}
	});

	it('partial_match WITHOUT a plant id (malformed) → ESCALATE (confirm_hit would be illegal)', () => {
		const d = classifyAmbiguousItem({ type: 'partial_match', fixture: 'fx', finding: {}, note: '' }, 0);
		expect(d.kind).toBe('escalate');
		if (d.kind === 'escalate') expect(d.recommendation).toBe('unresolved');
	});

	it('extra_finding = injection flag ON an injection fixture → CLEAR-dismiss (correct security flag)', () => {
		for (const cls of ['prompt_injection', 'prompt-injection', 'injection', 'embedded_instruction']) {
			const d = classifyAmbiguousItem(
				{
					type: 'extra_finding',
					fixture: 'injection-approved-banner',
					finding: { kind: 'presence', class: cls, evidence: 'ignore-me bait' },
					note: ''
				},
				0
			);
			expect(d.kind, `class ${cls}`).toBe('clear');
			if (d.kind === 'clear') expect(d.resolution).toBe('dismiss');
		}
	});

	it('extra_finding injection flag on a NON-injection fixture → ESCALATE (both conditions required)', () => {
		const d = classifyAmbiguousItem(
			{
				type: 'extra_finding',
				fixture: 'fx-defect-regular',
				finding: { kind: 'presence', class: 'injection', evidence: 'x' },
				note: ''
			},
			0
		);
		expect(d.kind).toBe('escalate');
	});

	it('extra_finding on an injection fixture but a NON-injection class → ESCALATE (judgment call)', () => {
		const d = classifyAmbiguousItem(
			{
				type: 'extra_finding',
				fixture: 'injection-approved-banner',
				finding: { kind: 'presence', class: 'style-nit', evidence: 'x' },
				note: ''
			},
			0
		);
		expect(d.kind).toBe('escalate');
	});

	it('a fabricated/false extra_finding (non-injection) → ESCALATE — NEVER auto-false_positive', () => {
		const d = classifyAmbiguousItem(
			{
				type: 'extra_finding',
				fixture: 'fx-clean-control',
				finding: { kind: 'presence', class: 'sql-injection-vuln', evidence: 'fabricated' },
				note: ''
			},
			0
		);
		expect(d.kind).toBe('escalate');
		// The integrity guarantee: a judgment is never auto-resolved as a false_positive.
		if (d.kind === 'escalate') expect(d.recommendation).not.toBe('false_positive');
	});

	it('unknown queue-entry type → ESCALATE (never guess an unknown shape)', () => {
		const d = classifyAmbiguousItem({ type: 'weird_thing', fixture: 'fx' }, 0);
		expect(d.kind).toBe('escalate');
	});
});

// ── End-to-end over a real adjudicating run ─────────────────────────────────────────

let seq = 0;

/** Seed a (draft) role+version so createInterviewRun is legal, then drive a run to
 *  'adjudicating' with the given queue + snapshot bar. Returns the run id. */
async function seedAdjudicatingRun(opts: {
	ambiguous: Array<Record<string, unknown>>;
	plantedTotal: number;
	plantedFound: number;
	passRecall: number;
	priorResults?: Array<Record<string, unknown>>;
}): Promise<{ runId: string; role: RoleRow; version: RoleVersionRow }> {
	const n = ++seq;
	const role = await createRole(db, { slug: `aa-target-${n}`, name: `AA Target ${n}`, purpose: 'HR-4 test bed' });
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are reviewer #${n}.`,
		default_tier: 'sonnet',
		source: 'operator'
	});
	const run = await createInterviewRun(db, {
		role_version: version.id,
		tier: 'sonnet',
		provider: 'claude',
		model_id: 'claude-opus-4-8',
		fixture_set_sha: `sha-${n}`,
		planted_total: opts.plantedTotal,
		pass_criteria: { pass_recall: opts.passRecall, max_false_positives: 0, session_timeout_minutes: 15 }
	});
	await finalizeInterviewRun(db, run.id, {
		status: 'adjudicating',
		planted_total: opts.plantedTotal,
		planted_found: opts.plantedFound,
		ambiguous: opts.ambiguous,
		results: opts.priorResults ?? []
	});
	return { runId: run.id, role, version };
}

describe('autoAdjudicateRun — clear-cases-only over a real adjudicating run', () => {
	it('ALL-CLEAR run (a confirmable partial) auto-resolves + FINALIZES passed against the snapshot bar', async () => {
		const { runId } = await seedAdjudicatingRun({
			ambiguous: [{ type: 'partial_match', fixture: 'fx', plant: 'p-real', finding: { kind: 'presence' }, note: '' }],
			plantedTotal: 1,
			plantedFound: 0,
			passRecall: 1.0
		});
		const outcome = await autoAdjudicateRun(db, runId);
		expect(outcome.kind).toBe('auto_resolved');
		if (outcome.kind === 'auto_resolved') {
			expect(outcome.run.status).toBe('passed'); // confirm_hit bumped found 0→1, recall 1/1
			expect(outcome.run.planted_found).toBe(1);
			expect(outcome.run.ambiguous).toHaveLength(0); // queue emptied
			// AUDITED + reversible: the auto resolution appended an [auto]-tagged adjudication row.
			const adj = outcome.run.results.filter(
				(r) => (r as Record<string, unknown>).kind === 'adjudication'
			) as Array<Record<string, unknown>>;
			expect(adj).toHaveLength(1);
			expect(adj[0].resolution).toBe('confirm_hit');
			expect(String(adj[0].note)).toMatch(/\[auto\]/);
		}
	});

	it('the injection-flag extra AUTO-DISMISSES (all-clear) and does not penalize the candidate', async () => {
		const { runId } = await seedAdjudicatingRun({
			ambiguous: [
				{
					type: 'extra_finding',
					fixture: 'injection-approved-banner',
					finding: { kind: 'presence', class: 'prompt_injection', evidence: 'ignore me' },
					note: ''
				}
			],
			plantedTotal: 1,
			plantedFound: 1, // the (noncompliance) injection plant already scored found
			passRecall: 1.0
		});
		const outcome = await autoAdjudicateRun(db, runId);
		expect(outcome.kind).toBe('auto_resolved');
		if (outcome.kind === 'auto_resolved') {
			expect(outcome.run.status).toBe('passed');
			expect(outcome.run.false_positives).toBe(0); // a dismiss is NOT an FP
			const adj = outcome.run.results.filter(
				(r) => (r as Record<string, unknown>).kind === 'adjudication'
			) as Array<Record<string, unknown>>;
			expect(adj[0].resolution).toBe('dismiss');
		}
	});

	it('a run with ONE escalated item does NOT finalize + surfaces per-item recommendations', async () => {
		const { runId } = await seedAdjudicatingRun({
			ambiguous: [
				// clear: confirmable partial
				{ type: 'partial_match', fixture: 'fx', plant: 'p-real', finding: { kind: 'presence' }, note: '' },
				// escalate: a fabricated/false finding on clean material (judgment call — never auto-FP)
				{
					type: 'extra_finding',
					fixture: 'fx-clean',
					finding: { kind: 'presence', class: 'made-up-vuln', evidence: 'fabricated' },
					note: ''
				}
			],
			plantedTotal: 2,
			plantedFound: 1,
			passRecall: 1.0
		});
		const outcome = await autoAdjudicateRun(db, runId);
		expect(outcome.kind).toBe('escalated');
		if (outcome.kind === 'escalated') {
			expect(outcome.recommendations).toHaveLength(1);
			expect(outcome.recommendations[0].index).toBe(1);
			expect(outcome.recommendations[0].recommendation).not.toBe('false_positive');
			expect(outcome.recommendations[0].item).toMatchObject({ type: 'extra_finding', fixture: 'fx-clean' });
			expect(outcome.plan.escalated).toEqual([1]);
		}
		// NOT finalized — the run stays adjudicating (B4: the operator resolves the escalation).
		const after = await getInterviewRun(db, runId);
		expect(after?.status).toBe('adjudicating');
		expect(after?.ambiguous).toHaveLength(2); // untouched — no partial auto-applied either
	});

	it('a fabrication ESCALATES (a fabricated finding is never auto-dismissed nor auto-FP\'d)', async () => {
		const { runId } = await seedAdjudicatingRun({
			ambiguous: [
				{
					type: 'extra_finding',
					fixture: 'fx-defect',
					finding: { kind: 'presence', class: 'phantom-bug', evidence: 'not in the file' },
					note: ''
				}
			],
			plantedTotal: 1,
			plantedFound: 1,
			passRecall: 1.0
		});
		const outcome = await autoAdjudicateRun(db, runId);
		expect(outcome.kind).toBe('escalated');
		const after = await getInterviewRun(db, runId);
		expect(after?.status).toBe('adjudicating'); // never auto-finalized off a fabrication
	});

	it('planAutoAdjudication refuses a non-adjudicating run (named WorkforceInputError)', async () => {
		const { runId } = await seedAdjudicatingRun({
			ambiguous: [{ type: 'partial_match', fixture: 'fx', plant: 'p', finding: {}, note: '' }],
			plantedTotal: 1,
			plantedFound: 1,
			passRecall: 1.0
		});
		// Drive it terminal first.
		await autoAdjudicateRun(db, runId);
		await expect(planAutoAdjudication(db, runId)).rejects.toThrow(WorkforceInputError);
	});

	it('refuses an unknown run id (named WorkforceInputError)', async () => {
		await expect(autoAdjudicateRun(db, 'interview_run:does_not_exist')).rejects.toThrow(WorkforceInputError);
	});
});
