// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the release agent module.
 *
 * Since buildReleasePrompt is private, we test the public API (spawnReleaseAgent)
 * with mocked dependencies, verifying:
 * - Capacity checks (global + per-project limits)
 * - Duplicate agent prevention
 * - Dry-run vs live mode
 * - Prompt content passed to spawnClaude
 */

// Mock fs/promises
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

// Track what prompt was passed to spawnClaude
let capturedPrompt = '';
let capturedOptions: any = {};

const mockChild = {
	pid: 12345,
	on: vi.fn()
};

vi.mock('./agent-spawn.js', () => ({
	spawnClaude: vi.fn(async (prompt: string, _logFile: string, opts: any) => {
		capturedPrompt = prompt;
		capturedOptions = opts;
		return mockChild;
	})
}));

vi.mock('./agent-tracking.js', () => ({
	logAgentCompletion: vi.fn().mockResolvedValue(undefined),
	parseStreamJsonLog: vi.fn().mockResolvedValue({ usage: null })
}));

vi.mock('./agent-analytics.js', () => ({
	recordEvent: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./session-pool.js', () => ({
	recordSpawn: vi.fn().mockResolvedValue(undefined),
	recordSpawnCompletion: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./pid-registry.js', () => ({
	registerPid: vi.fn().mockResolvedValue(undefined),
	unregisterPid: vi.fn().mockResolvedValue(undefined)
}));

import { spawnReleaseAgent } from './release-agent.js';
import { getActiveAgents, getProjectLimits, getProjectAgentMap } from './shared.js';
import { spawnClaude } from './agent-spawn.js';
import { recordEvent } from './agent-analytics.js';

beforeEach(() => {
	vi.clearAllMocks();
	capturedPrompt = '';
	capturedOptions = {};
	mockChild.on.mockReset();

	const g = globalThis as Record<string, unknown>;
	delete g.__claw_active_agents;
	delete g.__claw_slot_map;
	delete g.__claw_project_limits;
	delete g.__claw_project_agent_map;
	delete g.__claw_max_agents;
	delete g.__claw_color_idx;
	delete g.__claw_heartbeat_config;
	delete g.__claw_discussion_map;
	delete g.__claw_spawn_stats;
});

describe('spawnReleaseAgent', () => {
	it('spawns an agent and returns true on success', async () => {
		const result = await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(result).toBe(true);
		expect(spawnClaude).toHaveBeenCalledOnce();
		expect(getActiveAgents().has('release-my-project')).toBe(true);
	});

	it('uses claude-sonnet model for release agents', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(capturedOptions.model).toBe('claude-sonnet-4-6');
	});

	it('returns false when max agents is reached', async () => {
		const agents = getActiveAgents();
		for (let i = 0; i < 5; i++) {
			agents.set(`agent-${i}`, {} as any);
		}

		const result = await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(result).toBe(false);
		expect(spawnClaude).not.toHaveBeenCalled();
	});

	it('returns false when per-project limit is reached', async () => {
		const agents = getActiveAgents();
		const projectMap = getProjectAgentMap();
		const limits = getProjectLimits();

		limits.set('my-project', 1);
		agents.set('existing-1', {} as any);
		projectMap.set('existing-1', 'my-project');

		const result = await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(result).toBe(false);
		expect(spawnClaude).not.toHaveBeenCalled();
	});

	it('returns false if release agent already running for same project', async () => {
		const agents = getActiveAgents();
		agents.set('release-my-project', {} as any);

		const result = await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(result).toBe(false);
		expect(spawnClaude).not.toHaveBeenCalled();
	});

	it('builds a live release prompt by default', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(capturedPrompt).toContain('LIVE');
		expect(capturedPrompt).toContain('bump the version');
		expect(capturedPrompt).toContain('gh release create');
		expect(capturedPrompt).not.toContain('DRY-RUN');
	});

	it('builds a dry-run prompt when dryRun option is true', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project', { dryRun: true });

		expect(capturedPrompt).toContain('DRY-RUN');
		expect(capturedPrompt).toContain('Do NOT modify any files');
		expect(capturedPrompt).not.toContain('LIVE');
	});

	it('includes project path in the prompt', async () => {
		await spawnReleaseAgent('/tmp/my-special-project', 'proj-id');

		expect(capturedPrompt).toContain('/tmp/my-special-project');
	});

	it('includes version bump rules in the prompt', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(capturedPrompt).toContain('BREAKING CHANGE');
		expect(capturedPrompt).toContain('major');
		expect(capturedPrompt).toContain('minor');
		expect(capturedPrompt).toContain('patch');
	});

	it('includes test step in the prompt', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(capturedPrompt).toContain('Run Tests');
		expect(capturedPrompt).toContain('npm test');
	});

	it('includes changelog generation step', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(capturedPrompt).toContain('Generate Changelog');
		expect(capturedPrompt).toContain('conventional commits');
		expect(capturedPrompt).toContain('git log');
	});

	it('registers the agent in the project agent map', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project');

		const projectMap = getProjectAgentMap();
		expect(projectMap.get('release-my-project')).toBe('my-project');
	});

	it('records a spawned analytics event', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: 'release-my-project',
				type: 'spawned',
				model: 'claude-sonnet-4-6',
				projectId: 'my-project'
			})
		);
	});

	it('registers the close handler on the child process', async () => {
		await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(mockChild.on).toHaveBeenCalledWith('close', expect.any(Function));
	});

	it('returns false and logs error when spawnClaude throws', async () => {
		vi.mocked(spawnClaude).mockRejectedValueOnce(new Error('spawn failed'));

		const result = await spawnReleaseAgent('/tmp/project', 'my-project');

		expect(result).toBe(false);
	});
});

describe('release prompt — semver bump rules', () => {
	it('documents all three bump levels', async () => {
		await spawnReleaseAgent('/tmp/project', 'test-proj');

		// Verify the prompt contains clear semver rules
		expect(capturedPrompt).toContain('feat!');
		expect(capturedPrompt).toContain('major');
		expect(capturedPrompt).toContain('feat');
		expect(capturedPrompt).toContain('minor');
		expect(capturedPrompt).toContain('fix');
		expect(capturedPrompt).toContain('patch');
	});
});

describe('release prompt — dry-run vs live differences', () => {
	it('dry-run prompt has Report step, not Bump/Tag/Release', async () => {
		await spawnReleaseAgent('/tmp/project', 'test-proj', { dryRun: true });

		expect(capturedPrompt).toContain('Report (Dry-Run)');
		expect(capturedPrompt).not.toContain('Bump Version');
		expect(capturedPrompt).not.toContain('Create Git Tag');
		expect(capturedPrompt).not.toContain('Create GitHub Release');
	});

	it('live prompt has Bump/Tag/Release steps, not Report', async () => {
		await spawnReleaseAgent('/tmp/project', 'test-proj', { dryRun: false });

		expect(capturedPrompt).toContain('Bump Version');
		expect(capturedPrompt).toContain('Create Git Tag');
		expect(capturedPrompt).toContain('Create GitHub Release');
		expect(capturedPrompt).not.toContain('Report (Dry-Run)');
	});
});
