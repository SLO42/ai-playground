import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StringRecordId } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	addPanelVerdict,
	createInterviewRun,
	createRole,
	createRoleVersion,
	finalizeInterviewRun,
	createGauntletFixture,
	swapActiveVersion,
	transitionLifecycle,
	withdrawRoleVersion
} from './repo';
import { loadWorkforcePanel } from './panel';
import { newSentinelUlid } from './activation';
import { raiseHireBrief, applyHireDecision, recordPmFitVerdict } from './recruiter-hire';

// TASK 16.7b VERIFY — the read-only workforce-panel aggregator (WORKFORCE-SPEC §8) against
// a REAL throwaway SurrealDB. The FOUR data paths the §8 surfaces depend on:
//   happy   — a certified role with a passing run + verdicts → deployable card + line;
//   nil     — a role with NO version → 'no version', NOT DEPLOYABLE, null track;
//   empty   — a draft role with NO interviews → 'not yet interviewed', honest empties;
//   error   — a role whose latest terminal run is status='error' → the error line.
// Plus the §3.4 adjudication queue (an 'adjudicating' run surfaces with its items).

let tdb: TestDb;
let db: Db;

const MODEL = 'claude-sonnet-test-1';

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
	expect(applied).toContain('0031_workforce');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let seq = 0;
const nextSlug = (p: string) => `${p}-${++seq}`;

function cardFor(panel: Awaited<ReturnType<typeof loadWorkforcePanel>>, slug: string) {
	const c = panel.roles.find((r) => r.slug === slug);
	if (!c) throw new Error(`no card for ${slug}`);
	return c;
}

describe('loadWorkforcePanel — §8 surfaces', () => {
	it('empty workforce: zero roles → empty arrays, allCertified false (honest, no throw)', async () => {
		// Before any role exists this is the literal day-0 state.
		const panel = await loadWorkforcePanel(db);
		// (other suites may have seeded rows; assert the SHAPE not the emptiness here)
		expect(Array.isArray(panel.roles)).toBe(true);
		expect(Array.isArray(panel.adjudication)).toBe(true);
		expect(Array.isArray(panel.hireQueue)).toBe(true); // HR-5 hire queue is always an array
		expect(typeof panel.allCertified).toBe('boolean');
	});

	it("NIL path: a role with no version → 'no version', NOT DEPLOYABLE, null track", async () => {
		const slug = nextSlug('nilrole');
		await createRole(db, { slug, name: slug, purpose: 'nil-version case' });
		const card = cardFor(await loadWorkforcePanel(db), slug);
		expect(card.version).toBeNull();
		expect(card.roleVersion).toBeNull();
		expect(card.deployable).toBe(false);
		expect(card.notDeployableReason).toBe('no version');
		expect(card.interview).toBeNull();
		expect(card.track).toBeNull();
		expect(card.interviewRuns).toBe(0);
	});

	it("EMPTY path: a draft version with no interviews → 'not yet interviewed', null-honest track", async () => {
		const slug = nextSlug('draftrole');
		const role = await createRole(db, { slug, name: slug, purpose: 'never interviewed' });
		await createRoleVersion(db, { role: role.id, prompt_core: 'draft core', default_tier: 'sonnet' });
		const card = cardFor(await loadWorkforcePanel(db), slug);
		expect(card.version).toBe(1);
		expect(card.lifecycle).toBe('draft');
		expect(card.deployable).toBe(false);
		expect(card.notDeployableReason).toBe('not yet interviewed');
		expect(card.interview).toBeNull();
		// Track exists (version exists) but every plane is honest-empty.
		expect(card.track).not.toBeNull();
		expect(card.track?.interviews).toEqual([]);
		expect(card.track?.panel.total).toBe(0);
		expect(card.track?.field.costUsd).toBeNull();
		// Pre-B2 metrics are literally null.
		expect(card.track?.refutationRate).toBeNull();
		expect(card.poolGeneration).toBeNull();
	});

	it('HAPPY path: a passing run + a verdict → deployable card, real interview line, model_id from the row', async () => {
		const slug = nextSlug('certrole');
		const role = await createRole(db, { slug, name: slug, purpose: 'certified' });
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'cert core',
			default_tier: 'sonnet'
		});
		const run = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'sonnet',
			provider: 'claude',
			model_id: MODEL,
			fixture_set_sha: 'fsha-happy'
		});
		await finalizeInterviewRun(db, run.id, {
			status: 'passed',
			planted_total: 4,
			planted_found: 4,
			false_positives: 0,
			cost_usd: 0.12
		});
		// A panel verdict naming this version (track-record source).
		const valSession = (
			await db.query<[Array<{ id: unknown }>]>(
				`CREATE session CONTENT {
					kind: 'review',
					model: { provider: 'claude', model_id: $m },
					status: 'done'
				} RETURN id;`,
				{ m: MODEL }
			)
		)[0][0].id;
		await addPanelVerdict(db, {
			artifact: v.id,
			artifact_kind: 'review_proposal',
			validator_session: String(valSession),
			verdict: 'approve',
			reasons: ['fit'],
			role: role.id,
			role_version: v.id
		});
		// Make it the incumbent (active_version) — purely informational for the card.
		await swapActiveVersion(db, role.id, v.id);

		const card = cardFor(await loadWorkforcePanel(db), slug);
		expect(card.deployable).toBe(true);
		expect(card.notDeployableReason).toBeNull();
		expect(card.interview).not.toBeNull();
		expect(card.interview?.status).toBe('passed');
		expect(card.interview?.plantedFound).toBe(4);
		expect(card.interview?.plantedTotal).toBe(4);
		expect(card.interview?.falsePositives).toBe(0);
		// model_id is the REAL run value, never hardcoded.
		expect(card.interview?.modelId).toBe(MODEL);
		expect(card.interview?.run).toBe(run.id);
		// Track record reflects the verdict.
		expect(card.track?.panel.total).toBe(1);
		expect(card.track?.panel.approve).toBe(1);
		// Recall cell from the real run.
		expect(card.track?.interviews.find((c) => c.model_id === MODEL)?.recall).toBe(1);
	});

	it('ERROR path: latest terminal run is status=error → the error line carries the named reason', async () => {
		const slug = nextSlug('errrole');
		const role = await createRole(db, { slug, name: slug, purpose: 'env error' });
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'err core',
			default_tier: 'haiku'
		});
		const run = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'haiku',
			provider: 'claude',
			model_id: 'claude-haiku-test-1',
			fixture_set_sha: 'fsha-err'
		});
		await finalizeInterviewRun(db, run.id, { status: 'error', error_reason: 'env_timeout' });
		const card = cardFor(await loadWorkforcePanel(db), slug);
		expect(card.deployable).toBe(false);
		expect(card.interview?.status).toBe('error');
		expect(card.interview?.errorReason).toBe('env_timeout');
		// An errored run is not a pass → still 'not yet interviewed' deployability reason.
		expect(card.notDeployableReason).toBe('not yet interviewed');
	});

	it('STALE-ERROR fix: older error + NEWER adjudicating run → line reflects the NEWER run, deployability unchanged', async () => {
		// Operator scenario: a role had old failing runs (status='error', scorer_error) from
		// before a fix, then a NEWER successful run that is status='adjudicating' (found 5/5).
		// The card must headline the LATEST run (adjudicating), NOT the stale error.
		const slug = nextSlug('stalerole');
		const role = await createRole(db, { slug, name: slug, purpose: 'stale-error masking' });
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'stale core',
			default_tier: 'sonnet'
		});
		// OLDER run → error (scorer_error), explicitly stamped earlier so ordering is deterministic.
		const errRun = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'sonnet',
			provider: 'claude',
			model_id: MODEL,
			fixture_set_sha: 'fsha-stale-err'
		});
		await finalizeInterviewRun(db, errRun.id, { status: 'error', error_reason: 'scorer_error' });
		await db.query(`UPDATE $rid SET started_at = d'2026-06-14T00:00:00Z';`, {
			rid: new StringRecordId(errRun.id)
		});
		// NEWER run → adjudicating (found 5/5), stamped later → it is runs[0] (newest-first).
		const adjRun = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'sonnet',
			provider: 'claude',
			model_id: MODEL,
			fixture_set_sha: 'fsha-stale-adj'
		});
		await finalizeInterviewRun(db, adjRun.id, {
			status: 'adjudicating',
			planted_total: 5,
			planted_found: 5,
			ambiguous: [{ type: 'partial_match', plant: 'p1', fixture: 'fx-a', file: 'a.ts', lines: '10' }]
		});
		await db.query(`UPDATE $rid SET started_at = d'2026-06-15T00:00:00Z';`, {
			rid: new StringRecordId(adjRun.id)
		});

		const card = cardFor(await loadWorkforcePanel(db), slug);
		// The line reflects the NEWER adjudicating run — NOT the stale error.
		expect(card.interview?.status).toBe('adjudicating');
		expect(card.interview?.run).toBe(adjRun.id);
		expect(card.interview?.errorReason).toBeNull();
		expect(card.interview?.plantedFound).toBe(5);
		expect(card.interview?.plantedTotal).toBe(5);
		// Deployability is UNCHANGED: an adjudicating run is not a pass → still not deployable.
		expect(card.deployable).toBe(false);
		expect(card.notDeployableReason).toBe('not yet interviewed');
		// Both runs still counted for sample-size context.
		expect(card.interviewRuns).toBe(2);
	});

	it('RUNNING latest run surfaces as running (in-progress), not deployable', async () => {
		const slug = nextSlug('runningrole');
		const role = await createRole(db, { slug, name: slug, purpose: 'in-flight run' });
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'running core',
			default_tier: 'haiku'
		});
		// A run left in flight (never finalized) stays status='running'.
		const run = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'haiku',
			provider: 'claude',
			model_id: 'claude-haiku-test-1',
			fixture_set_sha: 'fsha-running'
		});
		const card = cardFor(await loadWorkforcePanel(db), slug);
		expect(card.interview?.status).toBe('running');
		expect(card.interview?.run).toBe(run.id);
		expect(card.deployable).toBe(false);
		expect(card.notDeployableReason).toBe('not yet interviewed');
	});

	it('§3.4 adjudication queue: an adjudicating run surfaces with its ambiguous items', async () => {
		const slug = nextSlug('adjrole');
		const role = await createRole(db, { slug, name: slug, purpose: 'adjudication' });
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'adj core',
			default_tier: 'sonnet'
		});
		const run = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'sonnet',
			provider: 'claude',
			model_id: MODEL,
			fixture_set_sha: 'fsha-adj'
		});
		await finalizeInterviewRun(db, run.id, {
			status: 'adjudicating',
			planted_total: 3,
			planted_found: 2,
			ambiguous: [
				{ type: 'partial_match', plant: 'p1', fixture: 'fx-a', file: 'a.ts', lines: '10' },
				{ type: 'unexpected_on_clean', fixture: 'fx-b', file: 'b.ts' }
			]
		});
		const panel = await loadWorkforcePanel(db);
		const adj = panel.adjudication.find((a) => a.run === run.id);
		expect(adj).toBeDefined();
		expect(adj?.roleSlug).toBe(slug);
		expect(adj?.modelId).toBe(MODEL);
		expect(adj?.plantedTotal).toBe(3);
		expect(adj?.ambiguous).toHaveLength(2);
		expect(adj?.ambiguous[0].type).toBe('partial_match');
	});

	it('HR-5 hire queue: an OPEN cert_hire brief surfaces (verbatim §8 fields); a DECIDED one drops off', async () => {
		const slug = nextSlug('hirerole');
		const role = await createRole(db, { slug, name: slug, purpose: 'hire-queue surface' });
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'hire core',
			default_tier: 'sonnet'
		});
		const run = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'sonnet',
			provider: 'claude',
			model_id: MODEL,
			fixture_set_sha: 'fsha-hire'
		});
		// A PASSING terminal run → the recruiter raises a HIRE-recommended cert_hire brief.
		await finalizeInterviewRun(db, run.id, {
			status: 'passed',
			planted_total: 2,
			planted_found: 2,
			false_positives: 0,
			results: [{ fixture: slug, kind: 'planted_defect', found: ['p1', 'p2'], missed: [] }]
		});
		const brief = await raiseHireBrief(db, run.id);

		// The OPEN brief surfaces on the hire queue with its §8 fields VERBATIM (B3 read-only).
		const card = (await loadWorkforcePanel(db)).hireQueue.find((h) => h.brief === brief.id);
		expect(card).toBeDefined();
		expect(card?.run).toBe(run.id);
		expect(card?.recommendation).toBe('hire'); // a passing run recommends HIRE
		expect(card?.ask).toMatch(/hire/i);
		expect(card?.evidence.length).toBeGreaterThanOrEqual(2);
		expect(card?.evidence).toContain(run.id); // the candidate run is an evidence link
		expect(card?.falsifier.trim().length).toBeGreaterThan(0);
		// Exactly one recommended option (the §8 invariant) flows through to the card.
		expect(card?.options.filter((o) => o.recommended)).toHaveLength(1);
		// Gap D - no PM fit-verdict yet -> honest null (F-008, never a fabricated approve).
		expect(card?.fitVerdict).toBeNull();

		// Gap D - record a PM fit-verdict; the card now surfaces it (read-only, latest-wins).
		await recordPmFitVerdict(db, brief.id, { outcome: 'deny', reason: 'wrong stack for this project' });
		const withFit = (await loadWorkforcePanel(db)).hireQueue.find((h) => h.brief === brief.id);
		expect(withFit?.fitVerdict?.outcome).toBe('deny');
		expect(withFit?.fitVerdict?.reason).toBe('wrong stack for this project');

		// DECIDE it (operator approves, B4) → it must DROP OFF the open queue (status no longer 'open').
		await applyHireDecision(db, brief.id, 'approve', { operatorConfirmed: true });
		const after = (await loadWorkforcePanel(db)).hireQueue.find((h) => h.brief === brief.id);
		expect(after).toBeUndefined();
	}, 40_000);

	it('pool generation: a deployable role with active fixtures surfaces the honest count', async () => {
		const slug = nextSlug('poolrole');
		const role = await createRole(db, { slug, name: slug, purpose: 'pool gen' });
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'pool core',
			default_tier: 'sonnet'
		});
		// Two fixtures, then flip them ACTIVE (the §3.8 activation effect).
		for (const fxSlug of ['pf-1', 'pf-2']) {
			await createGauntletFixture(db, {
				role: role.id,
				slug: nextSlug(fxSlug),
				kind: 'planted_defect',
				work: { 'x.ts': 'code' },
				// A valid 26-char Crockford ULID — the m0035 shape assert rejects malformed
				// sentinels on the active flip below, so seed the mint-shape (matches prod).
				sentinel: newSentinelUlid()
			});
		}
		await db.query(`UPDATE gauntlet_fixture SET status = 'active' WHERE role = $r;`, {
			r: new StringRecordId(role.id)
		});
		const run = await createInterviewRun(db, {
			role_version: v.id,
			tier: 'sonnet',
			provider: 'claude',
			model_id: MODEL,
			fixture_set_sha: 'fsha-pool'
		});
		await finalizeInterviewRun(db, run.id, {
			status: 'passed',
			planted_total: 2,
			planted_found: 2,
			false_positives: 0
		});
		const card = cardFor(await loadWorkforcePanel(db), slug);
		expect(card.deployable).toBe(true);
		expect(card.poolGeneration).toMatch(/passed launch pool/);
	});
});

// ── pickLaunchVersion — newest-selectable (the investigator/qa_lead/security_officer bug) ──
// The panel picker MUST mirror ceremony.ts: pick the NEWEST ceremony-selectable version
// (draft/interviewing/error/passed), never a failed/withdrawn/retired terminal. The old
// "lowest non-withdrawn" rule surfaced a re-versioned role's dead v1 (failed) as the launch
// version → the card read v1-FAILED even though a passing v2 existed. CERT-INTEGRITY: picking
// newest-selectable + the UNCHANGED deployability gate must never show a non-passed version
// as certified.

/** Drive a fresh version draft→interviewing→passed via a passing interview_run (the lifecycle
 *  couple in finalizeInterviewRun only fires when the version is 'interviewing'). */
async function makePassedVersion(roleId: string, model: string, core: string) {
	const v = await createRoleVersion(db, { role: roleId, prompt_core: core, default_tier: 'sonnet' });
	await transitionLifecycle(db, v.id, 'interviewing');
	const run = await createInterviewRun(db, {
		role_version: v.id,
		tier: 'sonnet',
		provider: 'claude',
		model_id: model,
		fixture_set_sha: `fsha-${core}`
	});
	await finalizeInterviewRun(db, run.id, {
		status: 'passed',
		planted_total: 4,
		planted_found: 4,
		false_positives: 0
	});
	return { v, run };
}

/** Drive a fresh version draft→interviewing→failed via a failing interview_run. */
async function makeFailedVersion(roleId: string, model: string, core: string) {
	const v = await createRoleVersion(db, { role: roleId, prompt_core: core, default_tier: 'sonnet' });
	await transitionLifecycle(db, v.id, 'interviewing');
	const run = await createInterviewRun(db, {
		role_version: v.id,
		tier: 'sonnet',
		provider: 'claude',
		model_id: model,
		fixture_set_sha: `fsha-${core}`
	});
	await finalizeInterviewRun(db, run.id, {
		status: 'failed',
		planted_total: 4,
		planted_found: 1,
		false_positives: 2
	});
	return { v, run };
}

describe('loadWorkforcePanel — newest-selectable launch picker (cert-integrity)', () => {
	it('[v1 failed, v2 passed]: picks v2, version=2, CERTIFIED (the investigator/qa_lead/security_officer case)', async () => {
		const slug = nextSlug('reversioned');
		const role = await createRole(db, { slug, name: slug, purpose: 'failed v1, passed v2' });
		const { v: v1 } = await makeFailedVersion(role.id, MODEL, 'reversion-v1');
		const { v: v2, run: v2run } = await makePassedVersion(role.id, MODEL, 'reversion-v2');
		expect(v1.version).toBe(1);
		expect(v2.version).toBe(2);

		const card = cardFor(await loadWorkforcePanel(db), slug);
		// Picks the NEWEST selectable version — NOT the dead failed v1.
		expect(card.version).toBe(2);
		expect(card.roleVersion).toBe(v2.id);
		expect(card.lifecycle).toBe('passed');
		// Certified off v2's passing run (deployability gate unchanged).
		expect(card.deployable).toBe(true);
		expect(card.notDeployableReason).toBeNull();
		expect(card.interview?.run).toBe(v2run.id);
		expect(card.interview?.status).toBe('passed');
	});

	it('[v1 failed] only: picks v1, version=1, lifecycle=failed, NOT certified (unchanged)', async () => {
		const slug = nextSlug('failedonly');
		const role = await createRole(db, { slug, name: slug, purpose: 'only a failed version' });
		const { v: v1 } = await makeFailedVersion(role.id, MODEL, 'failedonly-v1');

		const card = cardFor(await loadWorkforcePanel(db), slug);
		// failed is NOT ceremony-selectable → no selectable version → null launch → 'no version'.
		// (A role whose ONLY version is terminal failed has no drivable launch candidate; the
		// reversion affordance lives in ceremony.ts. The card honestly shows NOT DEPLOYABLE.)
		expect(card.version).toBeNull();
		expect(card.roleVersion).toBeNull();
		expect(card.deployable).toBe(false);
		expect(card.notDeployableReason).toBe('no version');
		void v1;
	});

	it('[v1 passed, v2 draft]: picks v2 draft, NOT-yet-certified (newest selectable, honest — never falsely certified off v1)', async () => {
		const slug = nextSlug('passedthendraft');
		const role = await createRole(db, { slug, name: slug, purpose: 'passed v1, draft v2' });
		const { v: v1 } = await makePassedVersion(role.id, MODEL, 'ptd-v1');
		const v2 = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'ptd-v2-draft',
			default_tier: 'sonnet'
		});
		expect(v1.version).toBe(1);
		expect(v2.version).toBe(2);

		const card = cardFor(await loadWorkforcePanel(db), slug);
		// Newest selectable = the v2 draft, NOT the older passed v1.
		expect(card.version).toBe(2);
		expect(card.roleVersion).toBe(v2.id);
		expect(card.lifecycle).toBe('draft');
		// CERT-INTEGRITY: a draft has no passing run at its prompt_sha → NOT certified, even
		// though v1 passed. The deployability gate runs off the PICKED version (v2), so v1's
		// pass can never leak certification onto the draft.
		expect(card.deployable).toBe(false);
		expect(card.notDeployableReason).toBe('not yet interviewed');
		expect(card.interview).toBeNull();
	});

	it('withdrawn versions are excluded: [v1 passed, v2 withdrawn] → picks v1 passed (certified)', async () => {
		const slug = nextSlug('withdrawnnewest');
		const role = await createRole(db, { slug, name: slug, purpose: 'passed v1, withdrawn v2' });
		const { v: v1 } = await makePassedVersion(role.id, MODEL, 'wn-v1');
		const v2 = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'wn-v2',
			default_tier: 'sonnet'
		});
		await withdrawRoleVersion(db, v2.id); // draft → withdrawn (legal §2.2)

		const card = cardFor(await loadWorkforcePanel(db), slug);
		// v2 withdrawn is NOT selectable → newest selectable is v1 (passed).
		expect(card.version).toBe(1);
		expect(card.roleVersion).toBe(v1.id);
		expect(card.lifecycle).toBe('passed');
		expect(card.deployable).toBe(true);
	});

	it('all-withdrawn role → null launch, honest NOT DEPLOYABLE (no version)', async () => {
		const slug = nextSlug('allwithdrawn');
		const role = await createRole(db, { slug, name: slug, purpose: 'every version withdrawn' });
		const v1 = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'aw-v1',
			default_tier: 'sonnet'
		});
		await withdrawRoleVersion(db, v1.id);

		const card = cardFor(await loadWorkforcePanel(db), slug);
		expect(card.version).toBeNull();
		expect(card.roleVersion).toBeNull();
		expect(card.deployable).toBe(false);
		expect(card.notDeployableReason).toBe('no version');
		expect(card.interview).toBeNull();
		expect(card.track).toBeNull();
	});
});

// ── RED-TEAM: panel.ts and ceremony.ts MUST share the selection predicate (no divergence) ──
// The original bug was a DIVERGENT copy of pickLaunchVersion. Statically prove (no DB) that
// both modules now import and use the SAME shared lifecycle.ts predicate so they can never
// disagree about the launch version again. Pure source-read assertion.
describe('RED-TEAM: panel.ts / ceremony.ts launch-picker convergence', () => {
	const here = fileURLToPath(import.meta.url);
	const sep = Math.max(here.lastIndexOf('/'), here.lastIndexOf('\\'));
	const dir = here.slice(0, sep + 1);
	const read = (f: string) => readFileSync(dir + f, 'utf8');

	it('both modules import isCeremonySelectable from ./lifecycle (single source of truth)', () => {
		const panelSrc = read('panel.ts');
		const ceremonySrc = read('ceremony.ts');
		const importRe = /import\s*\{[^}]*\bisCeremonySelectable\b[^}]*\}\s*from\s*'\.\/lifecycle'/;
		expect(panelSrc).toMatch(importRe);
		expect(ceremonySrc).toMatch(importRe);
	});

	it('both pickLaunchVersion filter on the SAME predicate expression (no third divergent copy)', () => {
		const filterExpr = 'versions.filter((v) => isCeremonySelectable(v.lifecycle))';
		expect(read('panel.ts')).toContain(filterExpr);
		expect(read('ceremony.ts')).toContain(filterExpr);
	});

	it('panel.ts no longer contains the OLD divergent lowest-version sort', () => {
		const panelSrc = read('panel.ts');
		// The bug was `.sort((a, b) => a.version - b.version)[0]` (lowest-first). The fixed
		// picker sorts newest-first `(b.version - a.version)`. Assert the lowest-first picker
		// is gone from panel.ts.
		expect(panelSrc).not.toContain('.sort((a, b) => a.version - b.version)');
		expect(panelSrc).toContain('.sort((a, b) => b.version - a.version)');
	});
});
