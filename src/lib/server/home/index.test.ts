import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask, setStatus } from '../tasks/repo';
import { writeAgentEvent } from '../analytics/events';
import { buildShellMetrics, listFleet } from '../analytics';
import {
	readServicesHealth,
	listRecentActivity,
	buildTaskSummary
} from './index';

// TASK 9.2 VERIFY: the Home read model, end-to-end against the throwaway test DB. Every
// assertion reads back what the live DB persisted — no fabricated runtime data (F-008).
// Covers: services-health rollup, recent-activity feed ordering, portfolio task summary
// GROUP BY, and the shared metric/fleet reads the Home loader composes.

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
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied.length).toBeGreaterThan(0);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('home — empty portfolio (honest zero/empty, F-008)', () => {
	it('reports empty/zero figures from real rows, never fabricated', async () => {
		const services = await readServicesHealth(db);
		expect(services).toEqual({ up: 0, total: 0 });

		const activity = await listRecentActivity(db);
		expect(activity).toEqual([]);

		const summary = await buildTaskSummary(db);
		expect(summary).toEqual({ byStatus: {}, total: 0 });

		const metrics = await buildShellMetrics(db);
		expect(metrics.runningAgents).toBe(0);
		expect(metrics.tokensToday).toBe(0);
		expect(metrics.costToday).toBeNull(); // no priced row ⇒ null, never a fake $0
	});
});

describe('home — services health rollup', () => {
	it('counts up vs total from real service rows', async () => {
		await db.query(`UPSERT service:ollama CONTENT { name: 'ollama', status: 'running' };`);
		await db.query(`UPSERT service:surrealdb CONTENT { name: 'surrealdb', status: 'running' };`);
		await db.query(`UPSERT service:engine CONTENT { name: 'engine', status: 'stopped' };`);

		const health = await readServicesHealth(db);
		expect(health.total).toBe(3);
		expect(health.up).toBe(2);
	});
});

describe('home — portfolio task summary (GROUP BY across projects)', () => {
	it('counts tasks by status across all projects', async () => {
		const p = await createProject(db, {
			slug: 'home_tasks',
			name: 'Home Tasks',
			root_path: 'F:/code/home_tasks'
		});
		// 3 backlog (default), then move two to in_progress.
		const t1 = await createTask(db, { project: p.id, title: 'one', description: 'a' });
		const t2 = await createTask(db, { project: p.id, title: 'two', description: 'b' });
		await createTask(db, { project: p.id, title: 'three', description: 'c' });
		await setStatus(db, t1.id, 'ready');
		await setStatus(db, t1.id, 'in_progress');
		await setStatus(db, t2.id, 'ready');
		await setStatus(db, t2.id, 'in_progress');

		const summary = await buildTaskSummary(db);
		expect(summary.total).toBe(3);
		expect(summary.byStatus['in_progress']).toBe(2);
		expect(summary.byStatus['backlog']).toBe(1);
	});
});

describe('home — recent activity feed', () => {
	it('returns the most recent agent_event rows, newest first, with model + links', async () => {
		const p = await createProject(db, {
			slug: 'home_act',
			name: 'Home Activity',
			root_path: 'F:/code/home_act'
		});

		await writeAgentEvent(db, {
			type: 'spawn',
			project: p.id,
			model: { provider: 'anthropic', modelId: 'claude-opus-4-8', tier: 'opus' }
		});
		await writeAgentEvent(db, {
			type: 'completion',
			project: p.id,
			model: { provider: 'anthropic', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn: 100,
			tokensOut: 50,
			costUsd: 0.42
		});

		const feed = await listRecentActivity(db, 8);
		expect(feed.length).toBeGreaterThanOrEqual(2);
		// Newest first: the most recent should be the completion we wrote last.
		expect(feed[0].type).toBe('completion');
		expect(feed[0].model).toBe('anthropic/claude-opus-4-8');
		expect(feed[0].projectId).toBe(p.id);
	});
});

describe('home — shared shell metrics + fleet reflect today’s real events', () => {
	it('today’s tokens/cost sum from real rows; fleet reflects sessions', async () => {
		// The completion above carried tokens + a priced cost today.
		const metrics = await buildShellMetrics(db);
		expect(metrics.tokensToday).toBeGreaterThanOrEqual(150);
		expect(metrics.costToday).not.toBeNull();
		expect(metrics.costToday).toBeGreaterThanOrEqual(0.42);

		// A running session shows up in the fleet (liveness = session.status).
		await db.query(
			`CREATE session CONTENT {
				kind: 'task',
				model: { provider: 'anthropic', model_id: 'claude-opus-4-8', tier: 'opus' },
				status: 'running',
				runtime: 'claude-code'
			};`
		);
		const fleet = await listFleet(db, 24);
		expect(fleet.some((s) => s.status === 'running')).toBe(true);
		const running = fleet.filter((s) => s.status === 'running');
		expect(running[0].provider).toBe('anthropic');
	});
});
