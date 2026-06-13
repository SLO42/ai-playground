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
	swapActiveVersion
} from './repo';
import { loadWorkforcePanel } from './panel';

// TASK 16.8 VERIFY — the read-only workforce-panel aggregator (WORKFORCE-SPEC §8) against
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
				sentinel: `SENT-${nextSlug('s')}`
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
