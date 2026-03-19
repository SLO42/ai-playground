// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing
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

vi.mock('$lib/server/notifications.js', () => ({
	pushNotification: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/server/task-store.js', () => ({
	getAllTasks: vi.fn().mockResolvedValue([]),
	updateTask: vi.fn().mockResolvedValue(null)
}));

vi.mock('./agent-spawn.js', () => ({
	spawnClaude: vi.fn(),
	buildTaskPromptWithDiscussion: vi.fn().mockReturnValue('prompt'),
	pickModelForTask: vi.fn().mockReturnValue('claude-sonnet-4-6')
}));

vi.mock('./agent-tracking.js', () => ({
	logAgentCompletion: vi.fn().mockResolvedValue(undefined),
	captureGitBaseline: vi.fn().mockResolvedValue(new Set()),
	parseStreamJsonLog: vi.fn().mockResolvedValue({ usage: null })
}));

vi.mock('./session-pool.js', () => ({
	recordSpawn: vi.fn().mockResolvedValue(undefined),
	recordSpawnCompletion: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./pid-registry.js', () => ({
	registerPid: vi.fn().mockResolvedValue(undefined),
	unregisterPid: vi.fn().mockResolvedValue(undefined)
}));

import { writeFile } from 'fs/promises';
import {
	getPendingReplyCount,
	createDiscussionSession
} from './discussion.js';
import { getActiveAgents, getDiscussionMap } from './shared.js';
import type { ChatSession } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

function makeTask(overrides: Partial<Task> = {}): Task {
	const now = new Date().toISOString();
	return {
		id: 'test-task-1',
		title: 'Test task',
		description: 'A test task',
		status: 'pending',
		priority: 'medium',
		flagDiscussion: false,
		assignee: null,
		tags: [],
		feature: null,
		createdBy: 'test',
		createdAt: now,
		updatedAt: now,
		completedAt: null,
		...overrides
	};
}

function makeSession(): ChatSession {
	return {
		id: 'monitor',
		model: 'system',
		provider: 'internal',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		messages: [],
		source: 'claw',
		status: 'idle'
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	const g = globalThis as Record<string, unknown>;
	delete g.__claw_active_agents;
	delete g.__claw_discussion_map;
	delete g.__claw_color_idx;
	delete g.__claw_heartbeat_config;
	delete g.__claw_project_agent_map;
	delete g.__claw_project_limits;
});

describe('getPendingReplyCount', () => {
	it('returns 0 initially', () => {
		expect(getPendingReplyCount()).toBe(0);
	});
});

describe('createDiscussionSession', () => {
	it('creates a session file with correct id prefix', async () => {
		const task = makeTask({ id: 'abc-123', title: 'Fix the bug' });
		const mockWriteFile = vi.mocked(writeFile);

		const sessionId = await createDiscussionSession(task);

		expect(sessionId).toBe('discuss-abc-123');
		expect(mockWriteFile).toHaveBeenCalled();

		// Verify the session content written
		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		expect(writtenContent.id).toBe('discuss-abc-123');
		expect(writtenContent.status).toBe('waiting');
		expect(writtenContent.source).toBe('claw');
	});

	it('includes task title in the system message', async () => {
		const task = makeTask({ title: 'Implement feature X' });
		const mockWriteFile = vi.mocked(writeFile);

		await createDiscussionSession(task);

		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const systemMsg = writtenContent.messages.find((m: any) => m.role === 'system');
		expect(systemMsg.content).toContain('Implement feature X');
	});

	it('includes discussion prompt with questions', async () => {
		const task = makeTask({
			title: 'Update settings page',
			tags: ['settings', 'ui']
		});
		const mockWriteFile = vi.mocked(writeFile);

		await createDiscussionSession(task);

		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const assistantMsg = writtenContent.messages.find((m: any) => m.role === 'assistant');

		// Should include questions relevant to settings and UI tags
		expect(assistantMsg.content).toContain('settings');
		expect(assistantMsg.content.toLowerCase()).toContain('questions');
	});

	it('generates settings question for settings-tagged tasks', async () => {
		const task = makeTask({ title: 'Configure app', tags: ['settings'] });
		const mockWriteFile = vi.mocked(writeFile);

		await createDiscussionSession(task);

		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const assistantMsg = writtenContent.messages.find((m: any) => m.role === 'assistant');
		expect(assistantMsg.content).toContain('per-project overrides');
	});

	it('generates UI question for ui-tagged tasks', async () => {
		const task = makeTask({ title: 'Build dashboard', tags: ['ui'] });
		const mockWriteFile = vi.mocked(writeFile);

		await createDiscussionSession(task);

		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const assistantMsg = writtenContent.messages.find((m: any) => m.role === 'assistant');
		expect(assistantMsg.content).toContain('look or behavior');
	});

	it('generates report question for report-tagged tasks', async () => {
		const task = makeTask({ title: 'Generate weekly report', tags: ['reports'] });
		const mockWriteFile = vi.mocked(writeFile);

		await createDiscussionSession(task);

		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const assistantMsg = writtenContent.messages.find((m: any) => m.role === 'assistant');
		expect(assistantMsg.content).toContain('report actually tell you');
	});

	it('generates security question for security-tagged tasks', async () => {
		const task = makeTask({ title: 'Manage api key rotation', tags: ['security'] });
		const mockWriteFile = vi.mocked(writeFile);

		await createDiscussionSession(task);

		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const assistantMsg = writtenContent.messages.find((m: any) => m.role === 'assistant');
		expect(assistantMsg.content).toContain('sensitive values');
	});

	it('generates generic question when no specific tags match', async () => {
		const task = makeTask({ title: 'Something generic', tags: ['misc'] });
		const mockWriteFile = vi.mocked(writeFile);

		await createDiscussionSession(task);

		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const assistantMsg = writtenContent.messages.find((m: any) => m.role === 'assistant');
		expect(assistantMsg.content).toContain('outcome are you expecting');
	});

	it('includes task description when present', async () => {
		const task = makeTask({ title: 'Do thing', description: 'Detailed description here' });
		const mockWriteFile = vi.mocked(writeFile);

		await createDiscussionSession(task);

		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const assistantMsg = writtenContent.messages.find((m: any) => m.role === 'assistant');
		expect(assistantMsg.content).toContain('Detailed description here');
	});
});
