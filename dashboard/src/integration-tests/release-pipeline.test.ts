// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration tests for the release pipeline.
 *
 * Tests the release agent's prompt construction, semver bump logic,
 * and publisher registry patterns without spawning actual processes.
 *
 * Run with: npx vitest run src/integration-tests/release-pipeline.test.ts
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

let capturedPrompt = '';
const mockChild = { pid: 99999, on: vi.fn() };

vi.mock('$lib/server/heartbeat/agent-spawn.js', () => ({
	spawnClaude: vi.fn(async (prompt: string) => {
		capturedPrompt = prompt;
		return mockChild;
	})
}));

vi.mock('$lib/server/heartbeat/agent-tracking.js', () => ({
	logAgentCompletion: vi.fn().mockResolvedValue(undefined),
	parseStreamJsonLog: vi.fn().mockResolvedValue({ usage: null })
}));

vi.mock('$lib/server/heartbeat/agent-analytics.js', () => ({
	recordEvent: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/server/heartbeat/session-pool.js', () => ({
	recordSpawn: vi.fn().mockResolvedValue(undefined),
	recordSpawnCompletion: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/server/heartbeat/pid-registry.js', () => ({
	registerPid: vi.fn().mockResolvedValue(undefined),
	unregisterPid: vi.fn().mockResolvedValue(undefined)
}));

import { spawnReleaseAgent } from '$lib/server/heartbeat/release-agent.js';
import {
	getActiveAgents,
	getProjectLimits,
	getProjectAgentMap
} from '$lib/server/heartbeat/shared.js';

beforeEach(() => {
	vi.clearAllMocks();
	capturedPrompt = '';
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

describe('Release Pipeline — Changelog Generation', () => {
	it('prompt includes git log command for commit collection', async () => {
		await spawnReleaseAgent('/tmp/my-project', 'my-project');

		expect(capturedPrompt).toContain('git log');
		expect(capturedPrompt).toContain('git describe --tags');
		expect(capturedPrompt).toContain('--oneline');
	});

	it('prompt instructs grouping by commit type', async () => {
		await spawnReleaseAgent('/tmp/my-project', 'my-project');

		expect(capturedPrompt).toContain('feat/fix/refactor/docs');
		expect(capturedPrompt).toContain('group them');
	});
});

describe('Release Pipeline — Semver Bumping', () => {
	it('major bump for BREAKING CHANGE commits', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj');

		expect(capturedPrompt).toContain('BREAKING CHANGE');
		expect(capturedPrompt).toContain('major');
	});

	it('minor bump for feat commits', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj');

		// The prompt should indicate feat → minor
		expect(capturedPrompt).toMatch(/feat.*minor/s);
	});

	it('patch bump for fix-only commits', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj');

		// The prompt should indicate fix → patch
		expect(capturedPrompt).toMatch(/fix.*patch/s);
	});

	it('reads current version from package.json', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj');

		expect(capturedPrompt).toContain('package.json');
	});
});

describe('Release Pipeline — Dry-Run Mode', () => {
	it('dry-run does not modify files', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: true });

		expect(capturedPrompt).toContain('DRY-RUN');
		expect(capturedPrompt).toContain('Do NOT modify any files');
	});

	it('dry-run still runs tests', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: true });

		expect(capturedPrompt).toContain('Run Tests');
		expect(capturedPrompt).toContain('npm test');
	});

	it('dry-run still generates changelog', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: true });

		expect(capturedPrompt).toContain('Generate Changelog');
	});

	it('dry-run reports recommended bump without executing', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: true });

		expect(capturedPrompt).toContain('Recommended bump type');
		expect(capturedPrompt).toContain('next version');
	});
});

describe('Release Pipeline — Live Publishing', () => {
	it('live mode creates git tag', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: false });

		expect(capturedPrompt).toContain('git tag -a');
	});

	it('live mode creates GitHub release via gh CLI', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: false });

		expect(capturedPrompt).toContain('gh release create');
	});

	it('live mode bumps version in package.json', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: false });

		expect(capturedPrompt).toContain('Bump Version');
		expect(capturedPrompt).toContain('Update the');
		expect(capturedPrompt).toContain('version');
	});

	it('live mode runs build after version bump', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: false });

		expect(capturedPrompt).toContain('npm run build');
	});

	it('live mode handles gh CLI failure gracefully', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj', { dryRun: false });

		expect(capturedPrompt).toContain('gh');
		expect(capturedPrompt).toContain('not available or fails');
	});
});

describe('Release Pipeline — Publisher Validation', () => {
	it('validates tests pass before proceeding', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj');

		// Prompt should instruct stopping on test failure
		expect(capturedPrompt).toContain('tests fail');
		expect(capturedPrompt).toContain('STOP');
	});

	it('targets the correct project path', async () => {
		await spawnReleaseAgent('/home/user/my-app', 'my-app');

		expect(capturedPrompt).toContain('/home/user/my-app');
		expect(capturedPrompt).toContain('cd "/home/user/my-app"');
	});
});

describe('Release Pipeline — Agent Lifecycle', () => {
	it('registers agent in active agents map', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj');

		expect(getActiveAgents().has('release-proj')).toBe(true);
	});

	it('tracks project association', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj');

		expect(getProjectAgentMap().get('release-proj')).toBe('proj');
	});

	it('respects global agent limit', async () => {
		const agents = getActiveAgents();
		for (let i = 0; i < 5; i++) agents.set(`agent-${i}`, {} as any);

		const result = await spawnReleaseAgent('/tmp/proj', 'proj');

		expect(result).toBe(false);
	});

	it('respects per-project agent limit', async () => {
		const agents = getActiveAgents();
		const projectMap = getProjectAgentMap();
		const limits = getProjectLimits();

		limits.set('proj', 1);
		agents.set('existing', {} as any);
		projectMap.set('existing', 'proj');

		const result = await spawnReleaseAgent('/tmp/proj', 'proj');

		expect(result).toBe(false);
	});

	it('prevents duplicate release agents for same project', async () => {
		await spawnReleaseAgent('/tmp/proj', 'proj');
		const result = await spawnReleaseAgent('/tmp/proj', 'proj');

		expect(result).toBe(false);
	});
});
