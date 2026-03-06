// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing the module
vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		readFile: vi.fn(),
		writeFile: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined)
	};
});

import { readFile, writeFile } from 'fs/promises';
import {
	logRoutingDecision,
	getRoutingStats,
	getRecentDecisions,
	getWorkflowStats,
	type RoutingDecision
} from './routing-telemetry.js';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);

function makeDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
	return {
		id: 'test-id',
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

beforeEach(() => {
	vi.clearAllMocks();
});

describe('logRoutingDecision', () => {
	it('creates a new entry and prepends it to the log', async () => {
		const existing = [makeDecision({ id: 'old' })];
		mockReadFile.mockResolvedValue(JSON.stringify(existing));

		const result = await logRoutingDecision({
			model: 'gpt-oss:20b',
			provider: 'ollama',
			agent: 'coder',
			taskType: 'code-gen',
			complexity: 0.3,
			latencyMs: 200,
			success: true,
			source: 'user'
		});

		expect(result.model).toBe('gpt-oss:20b');
		expect(result.id).toBeDefined();
		expect(result.timestamp).toBeDefined();

		const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		expect(written).toHaveLength(2);
		expect(written[0].model).toBe('gpt-oss:20b');
		expect(written[1].id).toBe('old');
	});

	it('starts a new log when file does not exist', async () => {
		mockReadFile.mockRejectedValue(new Error('ENOENT'));

		const result = await logRoutingDecision({
			model: 'claude-sonnet-4-6',
			provider: 'anthropic',
			agent: 'reviewer',
			taskType: 'review',
			complexity: 0.5,
			latencyMs: 3000,
			success: true,
			source: 'claw'
		});

		expect(result.agent).toBe('reviewer');
		const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		expect(written).toHaveLength(1);
	});

	it('truncates log to MAX_ENTRIES (500)', async () => {
		const existing = Array.from({ length: 500 }, (_, i) =>
			makeDecision({ id: `entry-${i}` })
		);
		mockReadFile.mockResolvedValue(JSON.stringify(existing));

		await logRoutingDecision({
			model: 'gpt-oss:20b',
			provider: 'ollama',
			agent: 'coder',
			taskType: 'code-gen',
			complexity: 0.1,
			latencyMs: 50,
			success: true,
			source: 'user'
		});

		const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		expect(written).toHaveLength(500);
		// New entry is first
		expect(written[0].latencyMs).toBe(50);
	});

	it('preserves optional fields (reason, sessionId)', async () => {
		mockReadFile.mockRejectedValue(new Error('ENOENT'));

		const result = await logRoutingDecision({
			model: 'gpt-oss:20b',
			provider: 'ollama',
			agent: 'planner',
			taskType: 'planning',
			complexity: 0.4,
			latencyMs: 100,
			success: false,
			source: 'claw',
			reason: 'complexity threshold exceeded',
			sessionId: 'sess-123'
		});

		expect(result.reason).toBe('complexity threshold exceeded');
		expect(result.sessionId).toBe('sess-123');
	});
});

describe('getRecentDecisions', () => {
	it('returns the most recent entries up to limit', async () => {
		const log = Array.from({ length: 30 }, (_, i) =>
			makeDecision({ id: `d-${i}` })
		);
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const recent = await getRecentDecisions(5);
		expect(recent).toHaveLength(5);
		expect(recent[0].id).toBe('d-0');
	});

	it('returns empty array when log is empty', async () => {
		mockReadFile.mockRejectedValue(new Error('ENOENT'));
		const recent = await getRecentDecisions();
		expect(recent).toEqual([]);
	});

	it('defaults to 20 entries', async () => {
		const log = Array.from({ length: 50 }, (_, i) =>
			makeDecision({ id: `d-${i}` })
		);
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const recent = await getRecentDecisions();
		expect(recent).toHaveLength(20);
	});
});

describe('getRoutingStats', () => {
	it('returns zeroed stats for empty log', async () => {
		mockReadFile.mockRejectedValue(new Error('ENOENT'));

		const stats = await getRoutingStats();
		expect(stats.totalDecisions).toBe(0);
		expect(stats.successRate).toBe(0);
		expect(stats.avgLatencyMs).toBe(0);
		expect(stats.recentDecisions).toEqual([]);
		expect(stats.hourlyActivity).toHaveLength(24);
	});

	it('computes correct aggregate stats', async () => {
		const log = [
			makeDecision({ latencyMs: 100, success: true, complexity: 0.2 }),
			makeDecision({ latencyMs: 300, success: false, complexity: 0.8 })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const stats = await getRoutingStats();
		expect(stats.totalDecisions).toBe(2);
		expect(stats.successRate).toBe(0.5);
		expect(stats.avgLatencyMs).toBe(200);
	});

	it('groups stats by model', async () => {
		const log = [
			makeDecision({ model: 'gpt-oss:20b', provider: 'ollama', latencyMs: 50, success: true }),
			makeDecision({ model: 'gpt-oss:20b', provider: 'ollama', latencyMs: 150, success: true }),
			makeDecision({ model: 'claude-sonnet-4-6', provider: 'anthropic', latencyMs: 3000, success: false })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const stats = await getRoutingStats();
		expect(stats.byModel['gpt-oss:20b'].count).toBe(2);
		expect(stats.byModel['gpt-oss:20b'].avgLatencyMs).toBe(100);
		expect(stats.byModel['gpt-oss:20b'].successRate).toBe(1);
		expect(stats.byModel['gpt-oss:20b'].costEstimate).toBe(0); // free local model
		expect(stats.byModel['claude-sonnet-4-6'].count).toBe(1);
		expect(stats.byModel['claude-sonnet-4-6'].costEstimate).toBe(0.003);
	});

	it('groups stats by agent with task types', async () => {
		const log = [
			makeDecision({ agent: 'coder', taskType: 'code-gen' }),
			makeDecision({ agent: 'coder', taskType: 'refactor' }),
			makeDecision({ agent: 'reviewer', taskType: 'review' })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const stats = await getRoutingStats();
		expect(stats.byAgent['coder'].count).toBe(2);
		expect(stats.byAgent['coder'].taskTypes).toContain('code-gen');
		expect(stats.byAgent['coder'].taskTypes).toContain('refactor');
		expect(stats.byAgent['reviewer'].count).toBe(1);
	});

	it('groups stats by task type with preferred agent', async () => {
		const log = [
			makeDecision({ agent: 'coder', taskType: 'code-gen' }),
			makeDecision({ agent: 'coder', taskType: 'code-gen' }),
			makeDecision({ agent: 'reviewer', taskType: 'code-gen' })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const stats = await getRoutingStats();
		expect(stats.byTaskType['code-gen'].count).toBe(3);
		expect(stats.byTaskType['code-gen'].preferredAgent).toBe('coder');
	});

	it('generates 24 hourly activity buckets', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify([]));

		const stats = await getRoutingStats();
		expect(stats.hourlyActivity).toHaveLength(24);
		for (const bucket of stats.hourlyActivity) {
			expect(bucket).toHaveProperty('hour');
			expect(bucket).toHaveProperty('count');
			expect(bucket).toHaveProperty('successRate');
		}
	});

	it('limits recent decisions to 20', async () => {
		const log = Array.from({ length: 50 }, (_, i) =>
			makeDecision({ id: `d-${i}` })
		);
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const stats = await getRoutingStats();
		expect(stats.recentDecisions).toHaveLength(20);
	});
});

describe('getWorkflowStats', () => {
	it('returns zeroed stats for empty log', async () => {
		mockReadFile.mockRejectedValue(new Error('ENOENT'));

		const wfStats = await getWorkflowStats();
		expect(wfStats.escalationRate).toBe(0);
		expect(wfStats.avgChainLength).toBe(0);
		expect(wfStats.clawInitiated).toBe(0);
		expect(wfStats.userInitiated).toBe(0);
		expect(wfStats.recentWorkflows).toEqual([]);
		expect(wfStats.chainPatterns).toEqual([]);
	});

	it('groups decisions into workflow chains by sessionId', async () => {
		const log = [
			makeDecision({ sessionId: 'sess-1', agent: 'planner', source: 'claw', timestamp: '2026-03-05T10:00:00Z' }),
			makeDecision({ sessionId: 'sess-1', agent: 'coder', source: 'claw', timestamp: '2026-03-05T10:00:05Z' }),
			makeDecision({ sessionId: 'sess-2', agent: 'reviewer', source: 'user', timestamp: '2026-03-05T10:01:00Z' })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const wfStats = await getWorkflowStats();
		const sess1 = wfStats.recentWorkflows.find((w) => w.sessionId === 'sess-1');
		expect(sess1).toBeDefined();
		expect(sess1!.steps).toHaveLength(2);
		expect(sess1!.steps[0].agent).toBe('planner');
		expect(sess1!.steps[1].agent).toBe('coder');
	});

	it('creates single-step workflows for decisions without sessionId', async () => {
		const log = [makeDecision({ source: 'user' })]; // no sessionId
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const wfStats = await getWorkflowStats();
		expect(wfStats.recentWorkflows).toHaveLength(1);
		expect(wfStats.recentWorkflows[0].steps).toHaveLength(1);
		expect(wfStats.recentWorkflows[0].escalated).toBe(false);
	});

	it('detects escalation when providers change within a session', async () => {
		const log = [
			makeDecision({ sessionId: 's1', provider: 'ollama', agent: 'coder', complexity: 0.1, timestamp: '2026-03-05T10:00:00Z' }),
			makeDecision({ sessionId: 's1', provider: 'anthropic', agent: 'coder', complexity: 0.5, timestamp: '2026-03-05T10:00:10Z' })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const wfStats = await getWorkflowStats();
		const wf = wfStats.recentWorkflows.find((w) => w.sessionId === 's1');
		expect(wf!.escalated).toBe(true);
	});

	it('counts claw-initiated vs user-initiated workflows', async () => {
		const log = [
			makeDecision({ source: 'claw', sessionId: 'c1' }),
			makeDecision({ source: 'claw', sessionId: 'c2' }),
			makeDecision({ source: 'user', sessionId: 'u1' })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const wfStats = await getWorkflowStats();
		expect(wfStats.clawInitiated).toBe(2);
		expect(wfStats.userInitiated).toBe(1);
	});

	it('computes source stats with success rate and latency', async () => {
		const log = [
			makeDecision({ source: 'claw', latencyMs: 100, success: true }),
			makeDecision({ source: 'claw', latencyMs: 200, success: false }),
			makeDecision({ source: 'user', latencyMs: 50, success: true })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const wfStats = await getWorkflowStats();
		expect(wfStats.bySource['claw'].count).toBe(2);
		expect(wfStats.bySource['claw'].avgLatencyMs).toBe(150);
		expect(wfStats.bySource['claw'].successRate).toBe(0.5);
		expect(wfStats.bySource['user'].count).toBe(1);
		expect(wfStats.bySource['user'].successRate).toBe(1);
	});

	it('identifies chain patterns from repeated agent sequences', async () => {
		const log = [
			makeDecision({ sessionId: 'a', agent: 'planner', timestamp: '2026-03-05T10:00:00Z' }),
			makeDecision({ sessionId: 'a', agent: 'coder', timestamp: '2026-03-05T10:00:05Z' }),
			makeDecision({ sessionId: 'b', agent: 'planner', timestamp: '2026-03-05T10:01:00Z' }),
			makeDecision({ sessionId: 'b', agent: 'coder', timestamp: '2026-03-05T10:01:05Z' })
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const wfStats = await getWorkflowStats();
		const plannerCoder = wfStats.chainPatterns.find(
			(p) => p.pattern[0] === 'planner' && p.pattern[1] === 'coder'
		);
		expect(plannerCoder).toBeDefined();
		expect(plannerCoder!.count).toBe(2);
	});

	it('builds agent routing profiles with escalation tracking', async () => {
		const log = [
			makeDecision({
				sessionId: 's1', agent: 'coder', provider: 'ollama',
				model: 'gpt-oss:20b', taskType: 'code-gen',
				complexity: 0.2, latencyMs: 100, success: true,
				timestamp: '2026-03-05T10:00:00Z'
			}),
			makeDecision({
				sessionId: 's1', agent: 'reviewer', provider: 'anthropic',
				model: 'claude-sonnet-4-6', taskType: 'review',
				complexity: 0.6, latencyMs: 3000, success: true,
				timestamp: '2026-03-05T10:00:10Z'
			})
		];
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const wfStats = await getWorkflowStats();
		const coderProfile = wfStats.agentProfiles['coder'];
		expect(coderProfile.totalRouted).toBe(1);
		expect(coderProfile.asFirst).toBe(1);
		expect(coderProfile.escalatedFrom).toBe(1); // escalated to different provider

		const reviewerProfile = wfStats.agentProfiles['reviewer'];
		expect(reviewerProfile.escalatedTo).toBe(1);
		expect(reviewerProfile.asLast).toBe(1);
	});

	it('limits recent workflows to 10', async () => {
		const log = Array.from({ length: 20 }, (_, i) =>
			makeDecision({ id: `d-${i}`, source: 'user' })
		);
		mockReadFile.mockResolvedValue(JSON.stringify(log));

		const wfStats = await getWorkflowStats();
		expect(wfStats.recentWorkflows.length).toBeLessThanOrEqual(10);
	});
});
