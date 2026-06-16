import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { EventBus } from '../events/bus';
import { ClaudeCodeRuntime, type CcBackend, type CcSpawnPlan, type RuntimeEvent } from '../runtime/index';
import {
	MemoryService,
	FakeEmbedder,
	enqueueReview,
	type ExtractFn,
	type MemoryCandidate
} from '../memory/index';
import { assertRecordId } from '../db/validate';
import { Orchestrator, type StubRoute } from './index';
import { countByStatus } from './workqueue';

// BL-7 Part B (D-027 FAST tier DRAIN dispatch) — VERIFY the orchestrator #runItem now EXECUTES a
// drained `memory_review` work_item (runReviewFork) instead of early-returning (MEMORY-UTILIZATION
// SPEC §5.2/§5.2a). The dead drain side (orchestrator.ts #runItem read only payload.taskId → a
// memory_review never ran; runReviewFork had ZERO non-test callers) is now wired against a REAL
// throwaway SurrealDB (FakeEmbedder for determinism; the review LLM is the injected `extract` seam
// — a mock in a TEST is allowed, F-008). Proven here:
//   (1) a drained memory_review runs the fork and writes ADD-only memory rows; the item completes 'done';
//   (2) the D-021 daily cap THROTTLES the drain (a parked review is not claimed past the cap);
//   (3) re-claim of the SAME logical work is idempotent (no double memory write — dedup at enqueue);
//   (4) a fork failure marks the item 'failed' and NEVER crashes the drain (best-effort);
//   (5) ADD-only — the fork has only the MemoryWriteSurface; no delete/mutate/consolidate path runs;
//   (6) no memory dep configured ⇒ the item fails HONESTLY (no fake success, F-008).

/** A backend that should never be invoked by the memory_review path (asserts the dispatch fork). */
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
let mem: MemoryService;

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
	const p = await createProject(db, { slug: 'ftdrain', name: 'FT Drain', root_path: 'F:/code/ftdrain' });
	projectId = p.id;
	mem = new MemoryService({ db, embedder: new FakeEmbedder(), cache: false });
}, 90_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function clearQueue(): Promise<void> {
	await db.query(`DELETE work_item;`);
}

async function makeSession(kind = 'task'): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
		   kind: $kind, model: { provider: "claude", model_id: "claude-opus-4-8" }, runtime: "claude-code"
		 } RETURN AFTER;`,
		{ kind }
	);
	return String(rows[0].id);
}

async function countMemoriesFor(session: string): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM memory WHERE session = $sid GROUP ALL;`,
		{ sid: new StringRecordId(assertRecordId(session)) }
	);
	return rows[0]?.c ?? 0;
}

function orchWith(opts: {
	bus: EventBus;
	extract: ExtractFn;
	withMemory?: boolean;
	dailySpawnCap?: number;
}): Orchestrator {
	const runtime = new ClaudeCodeRuntime({ backend: unusedBackend(), harnessConfigRoot: 'F:/code/ftdrain/.h' });
	return new Orchestrator({
		db,
		bus: opts.bus,
		runtime,
		maxConcurrent: 4,
		mode: 'manual',
		route: stubRoute(),
		dailySpawnCap: opts.dailySpawnCap,
		memory: opts.withMemory === false ? undefined : { service: mem, extract: opts.extract }
	});
}

describe('BL-7 Part B — memory_review drain dispatch', () => {
	it('(1) a drained memory_review runs the fork and writes ADD-only memory; the item completes done', async () => {
		await clearQueue();
		const session = await makeSession();
		const enq = await enqueueReview(db, {
			session,
			kind: 'memory',
			project: projectId,
			turnText: 'the project uses SurrealDB 2.x and Svelte 5 runes'
		});
		expect(enq).not.toBeNull();

		const extract: ExtractFn = async (): Promise<MemoryCandidate[]> => [
			{ content: 'Atelier uses SurrealDB 2.x', kind: 'semantic', source: 'review-fork' },
			{ content: 'Atelier dashboard uses Svelte 5 runes', kind: 'semantic', source: 'review-fork' }
		];
		const orch = orchWith({ bus: new EventBus(), extract });
		const summary = await orch.drain();
		// The drain claimed + ran the review item.
		expect(summary.claimed).toBe(1);
		// Let the fire-and-forget #runItem settle (it awaits the fork, then completes the item).
		await waitForDone(session);
		expect(await countMemoriesFor(session)).toBe(2);
		expect(await countByStatus(db, 'done')).toBeGreaterThanOrEqual(1);
		expect(await countByStatus(db, 'pending')).toBe(0);
		orch.stop();
	}, 30_000);

	it('(2) the D-021 daily cap THROTTLES the drain (parked review not claimed past the cap)', async () => {
		await clearQueue();
		// Pre-load the cap: 2 already-claimed items in the window (claimed_at stamped now).
		await db.query(
			`CREATE work_item CONTENT { work_type:'task_run', payload:{}, status:'done', claim_token:'t1', claimed_at: time::now(), dedup_scope:'a' };
			 CREATE work_item CONTENT { work_type:'task_run', payload:{}, status:'done', claim_token:'t2', claimed_at: time::now(), dedup_scope:'b' };`
		);
		const session = await makeSession();
		await enqueueReview(db, { session, kind: 'memory', project: projectId, turnText: 'capped turn' });

		let extractCalled = false;
		const extract: ExtractFn = async () => {
			extractCalled = true;
			return [{ content: 'should not run under the cap' }];
		};
		// Cap = 2; two already drained ⇒ the new review is parked, never claimed.
		const orch = orchWith({ bus: new EventBus(), extract, dailySpawnCap: 2 });
		const summary = await orch.drain();
		expect(summary.claimed).toBe(0);
		await new Promise((r) => setTimeout(r, 150));
		expect(extractCalled).toBe(false);
		expect(await countMemoriesFor(session)).toBe(0);
		// The review is STILL pending (parked, honest) — not lost.
		expect(await countByStatus(db, 'pending')).toBe(1);
		orch.stop();
	}, 30_000);

	it('(3) re-claim of the same logical review is idempotent — the per-session dedup prevents a double write', async () => {
		await clearQueue();
		const session = await makeSession();
		// First enqueue succeeds; a SECOND enqueue for the same session coalesces (dedup → null) while
		// the first is pending — so a rapid re-run can never queue (or drain) two writes for one turn.
		const first = await enqueueReview(db, { session, kind: 'memory', project: projectId, turnText: 'turn A' });
		const second = await enqueueReview(db, { session, kind: 'memory', project: projectId, turnText: 'turn B' });
		expect(first).not.toBeNull();
		expect(second).toBeNull(); // dedup coalesced — exactly one pending review

		const extract: ExtractFn = async () => [{ content: 'one durable note from the turn' }];
		const orch = orchWith({ bus: new EventBus(), extract });
		await orch.drain();
		await waitForDone(session);
		// Exactly ONE memory written (one item drained), not two.
		expect(await countMemoriesFor(session)).toBe(1);
		orch.stop();
	}, 30_000);

	it('(4) a fork failure marks the item failed and never crashes the drain (best-effort)', async () => {
		await clearQueue();
		const session = await makeSession();
		await enqueueReview(db, { session, kind: 'memory', project: projectId, turnText: 'boom turn' });
		const extract: ExtractFn = async () => {
			throw new Error('review LLM unreachable');
		};
		const orch = orchWith({ bus: new EventBus(), extract });
		// The drain itself does not throw (the fork failure is caught inside #runItem).
		await expect(orch.drain()).resolves.toBeTruthy();
		await waitForTerminal(session);
		expect(await countMemoriesFor(session)).toBe(0); // nothing written on a failed fork
		expect(await countByStatus(db, 'failed')).toBeGreaterThanOrEqual(1);
		orch.stop();
	}, 30_000);

	it('(5) ADD-only — a drained review never deletes/mutates an existing memory (D-028)', async () => {
		await clearQueue();
		const session = await makeSession();
		// Seed a pre-existing memory; after a review drain it must STILL exist unchanged.
		const seeded = await mem.store([{ content: 'pre-existing durable fact', project: projectId, importance: 7 }]);
		const seededId = seeded[0].id;
		await enqueueReview(db, { session, kind: 'memory', project: projectId, turnText: 'a new turn' });
		const extract: ExtractFn = async () => [{ content: 'a brand new additive fact' }];
		const orch = orchWith({ bus: new EventBus(), extract });
		await orch.drain();
		await waitForDone(session);
		// The seeded row is untouched (not archived/deleted/mutated) — the fork is ADD-only.
		const [rows] = await db.query<[Array<{ content: string; status: string }>]>(
			`SELECT content, status FROM $id;`,
			{ id: new StringRecordId(assertRecordId(seededId)) }
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toBe('pre-existing durable fact');
		expect(rows[0].status).not.toBe('archived');
		orch.stop();
	}, 30_000);

	it('(6) no memory dep configured ⇒ the review fails HONESTLY (no fake success, F-008)', async () => {
		await clearQueue();
		const session = await makeSession();
		await enqueueReview(db, { session, kind: 'memory', project: projectId, turnText: 'orphan turn' });
		const orch = orchWith({ bus: new EventBus(), extract: async () => [], withMemory: false });
		await orch.drain();
		await waitForTerminal(session);
		// No fork could run (no review LLM) — the item is marked failed, never silently 'done'.
		expect(await countByStatus(db, 'failed')).toBeGreaterThanOrEqual(1);
		expect(await countByStatus(db, 'done')).toBe(0);
		orch.stop();
	}, 30_000);
});

// ── helpers ──────────────────────────────────────────────────────────────────────

async function waitForDone(session: string, ms = 8000): Promise<void> {
	const start = Date.now();
	for (;;) {
		const [rows] = await db.query<[Array<{ status: string }>]>(
			`SELECT status FROM work_item WHERE work_type = 'memory_review' AND session = $sid;`,
			{ sid: new StringRecordId(assertRecordId(session)) }
		);
		if (rows.length && rows.every((r) => r.status === 'done')) return;
		if (Date.now() - start > ms) throw new Error('timeout waiting for review item done');
		await new Promise((r) => setTimeout(r, 30));
	}
}

async function waitForTerminal(session: string, ms = 8000): Promise<void> {
	const start = Date.now();
	for (;;) {
		const [rows] = await db.query<[Array<{ status: string }>]>(
			`SELECT status FROM work_item WHERE work_type = 'memory_review' AND session = $sid;`,
			{ sid: new StringRecordId(assertRecordId(session)) }
		);
		if (rows.length && rows.every((r) => r.status === 'done' || r.status === 'failed')) return;
		if (Date.now() - start > ms) throw new Error('timeout waiting for review item terminal');
		await new Promise((r) => setTimeout(r, 30));
	}
}
