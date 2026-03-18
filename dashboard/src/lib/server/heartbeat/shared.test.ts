// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises and dependencies before importing
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

import {
	getDefaultConfig,
	MIN_INTERVAL_MS,
	DEFAULT_INTERVAL_MS,
	DEFAULT_MAX_AGENTS,
	MONITOR_SESSION_ID,
	CLAW_SENDER,
	agentSender,
	getHeartbeatConfig,
	getActiveAgents,
	getDiscussionMap,
	getMaxConcurrentAgents,
	getProjectLimits,
	getProjectAgentMap,
	countProjectAgents,
	log,
	trimSession,
	taskSessionId
} from './shared.js';
import type { HeartbeatConfig, HeartbeatIntervals } from './shared.js';
import type { ChatSession } from '$lib/types/chat.js';

beforeEach(() => {
	vi.clearAllMocks();
	// Reset globalThis state between tests
	const g = globalThis as Record<string, unknown>;
	delete g.__claw_active_agents;
	delete g.__claw_discussion_map;
	delete g.__claw_project_limits;
	delete g.__claw_project_agent_map;
	delete g.__claw_color_idx;
	delete g.__claw_heartbeat_config;
});

describe('getDefaultConfig', () => {
	it('returns a valid HeartbeatConfig', () => {
		const config = getDefaultConfig();

		expect(config.enabled).toBe(true);
		expect(config.phases).toBeDefined();
		expect(config.intervals).toBeDefined();
	});

	it('has all phases enabled by default', () => {
		const config = getDefaultConfig();

		expect(config.phases.healthChecks).toBe(true);
		expect(config.phases.taskScanning).toBe(true);
		expect(config.phases.agentSpawning).toBe(true);
		expect(config.phases.reviewCycle).toBe(true);
		expect(config.phases.memorySync).toBe(true);
	});

	it('has valid intervals above MIN_INTERVAL_MS', () => {
		const config = getDefaultConfig();

		for (const [key, val] of Object.entries(config.intervals)) {
			expect(val, `${key} should be >= MIN_INTERVAL_MS`).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
		}
	});

	it('returns a deep copy each time (not shared reference)', () => {
		const a = getDefaultConfig();
		const b = getDefaultConfig();

		a.enabled = false;
		a.phases.healthChecks = false;
		a.intervals.healthChecks = 99999;

		expect(b.enabled).toBe(true);
		expect(b.phases.healthChecks).toBe(true);
		expect(b.intervals.healthChecks).not.toBe(99999);
	});
});

describe('constants', () => {
	it('MIN_INTERVAL_MS is 10 seconds', () => {
		expect(MIN_INTERVAL_MS).toBe(10_000);
	});

	it('DEFAULT_INTERVAL_MS is 60 seconds', () => {
		expect(DEFAULT_INTERVAL_MS).toBe(60_000);
	});

	it('DEFAULT_MAX_AGENTS is 5', () => {
		expect(DEFAULT_MAX_AGENTS).toBe(5);
	});

	it('MONITOR_SESSION_ID is set', () => {
		expect(MONITOR_SESSION_ID).toBe('claw-monitor');
	});

	it('CLAW_SENDER has correct shape', () => {
		expect(CLAW_SENDER).toEqual({
			id: 'claw',
			label: 'Claw',
			color: '#06b6d4'
		});
	});
});

describe('agentSender', () => {
	it('returns a sender with the correct id prefix', () => {
		const sender = agentSender('task-123', 'My Agent');

		expect(sender.id).toBe('agent-task-123');
		expect(sender.label).toBe('My Agent');
		expect(sender.color).toBeTruthy();
	});

	it('cycles through colors on subsequent calls', () => {
		const s1 = agentSender('t1', 'A1');
		const s2 = agentSender('t2', 'A2');

		// Colors should be different (first two from the palette)
		expect(s1.color).not.toBe(s2.color);
	});
});

describe('getActiveAgents', () => {
	it('returns an empty Map initially', () => {
		const agents = getActiveAgents();

		expect(agents).toBeInstanceOf(Map);
		expect(agents.size).toBe(0);
	});

	it('returns the same Map instance on repeated calls', () => {
		const a = getActiveAgents();
		const b = getActiveAgents();

		expect(a).toBe(b);
	});
});

describe('getDiscussionMap', () => {
	it('returns an empty Map initially', () => {
		const map = getDiscussionMap();

		expect(map).toBeInstanceOf(Map);
		expect(map.size).toBe(0);
	});
});

describe('getProjectLimits', () => {
	it('returns an empty Map initially', () => {
		const limits = getProjectLimits();

		expect(limits).toBeInstanceOf(Map);
		expect(limits.size).toBe(0);
	});
});

describe('getProjectAgentMap', () => {
	it('returns an empty Map initially', () => {
		const map = getProjectAgentMap();

		expect(map).toBeInstanceOf(Map);
		expect(map.size).toBe(0);
	});
});

describe('countProjectAgents', () => {
	it('returns 0 when no agents are active', () => {
		expect(countProjectAgents('proj-1')).toBe(0);
	});

	it('counts only agents for the given project', () => {
		const agents = getActiveAgents();
		const projectMap = getProjectAgentMap();

		// Simulate two agents for proj-1, one for proj-2
		agents.set('task-a', {} as any);
		agents.set('task-b', {} as any);
		agents.set('task-c', {} as any);
		projectMap.set('task-a', 'proj-1');
		projectMap.set('task-b', 'proj-1');
		projectMap.set('task-c', 'proj-2');

		expect(countProjectAgents('proj-1')).toBe(2);
		expect(countProjectAgents('proj-2')).toBe(1);
		expect(countProjectAgents('proj-3')).toBe(0);
	});
});

describe('getMaxConcurrentAgents', () => {
	it('returns DEFAULT_MAX_AGENTS by default', () => {
		expect(getMaxConcurrentAgents()).toBe(DEFAULT_MAX_AGENTS);
	});
});

describe('log', () => {
	it('appends a message to the session', () => {
		const session: ChatSession = {
			id: 'test',
			model: 'system',
			provider: 'internal',
			createdAt: '',
			updatedAt: '',
			messages: [],
			source: 'claw',
			status: 'idle'
		};

		log(session, 'Hello world');

		expect(session.messages).toHaveLength(1);
		expect(session.messages[0].role).toBe('assistant');
		expect(session.messages[0].content).toBe('Hello world');
		expect(session.messages[0].sender).toEqual(CLAW_SENDER);
	});

	it('uses a custom sender when provided', () => {
		const session: ChatSession = {
			id: 'test',
			model: 'system',
			provider: 'internal',
			createdAt: '',
			updatedAt: '',
			messages: [],
			source: 'claw',
			status: 'idle'
		};
		const sender = { id: 'custom', label: 'Custom', color: '#fff' };

		log(session, 'Custom message', sender);

		expect(session.messages[0].sender).toEqual(sender);
	});
});

describe('trimSession', () => {
	it('does not trim sessions under 200 messages', () => {
		const session: ChatSession = {
			id: 'test',
			model: 'system',
			provider: 'internal',
			createdAt: '',
			updatedAt: '',
			messages: Array.from({ length: 50 }, (_, i) => ({
				role: 'assistant' as const,
				content: `msg-${i}`
			})),
			source: 'claw',
			status: 'idle'
		};

		trimSession(session);

		expect(session.messages).toHaveLength(50);
	});

	it('trims to 200 messages preserving the system message', () => {
		const systemMsg = { role: 'system' as const, content: 'System prompt' };
		const messages = [systemMsg];
		for (let i = 0; i < 250; i++) {
			messages.push({ role: 'assistant' as const, content: `msg-${i}` });
		}

		const session: ChatSession = {
			id: 'test',
			model: 'system',
			provider: 'internal',
			createdAt: '',
			updatedAt: '',
			messages,
			source: 'claw',
			status: 'idle'
		};

		trimSession(session);

		expect(session.messages).toHaveLength(200);
		expect(session.messages[0]).toEqual(systemMsg);
		// Last message should be the last one added
		expect(session.messages[session.messages.length - 1].content).toBe('msg-249');
	});
});

describe('taskSessionId', () => {
	it('prefixes the task id with "task-"', () => {
		expect(taskSessionId('abc-123')).toBe('task-abc-123');
	});
});
