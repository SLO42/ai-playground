// SPAWN-IDENTITY (LB-2 write half) — the drain END-TO-END.
//
// launch-identity.test.ts proves `launchSession` stamps what it is GIVEN. spawn-identity.test.ts
// proves the pool → identity mapping. This proves the MIDDLE LINK that was actually missing: the
// orchestrator drain (`orchestrator.ts` launchSession input block) forwards what the route
// resolved, so a session spawned by the real drain is born with a purposeful identity.
//
// Before this change the drain forwarded `agentId` and nothing else — which is why 0 of 32
// agent-bearing sessions carried a role and 0 of 177 carried a specialist, live.
//
// Real SurrealDB + a mock Claude Code backend (no creds/network). Both directions are asserted:
// a route that resolves an identity lands it, and a route that resolves NONE (every pre-existing
// route seam / test stub) produces the pre-change row exactly — the F-053 regression.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus } from '../events/bus';
import { watchTable } from '../events/db-source';
import { createProject, deleteProject } from '../projects/repo';
import { createTask, setStatus } from '../tasks/repo';
import { loadAgentPool } from '../config/index';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { Orchestrator, type StubRoute, type RouteResolver } from './index';
import { resolveSlotIdentity } from './boot';
import { countByStatus } from './workqueue';

const SHIPPED_POOL = join(process.cwd(), 'config/agent-pool.yaml');

function recordingBackend(): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	const self = {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			const ccSessionId = `cc_${plans.length}_${Math.random().toString(36).slice(2, 10)}`;
			return {
				ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'done', ccSessionId } };
				},
				async cancel() {}
			};
		},
		async resume(req: { ccSessionId: string }) {
			return {
				ccSessionId: req.ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'resumed' } };
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
	return self as unknown as CcBackend & { plans: CcSpawnPlan[] };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
		await new Promise((r) => setTimeout(r, 25));
	}
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
	const p = await createProject(db, { slug: 'dident', name: 'Drain Identity', root_path: 'F:/code/dident' });
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** The session the drain spawned for a task (there is exactly one — the one-spawn guarantee). */
async function sessionForTask(taskId: string): Promise<Record<string, unknown>> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, agent, specialist, role, role_version, model FROM session WHERE task = $tid LIMIT 1;`,
		{ tid: new StringRecordId(taskId) }
	);
	return rows[0] ?? {};
}

/** Drive ONE task through a real Orchestrator with the supplied route, return its session row. */
async function drainOne(
	route: RouteResolver,
	title: string,
	harnessSuffix: string
): Promise<Record<string, unknown>> {
	await db.query(`DELETE work_item;`);
	const bus = new EventBus();
	const runtime = new ClaudeCodeRuntime({
		backend: recordingBackend(),
		harnessConfigRoot: `F:/code/dident/.harness-${harnessSuffix}`
	});
	const orchestrator = new Orchestrator({ db, bus, runtime, maxConcurrent: 2, mode: 'event', route });
	orchestrator.start();
	const watch = await watchTable(db, bus, 'task');
	try {
		const task = await createTask(db, { project: projectId, title, description: 'Read and report.' });
		await setStatus(db, task.id, 'ready');
		await waitFor(async () => (await countByStatus(db, 'done')) >= 1);
		expect(orchestrator.spawnCount).toBe(1);
		return await sessionForTask(task.id);
	} finally {
		orchestrator.stop();
		watch.stop();
	}
}

describe('drain → session identity (the middle link)', () => {
	it('forwards the routed slot NAME + specialist + role onto the session row', async () => {
		// A real role/version pair, as the WORKFORCE-SPEC §7 staffing short-circuit would resolve.
		const [r] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE role CONTENT { slug: "drain-role", name: "Drain Role", purpose: "e2e" } RETURN AFTER;`
		);
		const roleId = String(r[0].id);
		const [v] = await db.query<[Array<{ id: unknown }>]>(`CREATE role_version CONTENT $c RETURN AFTER;`, {
			c: {
				role: new StringRecordId(roleId),
				version: 1,
				prompt_core: 'x',
				prompt_sha: 'sha_drain',
				default_tier: 'sonnet'
			}
		});
		const versionId = String(v[0].id);

		// The route mirrors production: the identity comes from the REAL shipped pool via the REAL
		// resolveSlotIdentity, plus the role the staffing path resolved.
		const pool = loadAgentPool(SHIPPED_POOL);
		const route: RouteResolver = (): StubRoute => ({
			...resolveSlotIdentity(pool, 'sonnet'),
			specialist: 'atelier-developer',
			roleId,
			roleVersionId: versionId,
			model: { provider: 'claude', modelId: 'claude-sonnet-4-6', tier: 'sonnet' },
			intent: 'code-read',
			budgets: { thinking: 'low', toolCalls: 5, concurrency: 1 },
			toolPolicy: { allow: ['Read'] }
		});

		const sess = await drainOne(route, 'Read the queue and report', 'ident');
		// The purposeful name, not the tier bucket — this is the operator-visible fix.
		expect(sess.agent).toBe(resolveSlotIdentity(pool, 'sonnet').agentName);
		expect(sess.agent).not.toBe('sonnet-1');
		expect(sess.specialist).toBe('atelier-developer');
		expect(String(sess.role)).toBe(roleId);
		expect(String(sess.role_version)).toBe(versionId);
	}, 40_000);

	it('REGRESSION: a route with no identity keys spawns exactly as before (F-053)', async () => {
		// This is every pre-existing route seam and test stub: agentId only. The spawn must
		// succeed identically and the row must carry the slot id with no role/specialist —
		// the additive branch engages only when wired.
		const route: RouteResolver = (): StubRoute => ({
			agentId: 'sonnet-1',
			model: { provider: 'claude', modelId: 'claude-sonnet-4-6', tier: 'sonnet' },
			intent: 'code-read',
			budgets: { thinking: 'low', toolCalls: 5, concurrency: 1 },
			toolPolicy: { allow: ['Read'] }
		});

		const sess = await drainOne(route, 'Read the other queue and report', 'legacy');
		expect(sess.agent).toBe('sonnet-1');
		expect(sess.specialist ?? null).toBeNull();
		expect(sess.role ?? null).toBeNull();
		expect(sess.role_version ?? null).toBeNull();
	}, 40_000);
});
