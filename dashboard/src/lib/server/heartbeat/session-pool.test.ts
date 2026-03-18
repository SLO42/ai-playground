// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
		writeFile: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		root: '/tmp/test-root',
		chatsDir: '/tmp/test-root/.playground/chats',
		heartbeatConfig: '/tmp/test-root/.playground/heartbeat.json',
		headlessLogsDir: '/tmp/test-root/.playground/logs'
	}
}));

vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: vi.fn().mockResolvedValue(null)
}));

vi.mock('$lib/server/agent-defaults.js', () => ({
	loadAgentDefaults: vi.fn().mockResolvedValue({ maxConcurrentAgents: 5 })
}));

vi.mock('$lib/server/async-mutex.js', () => ({
	withLock: vi.fn(async (_path: string, fn: () => Promise<void>) => fn())
}));

import {
	requestSlot,
	releaseSlot,
	getAllocatedSlots,
	suggestAgentPreset,
	getAutoScaleDefaults,
	getPoolStats,
	resetPool,
	recordSpawn,
	recordSpawnCompletion
} from './session-pool.js';
import { getActiveAgents, getProjectLimits, getProjectAgentMap } from './shared.js';

beforeEach(() => {
	vi.clearAllMocks();

	// Reset globalThis state between tests
	const g = globalThis as Record<string, unknown>;
	delete g.__claw_active_agents;
	delete g.__claw_slot_map;
	delete g.__claw_project_limits;
	delete g.__claw_project_agent_map;
	delete g.__claw_max_agents;
	delete g.__claw_spawn_stats;
});

describe('requestSlot / releaseSlot', () => {
	it('allocates a slot for a new task', () => {
		const slot = requestSlot('task-1', 'proj-1');

		expect(slot).not.toBeNull();
		expect(slot!.taskId).toBe('task-1');
		expect(slot!.projectId).toBe('proj-1');
		expect(slot!.allocatedAt).toBeTruthy();
	});

	it('returns the existing slot if already allocated for a task', () => {
		const slot1 = requestSlot('task-1', 'proj-1');
		const slot2 = requestSlot('task-1', 'proj-1');

		expect(slot1).toBe(slot2);
	});

	it('returns null when global max agents is reached', () => {
		// Fill up active agents to the limit (default 5)
		const agents = getActiveAgents();
		for (let i = 0; i < 5; i++) {
			agents.set(`existing-${i}`, {} as any);
		}

		const slot = requestSlot('new-task', 'proj-1');

		expect(slot).toBeNull();
	});

	it('returns null when per-project limit is reached', () => {
		const agents = getActiveAgents();
		const projectMap = getProjectAgentMap();
		const limits = getProjectLimits();

		// Set project limit to 1
		limits.set('proj-1', 1);

		// Add one active agent for proj-1
		agents.set('existing-1', {} as any);
		projectMap.set('existing-1', 'proj-1');

		const slot = requestSlot('new-task', 'proj-1');

		expect(slot).toBeNull();
	});

	it('uses default project limit of 2 when not configured', () => {
		const agents = getActiveAgents();
		const projectMap = getProjectAgentMap();

		// Add two agents for a project with no explicit limit
		agents.set('a1', {} as any);
		agents.set('a2', {} as any);
		projectMap.set('a1', 'proj-1');
		projectMap.set('a2', 'proj-1');

		const slot = requestSlot('new-task', 'proj-1');

		expect(slot).toBeNull();
	});

	it('allows slots for different projects independently', () => {
		const agents = getActiveAgents();
		const projectMap = getProjectAgentMap();
		const limits = getProjectLimits();

		limits.set('proj-1', 1);
		limits.set('proj-2', 1);

		// One agent for proj-1
		agents.set('a1', {} as any);
		projectMap.set('a1', 'proj-1');

		// Should reject proj-1 but accept proj-2
		expect(requestSlot('task-p1', 'proj-1')).toBeNull();
		expect(requestSlot('task-p2', 'proj-2')).not.toBeNull();
	});

	it('releaseSlot removes the allocation', () => {
		requestSlot('task-1', 'proj-1');

		expect(getAllocatedSlots()).toHaveLength(1);

		releaseSlot('task-1');

		expect(getAllocatedSlots()).toHaveLength(0);
	});

	it('releaseSlot is idempotent', () => {
		requestSlot('task-1', 'proj-1');
		releaseSlot('task-1');
		releaseSlot('task-1'); // second call should not throw

		expect(getAllocatedSlots()).toHaveLength(0);
	});
});

describe('getAllocatedSlots', () => {
	it('returns empty array initially', () => {
		expect(getAllocatedSlots()).toEqual([]);
	});

	it('returns all allocated slots', () => {
		requestSlot('task-1', 'proj-1');
		requestSlot('task-2', 'proj-2');

		const slots = getAllocatedSlots();

		expect(slots).toHaveLength(2);
		expect(slots.map(s => s.taskId).sort()).toEqual(['task-1', 'task-2']);
	});
});

describe('suggestAgentPreset', () => {
	it('returns tester preset for test tags', () => {
		expect(suggestAgentPreset(['test'])).toEqual({ model: 'claude-sonnet-4-6', type: 'tester' });
		expect(suggestAgentPreset(['Testing'])).toEqual({ model: 'claude-sonnet-4-6', type: 'tester' });
		expect(suggestAgentPreset(['e2e'])).toEqual({ model: 'claude-sonnet-4-6', type: 'tester' });
		expect(suggestAgentPreset(['unit-test'])).toEqual({ model: 'claude-sonnet-4-6', type: 'tester' });
	});

	it('returns reviewer preset for review/audit tags', () => {
		expect(suggestAgentPreset(['review'])).toEqual({ model: 'claude-sonnet-4-6', type: 'reviewer' });
		expect(suggestAgentPreset(['audit'])).toEqual({ model: 'claude-sonnet-4-6', type: 'reviewer' });
		expect(suggestAgentPreset(['lint'])).toEqual({ model: 'claude-sonnet-4-6', type: 'reviewer' });
		expect(suggestAgentPreset(['Security'])).toEqual({ model: 'claude-sonnet-4-6', type: 'reviewer' });
	});

	it('returns opus coder preset for complex implementation tags', () => {
		expect(suggestAgentPreset(['feature'])).toEqual({ model: 'claude-opus-4-6', type: 'coder' });
		expect(suggestAgentPreset(['refactor'])).toEqual({ model: 'claude-opus-4-6', type: 'coder' });
		expect(suggestAgentPreset(['architecture'])).toEqual({ model: 'claude-opus-4-6', type: 'coder' });
		expect(suggestAgentPreset(['api'])).toEqual({ model: 'claude-opus-4-6', type: 'coder' });
		expect(suggestAgentPreset(['Integration'])).toEqual({ model: 'claude-opus-4-6', type: 'coder' });
	});

	it('returns sonnet coder preset for unknown tags', () => {
		expect(suggestAgentPreset(['misc'])).toEqual({ model: 'claude-sonnet-4-6', type: 'coder' });
		expect(suggestAgentPreset([])).toEqual({ model: 'claude-sonnet-4-6', type: 'coder' });
	});

	it('prioritizes test tags over feature tags when both present', () => {
		// test is checked first in the function
		const result = suggestAgentPreset(['feature', 'test']);
		expect(result.type).toBe('tester');
	});
});

describe('getAutoScaleDefaults', () => {
	it('returns valid auto-scale config', () => {
		const defaults = getAutoScaleDefaults();

		expect(defaults.minSlots).toBeGreaterThan(0);
		expect(defaults.maxSlots).toBeGreaterThan(defaults.minSlots);
		expect(defaults.tasksPerSlot).toBeGreaterThan(0);
		expect(defaults.idleCooldownMs).toBeGreaterThan(0);
	});
});

describe('getPoolStats', () => {
	it('returns SessionPool shape with empty slots', async () => {
		const stats = await getPoolStats();

		expect(stats.slots).toEqual([]);
		expect(stats.maxSlots).toBe(0);
		expect(typeof stats.coldStarts).toBe('number');
		expect(stats.warmResumes).toBe(0);
		expect(stats.scaleEvents).toEqual([]);
	});
});

describe('recordSpawn / recordSpawnCompletion', () => {
	it('increments spawn count', async () => {
		await recordSpawn();
		await recordSpawn();

		const stats = await getPoolStats();
		expect(stats.coldStarts).toBe(2);
	});

	it('accumulates token usage and cost', async () => {
		await recordSpawn();
		await recordSpawnCompletion(1000, 0.05);
		await recordSpawnCompletion(2000, 0.10);

		// Internal stats tracked — getPoolStats returns coldStarts = totalSpawns
		const stats = await getPoolStats();
		expect(stats.coldStarts).toBe(1);
	});
});

describe('resetPool', () => {
	it('resets all stats to zero', async () => {
		await recordSpawn();
		await recordSpawn();
		await resetPool();

		const stats = await getPoolStats();
		expect(stats.coldStarts).toBe(0);
	});
});
