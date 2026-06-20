import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { LifecycleError, RunStatusError } from './lifecycle';
import {
	addPanelVerdict,
	addRoleEvent,
	closePanelVerdictOutcome,
	computePromptSha,
	computeWorkSha,
	createGauntletFixture,
	createGauntletKey,
	createInterviewRun,
	createRole,
	createRoleVersion,
	currentBundleDigest,
	finalizeInterviewRun,
	getInterviewRun,
	getRole,
	getRoleBySlug,
	getRoleVersion,
	listRoleEvents,
	markInterviewRunStale,
	readGauntletKeyForScoring,
	retireRoleVersion,
	roleIdForSlug,
	swapActiveVersion,
	transitionLifecycle,
	withdrawRoleVersion,
	WorkforceInputError
} from './repo';

// TASK 16.3 VERIFY — W-D7a data plane against a REAL throwaway SurrealDB
// (namespace dropped per run): migration pair discipline (apply-twice +
// half-applied recovery, F-015), the session widen, normalizers asserted on SET
// rows (F-013), dedup keys (D-008), §2.2 lifecycle-as-code incl.
// re-run-never-demotes + withdrawn-from-error, §2.3 swap, §2.2 outcome closure,
// §2.6 bundle-digest honesty.

let tdb: TestDb;
let db: Db;

const WORKFORCE_MIG = '0031_workforce';

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
	expect(applied).toContain(WORKFORCE_MIG);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let seq = 0;
async function freshRole(prefix = 'wf-role') {
	const slug = `${prefix}-${++seq}`;
	return createRole(db, { slug, name: `Role ${slug}`, purpose: 'test the data plane' });
}

async function freshVersion(roleId: string, core = 'Review everything twice.') {
	return createRoleVersion(db, { role: roleId, prompt_core: core, default_tier: 'sonnet' });
}

async function freshSession(kind = 'review'): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session SET kind = $kind, model = { provider: 'claude', model_id: 'claude-test' } RETURN id;`,
		{ kind }
	);
	return String(rows[0].id);
}

// ── migration pair discipline (F-015) ─────────────────────────────────────────────

describe('0031_workforce migration — tables, indexes, apply-twice, half-applied', () => {
	it('defines every §2.1 table', async () => {
		const [info] = await db.query<[{ tables: Record<string, string> }]>('INFO FOR DB;');
		const present = Object.keys(info.tables);
		for (const t of [
			'role',
			'role_version',
			'interview_run',
			'gauntlet_fixture',
			'gauntlet_key',
			'panel_verdict',
			'role_event'
		]) {
			expect(present, `missing table: ${t}`).toContain(t);
		}
	});

	it('defines every §2.1 index (incl. the session additive index)', async () => {
		const expected: Record<string, string[]> = {
			role: ['role_slug'],
			role_version: ['role_version_dedup', 'role_version_by_role', 'role_version_by_sha'],
			interview_run: ['interview_by_version', 'interview_by_role'],
			gauntlet_fixture: ['gauntlet_fixture_dedup'],
			gauntlet_key: ['gauntlet_key_dedup'],
			panel_verdict: ['panel_verdict_dedup', 'panel_verdict_by_version', 'panel_verdict_by_project'],
			role_event: ['role_event_by_role'],
			session: ['session_by_role_version']
		};
		for (const [table, indexes] of Object.entries(expected)) {
			const [info] = await db.query<[{ indexes: Record<string, string> }]>(
				`INFO FOR TABLE ${table};`
			);
			for (const idx of indexes) {
				expect(Object.keys(info.indexes), `missing index ${table}.${idx}`).toContain(idx);
			}
		}
	});

	it('apply-twice: the runner skips it AND the raw DDL re-applies cleanly (OVERWRITE)', async () => {
		const again = await runMigrations(db, schemaMigrations);
		expect(again).toEqual([]);
		// The F-015 hard case: the DDL itself re-runs over the already-applied state.
		const mig = schemaMigrations.find((m) => m.id === WORKFORCE_MIG);
		expect(mig).toBeDefined();
		await expect(db.query(mig!.up)).resolves.toBeDefined();
	});

	it('half-applied recovery: a bare half-applied table is absorbed by the re-run (m0025 case study)', async () => {
		// Fresh namespace on the same server: apply everything EXCEPT 0031, then
		// simulate the mid-apply death (a bare DEFINE TABLE landed, nothing else,
		// migration never recorded), then run the full set — must recover.
		const half = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: `${tdb.namespace}_half`,
			database: tdb.database
		});
		try {
			const withoutWorkforce = schemaMigrations.filter((m) => m.id !== WORKFORCE_MIG);
			await runMigrations(half, withoutWorkforce);
			// The wedge shape that broke m0025: a bare (non-OVERWRITE) DEFINE TABLE.
			await half.query(`DEFINE TABLE role SCHEMAFULL;`);

			const applied = await runMigrations(half, schemaMigrations);
			expect(applied).toEqual([WORKFORCE_MIG]);

			// The recovered table is fully functional: fields + UNIQUE index landed.
			const [rows] = await half.query<[Array<{ id: unknown; slug: string }>]>(
				`CREATE type::thing('role', 'half_recovery') CONTENT { slug: 'half-recovery', name: 'X', purpose: 'p' } RETURN AFTER;`
			);
			expect(rows[0].slug).toBe('half-recovery');
			await expect(
				half.query(
					`CREATE role CONTENT { slug: 'half-recovery', name: 'dup', purpose: 'p' };`
				)
			).rejects.toThrow(); // role_slug UNIQUE survived the recovery
		} finally {
			await half.query('REMOVE NAMESPACE IF EXISTS type::namespace($ns);', {
				ns: `${tdb.namespace}_half`
			}).catch(() => {});
			await half.close().catch(() => {});
		}
	}, 60_000);
});

// ── session additive + kind widen ─────────────────────────────────────────────────

describe('session additive columns + kind widen (m0022 lesson)', () => {
	it("kind='interview' writes succeed and role/role_version links round-trip", async () => {
		const role = await freshRole('wf-sess');
		const version = await freshVersion(role.id);
		const [rows] = await db.query<
			[Array<{ id: unknown; kind: string; role: unknown; role_version: unknown }>]
		>(
			`CREATE session CONTENT {
				kind: 'interview',
				model: { provider: 'claude', model_id: 'claude-test' },
				role: type::thing('role', $rid), role_version: $vid
			} RETURN AFTER;`,
			{ rid: role.id.slice('role:'.length), vid: new StringRecordId(version.id) }
		);
		expect(rows[0].kind).toBe('interview');
		expect(String(rows[0].role)).toBe(role.id);
		expect(String(rows[0].role_version)).toBe(version.id);
	});

	it('every pre-existing kind still writes; a bogus kind is rejected', async () => {
		for (const kind of ['chat', 'task', 'review', 'release', 'discussion']) {
			await expect(freshSession(kind)).resolves.toBeTruthy();
		}
		await expect(freshSession('seance')).rejects.toThrow();
	});
});

// ── role identity ─────────────────────────────────────────────────────────────────

describe('role — slug-derived ids, dedup, audit event', () => {
	it("derives 'role:code_reviewer' from 'code-reviewer'; display slug keeps the hyphen", async () => {
		expect(roleIdForSlug('code-reviewer')).toBe('role:code_reviewer');
		const created = await createRole(db, {
			slug: 'code-reviewer',
			name: 'Code Reviewer',
			purpose: 'find planted defects',
			provenance: 'harvested: gstack review/SKILL.md, MIT'
		});
		expect(created.id).toBe('role:code_reviewer');
		expect(created.slug).toBe('code-reviewer');
		expect(created.status).toBe('active');
		expect(created.active_version).toBeNull(); // honest: not deployable yet
		// F-013: datetimes on a SET row are parseable ISO strings.
		expect(typeof created.created_at).toBe('string');
		expect(Number.isNaN(new Date(created.created_at as string).getTime())).toBe(false);

		const events = await listRoleEvents(db, created.id);
		expect(events.some((e) => e.op === 'created')).toBe(true);

		const read = await getRoleBySlug(db, 'code-reviewer');
		expect(read?.id).toBe('role:code_reviewer');
	});

	it('a duplicate slug collides on the UNIQUE index (D-008)', async () => {
		const role = await freshRole('wf-dup');
		await expect(
			createRole(db, { slug: role.slug, name: 'again', purpose: 'p' })
		).rejects.toThrow();
	});

	it('nil/empty/invalid slugs are refused at the boundary (named error)', async () => {
		for (const bad of ['', 'Has-Caps', 'spaces here', 'trailing-', '-leading', 'a_b']) {
			expect(() => roleIdForSlug(bad)).toThrow(WorkforceInputError);
		}
		// @ts-expect-error — nil input shadow path
		expect(() => roleIdForSlug(undefined)).toThrow(WorkforceInputError);
	});
});

// ── role_version ──────────────────────────────────────────────────────────────────

describe('role_version — monotonic versions, content hash, dedup, immutability stance', () => {
	it('versions are monotonic per role; dedup_key collides on a forced duplicate', async () => {
		const role = await freshRole('wf-ver');
		const v1 = await freshVersion(role.id, 'core v1');
		const v2 = await freshVersion(role.id, 'core v2');
		expect(v1.version).toBe(1);
		expect(v2.version).toBe(2);
		expect(v1.lifecycle).toBe('draft');
		// F-013 on SET vs absent: created_at set; activated_at/retired_at honestly null.
		expect(typeof v1.created_at).toBe('string');
		expect(v1.activated_at).toBeNull();
		expect(v1.retired_at).toBeNull();

		// Forced duplicate (role|version) — the D-008 VALUE+UNIQUE collides loudly.
		await expect(
			db.query(
				`CREATE role_version CONTENT {
					role: type::thing('role', $rid), version: 1, prompt_core: 'x', prompt_sha: 'x',
					default_tier: 'sonnet'
				};`,
				{ rid: role.id.slice('role:'.length) }
			)
		).rejects.toThrow();
	});

	it('prompt_sha is deterministic and capability-ORDER-insensitive (sorted id arrays)', () => {
		const a = computePromptSha('core', { skills: ['b', 'a'], agents: ['z'], mcp: [] });
		const b = computePromptSha('core', { mcp: [], agents: ['z'], skills: ['a', 'b'] });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		// Different text or different bundle = different certification address.
		expect(computePromptSha('other core', { skills: ['a', 'b'] })).not.toBe(a);
		expect(computePromptSha('core', { skills: ['a'] })).not.toBe(a);
	});

	it('the stored prompt_sha matches the mechanical computation', async () => {
		const role = await freshRole('wf-sha');
		const caps = { skills: ['review-basics'], agents: [], mcp: [] };
		const v = await createRoleVersion(db, {
			role: role.id,
			prompt_core: 'Audit with evidence.',
			capabilities: caps,
			default_tier: 'opus'
		});
		expect(v.prompt_sha).toBe(computePromptSha('Audit with evidence.', caps));
		expect(v.capabilities).toEqual(caps); // FLEXIBLE round-trip — nested keys intact
	});

	it('an empty prompt_core is refused (empty-input shadow path, named error)', async () => {
		const role = await freshRole('wf-empty');
		await expect(
			createRoleVersion(db, { role: role.id, prompt_core: '   ', default_tier: 'haiku' })
		).rejects.toThrow(WorkforceInputError);
	});
});

// ── §2.2 lifecycle semantics against the DB ──────────────────────────────────────

const RUN_BASE = {
	tier: 'sonnet' as const,
	provider: 'claude',
	model_id: 'claude-sonnet-test',
	fixture_set_sha: 'fsha-1'
};

describe('certification campaign — lifecycle coupling (§2.2)', () => {
	it('createInterviewRun moves draft → interviewing and COPIES prompt_sha', async () => {
		const role = await freshRole('wf-camp');
		const v = await freshVersion(role.id);
		const run = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		expect(run.status).toBe('running');
		expect(run.prompt_sha).toBe(v.prompt_sha); // copied at run start
		expect(run.ended_at).toBeNull(); // absent → null, never 'undefined'
		expect((await getRoleVersion(db, v.id))?.lifecycle).toBe('interviewing');
	});

	it('finalize passed → version passed + role_event interviewed; ended_at stamped (D-035)', async () => {
		const role = await freshRole('wf-pass');
		const v = await freshVersion(role.id);
		const run = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		const done = await finalizeInterviewRun(db, run.id, {
			status: 'passed',
			planted_total: 4,
			planted_found: 4,
			false_positives: 0
		});
		expect(done.status).toBe('passed');
		expect(typeof done.ended_at).toBe('string'); // F-013: ISO on the SET row
		expect((await getRoleVersion(db, v.id))?.lifecycle).toBe('passed');
		const events = await listRoleEvents(db, role.id);
		expect(events.some((e) => e.op === 'interviewed' && e.detail?.status === 'passed')).toBe(true);
	});

	it('RE-RUN NEVER DEMOTES: a failed evidence run against a passed version leaves it passed', async () => {
		const role = await freshRole('wf-evid');
		const v = await freshVersion(role.id);
		const campaign = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await finalizeInterviewRun(db, campaign.id, { status: 'passed' });

		// Evidence re-run (stale re-check / comparison probe) fails…
		const rerun = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		expect((await getRoleVersion(db, v.id))?.lifecycle).toBe('passed'); // not re-campaigned
		await finalizeInterviewRun(db, rerun.id, { status: 'failed' });
		// …the run row records the failure honestly, the version is NOT demoted.
		expect((await getInterviewRun(db, rerun.id))?.status).toBe('failed');
		expect((await getRoleVersion(db, v.id))?.lifecycle).toBe('passed');
	});

	it("error requires a mechanical error_reason; retry re-enters 'interviewing' (§3.6)", async () => {
		const role = await freshRole('wf-err');
		const v = await freshVersion(role.id);
		const run = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await expect(finalizeInterviewRun(db, run.id, { status: 'error' })).rejects.toThrow(
			WorkforceInputError
		);
		await expect(
			finalizeInterviewRun(db, run.id, { status: 'passed', error_reason: 'env_timeout' })
		).rejects.toThrow(WorkforceInputError);

		await finalizeInterviewRun(db, run.id, { status: 'error', error_reason: 'env_timeout' });
		expect((await getRoleVersion(db, v.id))?.lifecycle).toBe('error');

		const retry = await createInterviewRun(db, {
			role_version: v.id,
			...RUN_BASE,
			retry_of: run.id
		});
		expect(retry.retry_of).toBe(run.id);
		expect((await getRoleVersion(db, v.id))?.lifecycle).toBe('interviewing');
	});

	it('WITHDRAWN-FROM-ERROR: an unretried error row exits cleanly; failed stays terminal', async () => {
		const role = await freshRole('wf-wd');
		const v = await freshVersion(role.id);
		const run = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await finalizeInterviewRun(db, run.id, { status: 'error', error_reason: 'spawn_failure' });
		const withdrawn = await withdrawRoleVersion(db, v.id);
		expect(withdrawn.lifecycle).toBe('withdrawn');
		// withdrawn is terminal — and a failed version can never move again either.
		await expect(transitionLifecycle(db, v.id, 'interviewing')).rejects.toThrow(LifecycleError);

		const v2 = await freshVersion(role.id, 'second attempt');
		const run2 = await createInterviewRun(db, { role_version: v2.id, ...RUN_BASE });
		await finalizeInterviewRun(db, run2.id, { status: 'failed' });
		await expect(transitionLifecycle(db, v2.id, 'passed')).rejects.toThrow(LifecycleError);
		await expect(withdrawRoleVersion(db, v2.id)).rejects.toThrow(LifecycleError); // failed ∉ withdrawable
		// failed/withdrawn versions are not interviewable — a fix is a NEW version.
		await expect(createInterviewRun(db, { role_version: v2.id, ...RUN_BASE })).rejects.toThrow(
			WorkforceInputError
		);
	});

	it('adjudicating is an honest intermediate: running → adjudicating → passed; never → error', async () => {
		const role = await freshRole('wf-adj');
		const v = await freshVersion(role.id);
		const run = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		const adj = await finalizeInterviewRun(db, run.id, {
			status: 'adjudicating',
			ambiguous: [{ fixture: 'fx-1', finding: 'unexpected finding on clean material' }]
		});
		expect(adj.status).toBe('adjudicating');
		expect(typeof adj.ended_at).toBe('string'); // session over; verdict pending
		expect((await getRoleVersion(db, v.id))?.lifecycle).toBe('interviewing'); // not yet judged
		await expect(
			finalizeInterviewRun(db, run.id, { status: 'error', error_reason: 'scorer_error' })
		).rejects.toThrow(RunStatusError);
		await finalizeInterviewRun(db, run.id, { status: 'passed' });
		expect((await getRoleVersion(db, v.id))?.lifecycle).toBe('passed');
	});

	it('markInterviewRunStale flags honestly + appends role_event (§3.7 — NOT revocation)', async () => {
		const role = await freshRole('wf-stale');
		const v = await freshVersion(role.id);
		const run = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await finalizeInterviewRun(db, run.id, { status: 'passed' });
		const marked = await markInterviewRunStale(db, run.id);
		expect(marked.stale).toBe(true);
		expect(marked.status).toBe('passed'); // certification untouched
		const events = await listRoleEvents(db, role.id);
		expect(events.some((e) => e.op === 'stale_marked')).toBe(true);
	});
});

// ── §2.3 incumbency ───────────────────────────────────────────────────────────────

describe('incumbency swap (§2.3 — one pointer write + one role_event)', () => {
	it('swap sets the pointer, appends the audit event, stamps informational activated_at', async () => {
		const role = await freshRole('wf-swap');
		const v1 = await freshVersion(role.id, 'v1 core');
		const r1 = await createInterviewRun(db, { role_version: v1.id, ...RUN_BASE });
		await finalizeInterviewRun(db, r1.id, { status: 'passed' });

		const swapped = await swapActiveVersion(db, role.id, v1.id);
		expect(swapped.active_version).toBe(v1.id);
		const after1 = await getRoleVersion(db, v1.id);
		expect(typeof after1?.activated_at).toBe('string'); // F-013 on the SET row

		const ev1 = (await listRoleEvents(db, role.id)).find((e) => e.op === 'swap');
		expect(ev1?.detail).toMatchObject({ from: null, to: v1.id, operator_confirmed: true });

		// Second swap records from → to; the OLD incumbent simply stays 'passed'.
		const v2 = await freshVersion(role.id, 'v2 core');
		const r2 = await createInterviewRun(db, { role_version: v2.id, ...RUN_BASE });
		await finalizeInterviewRun(db, r2.id, { status: 'passed' });
		await swapActiveVersion(db, role.id, v2.id);
		expect((await getRole(db, role.id))?.active_version).toBe(v2.id);
		expect((await getRoleVersion(db, v1.id))?.lifecycle).toBe('passed'); // no 'incumbent' state
		const swaps = (await listRoleEvents(db, role.id)).filter((e) => e.op === 'swap');
		expect(swaps.some((e) => e.detail?.from === v1.id && e.detail?.to === v2.id)).toBe(true);
	});

	it('refuses a non-passed target and a cross-role target (fail-closed, named)', async () => {
		const role = await freshRole('wf-swapfail');
		const draft = await freshVersion(role.id);
		await expect(swapActiveVersion(db, role.id, draft.id)).rejects.toThrow(WorkforceInputError);

		const other = await freshRole('wf-swapother');
		const otherV = await freshVersion(other.id);
		const r = await createInterviewRun(db, { role_version: otherV.id, ...RUN_BASE });
		await finalizeInterviewRun(db, r.id, { status: 'passed' });
		await expect(swapActiveVersion(db, role.id, otherV.id)).rejects.toThrow(/cross-role/);
	});

	it('retire stamps retired_at + role_event; retired is terminal', async () => {
		const role = await freshRole('wf-retire');
		const v = await freshVersion(role.id);
		const r = await createInterviewRun(db, { role_version: v.id, ...RUN_BASE });
		await finalizeInterviewRun(db, r.id, { status: 'passed' });
		const retired = await retireRoleVersion(db, v.id);
		expect(retired.lifecycle).toBe('retired');
		expect(typeof retired.retired_at).toBe('string'); // F-013 on the SET row
		expect((await listRoleEvents(db, role.id)).some((e) => e.op === 'retired')).toBe(true);
		await expect(withdrawRoleVersion(db, v.id)).rejects.toThrow(LifecycleError);
	});
});

// ── panel_verdict + §2.2 outcome closure ─────────────────────────────────────────

describe('panel_verdict — D-008 dedup + mechanical outcome closure', () => {
	it('records a verdict; dedup (artifact|validator_session) collides on a double-write', async () => {
		const role = await freshRole('wf-panel');
		const v = await freshVersion(role.id);
		const session = await freshSession();
		const verdict = await addPanelVerdict(db, {
			artifact: v.id,
			artifact_kind: 'review_proposal',
			validator_session: session,
			verdict: 'pushback',
			reasons: ['scope creep: 3 undeclared files'],
			confidence: 'high'
		});
		expect(verdict.validator_kind).toBe('inline'); // §9 bootstrap default
		expect(verdict.project).toBeNull(); // project-less workforce artifact
		expect(verdict.outcome).toBeNull(); // closed LATER, mechanically
		expect(typeof verdict.at).toBe('string'); // F-013 SET row

		await expect(
			addPanelVerdict(db, {
				artifact: v.id,
				artifact_kind: 'review_proposal',
				validator_session: session,
				verdict: 'approve'
			})
		).rejects.toThrow(); // ONE verdict per (artifact, validator_session)
	});

	it("validator_kind='catalog_role' requires the role identity (fail-closed)", async () => {
		const role = await freshRole('wf-panel-cat');
		const v = await freshVersion(role.id);
		const session = await freshSession();
		await expect(
			addPanelVerdict(db, {
				artifact: v.id,
				artifact_kind: 'fixture_proposal',
				validator_session: session,
				validator_kind: 'catalog_role',
				verdict: 'approve'
			})
		).rejects.toThrow(WorkforceInputError);

		const ok = await addPanelVerdict(db, {
			artifact: v.id,
			artifact_kind: 'fixture_proposal',
			validator_session: session,
			validator_kind: 'catalog_role',
			role: role.id,
			role_version: v.id,
			verdict: 'approve'
		});
		expect(ok.role).toBe(role.id);
	});

	it('outcome closure: append-once, idempotent on re-run, refuses relabel', async () => {
		const role = await freshRole('wf-close');
		const v = await freshVersion(role.id);
		const session = await freshSession();
		const verdict = await addPanelVerdict(db, {
			artifact: v.id,
			artifact_kind: 'task',
			validator_session: session,
			verdict: 'approve'
		});
		const closed = await closePanelVerdictOutcome(db, verdict.id, 'upheld');
		expect(closed.outcome).toBe('upheld');
		// Interrupt contract: a re-run with the SAME outcome absorbs as a no-op…
		const again = await closePanelVerdictOutcome(db, verdict.id, 'upheld');
		expect(again.outcome).toBe('upheld');
		// …but relabeling history is refused (calibration integrity).
		await expect(
			closePanelVerdictOutcome(db, verdict.id, 'overridden_by_operator')
		).rejects.toThrow(WorkforceInputError);
	});
});

// ── gauntlet fixture / key ───────────────────────────────────────────────────────

describe('gauntlet_fixture + gauntlet_key — content addressing, dedup, single reader', () => {
	it('fixture content_sha is computed mechanically; (role|slug) dedup collides', async () => {
		const role = await freshRole('wf-fix');
		const work = { 'src/a.ts': 'export const x = 1;' };
		const fixture = await createGauntletFixture(db, {
			role: role.id,
			slug: 'planted-1',
			kind: 'planted_defect',
			work,
			sentinel: '01JXJ0000000000000000TEST1',
			provenance: 'fails: F-015'
		});
		expect(fixture.status).toBe('proposed');
		expect(fixture.content_sha).toBe(computeWorkSha(work));
		expect(typeof fixture.created_at).toBe('string');

		await expect(
			createGauntletFixture(db, {
				role: role.id,
				slug: 'planted-1',
				kind: 'clean_control',
				work: { 'b.ts': 'x' },
				sentinel: '01JXJ0000000000000000TEST2'
			})
		).rejects.toThrow(); // dedup (role|slug)
	});

	it('empty work is refused (empty-input shadow path)', async () => {
		const role = await freshRole('wf-fix-empty');
		await expect(
			createGauntletFixture(db, {
				role: role.id,
				slug: 'empty',
				kind: 'clean_control',
				work: {},
				sentinel: '01JXJ0000000000000000TEST3'
			})
		).rejects.toThrow(WorkforceInputError);
	});

	it('the key binds the fixture content_sha mechanically; ONE key per fixture', async () => {
		const role = await freshRole('wf-key');
		const fixture = await createGauntletFixture(db, {
			role: role.id,
			slug: 'keyed',
			kind: 'planted_defect',
			work: { 'm.surql': 'DEFINE TABLE x SCHEMAFULL;' },
			sentinel: '01JXJ0000000000000000TEST4'
		});
		const key = await createGauntletKey(db, {
			fixture: fixture.id,
			plants: [{ id: 'p1', class: 'non-idempotent-ddl', location: 'm.surql:1', detection: 'OVERWRITE', severity: 'high' }],
			fp_tolerance: 0
		});
		expect(key.content_sha).toBe(fixture.content_sha); // content-addressed binding
		expect(key.author).toBe('operator'); // §4.4 default
		await expect(createGauntletKey(db, { fixture: fixture.id })).rejects.toThrow(); // dedup

		const read = await readGauntletKeyForScoring(db, fixture.id);
		expect(read?.id).toBe(key.id);
		expect(read?.plants).toHaveLength(1);
	});

	it('a key for a missing fixture is refused; a keyless fixture reads null (honest empty)', async () => {
		await expect(createGauntletKey(db, { fixture: 'gauntlet_fixture:nope' })).rejects.toThrow(
			WorkforceInputError
		);
		const role = await freshRole('wf-keyless');
		const fixture = await createGauntletFixture(db, {
			role: role.id,
			slug: 'keyless',
			kind: 'clean_control',
			work: { 'c.ts': 'clean' },
			sentinel: '01JXJ0000000000000000TEST5'
		});
		expect(await readGauntletKeyForScoring(db, fixture.id)).toBeNull();
	});

	// Strip line (`// …`) and block (`/* … */`) comments so a prior-art *reference* to
	// gauntlet_key in prose (e.g. file-snapshot.ts cites F-026/gauntlet_key as the dedup
	// pattern) never false-positives, while an ACTUAL code read (SELECT/db.query touching
	// the table) still trips the census. Naive but sufficient: this is a leak-channel guard
	// over our own source, not a general JS parser — string literals containing `//` or `/*`
	// are not present in the files it walks, and a real `gauntlet_key` table read lives in
	// executable code regardless.
	const stripComments = (src: string): string =>
		src
			.replace(/\/\*[\s\S]*?\*\//g, '') // block comments
			.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (keep `://` in URLs intact)
	const mentionsGauntletKeyInCode = (src: string): boolean =>
		stripComments(src).includes('gauntlet_key');

	it('comment-stripping census ignores prose mentions but still trips on a real code read (guard teeth)', () => {
		// A prior-art REFERENCE in a comment must NOT count (false-positive guard).
		expect(
			mentionsGauntletKeyInCode(
				`/** mirrors F-026 / gauntlet_key: deterministic id dedup */\nexport const x = 1;`
			)
		).toBe(false);
		expect(mentionsGauntletKeyInCode(`const y = 2; // see gauntlet_key prior art\n`)).toBe(false);
		// An ACTUAL code read (SELECT/db.query in executable code) MUST still trip it.
		expect(
			mentionsGauntletKeyInCode(`const r = await db.query('SELECT * FROM gauntlet_key');`)
		).toBe(true);
		expect(mentionsGauntletKeyInCode(`const t = 'gauntlet_key'; // table name`)).toBe(true);
	});

	it('READ-PATH fixture (§2.1/§4.4): the workforce module is the ONLY gauntlet_key reader in src/lib', () => {
		// Walk src/lib; any non-test module outside workforce/ (and the migration
		// definition in db/schema.ts) that reads gauntlet_key IN CODE is a leak channel.
		// Comment-only mentions (prior-art prose) are stripped first — see census helper above.
		const root = join(__dirname, '..', '..', '..');
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === 'node_modules') continue;
					walk(p);
				} else if (/\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
					if (!p.includes(join('server', 'workforce')) && !p.endsWith(join('db', 'schema.ts'))) {
						if (mentionsGauntletKeyInCode(readFileSync(p, 'utf8'))) offenders.push(p);
					}
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});

// ── §2.6 bundle digest honesty ────────────────────────────────────────────────────

describe('currentBundleDigest (§2.6)', () => {
	it("is the honest literal 'unhashed' when the cc-config mirror has digested nothing", async () => {
		expect(await currentBundleDigest(db)).toBe('unhashed');
	});

	it('covers exactly the settings scope when sync digests exist (self-describing prefix)', async () => {
		const [scopes] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE cc_scope SET kind = 'global', path = 'C:/Users/x/.claude' RETURN id;`
		);
		await db.query(
			`CREATE cc_settings CONTENT {
				scope: $scope, file_path: 'settings.json', raw: { a: 1 }, sync_digest: 'abc123'
			};`,
			{ scope: scopes[0].id }
		);
		const digest = await currentBundleDigest(db);
		expect(digest).toMatch(/^settings:[0-9a-f]{64}$/); // covers what was digested — no more
		expect(await currentBundleDigest(db)).toBe(digest); // deterministic
	});
});

// ── role_event audit feed ────────────────────────────────────────────────────────

describe('role_event — append-only audit feed', () => {
	it('rejects an out-of-enum op (DDL ASSERT); lists newest-first', async () => {
		const role = await freshRole('wf-ev');
		await addRoleEvent(db, { role: role.id, op: 'archived' });
		await expect(
			// @ts-expect-error — deliberately invalid op to prove the ASSERT fires.
			addRoleEvent(db, { role: role.id, op: 'promoted' })
		).rejects.toThrow();
		const events = await listRoleEvents(db, role.id);
		expect(events[0].op).toBe('archived'); // newest first ('created' came first)
		expect(typeof events[0].at).toBe('string'); // F-013 SET row
	});
});
