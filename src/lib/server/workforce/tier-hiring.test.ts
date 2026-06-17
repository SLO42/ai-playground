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
	getReviewProposal,
	getRole,
	listReviewProposalsForRole,
	type RoleRow,
	type RoleVersionRow,
	type Tier
} from './repo';
import {
	computeRecommendation,
	proposeTierChange,
	resolveTierChangeGate,
	swapTierChange,
	tierHiringGrid,
	TierGateError,
	TIER_ORDER,
	type TierGridCell,
	type TierModelResolver
} from './tier-hiring';
import { WorkforceInputError } from './repo';

// WORKFORCE-SPEC §7 TIER-AWARE HIRING — STRICT policy (LOCKED 2026-06-16), end-to-end vs a
// REAL throwaway SurrealDB. Certifies the FOUR data flows (happy + the three shadow paths:
// nil / empty / upstream-error) AND the STRICT integrity red-team:
//   • the grid is null-honest on uninterviewed/unmapped tiers (never a fake 0%);
//   • the recommendation fires ONLY on same-fixture_set_sha + both-passing + cheaper-wins,
//     and NOT when the cheaper tier is worse on recall/FP or the fixture sets mismatch;
//   • a tier_change proposal CANNOT be swapped without a passing run at (prompt_sha × target
//     model_id) — the strict gate blocks it; the swap needs the operator D-039 confirm;
//   • NO waiver path, NO auto-swap, NO inherited cert across tiers; cost from PRICED rows only.

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

// ── The tier→model resolver stub (deterministic; D-003 seam) ─────────────────────────
const MODELS: Record<Tier, { provider: string; model_id: string }> = {
	local: { provider: 'ollama', model_id: 'gpt-oss:20b' },
	haiku: { provider: 'claude', model_id: 'claude-haiku-x' },
	sonnet: { provider: 'claude', model_id: 'claude-sonnet-x' },
	opus: { provider: 'claude', model_id: 'claude-opus-x' }
};
const resolver: TierModelResolver = (tier) => MODELS[tier] ?? null;
/** A resolver that DROPS one tier (config gap) — for the unmapped-cell shadow path. */
function resolverWithout(drop: Tier): TierModelResolver {
	return (tier) => (tier === drop ? null : (MODELS[tier] ?? null));
}

let seq = 0;
async function seedRole(preferredTier?: Tier): Promise<{ role: RoleRow; version: RoleVersionRow }> {
	const n = ++seq;
	const role = await createRole(db, {
		slug: `tier-host-${n}`,
		name: `Tier Host ${n}`,
		purpose: 'tier-hiring test bed',
		...(preferredTier ? { preferred_tier: preferredTier } : {})
	});
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `methodology #${n}`,
		default_tier: 'opus',
		source: 'operator'
	});
	return { role, version };
}

/** Seed a finalized interview_run at a model with controlled recall/FP/fixture_set_sha. A
 *  draft version → 'interviewing' on first run (campaign), so the first run per version must
 *  be the certifying one; subsequent EVIDENCE runs are fine. */
async function seedRun(
	version: RoleVersionRow,
	opts: {
		tier: Tier;
		modelId: string;
		status: 'passed' | 'failed';
		plantedTotal: number;
		plantedFound: number;
		fp: number;
		fixtureSetSha: string;
		cost?: number;
	}
): Promise<string> {
	const run = await createInterviewRun(db, {
		role_version: version.id,
		tier: opts.tier,
		provider: 'claude',
		model_id: opts.modelId,
		fixture_set_sha: opts.fixtureSetSha,
		planted_total: opts.plantedTotal
	});
	const fin = await finalizeInterviewRun(db, run.id, {
		status: opts.status,
		planted_total: opts.plantedTotal,
		planted_found: opts.plantedFound,
		false_positives: opts.fp,
		...(opts.cost !== undefined ? { cost_usd: opts.cost } : {})
	});
	return fin.id;
}

describe('§7 tierHiringGrid — null-honest grid', () => {
	it('an uninterviewed version → every tier cell honest-empty (no fabricated 0%)', async () => {
		const { version } = await seedRole();
		const grid = await tierHiringGrid(db, version.id, resolver);
		expect(grid.cells).toHaveLength(TIER_ORDER.length);
		for (const c of grid.cells) {
			expect(c.gauntlet).toBeNull(); // no fabricated recall/FP
			expect(c.field).toBeNull();
			expect(c.deployable).toBe(false);
			expect(c.notDeployableReason).toBeTruthy();
			expect(c.modelId).toBe(MODELS[c.tier].model_id);
		}
		// No recommendation with zero passing tiers.
		expect(grid.recommendation.emit).toBe(false);
	});

	it('an UNMAPPED tier (config gap) → cell modelId null + named reason, never a guessed model', async () => {
		const { version } = await seedRole();
		const grid = await tierHiringGrid(db, version.id, resolverWithout('local'));
		const local = grid.cells.find((c) => c.tier === 'local')!;
		expect(local.modelId).toBeNull();
		expect(local.deployable).toBe(false);
		expect(local.notDeployableReason).toMatch(/not mapped/i);
		expect(local.gauntlet).toBeNull();
	});

	it('a passing run at sonnet → that cell deployable + recall/FP from REAL rows; others null', async () => {
		const { version } = await seedRole();
		await seedRun(version, {
			tier: 'sonnet',
			modelId: MODELS.sonnet.model_id,
			status: 'passed',
			plantedTotal: 4,
			plantedFound: 4,
			fp: 0,
			fixtureSetSha: 'sha-A',
			cost: 0.12
		});
		const grid = await tierHiringGrid(db, version.id, resolver);
		const sonnet = grid.cells.find((c) => c.tier === 'sonnet')!;
		expect(sonnet.deployable).toBe(true);
		expect(sonnet.gauntlet?.recall).toBe(1);
		expect(sonnet.gauntlet?.falsePositives).toBe(0);
		expect(sonnet.gauntlet?.costUsd).toBeCloseTo(0.12);
		expect(sonnet.gauntlet?.passedFixtureSetSha).toBe('sha-A');
		// opus never interviewed → null-honest, NOT deployable.
		const opus = grid.cells.find((c) => c.tier === 'opus')!;
		expect(opus.gauntlet).toBeNull();
		expect(opus.deployable).toBe(false);
	});

	it('cost is null when no run was priced (F-008 — never a dressed-up 0)', async () => {
		const { version } = await seedRole();
		await seedRun(version, {
			tier: 'sonnet',
			modelId: MODELS.sonnet.model_id,
			status: 'passed',
			plantedTotal: 2,
			plantedFound: 2,
			fp: 0,
			fixtureSetSha: 'sha-X'
			// no cost
		});
		const grid = await tierHiringGrid(db, version.id, resolver);
		const sonnet = grid.cells.find((c) => c.tier === 'sonnet')!;
		expect(sonnet.gauntlet?.costUsd).toBeNull();
	});

	it('throws for a missing version (a grid for a missing artifact is a caller bug)', async () => {
		await expect(tierHiringGrid(db, 'role_version:does_not_exist', resolver)).rejects.toThrow(
			WorkforceInputError
		);
	});
});

describe('§7 recommendation — STRICT (pure computeRecommendation)', () => {
	function cell(tier: Tier, over: Partial<TierGridCell['gauntlet']> & { sha: string | null }): TierGridCell {
		const g =
			over.sha === null && over.recall === undefined
				? null
				: {
						modelId: MODELS[tier].model_id,
						runs: 1,
						passed: 1,
						failed: 0,
						error: 0,
						adjudicating: 0,
						running: 0,
						recall: over.recall ?? 1,
						falsePositives: over.falsePositives ?? 0,
						costUsd: over.costUsd ?? null,
						stale: false,
						passedFixtureSetSha: over.sha,
						lastRunAt: '2026-06-16T00:00:00Z'
					};
		return {
			tier,
			modelId: MODELS[tier].model_id,
			deployable: true,
			notDeployableReason: null,
			current: false,
			gauntlet: g,
			field: null
		};
	}

	it('emits when cheaper tier matches dearer at SAME fixture_set_sha, ≥ recall + ≤ FP', () => {
		const r = computeRecommendation([
			cell('sonnet', { sha: 'sha-A', recall: 1, falsePositives: 0 }),
			cell('opus', { sha: 'sha-A', recall: 1, falsePositives: 0 })
		]);
		expect(r.emit).toBe(true);
		expect(r.cheaperTier).toBe('sonnet');
		expect(r.dearerTier).toBe('opus');
		expect(r.sentence).toMatch(/sonnet matches opus/i);
	});

	it('does NOT emit when fixture_set_sha differs (not apples-to-apples, F-008)', () => {
		const r = computeRecommendation([
			cell('sonnet', { sha: 'sha-A', recall: 1, falsePositives: 0 }),
			cell('opus', { sha: 'sha-B', recall: 1, falsePositives: 0 })
		]);
		expect(r.emit).toBe(false);
		expect(r.sentence).toBeNull();
		expect(r.reason).toMatch(/fixture_set_sha mismatch/i);
	});

	it('does NOT emit when cheaper tier has WORSE recall', () => {
		const r = computeRecommendation([
			cell('sonnet', { sha: 'sha-A', recall: 0.5, falsePositives: 0 }),
			cell('opus', { sha: 'sha-A', recall: 1, falsePositives: 0 })
		]);
		expect(r.emit).toBe(false);
		expect(r.reason).toMatch(/worse on recall or FP/i);
	});

	it('does NOT emit when cheaper tier has WORSE (higher) FP', () => {
		const r = computeRecommendation([
			cell('sonnet', { sha: 'sha-A', recall: 1, falsePositives: 2 }),
			cell('opus', { sha: 'sha-A', recall: 1, falsePositives: 0 })
		]);
		expect(r.emit).toBe(false);
		expect(r.reason).toMatch(/worse on recall or FP/i);
	});

	it('does NOT emit with fewer than two passing tiers', () => {
		const r = computeRecommendation([cell('sonnet', { sha: 'sha-A', recall: 1, falsePositives: 0 })]);
		expect(r.emit).toBe(false);
		expect(r.reason).toMatch(/fewer than two/i);
	});

	it('end-to-end via the grid: two passing tiers same sha → recommendation emits', async () => {
		const { version } = await seedRole();
		// First run certifies (campaign), then an evidence run at the cheaper tier.
		await seedRun(version, {
			tier: 'opus',
			modelId: MODELS.opus.model_id,
			status: 'passed',
			plantedTotal: 4,
			plantedFound: 4,
			fp: 0,
			fixtureSetSha: 'sha-SAME',
			cost: 0.5
		});
		await seedRun(version, {
			tier: 'sonnet',
			modelId: MODELS.sonnet.model_id,
			status: 'passed',
			plantedTotal: 4,
			plantedFound: 4,
			fp: 0,
			fixtureSetSha: 'sha-SAME',
			cost: 0.1
		});
		const grid = await tierHiringGrid(db, version.id, resolver);
		expect(grid.recommendation.emit).toBe(true);
		expect(grid.recommendation.cheaperTier).toBe('sonnet');
		expect(grid.recommendation.dearerTier).toBe('opus');
	});
});

describe('§7 STRICT tier_change proposal + gate + swap', () => {
	it('proposeTierChange opens a tier_change review_proposal citing grid evidence', async () => {
		const { role, version } = await seedRole('opus');
		const res = await proposeTierChange(
			db,
			{ roleVersion: version.id, targetTier: 'sonnet', note: 'cost saving' },
			resolver
		);
		expect(res.created).toBe(true);
		expect(res.proposal.kind).toBe('tier_change');
		expect(res.proposal.status).toBe('proposed');
		expect(res.proposal.trigger.target_tier).toBe('sonnet');
		expect(Array.isArray(res.proposal.trigger.grid_evidence)).toBe(true);
		// idempotent: a second propose returns the same open row (no duplicate).
		const again = await proposeTierChange(db, { roleVersion: version.id, targetTier: 'sonnet' }, resolver);
		expect(again.created).toBe(false);
		expect(again.proposal.id).toBe(res.proposal.id);
		const all = await listReviewProposalsForRole(db, role.id);
		expect(all.filter((p) => p.kind === 'tier_change').length).toBe(1);
	});

	it('rejects a proposal for the CURRENT tier (no change to propose)', async () => {
		const { version } = await seedRole('opus');
		await expect(
			proposeTierChange(db, { roleVersion: version.id, targetTier: 'opus' }, resolver)
		).rejects.toThrow(WorkforceInputError);
	});

	it('STRICT GATE: needs_interview when target tier has NO passing run; swap is REFUSED', async () => {
		const { version } = await seedRole('opus');
		// Certify ONLY at opus (current). Target sonnet has no run.
		await seedRun(version, {
			tier: 'opus',
			modelId: MODELS.opus.model_id,
			status: 'passed',
			plantedTotal: 2,
			plantedFound: 2,
			fp: 0,
			fixtureSetSha: 'sha-O'
		});
		const { proposal } = await proposeTierChange(
			db,
			{ roleVersion: version.id, targetTier: 'sonnet' },
			resolver
		);
		const gate = await resolveTierChangeGate(db, proposal.id, resolver);
		expect(gate.state).toBe('needs_interview');
		expect(gate.passingRunExists).toBe(false);
		expect(gate.message).toMatch(/needs a passing interview/i);
		// THE RED-TEAM: swap MUST be refused with no waiver.
		await expect(
			swapTierChange(db, { proposal: proposal.id, operatorConfirmed: true }, resolver)
		).rejects.toThrow(TierGateError);
	});

	it('STRICT GATE: a passing run at the TARGET model → ready_to_swap → operator swap succeeds', async () => {
		const { role, version } = await seedRole('opus');
		await seedRun(version, {
			tier: 'opus',
			modelId: MODELS.opus.model_id,
			status: 'passed',
			plantedTotal: 2,
			plantedFound: 2,
			fp: 0,
			fixtureSetSha: 'sha-O'
		});
		const { proposal } = await proposeTierChange(
			db,
			{ roleVersion: version.id, targetTier: 'sonnet' },
			resolver
		);
		// Now run a PASSING interview at the target (sonnet) model — the strict gate's only key.
		await seedRun(version, {
			tier: 'sonnet',
			modelId: MODELS.sonnet.model_id,
			status: 'passed',
			plantedTotal: 2,
			plantedFound: 2,
			fp: 0,
			fixtureSetSha: 'sha-S'
		});
		const gate = await resolveTierChangeGate(db, proposal.id, resolver);
		expect(gate.state).toBe('ready_to_swap');
		expect(gate.passingRunExists).toBe(true);
		expect(gate.certifiedBy).toBeTruthy();

		// THE RED-TEAM: no operator confirm → refused.
		await expect(
			swapTierChange(db, { proposal: proposal.id, operatorConfirmed: false }, resolver)
		).rejects.toThrow(TierGateError);

		// With the confirm → the swap moves role.preferred_tier + closes the proposal swapped.
		const res = await swapTierChange(db, { proposal: proposal.id, operatorConfirmed: true }, resolver);
		expect(res.tier).toBe('sonnet');
		expect(res.proposal.status).toBe('swapped');
		const after = await getRole(db, role.id);
		expect(after?.preferred_tier).toBe('sonnet');
		// active_version (the incumbent VERSION) is unchanged — only the operating tier moved.
		expect(after?.active_version).toBe(role.active_version);
		// A role_event{op:'tier_changed'} was appended (audit feed).
		const { StringRecordId } = await import('surrealdb');
		const [evs] = await db.query<[Array<{ op: string }>]>(
			`SELECT op FROM role_event WHERE role = $rid AND op = 'tier_changed';`,
			{ rid: new StringRecordId(role.id) }
		);
		expect((evs ?? []).length).toBeGreaterThanOrEqual(1);
	});

	it('swap is idempotent on an already-swapped proposal (interrupt contract)', async () => {
		const { version } = await seedRole('opus');
		await seedRun(version, {
			tier: 'sonnet',
			modelId: MODELS.sonnet.model_id,
			status: 'passed',
			plantedTotal: 1,
			plantedFound: 1,
			fp: 0,
			fixtureSetSha: 'sha-S2'
		});
		const { proposal } = await proposeTierChange(
			db,
			{ roleVersion: version.id, targetTier: 'sonnet' },
			resolver
		);
		await swapTierChange(db, { proposal: proposal.id, operatorConfirmed: true }, resolver);
		// Second call absorbs (no double-apply, no throw).
		const again = await swapTierChange(db, { proposal: proposal.id, operatorConfirmed: true }, resolver);
		expect(again.proposal.status).toBe('swapped');
		const fresh = await getReviewProposal(db, proposal.id);
		expect(fresh?.status).toBe('swapped');
	});

	it('STRICT: a FAILED run at the target does NOT unlock the swap (no laundering)', async () => {
		const { version } = await seedRole('opus');
		await seedRun(version, {
			tier: 'opus',
			modelId: MODELS.opus.model_id,
			status: 'passed',
			plantedTotal: 1,
			plantedFound: 1,
			fp: 0,
			fixtureSetSha: 'sha-O3'
		});
		const { proposal } = await proposeTierChange(
			db,
			{ roleVersion: version.id, targetTier: 'sonnet' },
			resolver
		);
		// A FAILED sonnet run — must NOT count.
		await seedRun(version, {
			tier: 'sonnet',
			modelId: MODELS.sonnet.model_id,
			status: 'failed',
			plantedTotal: 2,
			plantedFound: 1,
			fp: 1,
			fixtureSetSha: 'sha-S3'
		});
		const gate = await resolveTierChangeGate(db, proposal.id, resolver);
		expect(gate.state).toBe('needs_interview');
		await expect(
			swapTierChange(db, { proposal: proposal.id, operatorConfirmed: true }, resolver)
		).rejects.toThrow(TierGateError);
	});

	it('resolveTierChangeGate refuses a non-tier_change proposal (named error)', async () => {
		const { version } = await seedRole('opus');
		const { createReviewProposal } = await import('./repo');
		const p = await createReviewProposal(db, {
			role: version.role,
			kind: 'prompt_revision',
			incumbent: version.id
		});
		await expect(resolveTierChangeGate(db, p.id, resolver)).rejects.toThrow(WorkforceInputError);
	});
});
