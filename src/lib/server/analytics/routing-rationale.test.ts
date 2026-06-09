import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { writeRoutingEvent } from '../routing/resolve';
import {
	buildRoutingRationale,
	aggregateDecisions,
	type RoutingDecision
} from './routing-rationale';

// TASK 11.1 VERIFY — RoutingRationale analytics from REAL routing_event rows (F-008).
// The pure aggregate fold is unit-tested in isolation; the DB-backed builder is tested
// against the live throwaway DB so we prove: per-decision rationale is read back faithfully,
// the project/model filters narrow honestly, the outcome join derives from real session
// status (and "pending" when none), the datetime is coerced to an ISO string (F-013), and
// the override rate is computed from real rows (never fabricated).

describe('aggregateDecisions (pure)', () => {
	function dec(over: Partial<RoutingDecision>): RoutingDecision {
		return {
			id: 'routing_event:x',
			at: '2026-06-01T00:00:00Z',
			taskId: null,
			projectId: null,
			provider: 'claude',
			model: 'claude-opus-4-8',
			tier: 'opus',
			method: 'classify',
			reason: '[code-write] classify',
			complexity: 0.5,
			alternatives: [],
			outcome: 'pending',
			...over
		};
	}

	it('buckets by tier/model/method and computes the override rate', () => {
		const agg = aggregateDecisions([
			dec({ tier: 'opus', method: 'classify' }),
			dec({ tier: 'haiku', model: 'claude-haiku', method: 'classify' }),
			dec({ tier: 'sonnet', model: 'claude-sonnet', method: 'explicit' })
		]);
		expect(agg.total).toBe(3);
		expect(agg.overrides).toBe(1);
		expect(agg.overrideRate).toBeCloseTo(1 / 3, 5);
		expect(agg.byTier.find((b) => b.name === 'opus')?.count).toBe(1);
		expect(agg.byMethod.find((b) => b.name === 'classify')?.count).toBe(2);
		expect(agg.byModel.length).toBe(3);
	});

	it('returns a null override rate for an empty decision list (no fabricated 0%)', () => {
		const agg = aggregateDecisions([]);
		expect(agg.total).toBe(0);
		expect(agg.overrideRate).toBeNull();
		expect(agg.byTier).toEqual([]);
	});

	it('buckets an untiered decision under "untiered"', () => {
		const agg = aggregateDecisions([dec({ tier: null })]);
		expect(agg.byTier[0]).toEqual({ name: 'untiered', count: 1 });
	});
});

describe('buildRoutingRationale (DB-backed — F-008/F-013)', () => {
	let tdb: TestDb;
	let db: Db;
	let projectId: string;
	let otherProjectId: string;
	let taskId: string;

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

		const p = await createProject(db, { slug: 'rr', name: 'Rationale Host', root_path: 'F:/code/rr' });
		projectId = p.id;
		const o = await createProject(db, { slug: 'rr2', name: 'Other', root_path: 'F:/code/rr2' });
		otherProjectId = o.id;

		const t = await createTask(db, {
			project: projectId,
			title: 'Implement the widget endpoint',
			description: 'add a REST endpoint'
		});
		taskId = t.id;

		// A classify decision on a task that we will mark "done" via a session.
		await writeRoutingEvent(db, {
			task: taskId,
			project: projectId,
			chosen: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			method: 'classify',
			reason: 'classify code-write → complexity 0.55 → tier opus',
			intent: 'code-write',
			complexity: 0.55,
			alternatives: [{ tier: 'haiku', provider: 'claude', reason: 'too weak' }]
		});
		// An explicit override on the OTHER project (so the override rate + project filter bite).
		await writeRoutingEvent(db, {
			project: otherProjectId,
			chosen: { provider: 'ollama', modelId: 'gpt-oss-20b', tier: 'local' },
			method: 'explicit',
			reason: 'explicit override → ollama/gpt-oss-20b',
			intent: 'simple-question'
		});

		// A real session for the task, status=done → drives the outcome join.
		const { StringRecordId } = await import('surrealdb');
		await db.query(
			`CREATE session CONTENT {
				project: $project, task: $task,
				model: { provider: 'claude', model_id: 'claude-opus-4-8', tier: 'opus' },
				status: 'done', kind: 'task'
			};`,
			{ project: new StringRecordId(projectId), task: new StringRecordId(taskId) }
		);
	}, 90_000);

	afterAll(async () => {
		await deleteProject(db, projectId).catch(() => {});
		await deleteProject(db, otherProjectId).catch(() => {});
		await db?.close().catch(() => {});
		await tdb?.teardown();
	});

	it('reads decisions with their persisted rationale + ISO datetime (F-013)', async () => {
		const { decisions } = await buildRoutingRationale(db, { windowDays: 2 });
		expect(decisions.length).toBe(2);
		const d = decisions.find((x) => x.method === 'classify');
		expect(d).toBeTruthy();
		expect(d!.provider).toBe('claude');
		expect(d!.model).toBe('claude-opus-4-8');
		expect(d!.tier).toBe('opus');
		expect(d!.reason).toContain('code-write'); // intent folded into the WHY
		expect(d!.complexity).toBeCloseTo(0.55, 5);
		expect(d!.alternatives.length).toBe(1);
		// F-013: the datetime came back as a real ISO string, not a DateTime object dump.
		expect(typeof d!.at).toBe('string');
		expect(d!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('computes the override rate from real rows', async () => {
		const { aggregate } = await buildRoutingRationale(db, { windowDays: 2 });
		expect(aggregate.total).toBe(2);
		expect(aggregate.overrides).toBe(1);
		expect(aggregate.overrideRate).toBeCloseTo(0.5, 5);
		expect(aggregate.byMethod.map((b) => b.name).sort()).toEqual(['classify', 'explicit']);
	});

	it('narrows by project filter honestly', async () => {
		const { decisions } = await buildRoutingRationale(db, { windowDays: 2, projectId: otherProjectId });
		expect(decisions.length).toBe(1);
		expect(decisions[0].method).toBe('explicit');
		expect(decisions[0].provider).toBe('ollama');
	});

	it('narrows by model filter honestly', async () => {
		const { decisions } = await buildRoutingRationale(db, { windowDays: 2, model: 'gpt-oss-20b' });
		expect(decisions.length).toBe(1);
		expect(decisions[0].model).toBe('gpt-oss-20b');
	});

	it('derives a real outcome from the task session (done), pending when none', async () => {
		const { decisions } = await buildRoutingRationale(db, { windowDays: 2 });
		const withTask = decisions.find((x) => x.taskId === taskId);
		expect(withTask).toBeTruthy();
		expect(withTask!.outcome).toBe('done'); // joined from the real session status
		// The override decision has no task → outcome must be pending (honest, not fabricated).
		const noTask = decisions.find((x) => x.taskId === null);
		expect(noTask!.outcome).toBe('pending');
	});
});
