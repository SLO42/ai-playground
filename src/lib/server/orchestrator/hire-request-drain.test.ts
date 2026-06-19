import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { assertRecordId } from '../db/validate';
import { EventBus } from '../events/bus';
import { ClaudeCodeRuntime, type CcBackend, type CcSpawnPlan, type RuntimeEvent } from '../runtime/index';
import { createRole, createRoleVersion } from '../workforce/repo';
import { dispatchHireRequest } from '../workforce/hire-dispatch';
import { seedRecruiterRole } from '../workforce/launch-fixtures';
import { RECRUITER_SLUG } from '../workforce/recruiter';
import { Orchestrator, type StubRoute } from './index';
import { countByStatus } from './workqueue';

// AQ2 (PH1 deferral) — orchestrator-level VERIFY for the `hire_request` work_item drain FORK,
// the sibling of the proven `memory_review` fork (fast-tier-drain.test.ts). The fork lives in
// orchestrator.ts #runItem (~L416) → #runHireRequestItem (~L553) and was previously covered only
// by code-read + the hire-dispatch unit test (which claims the queue MANUALLY, not via the
// orchestrator drain). This drives the REAL orchestrator drain against a throwaway SurrealDB and
// asserts the work_item's terminal status (done/failed) under the SAME D-021 cap + claim-token
// the drain enforces — mirroring the memory_review harness. Proven here:
//   (a) a RESOLVABLE role (catalog role + version) → runHireRequest drafts PROPOSE-ONLY → item DONE;
//   (b) a B1 self-cert target (the recruiter itself) → RecruiterIntegrityError → item FAILED, the
//       drain SURVIVES (never crashes); both under the cap + single claim (no double-fire).
//
// TEST-ONLY (per the deferral): production code is unchanged — the fork is correct, just untested
// at the orchestrator level.

/** A backend that must never be invoked by the hire_request path (it routes BEFORE task-spawn). */
function unusedBackend(): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan) {
			plans.push(plan);
			return {
				ccSessionId: 'cc_unused',
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'x', ccSessionId: 'cc_unused' } };
				},
				async cancel() {}
			};
		},
		async resume(req: { ccSessionId: string }) {
			return { ccSessionId: req.ccSessionId, async *stream() {}, async cancel() {} };
		},
		async interject() {}
	};
}

function stubRoute(): () => StubRoute {
	return () => ({
		agentId: 'agent_coder_1',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		toolPolicy: { allow: ['Read'] }
	});
}

let tdb: TestDb;
let db: Db;
let projectId: string;

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
	const p = await createProject(db, { slug: 'hrdrain', name: 'HR Drain', root_path: 'F:/code/hrdrain' });
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function clearQueue(): Promise<void> {
	await db.query(`DELETE work_item;`);
}

let roleCount = 0;
/** A real catalog role + a (draft) version — a RESOLVABLE cert target for the hire_request drain. */
async function seedResolvableRole(): Promise<{ slug: string }> {
	const n = ++roleCount;
	const slug = `hrdrain-role-${n}`;
	const role = await createRole(db, { slug, name: `HR Drain Role ${n}`, purpose: 'hire_request drain test bed' });
	await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are role #${n}.`,
		default_tier: 'sonnet',
		source: 'operator'
	});
	return { slug };
}

function orch(opts?: { dailySpawnCap?: number }): Orchestrator {
	const runtime = new ClaudeCodeRuntime({ backend: unusedBackend(), harnessConfigRoot: 'F:/code/hrdrain/.h' });
	return new Orchestrator({
		db,
		bus: new EventBus(),
		runtime,
		maxConcurrent: 4,
		mode: 'manual',
		route: stubRoute(),
		dailySpawnCap: opts?.dailySpawnCap
		// NOTE: no `memory` dep — the hire_request fork routes before the memory_review fork and
		// never touches the review LLM seam (it is a recruiter DRAFT, not a memory write).
	});
}

/** Terminal-status of ONE hire_request work_item (no session link — keyed by id). */
async function statusOf(workItemId: string): Promise<string> {
	const [rows] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM $id;`, {
		id: new StringRecordId(assertRecordId(workItemId))
	});
	return rows[0]?.status ?? '';
}

async function waitForTerminal(workItemId: string, ms = 8000): Promise<string> {
	const start = Date.now();
	for (;;) {
		const s = await statusOf(workItemId);
		if (s === 'done' || s === 'failed') return s;
		if (Date.now() - start > ms) throw new Error(`timeout waiting for hire_request ${workItemId} terminal (was '${s}')`);
		await new Promise((r) => setTimeout(r, 30));
	}
}

describe('AQ2 — hire_request drain fork (orchestrator #runItem → #runHireRequestItem)', () => {
	it('(a) a RESOLVABLE role drains to a PROPOSE-ONLY draft and the work_item completes DONE', async () => {
		await clearQueue();
		const { slug } = await seedResolvableRole();
		// Dispatch via the REAL producer (the affordance the operator/PM triggers).
		const res = await dispatchHireRequest(db, {
			projectId,
			roleSlug: slug,
			defectClasses: ['platform-bug']
		});
		expect(res.enqueued).toBe(true);
		const workItemId = res.workItemId!;
		expect(workItemId).toBeTruthy();

		// Drive the orchestrator drain (claims under the D-021 cap + a fresh claim-token, then runs
		// #runHireRequestItem → runHireRequest → draftCertificationSet, PROPOSE-ONLY).
		const summary = await orch().drain();
		expect(summary.claimed).toBe(1); // exactly one claim — no double-fire
		const terminal = await waitForTerminal(workItemId);
		expect(terminal).toBe('done'); // a resolvable draft is an honest DONE
		expect(await countByStatus(db, 'done')).toBeGreaterThanOrEqual(1);
		expect(await countByStatus(db, 'pending')).toBe(0);
		// B2 — the drain is PROPOSE-ONLY: drafting writes ZERO gauntlet_key rows (no key confirmed).
		const [keyRows] = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM gauntlet_key GROUP ALL;`);
		expect(Number(keyRows?.[0]?.c ?? 0)).toBe(0);
	}, 30_000);

	it('(b) a B1 self-cert target (the recruiter itself) → item FAILED; the drain SURVIVES (no crash)', async () => {
		await clearQueue();
		// Seed the recruiter role so the slug resolves to a real version — the refusal must come from
		// draftCertificationSet's B1 guard (recruiter≠candidate), NOT from an unresolved role.
		await seedRecruiterRole(db);
		const res = await dispatchHireRequest(db, {
			projectId,
			roleSlug: RECRUITER_SLUG, // 'recruiter' — targeting the recruiter itself is self-cert (B1)
			defectClasses: ['integrity']
		});
		expect(res.enqueued).toBe(true);
		const workItemId = res.workItemId!;

		// The drain MUST NOT throw — the RecruiterIntegrityError is caught inside #runItem and the
		// item is marked failed (best-effort, mirroring the memory_review fork).
		const o = orch();
		const summary = await o.drain();
		expect(summary.claimed).toBe(1); // claimed once — the self-cert item, not double-fired
		const terminal = await waitForTerminal(workItemId);
		expect(terminal).toBe('failed'); // B1 refusal → failed, NOT silently done
		expect(await countByStatus(db, 'failed')).toBeGreaterThanOrEqual(1);
		// The drain survived: a SECOND drain over the now-empty queue is still healthy.
		await expect(o.drain()).resolves.toBeTruthy();
	}, 30_000);

	it('(c) the D-021 daily cap THROTTLES the drain (a parked hire_request is not claimed past the cap)', async () => {
		await clearQueue();
		// Pre-load the cap: 2 already-claimed items in the rolling window (claimed_at = now).
		await db.query(
			`CREATE work_item CONTENT { work_type:'task_run', payload:{}, status:'done', claim_token:'h1', claimed_at: time::now(), dedup_scope:'a' };
			 CREATE work_item CONTENT { work_type:'task_run', payload:{}, status:'done', claim_token:'h2', claimed_at: time::now(), dedup_scope:'b' };`
		);
		const { slug } = await seedResolvableRole();
		const res = await dispatchHireRequest(db, { projectId, roleSlug: slug, defectClasses: ['capped'] });
		expect(res.enqueued).toBe(true);
		const workItemId = res.workItemId!;

		// Cap = 2; two already drained ⇒ the new hire_request is parked, never claimed.
		const summary = await orch({ dailySpawnCap: 2 }).drain();
		expect(summary.claimed).toBe(0);
		await new Promise((r) => setTimeout(r, 150));
		expect(await statusOf(workItemId)).toBe('pending'); // parked (honest), not lost / not drafted
	}, 30_000);
});
