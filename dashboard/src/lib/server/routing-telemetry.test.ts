// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
	logRoutingDecision,
	getRoutingStats,
	getRecentDecisions,
	getWorkflowStats,
	_resetForTesting,
	type RoutingDecision
} from './routing-telemetry.js';

let testDb: Database.Database;

function makeDecision(overrides: Partial<RoutingDecision & { sessionId?: string }> = {}): RoutingDecision {
	return {
		id: crypto.randomUUID().slice(0, 10),
		timestamp: new Date().toISOString(),
		model: 'gpt-oss:20b',
		provider: 'ollama',
		agent: 'coder',
		taskType: 'code-gen',
		complexity: 0.2,
		latencyMs: 150,
		success: true,
		source: 'user',
		...overrides
	};
}

/** Insert a decision directly into the test DB (bypasses logRoutingDecision to control id/timestamp). */
function insertDecision(d: RoutingDecision): void {
	testDb.prepare(`
		INSERT OR IGNORE INTO decisions
			(id, timestamp, model, provider, agent, task_type, complexity, latency_ms, success, source, reason, session_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		d.id, d.timestamp, d.model, d.provider, d.agent,
		d.taskType, d.complexity, d.latencyMs, d.success ? 1 : 0,
		d.source, d.reason ?? null, d.sessionId ?? null
	);
}

beforeEach(() => {
	testDb = new Database(':memory:');
	testDb.pragma('journal_mode = WAL');
	testDb.exec(`
		CREATE TABLE IF NOT EXISTS decisions (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			model TEXT NOT NULL DEFAULT '',
			provider TEXT NOT NULL DEFAULT '',
			agent TEXT NOT NULL DEFAULT '',
			task_type TEXT NOT NULL DEFAULT '',
			complexity REAL NOT NULL DEFAULT 0,
			latency_ms REAL NOT NULL DEFAULT 0,
			success INTEGER NOT NULL DEFAULT 0,
			source TEXT NOT NULL DEFAULT '',
			reason TEXT,
			session_id TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
		CREATE INDEX IF NOT EXISTS idx_decisions_model ON decisions(model);
		CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent);
		CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source);
		CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
		CREATE INDEX IF NOT EXISTS idx_decisions_session_ts ON decisions(session_id, timestamp);
		CREATE INDEX IF NOT EXISTS idx_decisions_tasktype_agent ON decisions(task_type, agent);
	`);
	_resetForTesting(testDb);
});

afterEach(() => {
	_resetForTesting();
});

describe('logRoutingDecision', () => {
	it('creates a new entry and inserts it into the database', async () => {
		insertDecision(makeDecision({ id: 'old' }));

		const entry = await logRoutingDecision({
			model: 'gpt-oss:20b',
			provider: 'ollama',
			agent: 'coder',
			taskType: 'code-gen',
			complexity: 0.5,
			latencyMs: 200,
			success: true,
			source: 'user'
		});

		expect(entry.id).toBeDefined();
		expect(entry.timestamp).toBeDefined();
		expect(entry.model).toBe('gpt-oss:20b');

		const count = testDb.prepare('SELECT COUNT(*) as c FROM decisions').get() as { c: number };
		expect(count.c).toBe(2);
	});

	it('handles concurrent writes without losing entries', async () => {
		const promises = Array.from({ length: 5 }, (_, i) =>
			logRoutingDecision({
				model: 'gpt-oss:20b',
				provider: 'ollama',
				agent: `agent-${i}`,
				taskType: 'test',
				complexity: 0.1,
				latencyMs: 50,
				success: true,
				source: 'user'
			})
		);
		await Promise.all(promises);

		const count = testDb.prepare('SELECT COUNT(*) as c FROM decisions').get() as { c: number };
		expect(count.c).toBe(5);
	});
});

describe('getRoutingStats', () => {
	it('returns zeroed stats for empty database', async () => {
		const stats = await getRoutingStats();
		expect(stats.totalDecisions).toBe(0);
		expect(stats.successRate).toBe(0);
		expect(stats.avgLatencyMs).toBe(0);
		expect(stats.recentDecisions).toEqual([]);
	});

	it('computes correct success rate and avg latency', async () => {
		insertDecision(makeDecision({ id: 'd1', latencyMs: 100, success: true }));
		insertDecision(makeDecision({ id: 'd2', latencyMs: 200, success: false }));
		insertDecision(makeDecision({ id: 'd3', latencyMs: 300, success: true }));

		const stats = await getRoutingStats();
		expect(stats.totalDecisions).toBe(3);
		expect(stats.successRate).toBeCloseTo(2 / 3);
		expect(stats.avgLatencyMs).toBe(200);
	});

	it('groups stats by model', async () => {
		insertDecision(makeDecision({ id: 'd1', model: 'gpt-oss:20b', provider: 'ollama' }));
		insertDecision(makeDecision({ id: 'd2', model: 'claude-sonnet-4-6', provider: 'anthropic' }));
		insertDecision(makeDecision({ id: 'd3', model: 'gpt-oss:20b', provider: 'ollama' }));

		const stats = await getRoutingStats();
		expect(stats.byModel['gpt-oss:20b'].count).toBe(2);
		expect(stats.byModel['claude-sonnet-4-6'].count).toBe(1);
	});

	it('groups stats by agent', async () => {
		insertDecision(makeDecision({ id: 'd1', agent: 'coder' }));
		insertDecision(makeDecision({ id: 'd2', agent: 'reviewer' }));
		insertDecision(makeDecision({ id: 'd3', agent: 'coder' }));

		const stats = await getRoutingStats();
		expect(stats.byAgent['coder'].count).toBe(2);
		expect(stats.byAgent['reviewer'].count).toBe(1);
	});

	it('groups stats by task type', async () => {
		insertDecision(makeDecision({ id: 'd1', taskType: 'code-gen', agent: 'coder' }));
		insertDecision(makeDecision({ id: 'd2', taskType: 'review', agent: 'reviewer' }));
		insertDecision(makeDecision({ id: 'd3', taskType: 'code-gen', agent: 'coder' }));

		const stats = await getRoutingStats();
		expect(stats.byTaskType['code-gen'].count).toBe(2);
		expect(stats.byTaskType['code-gen'].preferredAgent).toBe('coder');
	});

	it('collects task types per agent', async () => {
		insertDecision(makeDecision({ id: 'd1', agent: 'coder', taskType: 'code-gen' }));
		insertDecision(makeDecision({ id: 'd2', agent: 'coder', taskType: 'refactor' }));

		const stats = await getRoutingStats();
		expect(stats.byAgent['coder'].taskTypes).toContain('code-gen');
		expect(stats.byAgent['coder'].taskTypes).toContain('refactor');
	});

	it('returns recent decisions in reverse chronological order', async () => {
		insertDecision(makeDecision({ id: 'first', timestamp: '2026-03-01T10:00:00Z' }));
		insertDecision(makeDecision({ id: 'second', timestamp: '2026-03-02T10:00:00Z' }));
		insertDecision(makeDecision({ id: 'third', timestamp: '2026-03-03T10:00:00Z' }));

		const stats = await getRoutingStats();
		expect(stats.recentDecisions[0].id).toBe('third');
		expect(stats.recentDecisions[2].id).toBe('first');
	});

	it('limits recent decisions to 20', async () => {
		for (let i = 0; i < 30; i++) {
			insertDecision(makeDecision({ id: `d-${i}` }));
		}

		const stats = await getRoutingStats();
		expect(stats.recentDecisions).toHaveLength(20);
	});

	it('computes hourly activity buckets', async () => {
		const stats = await getRoutingStats();
		expect(stats.hourlyActivity).toHaveLength(24);
	});

	it('estimates zero cost for local models', async () => {
		insertDecision(makeDecision({ id: 'd1', model: 'gpt-oss:20b' }));

		const stats = await getRoutingStats();
		expect(stats.byModel['gpt-oss:20b'].costEstimate).toBe(0);
	});

	it('estimates non-zero cost for cloud models', async () => {
		insertDecision(makeDecision({ id: 'd1', model: 'claude-sonnet-4-6', provider: 'anthropic' }));

		const stats = await getRoutingStats();
		expect(stats.byModel['claude-sonnet-4-6'].costEstimate).toBeGreaterThan(0);
	});
});

describe('getRecentDecisions', () => {
	it('returns an empty array when no decisions exist', async () => {
		const recent = await getRecentDecisions();
		expect(recent).toEqual([]);
	});

	it('returns decisions in reverse chronological order', async () => {
		insertDecision(makeDecision({ id: 'a', timestamp: '2026-03-01T10:00:00Z' }));
		insertDecision(makeDecision({ id: 'b', timestamp: '2026-03-02T10:00:00Z' }));

		const recent = await getRecentDecisions();
		expect(recent[0].id).toBe('b');
		expect(recent[1].id).toBe('a');
	});

	it('respects the limit parameter', async () => {
		for (let i = 0; i < 10; i++) {
			insertDecision(makeDecision({ id: `d-${i}` }));
		}

		const recent = await getRecentDecisions(3);
		expect(recent).toHaveLength(3);
	});
});

describe('getWorkflowStats', () => {
	it('returns zeroed stats for empty log', async () => {
		const wfStats = await getWorkflowStats();
		expect(wfStats.escalationRate).toBe(0);
		expect(wfStats.avgChainLength).toBe(0);
		expect(wfStats.clawInitiated).toBe(0);
		expect(wfStats.userInitiated).toBe(0);
		expect(wfStats.recentWorkflows).toEqual([]);
		expect(wfStats.chainPatterns).toEqual([]);
	});

	it('groups decisions into workflow chains by sessionId', async () => {
		insertDecision(makeDecision({ id: 'd1', sessionId: 'sess-1', agent: 'planner', source: 'claw', timestamp: '2026-03-05T10:00:00Z' }));
		insertDecision(makeDecision({ id: 'd2', sessionId: 'sess-1', agent: 'coder', source: 'claw', timestamp: '2026-03-05T10:00:05Z' }));
		insertDecision(makeDecision({ id: 'd3', sessionId: 'sess-2', agent: 'reviewer', source: 'user', timestamp: '2026-03-05T10:01:00Z' }));

		const wfStats = await getWorkflowStats();
		const sess1 = wfStats.recentWorkflows.find((w) => w.sessionId === 'sess-1');
		expect(sess1).toBeDefined();
		expect(sess1!.steps).toHaveLength(2);
		expect(sess1!.steps[0].agent).toBe('planner');
		expect(sess1!.steps[1].agent).toBe('coder');
	});

	it('creates single-step workflows for decisions without sessionId', async () => {
		insertDecision(makeDecision({ id: 'd1', source: 'user' }));

		const wfStats = await getWorkflowStats();
		expect(wfStats.recentWorkflows).toHaveLength(1);
		expect(wfStats.recentWorkflows[0].steps).toHaveLength(1);
		expect(wfStats.recentWorkflows[0].escalated).toBe(false);
	});

	it('detects escalation when providers change within a session', async () => {
		insertDecision(makeDecision({ id: 'd1', sessionId: 's1', provider: 'ollama', agent: 'coder', complexity: 0.1, timestamp: '2026-03-05T10:00:00Z' }));
		insertDecision(makeDecision({ id: 'd2', sessionId: 's1', provider: 'anthropic', agent: 'coder', complexity: 0.5, timestamp: '2026-03-05T10:00:10Z' }));

		const wfStats = await getWorkflowStats();
		const wf = wfStats.recentWorkflows.find((w) => w.sessionId === 's1');
		expect(wf!.escalated).toBe(true);
	});

	it('counts claw-initiated vs user-initiated workflows', async () => {
		insertDecision(makeDecision({ id: 'd1', source: 'claw', sessionId: 'c1' }));
		insertDecision(makeDecision({ id: 'd2', source: 'claw', sessionId: 'c2' }));
		insertDecision(makeDecision({ id: 'd3', source: 'user', sessionId: 'u1' }));

		const wfStats = await getWorkflowStats();
		expect(wfStats.clawInitiated).toBe(2);
		expect(wfStats.userInitiated).toBe(1);
	});

	it('computes source stats with success rate and latency', async () => {
		insertDecision(makeDecision({ id: 'd1', source: 'claw', latencyMs: 100, success: true }));
		insertDecision(makeDecision({ id: 'd2', source: 'claw', latencyMs: 200, success: false }));
		insertDecision(makeDecision({ id: 'd3', source: 'user', latencyMs: 50, success: true }));

		const wfStats = await getWorkflowStats();
		expect(wfStats.bySource['claw'].count).toBe(2);
		expect(wfStats.bySource['claw'].avgLatencyMs).toBe(150);
		expect(wfStats.bySource['claw'].successRate).toBe(0.5);
		expect(wfStats.bySource['user'].count).toBe(1);
		expect(wfStats.bySource['user'].successRate).toBe(1);
	});

	it('identifies chain patterns from repeated agent sequences', async () => {
		insertDecision(makeDecision({ id: 'd1', sessionId: 'a', agent: 'planner', timestamp: '2026-03-05T10:00:00Z' }));
		insertDecision(makeDecision({ id: 'd2', sessionId: 'a', agent: 'coder', timestamp: '2026-03-05T10:00:05Z' }));
		insertDecision(makeDecision({ id: 'd3', sessionId: 'b', agent: 'planner', timestamp: '2026-03-05T10:01:00Z' }));
		insertDecision(makeDecision({ id: 'd4', sessionId: 'b', agent: 'coder', timestamp: '2026-03-05T10:01:05Z' }));

		const wfStats = await getWorkflowStats();
		const plannerCoder = wfStats.chainPatterns.find(
			(p) => p.pattern[0] === 'planner' && p.pattern[1] === 'coder'
		);
		expect(plannerCoder).toBeDefined();
		expect(plannerCoder!.count).toBe(2);
	});

	it('builds agent routing profiles with escalation tracking', async () => {
		insertDecision(makeDecision({
			id: 'd1', sessionId: 's1', agent: 'coder', provider: 'ollama',
			model: 'gpt-oss:20b', taskType: 'code-gen',
			complexity: 0.2, latencyMs: 100, success: true,
			timestamp: '2026-03-05T10:00:00Z'
		}));
		insertDecision(makeDecision({
			id: 'd2', sessionId: 's1', agent: 'reviewer', provider: 'anthropic',
			model: 'claude-sonnet-4-6', taskType: 'review',
			complexity: 0.6, latencyMs: 3000, success: true,
			timestamp: '2026-03-05T10:00:10Z'
		}));

		const wfStats = await getWorkflowStats();
		const coderProfile = wfStats.agentProfiles['coder'];
		expect(coderProfile.totalRouted).toBe(1);
		expect(coderProfile.asFirst).toBe(1);
		expect(coderProfile.escalatedFrom).toBe(1);

		const reviewerProfile = wfStats.agentProfiles['reviewer'];
		expect(reviewerProfile.escalatedTo).toBe(1);
		expect(reviewerProfile.asLast).toBe(1);
	});

	it('limits recent workflows to 10', async () => {
		for (let i = 0; i < 20; i++) {
			insertDecision(makeDecision({ id: `d-${i}`, source: 'user' }));
		}

		const wfStats = await getWorkflowStats();
		expect(wfStats.recentWorkflows.length).toBeLessThanOrEqual(10);
	});
});
