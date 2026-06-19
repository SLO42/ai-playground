import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createRole, createRoleVersion, getRoleBySlug } from './repo';
import { createProject } from '../projects/repo';
import { seedRecruiterRole, RECRUITER_DRAFT_KEYS } from './launch-fixtures';
import { RecruiterIntegrityError, RECRUITER_SLUG } from './recruiter';
import {
	dispatchHireRequest,
	runHireRequest,
	HireDispatchError,
	HIRE_REQUEST_WORK_TYPE,
	type HireRequestPayload
} from './hire-dispatch';
import { claimNext, complete } from '../orchestrator/workqueue';

// PM→HR dispatch (gaps A+B) VERIFY — real throwaway SurrealDB, every assertion reads rows the
// engine actually wrote (F-008). Load-bearing red-team invariants (B1/B2):
//   • a hire_request DRAFTS but never self-certifies / never auto-runs the gauntlet / never
//     confirms a key (B2 — the spend gate stays operatorApprovedKeySet, enforced in recruiter.ts);
//   • a duplicate gap does NOT double-enqueue (the §4.12 dedup_key);
//   • a recruiter-self target is REFUSED at draft time (B1).

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

let projectCount = 0;
/** A real project row (recommendStaffing/dispatch read it as the work_item.project link). */
async function seedProject(): Promise<string> {
	const slug = `hire_proj_${++projectCount}`;
	const p = await createProject(db, { slug, name: slug, root_path: `/tmp/${slug}`, ecosystem: [] });
	return p.id;
}

let roleCount = 0;
/** A real catalog role + an ACTIVE version (a resolvable cert target for the drain). */
async function seedRole(): Promise<{ roleId: string; slug: string; versionId: string }> {
	const n = ++roleCount;
	const slug = `hire-role-${n}`;
	const role = await createRole(db, { slug, name: `Hire Role ${n}`, purpose: 'hire-dispatch test bed' });
	// A DRAFT version is enough: the drain certifies a version (active OR newest), no incumbency
	// required. draftCertificationSet drafts against any version's id.
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are role #${n}.`,
		default_tier: 'sonnet',
		source: 'operator'
	});
	return { roleId: role.id, slug, versionId: version.id };
}

async function countWorkItems(workType: string): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM work_item WHERE work_type = $wt GROUP ALL;`,
		{ wt: workType }
	);
	return Number(rows?.[0]?.c ?? 0);
}

async function countGauntletKeys(): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM gauntlet_key GROUP ALL;`
	);
	return Number(rows?.[0]?.c ?? 0);
}

// ── (A) PRODUCER — dispatchHireRequest ────────────────────────────────────────────────

describe('dispatchHireRequest — enqueues ONE hire_request (PROPOSE-ONLY)', () => {
	it('enqueues a hire_request work_item with the screened payload', async () => {
		const project = await seedProject();
		const before = await countWorkItems(HIRE_REQUEST_WORK_TYPE);
		const res = await dispatchHireRequest(db, {
			projectId: project,
			roleSlug: 'security-reviewer',
			defectClasses: ['  sql-injection ', 'sql-injection', 'xss'] // dups + whitespace
		});
		expect(res.enqueued).toBe(true);
		expect(res.workItemId).toBeTruthy();
		// Screened → distinct + sorted + trimmed.
		expect(res.defectClasses).toEqual(['sql-injection', 'xss']);
		expect(await countWorkItems(HIRE_REQUEST_WORK_TYPE)).toBe(before + 1);

		// The row carries the payload the drain will read back — fetch THIS request by its unique
		// (work_type, roleSlug) discriminator (this test uses a slug no other test reuses).
		const [rows] = await db.query<[Array<{ payload: HireRequestPayload; work_type: string }>]>(
			`SELECT payload, work_type FROM work_item WHERE work_type = $wt AND payload.roleSlug = $slug LIMIT 1;`,
			{ wt: HIRE_REQUEST_WORK_TYPE, slug: 'security-reviewer' }
		);
		expect(rows[0].work_type).toBe('hire_request');
		expect(rows[0].payload.roleSlug).toBe('security-reviewer');
		expect(rows[0].payload.defectClasses).toEqual(['sql-injection', 'xss']);
	}, 30_000);

	it('DEDUP — the same (project|role) gap does NOT double-enqueue (B/§4.12)', async () => {
		const project = await seedProject();
		const first = await dispatchHireRequest(db, {
			projectId: project,
			roleSlug: 'perf-auditor',
			defectClasses: ['n-plus-one']
		});
		expect(first.enqueued).toBe(true);
		const before = await countWorkItems(HIRE_REQUEST_WORK_TYPE);
		const second = await dispatchHireRequest(db, {
			projectId: project,
			roleSlug: 'perf-auditor',
			defectClasses: ['n-plus-one']
		});
		expect(second.enqueued).toBe(false); // dedup no-op, NOT an error
		expect(second.workItemId).toBeUndefined();
		expect(await countWorkItems(HIRE_REQUEST_WORK_TYPE)).toBe(before); // no second row

		// A DIFFERENT role on the SAME project is a distinct gap → coexists.
		const other = await dispatchHireRequest(db, {
			projectId: project,
			roleSlug: 'a11y-auditor',
			defectClasses: ['contrast']
		});
		expect(other.enqueued).toBe(true);
	}, 30_000);

	it('SHADOW PATHS — blank role / empty needs / blank project are refused (named)', async () => {
		const project = await seedProject();
		await expect(
			dispatchHireRequest(db, { projectId: project, roleSlug: '   ', defectClasses: ['x'] })
		).rejects.toBeInstanceOf(HireDispatchError);
		await expect(
			dispatchHireRequest(db, { projectId: project, roleSlug: 'r', defectClasses: [] })
		).rejects.toBeInstanceOf(HireDispatchError);
		// classes that screen to nothing (all blank) → empty → refused
		await expect(
			dispatchHireRequest(db, { projectId: project, roleSlug: 'r', defectClasses: ['  ', ''] })
		).rejects.toBeInstanceOf(HireDispatchError);
		await expect(
			dispatchHireRequest(db, { projectId: '', roleSlug: 'r', defectClasses: ['x'] })
		).rejects.toBeInstanceOf(HireDispatchError);
	}, 30_000);
});

// ── (B) DRAIN HANDLER — runHireRequest ──────────────────────────────────────────────────

describe('runHireRequest — drafts a cert key-set (PROPOSE-ONLY, B1/B2)', () => {
	it('drafts for a resolvable role WITHOUT writing any gauntlet_key (B2)', async () => {
		const project = await seedProject();
		const { slug, versionId } = await seedRole();
		const keysBefore = await countGauntletKeys();
		const outcome = await runHireRequest(db, {
			projectId: project,
			roleSlug: slug,
			defectClasses: ['platform-bug']
		});
		expect(outcome.kind).toBe('drafted');
		if (outcome.kind !== 'drafted') throw new Error('expected drafted');
		expect(outcome.draft.roleSlug).toBe(slug);
		expect(outcome.draft.roleVersion).toBe(versionId);
		// EMPTY draftKeys default → honest empty SET (the operator authors keys), F-008.
		expect(outcome.draft.keyCount).toBe(0);
		// B2 — drafting writes ZERO gauntlet_key rows (no key is confirmed).
		expect(await countGauntletKeys()).toBe(keysBefore);
	}, 30_000);

	it('SHADOW — an UNKNOWN role slug is honest-unresolved (no fabricated draft, F-008)', async () => {
		const project = await seedProject();
		const outcome = await runHireRequest(db, {
			projectId: project,
			roleSlug: 'role-that-does-not-exist',
			defectClasses: ['x']
		});
		expect(outcome.kind).toBe('unresolved');
		if (outcome.kind !== 'unresolved') throw new Error('expected unresolved');
		expect(outcome.reason).toMatch(/no catalog role/i);
	}, 30_000);

	it('SHADOW — a role with NO version is honest-unresolved', async () => {
		const project = await seedProject();
		// A role with no version row at all.
		const role = await createRole(db, { slug: 'bare-role', name: 'Bare', purpose: 'no version' });
		expect(await getRoleBySlug(db, 'bare-role')).not.toBeNull();
		const outcome = await runHireRequest(db, {
			projectId: project,
			roleSlug: 'bare-role',
			defectClasses: ['x']
		});
		expect(outcome.kind).toBe('unresolved');
		if (outcome.kind !== 'unresolved') throw new Error('expected unresolved');
		expect(outcome.reason).toMatch(/no role_version/i);
		void role;
	}, 30_000);

	it('B1 — REFUSES drafting a cert set for the RECRUITER itself (self-cert)', async () => {
		await seedRecruiterRole(db);
		// The drain target is the recruiter slug → draftCertificationSet throws B1.
		await expect(
			runHireRequest(
				db,
				{ projectId: await seedProject(), roleSlug: RECRUITER_SLUG, defectClasses: ['x'] },
				RECRUITER_DRAFT_KEYS
			)
		).rejects.toBeInstanceOf(RecruiterIntegrityError);
	}, 30_000);
});

// ── End-to-end: enqueue → claim (as the orchestrator drain does) → draft ────────────────

describe('hire_request end-to-end through the claim queue (gap A→B)', () => {
	it('a dispatched request is claimable + drains to a propose-only draft; never spends', async () => {
		const project = await seedProject();
		const { slug } = await seedRole();
		const keysBefore = await countGauntletKeys();
		await dispatchHireRequest(db, { projectId: project, roleSlug: slug, defectClasses: ['platform-bug'] });

		// Mirror the orchestrator drain: claim pending items until we reach OUR request (the queue
		// may carry other tests' pending hire_requests). Each claimed item is run + completed,
		// exactly as #runItem does.
		let mine: Awaited<ReturnType<typeof claimNext>> = null;
		for (let i = 0; i < 50; i++) {
			const item = await claimNext(db, `test-claim-${i}`);
			if (!item) break;
			expect(item.workType).toBe('hire_request');
			const payload = item.payload as unknown as HireRequestPayload;
			const outcome = await runHireRequest(db, payload);
			// Complete the item (done) — the queue lifecycle the drain runs.
			expect(await complete(db, item.id, item.claimToken, 'done')).toBe(true);
			if (payload.roleSlug === slug) {
				mine = item;
				expect(outcome.kind).toBe('drafted');
				break;
			}
		}
		expect(mine).not.toBeNull();

		// B2 spend gate held end-to-end: NO gauntlet_key was written, NO interview_run created.
		expect(await countGauntletKeys()).toBe(keysBefore);
		const [runRows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM interview_run GROUP ALL;`
		);
		expect(Number(runRows?.[0]?.c ?? 0)).toBe(0);
	}, 30_000);
});
