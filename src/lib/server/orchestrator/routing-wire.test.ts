// TASK 2.3 VERIFY — WIRE ROUTING (ARCHITECTURE §2.5; DATA-MODEL §4.4; D-020; F-005).
//
// Proves the orchestrator's `route` seam now hosts the REAL async `resolveRoute` instead of a
// hardcoded constant model, against a REAL throwaway SurrealDB + a MOCK Claude Code backend
// (no creds/network — the 1.4 test contract). The route resolver mirrors boot.ts exactly:
// read the task content → resolveRoute (which classifies intent → selects tier → reads provider
// health → WRITES the routing_event with rationale) → map onto the spawn plan.
//
// ASSERTIONS (the 2.3 contract):
//   • The chosen model is TASK-DEPENDENT — a "simple-question" routes to the cheapest tier and a
//     "code-debug" routes to a dearer one. A hardcoded DEFAULT_MODEL could not produce two
//     different tiers from two different tasks → this is what proves the constant is gone.
//   • A routing_event row is WRITTEN for each task, carrying the method + a rationale + the
//     intent (the trace) — the operator's how/why record (analytics first-class, F-008 honest).
//   • The orchestrator AWAITS the async route and still drives EXACTLY ONE spawn per task
//     (the exactly-one-spawn + no-double-fire guarantees survive the async seam).
//   • The spawn the runtime actually received carries the resolveRoute-chosen model (the route
//     flows through launchSession → SpawnRequest, not bypassed).

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
import { loadAgentPool, loadOrchestration } from '../config/index';
import { resolveRoute, type RouteTask } from '../routing/index';
import type { ProviderHealth } from '../providers/index';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { Orchestrator, type StubRoute, type RouteResolver } from './index';
import { countByStatus } from './workqueue';

const FIX = join(process.cwd(), 'src/lib/server/config/__fixtures__');

// ── A mock backend that records the model of every spawn it received. ───────────────
function recordingBackend(): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	const self = {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			const ccSessionId = `cc_${plan.agentId}_${plans.length}_${Math.random().toString(36).slice(2, 10)}`;
			return {
				ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'log', message: 'started' };
					yield { type: 'token_usage', input: 5, output: 3 };
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

/**
 * The production route resolver, mirrored (boot.ts bootRoute). Reads the task content, runs the
 * REAL resolveRoute (which writes the routing_event), maps onto the spawn plan. The ONLY test
 * seam is `providerHealth` — injected deterministic so the run needs no live provider (F-008:
 * the test injecting health is not fabricated PRODUCT data; every row read back is real).
 */
function realRoute(
	db: Db,
	pool: ReturnType<typeof loadAgentPool>,
	orch: ReturnType<typeof loadOrchestration>,
	providerHealth: () => Promise<ProviderHealth[]>
): RouteResolver {
	return async (taskId: string, projectId: string): Promise<StubRoute> => {
		const [rows] = await db.query<[Array<{ id: unknown; title?: string; description?: string }>]>(
			`SELECT id, title, description FROM ONLY $tid;`,
			{ tid: new StringRecordId(taskId) }
		);
		const row = (Array.isArray(rows) ? rows[0] : rows) as { id: unknown; title?: string; description?: string };
		const task: RouteTask = {
			id: String(row.id),
			project: projectId,
			title: row.title ?? '',
			description: row.description ?? ''
		};
		const plan = await resolveRoute({ db, task, pool, orchestration: orch, providerHealth });
		const slot = plan.model.tier ? pool.slots.find((s) => s.tier === plan.model.tier) : undefined;
		return {
			agentId: slot?.id ?? pool.slots[0].id,
			model: plan.model,
			intent: plan.intent,
			budgets: plan.budgets,
			toolPolicy: { allow: ['Read'] }
		};
	};
}

/** All providers up — so the tier resolveRoute picks is the COMPLEXITY pick, not a fallback. */
const allUp: () => Promise<ProviderHealth[]> = async () => [
	{ provider: 'ollama', up: true },
	{ provider: 'anthropic', up: true }
];

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
		await new Promise((r) => setTimeout(r, 25));
	}
}

let tdb: TestDb;
let db: Db;
let projectId: string;
let pool: ReturnType<typeof loadAgentPool>;
let orch: ReturnType<typeof loadOrchestration>;

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
	const p = await createProject(db, { slug: 'rwire', name: 'Routing Wire', root_path: 'F:/code/rwire' });
	projectId = p.id;
	pool = loadAgentPool(join(FIX, 'agent-pool.yaml'));
	orch = loadOrchestration(join(FIX, 'orchestration.yaml'));
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function routingEventsFor(taskId: string): Promise<Array<Record<string, unknown>>> {
	const tid = new StringRecordId(taskId);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT at, method, reason, complexity, chosen FROM routing_event WHERE task = $tid ORDER BY at ASC;`,
		{ tid }
	);
	return rows ?? [];
}

describe('WIRE ROUTING — orchestrator route seam runs resolveRoute (TASK 2.3 VERIFY)', () => {
	it('drives ONE spawn per task and writes a routing_event with rationale + intent', async () => {
		await db.query(`DELETE work_item; DELETE routing_event;`);
		const bus = new EventBus();
		const backend = recordingBackend();
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/rwire/.harness-cc' });
		const orchestrator = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 4,
			mode: 'event',
			route: realRoute(db, pool, orch, allUp)
		});
		orchestrator.start();
		const watch = await watchTable(db, bus, 'task');

		try {
			const task = await createTask(db, {
				project: projectId,
				title: 'Investigate the whole system architecture and evaluate tradeoffs',
				description: 'A deep-explore task — should route to the dearest capable tier.'
			});
			await setStatus(db, task.id, 'ready');

			await waitFor(async () => (await countByStatus(db, 'done')) >= 1);
			await new Promise((r) => setTimeout(r, 150)); // settle: catch any (forbidden) double-fire

			// EXACTLY ONE spawn — the async route did not break the one-spawn guarantee.
			expect(orchestrator.spawnCount).toBe(1);
			expect(await countByStatus(db, 'done')).toBe(1);
			expect(await countByStatus(db, 'pending')).toBe(0);
			expect(await countByStatus(db, 'processing')).toBe(0);

			// A routing_event was WRITTEN for the task, carrying a rationale + the intent (trace).
			const events = await routingEventsFor(task.id);
			expect(events.length).toBe(1);
			const ev = events[0];
			expect(String(ev.reason ?? '')).toContain('deep-explore'); // intent folded into the rationale
			expect(String(ev.reason ?? '').length).toBeGreaterThan(0);
			expect(['classify', 'fallback', 'tier', 'explicit']).toContain(ev.method);

			// The model the runtime ACTUALLY spawned with came from resolveRoute (flowed through
			// launchSession → SpawnRequest), and the routing_event records that SAME chosen model.
			expect(backend.plans.length).toBe(1);
			const chosen = (ev.chosen ?? {}) as Record<string, unknown>;
			expect(backend.plans[0].model.modelId).toBe(chosen.model_id);
			expect(backend.plans[0].model.tier).toBe(chosen.tier);
		} finally {
			orchestrator.stop();
			watch.stop();
		}
	}, 30_000);

	it('chooses a TASK-DEPENDENT tier — a constant DEFAULT_MODEL could not (the wire is real)', async () => {
		await db.query(`DELETE work_item; DELETE routing_event;`);
		const bus = new EventBus();
		const backend = recordingBackend();
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/rwire/.harness-cc2' });
		const orchestrator = new Orchestrator({
			db,
			bus,
			runtime,
			maxConcurrent: 4,
			mode: 'event',
			route: realRoute(db, pool, orch, allUp)
		});
		orchestrator.start();
		const watch = await watchTable(db, bus, 'task');

		try {
			// A trivial question → the cheapest tier (the `local` floor). A heavy explore → the top.
			const cheap = await createTask(db, {
				project: projectId,
				title: 'What is the build command?',
				description: ''
			});
			const heavy = await createTask(db, {
				project: projectId,
				title: 'Investigate and evaluate the whole system architecture and its tradeoffs',
				description: 'A deep architectural exploration across the entire codebase.'
			});
			await setStatus(db, cheap.id, 'ready');
			await setStatus(db, heavy.id, 'ready');

			await waitFor(async () => (await countByStatus(db, 'done')) >= 2);
			await new Promise((r) => setTimeout(r, 150));

			const cheapEv = (await routingEventsFor(cheap.id))[0];
			const heavyEv = (await routingEventsFor(heavy.id))[0];
			const cheapTier = String((cheapEv.chosen as Record<string, unknown>).tier);
			const heavyTier = String((heavyEv.chosen as Record<string, unknown>).tier);

			// THE proof the constant is gone: two tasks → two DIFFERENT tiers, driven by content.
			expect(cheapTier).not.toBe(heavyTier);
			// Intent shows in each rationale (simple-question vs deep-explore).
			expect(String(cheapEv.reason)).toContain('simple-question');
			expect(String(heavyEv.reason)).toContain('deep-explore');
			// The complexity ladder ordering: the explore tier sits above the question tier.
			const ladder = ['local', 'haiku', 'sonnet', 'opus'];
			expect(ladder.indexOf(heavyTier)).toBeGreaterThan(ladder.indexOf(cheapTier));
		} finally {
			orchestrator.stop();
			watch.stop();
		}
	}, 30_000);
});
