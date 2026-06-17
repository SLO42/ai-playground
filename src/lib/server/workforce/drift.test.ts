import { StringRecordId } from 'surrealdb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import type { WorkforceConfig } from '../config/load';
import {
	addPanelVerdict,
	closePanelVerdictOutcome,
	createRole,
	createReviewProposal,
	createRoleVersion,
	getReviewProposal,
	listReviewProposalsForRole,
	swapActiveVersion,
	transitionLifecycle,
	type PanelOutcome,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import {
	autoRaiseForVersion,
	computeDriftSignals,
	evaluateDriftAndAutoRaise,
	type ObservedDriftEvent
} from './drift';

// WORKFORCE-SPEC §5 — drift detection + auto-raise (operator decision 4) VERIFY, against a
// REAL throwaway SurrealDB. Covers: the A1-derived confidence-miscalibration metric (windowed,
// claim-floor honest); escaped_defect/operator_feedback observed-event signals; IDEMPOTENT +
// BOUNDED auto-raise (one open proposal per (role,kind); cooldown after reject; dedup collision
// absorbed); the bounded fleet pass; the four shadow paths (missing version / no verdicts /
// below floor / disarmed); and the GOVERNANCE red-team (auto-raise can NEVER swap/mutate/author —
// it only creates a 'proposed' row; evidence is REAL cited rows; confidence stays OUT of cert).

let tdb: TestDb;
let db: Db;

const REVIEW_PROPOSAL_MIG = '0046_review_proposal';

/** Base config: miscalibration armed @ 0.5, window 14d, floor 5 (the shipped defaults). */
function cfg(over: Partial<WorkforceConfig['drift']> = {}, wfOver: Partial<WorkforceConfig['workforce']> = {}): WorkforceConfig {
	return {
		pm: { provider: 'claude', model_id: 'm', triggers: { failure_threshold: null } },
		panel: { scope: { max_files: null, max_new_services: null } },
		gauntlet: { pass_recall: 1.0, max_false_positives: 0, session_timeout_minutes: 15 },
		budget: { max_auto_interviews_per_day: null, allowed_auto_tiers: [] },
		drift: {
			escaped_defect: true,
			operator_feedback: true,
			confidence_miscalibration: true,
			confidence_miscalibration_rate: 0.5,
			refutation_rate: null,
			fixloop_rate: null,
			...over
		},
		research: { max_wall_clock_minutes: null, max_fetches: null },
		workforce: { max_open_proposals: 2, track_window_days: 14, min_events_for_claim: 5, ...wfOver }
	};
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
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied).toContain(REVIEW_PROPOSAL_MIG);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let seq = 0;
async function freshRole(prefix = 'drift-role'): Promise<RoleRow> {
	const slug = `${prefix}-${++seq}`;
	return createRole(db, { slug, name: `Role ${slug}`, purpose: 'test drift detection' });
}
async function freshVersion(roleId: string): Promise<RoleVersionRow> {
	return createRoleVersion(db, { role: roleId, prompt_core: `Review v${++seq}.`, default_tier: 'sonnet' });
}
/** Drive a fresh version draft → interviewing → passed and swap it in as the incumbent. */
async function makeIncumbent(roleId: string, version: RoleVersionRow): Promise<void> {
	await transitionLifecycle(db, version.id, 'interviewing');
	await transitionLifecycle(db, version.id, 'passed');
	await swapActiveVersion(db, roleId, version.id);
}

let sessSeq = 0;
async function freshSession(): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('session', $id) CONTENT
		   { kind: 'review', model: { provider: 'claude', model_id: 'claude-test' } } RETURN id;`,
		{ id: `drift_sess_${++sessSeq}` }
	);
	return String(rows[0].id);
}

/**
 * Seed ONE closed panel_verdict naming `version` as a catalog-role validator, with the
 * given confidence + closed outcome, and force its `at` to `atDate` (windowing). Returns
 * the verdict id (a REAL row the evidence assertions check against).
 */
async function seedVerdict(
	role: string,
	version: string,
	confidence: 'low' | 'medium' | 'high',
	outcome: PanelOutcome | null,
	atDate: Date
): Promise<string> {
	const artifact = await freshSession(); // any record target works as the artifact
	const v = await addPanelVerdict(db, {
		artifact,
		artifact_kind: 'task',
		validator_session: await freshSession(),
		validator_kind: 'catalog_role',
		role,
		role_version: version,
		verdict: 'pushback',
		confidence
	});
	if (outcome) await closePanelVerdictOutcome(db, v.id, outcome);
	// Force `at` for windowing (the only mutation a test needs; product code never does this).
	await db.query(`UPDATE $rid SET at = $at;`, { rid: new StringRecordId(v.id), at: atDate });
	return v.id;
}

const NOW = new Date('2026-06-16T12:00:00Z');
const now = () => NOW;
const recent = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000);

beforeEach(() => {
	// each test uses fresh roles/versions (seq-namespaced) — no shared mutable state
});

// ── confidence-miscalibration metric (A1) ──────────────────────────────────────────

describe('computeDriftSignals — confidence-miscalibration (A1)', () => {
	it('fires when high-confidence-wrong rate ≥ threshold over ≥ floor closed verdicts', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		// 6 high-confidence closed verdicts in window: 4 wrong (overridden/revised), 2 upheld → 4/6 ≈ 0.667 ≥ 0.5.
		const wrongIds: string[] = [];
		for (let i = 0; i < 3; i++) wrongIds.push(await seedVerdict(role.id, version.id, 'high', 'overridden_by_operator', recent(2)));
		wrongIds.push(await seedVerdict(role.id, version.id, 'high', 'revised', recent(3)));
		await seedVerdict(role.id, version.id, 'high', 'upheld', recent(4));
		await seedVerdict(role.id, version.id, 'high', 'upheld', recent(5));

		const report = await computeDriftSignals(db, version.id, cfg(), { now });
		const sig = report.signals.find((s) => s.signal === 'confidence_miscalibration')!;
		expect(sig.armed).toBe(true);
		expect(sig.events).toBe(6);
		expect(sig.value).toBeCloseTo(4 / 6, 5);
		expect(sig.fired).toBe(true);
		// Evidence = the REAL wrong-verdict row ids (F-008) — never fabricated.
		expect(sig.evidence.sort()).toEqual(wrongIds.sort());
	});

	it('does NOT fire below threshold (rate < 0.5)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		// 5 closed: 2 wrong, 3 upheld → 0.4 < 0.5.
		await seedVerdict(role.id, version.id, 'high', 'overridden_by_operator', recent(1));
		await seedVerdict(role.id, version.id, 'high', 'revised', recent(1));
		for (let i = 0; i < 3; i++) await seedVerdict(role.id, version.id, 'high', 'upheld', recent(1));
		const report = await computeDriftSignals(db, version.id, cfg(), { now });
		const sig = report.signals.find((s) => s.signal === 'confidence_miscalibration')!;
		expect(sig.value).toBeCloseTo(0.4, 5);
		expect(sig.fired).toBe(false);
		expect(sig.reason).toContain('< 0.5');
	});

	it('SHADOW (below floor): 4 wrong-of-4 (rate 1.0) but < min_events → null-honest, not raised', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		for (let i = 0; i < 4; i++) await seedVerdict(role.id, version.id, 'high', 'overridden_by_operator', recent(1));
		const report = await computeDriftSignals(db, version.id, cfg(), { now });
		const sig = report.signals.find((s) => s.signal === 'confidence_miscalibration')!;
		expect(sig.events).toBe(4);
		expect(sig.value).toBe(1); // rate is honest…
		expect(sig.fired).toBe(false); // …but below the floor it does NOT fire
		expect(sig.reason).toContain('below claim floor');
	});

	it('SHADOW (no qualifying verdicts): rate is null (never a 0/0 → 0)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		// Only LOW/MEDIUM confidence + an OPEN high verdict (no closed outcome) → denominator 0.
		await seedVerdict(role.id, version.id, 'low', 'overridden_by_operator', recent(1));
		await seedVerdict(role.id, version.id, 'high', null, recent(1));
		const report = await computeDriftSignals(db, version.id, cfg(), { now });
		const sig = report.signals.find((s) => s.signal === 'confidence_miscalibration')!;
		expect(sig.value).toBeNull();
		expect(sig.events).toBe(0);
		expect(sig.fired).toBe(false);
	});

	it('windows OUT verdicts older than track_window_days', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		// 5 wrong INSIDE window + 5 wrong OUTSIDE (20 days ago) → only the 5 inside count.
		for (let i = 0; i < 5; i++) await seedVerdict(role.id, version.id, 'high', 'overridden_by_operator', recent(2));
		for (let i = 0; i < 5; i++) await seedVerdict(role.id, version.id, 'high', 'overridden_by_operator', recent(20));
		const report = await computeDriftSignals(db, version.id, cfg(), { now });
		const sig = report.signals.find((s) => s.signal === 'confidence_miscalibration')!;
		expect(sig.events).toBe(5); // the 20-day-old rows are windowed out
		expect(sig.value).toBe(1);
		expect(sig.fired).toBe(true);
	});

	it('a withdrawn outcome counts as NEITHER right nor wrong (excluded from rate)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		// 5 wrong + 5 withdrawn → denominator = 5 (withdrawn excluded), rate 1.0.
		for (let i = 0; i < 5; i++) await seedVerdict(role.id, version.id, 'high', 'overridden_by_operator', recent(1));
		for (let i = 0; i < 5; i++) await seedVerdict(role.id, version.id, 'high', 'withdrawn', recent(1));
		const report = await computeDriftSignals(db, version.id, cfg(), { now });
		const sig = report.signals.find((s) => s.signal === 'confidence_miscalibration')!;
		expect(sig.events).toBe(5);
		expect(sig.value).toBe(1);
	});

	it('SHADOW (disarmed): bool false → never fires even with a 1.0 rate over floor', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		for (let i = 0; i < 6; i++) await seedVerdict(role.id, version.id, 'high', 'overridden_by_operator', recent(1));
		const report = await computeDriftSignals(db, version.id, cfg({ confidence_miscalibration: false }), { now });
		const sig = report.signals.find((s) => s.signal === 'confidence_miscalibration')!;
		expect(sig.armed).toBe(false);
		expect(sig.fired).toBe(false);
		expect(sig.reason).toContain('disarmed');
	});

	it('SHADOW (rate unarmed null): surfaces the metric but never fires', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		for (let i = 0; i < 6; i++) await seedVerdict(role.id, version.id, 'high', 'overridden_by_operator', recent(1));
		const report = await computeDriftSignals(db, version.id, cfg({ confidence_miscalibration_rate: null }), { now });
		const sig = report.signals.find((s) => s.signal === 'confidence_miscalibration')!;
		expect(sig.value).toBe(1); // still surfaced honestly
		expect(sig.threshold).toBeNull();
		expect(sig.fired).toBe(false);
		expect(sig.reason).toContain('unarmed');
	});

	it('refutation/fixloop render LITERALLY null (needs B2 — no placeholder math, F-008)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		const report = await computeDriftSignals(db, version.id, cfg(), { now });
		expect(report.preB2.refutation_rate).toBeNull();
		expect(report.preB2.fixloop_rate).toBeNull();
	});

	it('SHADOW (nil input): a missing version throws WorkforceInputError, not an empty report', async () => {
		await expect(computeDriftSignals(db, 'role_version:does_not_exist', cfg(), { now })).rejects.toThrow(
			/role_version not found/
		);
	});
});

// ── escaped_defect / operator_feedback observed-event signals ──────────────────────

describe('computeDriftSignals — escaped_defect / operator_feedback', () => {
	it('fires from an explicit observed event with REAL evidence', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		const evidenceRow = await freshSession();
		const observed: ObservedDriftEvent[] = [
			{ roleVersion: version.id, signal: 'escaped_defect', evidence: [evidenceRow] }
		];
		const report = await computeDriftSignals(db, version.id, cfg(), { now, observed });
		const sig = report.signals.find((s) => s.signal === 'escaped_defect')!;
		expect(sig.fired).toBe(true);
		expect(sig.evidence).toEqual([evidenceRow]);
	});

	it('SHADOW (no event): armed but unobserved → honestly not fired (never invented)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		const report = await computeDriftSignals(db, version.id, cfg(), { now });
		const op = report.signals.find((s) => s.signal === 'operator_feedback')!;
		expect(op.armed).toBe(true);
		expect(op.fired).toBe(false);
		expect(op.evidence).toEqual([]);
	});

	it('disarmed signal never fires even with an observed event', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		const observed: ObservedDriftEvent[] = [
			{ roleVersion: version.id, signal: 'operator_feedback', evidence: [await freshSession()] }
		];
		const report = await computeDriftSignals(db, version.id, cfg({ operator_feedback: false }), { now, observed });
		const sig = report.signals.find((s) => s.signal === 'operator_feedback')!;
		expect(sig.armed).toBe(false);
		expect(sig.fired).toBe(false);
	});

	it('an observed event for a DIFFERENT version is not attributed here', async () => {
		const role = await freshRole();
		const a = await freshVersion(role.id);
		const b = await freshVersion(role.id);
		const observed: ObservedDriftEvent[] = [
			{ roleVersion: b.id, signal: 'escaped_defect', evidence: [await freshSession()] }
		];
		const report = await computeDriftSignals(db, a.id, cfg(), { now, observed });
		const sig = report.signals.find((s) => s.signal === 'escaped_defect')!;
		expect(sig.fired).toBe(false);
	});
});

// ── auto-raise: idempotency + cap + cooldown ───────────────────────────────────────

async function seedMiscalibrated(role: string, version: string, n = 6): Promise<void> {
	for (let i = 0; i < n; i++) await seedVerdict(role, version, 'high', 'overridden_by_operator', recent(1));
}

describe('autoRaiseForVersion — idempotent + bounded', () => {
	it('a fired miscalibration signal raises EXACTLY ONE proposed review_proposal', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now });
		const miscal = raises.find((r) => r.signal === 'confidence_miscalibration')!;
		expect(miscal.disposition).toBe('raised');
		expect(miscal.proposal!.status).toBe('proposed');
		expect(miscal.proposal!.kind).toBe('prompt_revision');
		expect(miscal.proposal!.incumbent).toBe(version.id);
		// The trigger carries the signal + REAL evidence (F-008) + a config snapshot.
		expect(miscal.proposal!.trigger.signal).toBe('confidence_miscalibration');
		expect((miscal.proposal!.trigger.evidence as string[]).length).toBe(6);
		const props = await listReviewProposalsForRole(db, role.id);
		expect(props.filter((p) => p.kind === 'prompt_revision' && p.status === 'proposed')).toHaveLength(1);
	});

	it('a SECOND evaluation tick does NOT duplicate (open_exists — idempotent)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		await autoRaiseForVersion(db, version.id, cfg(), { now });
		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now });
		const miscal = raises.find((r) => r.signal === 'confidence_miscalibration')!;
		expect(miscal.disposition).toBe('open_exists');
		const props = await listReviewProposalsForRole(db, role.id);
		expect(props.filter((p) => p.kind === 'prompt_revision')).toHaveLength(1); // STILL one
	});

	it('a PRE-EXISTING open proposal at the dedup fingerprint blocks the auto-raise (open_exists)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		// An operator-initiated open proposal already stands at (role|prompt_revision|incumbent).
		const existing = await createReviewProposal(db, {
			role: role.id,
			kind: 'prompt_revision',
			incumbent: version.id,
			trigger: { signal: 'manual' }
		});
		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now });
		const miscal = raises.find((r) => r.signal === 'confidence_miscalibration')!;
		// The drift signal FIRED but the auto-raise deferred to the standing proposal (no dup).
		expect(miscal.disposition).toBe('open_exists');
		expect(miscal.proposal!.id).toBe(existing.id);
		const props = await listReviewProposalsForRole(db, role.id);
		expect(props.filter((p) => p.kind === 'prompt_revision')).toHaveLength(1);
	});

	it('a REJECTED proposal holds the slot during cooldown (does not re-raise)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		// Open then REJECT (operator) a proposal, decided 1 day ago — inside a 14-day cooldown.
		const p = await createReviewProposal(db, { role: role.id, kind: 'prompt_revision', incumbent: version.id });
		await db.query(`UPDATE $rid SET status = 'rejected_by_operator', decided_at = $at;`, {
			rid: new StringRecordId(p.id),
			at: recent(1)
		});
		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now });
		const miscal = raises.find((r) => r.signal === 'confidence_miscalibration')!;
		expect(miscal.disposition).toBe('cooldown');
		const props = await listReviewProposalsForRole(db, role.id);
		expect(props.filter((p2) => p2.status === 'proposed')).toHaveLength(0); // no new raise
	});

	it('after the cooldown elapses, a persistent drift may re-raise', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		const p = await createReviewProposal(db, { role: role.id, kind: 'prompt_revision', incumbent: version.id });
		// Rejected 20 days ago — OUTSIDE the 14-day cooldown.
		await db.query(`UPDATE $rid SET status = 'rejected_by_operator', decided_at = $at;`, {
			rid: new StringRecordId(p.id),
			at: recent(20)
		});
		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now });
		const miscal = raises.find((r) => r.signal === 'confidence_miscalibration')!;
		expect(miscal.disposition).toBe('raised');
	});

	it('TWO same-kind signals firing in ONE pass raise EXACTLY ONE proposal (in-pass anti-spam)', async () => {
		// REGRESSION (red-team gap #1): confidence_miscalibration AND an observed escaped_defect
		// both map to kind 'prompt_revision' (SIGNAL_KIND). They share the IDENTICAL dedup
		// fingerprint role|prompt_revision|incumbent. Before the fix, `existing` was a snapshot
		// read ONCE before the loop, so the second signal never saw the row the first created →
		// a DUPLICATE 'proposed' row (the §5 anti-spam invariant violated; no DB UNIQUE backstop).
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id); // miscalibration fires
		const observed: ObservedDriftEvent[] = [
			{ roleVersion: version.id, signal: 'escaped_defect', evidence: [await freshSession()] }
		];
		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now, observed });
		// Both signals fired; exactly ONE created a row, the second collapsed to open_exists.
		const dispositions = raises.map((r) => r.disposition).sort();
		const raisedCount = raises.filter((r) => r.disposition === 'raised').length;
		const openExistsCount = raises.filter((r) => r.disposition === 'open_exists').length;
		expect(raisedCount).toBe(1);
		expect(openExistsCount).toBe(1);
		// And the DB carries exactly ONE proposed prompt_revision row (no duplicate fingerprint).
		const props = await listReviewProposalsForRole(db, role.id);
		expect(props.filter((p) => p.kind === 'prompt_revision' && p.status === 'proposed')).toHaveLength(1);
		expect(dispositions).toContain('raised');
		expect(dispositions).toContain('open_exists');
	});

	it('SHADOW (no drift): a healthy version raises nothing (not_fired)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		// 6 upheld high-confidence verdicts → rate 0 → no signal.
		for (let i = 0; i < 6; i++) await seedVerdict(role.id, version.id, 'high', 'upheld', recent(1));
		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now });
		expect(raises.every((r) => r.disposition === 'not_fired')).toBe(true);
		expect(await listReviewProposalsForRole(db, role.id)).toHaveLength(0);
	});
});

// ── bounded fleet pass + wiring entry point ────────────────────────────────────────

describe('evaluateDriftAndAutoRaise — the bounded fleet pass', () => {
	it('evaluates ACTIVE incumbents only and raises for the drifting one', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		// Make it the active incumbent (the only version the pass evaluates).
		await makeIncumbent(role.id, version);
		const res = await evaluateDriftAndAutoRaise(db, cfg(), { now });
		expect(res.evaluated).toBeGreaterThanOrEqual(1);
		expect(res.raised).toBeGreaterThanOrEqual(1);
		const props = await listReviewProposalsForRole(db, role.id);
		expect(props.filter((p) => p.status === 'proposed')).toHaveLength(1);
	});

	it('is idempotent across two fleet passes (no proposal storm under persistent drift)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		await makeIncumbent(role.id, version);
		await evaluateDriftAndAutoRaise(db, cfg(), { now });
		const second = await evaluateDriftAndAutoRaise(db, cfg(), { now });
		// The drifting role contributes 0 NEW raises on the second pass.
		const mine = second.details.find((d) => d.roleVersion === version.id)!;
		expect(mine.raises.find((r) => r.signal === 'confidence_miscalibration')!.disposition).toBe('open_exists');
		const props = await listReviewProposalsForRole(db, role.id);
		expect(props.filter((p) => p.kind === 'prompt_revision')).toHaveLength(1);
	});

	it('a role with NO active_version is skipped honestly (not deployable → no drift)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		// NOT swapped in → active_version is NONE.
		const res = await evaluateDriftAndAutoRaise(db, cfg(), { now });
		expect(res.details.some((d) => d.roleVersion === version.id)).toBe(false);
		expect(await listReviewProposalsForRole(db, role.id)).toHaveLength(0);
	});
});

// ── GOVERNANCE red-team (the locked decision-4 invariants) ─────────────────────────

describe('GOVERNANCE — auto-raise can NEVER swap / mutate / author (D-010/D-039)', () => {
	it('the ONLY mutation is a fresh proposed review_proposal — role/version untouched', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		await makeIncumbent(role.id, version);

		const beforeRole = (await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(role.id)
		}))[0][0];
		const beforeVersion = (await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(version.id)
		}))[0][0];

		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now });
		const raised = raises.find((r) => r.disposition === 'raised')!;

		// 1. The created row is status='proposed' with NO challenger (never auto-authored).
		const prop = await getReviewProposal(db, raised.proposal!.id);
		expect(prop!.status).toBe('proposed');
		expect(prop!.challenger).toBeNull();

		// 2. The role row is byte-identical (active_version NOT moved, no swap).
		const afterRole = (await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(role.id)
		}))[0][0];
		expect(String(afterRole.active_version)).toBe(String(beforeRole.active_version));
		expect(String(afterRole.updated_at)).toBe(String(beforeRole.updated_at));

		// 3. The version row is unchanged (no lifecycle move, no prompt mutation).
		const afterVersion = (await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(version.id)
		}))[0][0];
		expect(afterVersion.lifecycle).toBe(beforeVersion.lifecycle);
		expect(afterVersion.prompt_sha).toBe(beforeVersion.prompt_sha);
		expect(afterVersion.prompt_core).toBe(beforeVersion.prompt_core);
	});

	it('no role_version row is ever CREATED by an auto-raise (no challenger drafted)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		const before = (await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM role_version WHERE role = $role GROUP ALL;`,
			{ role: new StringRecordId(role.id) }
		))[0][0]?.c ?? 0;
		await autoRaiseForVersion(db, version.id, cfg(), { now });
		const after = (await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM role_version WHERE role = $role GROUP ALL;`,
			{ role: new StringRecordId(role.id) }
		))[0][0]?.c ?? 0;
		expect(after).toBe(before); // no challenger version materialized
	});

	it('the trigger evidence is REAL cited rows that exist in panel_verdict (no fabricated drift)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await seedMiscalibrated(role.id, version.id);
		const { raises } = await autoRaiseForVersion(db, version.id, cfg(), { now });
		const evidence = raises.find((r) => r.disposition === 'raised')!.proposal!.trigger.evidence as string[];
		expect(evidence.length).toBeGreaterThan(0);
		for (const id of evidence) {
			const [rows] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM $rid;`, {
				rid: new StringRecordId(id)
			});
			expect(rows).toHaveLength(1); // every cited id is a real, existing panel_verdict
		}
	});
});
