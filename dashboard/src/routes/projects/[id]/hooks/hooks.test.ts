// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: vi.fn()
}));

vi.mock('$lib/server/project-scanner.js', () => ({
	scanAllProjects: vi.fn()
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		playgroundRegistry: '/mock/registry.json',
		root: '/mock/root',
		settingsJson: '/mock/settings.json',
		daemonState: '/mock/daemon-state.json'
	}
}));

import { readJsonFile } from '$lib/server/file-reader.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { load } from './+page.server.js';

const mockedReadJson = vi.mocked(readJsonFile);
const mockedScan = vi.mocked(scanAllProjects);

function callLoad(overrides: { params?: Record<string, string> } = {}) {
	return load({
		params: { id: 'test-proj', ...overrides.params }
	} as any) as ReturnType<typeof load>;
}

const sampleSettings = {
	hooks: {
		PreToolUse: [{ matcher: '*.ts', hooks: [{ type: 'command', command: 'lint' }] }],
		PostToolUse: [],
		SessionStart: [],
		SessionEnd: [],
		UserPromptSubmit: [],
		UserPromptResponse: [],
		Stop: [],
		SubagentStop: []
	},
	claudeFlow: {
		daemon: {
			autoStart: true,
			workers: ['format', 'test-runner'],
			schedules: {
				format: { interval: '5m', priority: 'high', triggers: ['pre-edit'] },
				'test-runner': { interval: '10m', priority: 'normal' }
			}
		},
		learning: {
			enabled: true,
			autoTrain: false,
			patterns: ['*.ts'],
			retention: { default: '30d' }
		}
	}
};

const sampleDaemonState = {
	running: true,
	startedAt: '2026-03-01T00:00:00Z',
	workers: { format: { runs: 5, lastRun: '2026-03-01T12:00:00Z' } },
	config: { workers: [{ name: 'format', schedule: '5m' }] }
};

describe('Project Hooks +page.server load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedScan.mockResolvedValue([
			{ id: 'test-proj', name: 'Test Project', path: '/tmp/test-proj' }
		] as any);
		// Default: project-specific settings not found, global settings used
		mockedReadJson.mockImplementation(async (path: any) => {
			const p = String(path);
			if (p.includes('test-proj')) return null; // project-specific not found
			if (p.includes('settings.json')) return sampleSettings;
			if (p.includes('daemon-state.json')) return sampleDaemonState;
			return null;
		});
	});

	it('returns hooks from settings', async () => {
		const result = await callLoad();

		expect(result.hooks).toBeDefined();
		expect(result.hooks.PreToolUse).toHaveLength(1);
	});

	it('returns worker configs from daemon section', async () => {
		const result = await callLoad();

		expect(result.workers).toHaveLength(2);
		expect(result.workers[0].name).toBe('format');
		expect(result.workers[0].schedule).toBe('5m');
		expect(result.workers[0].priority).toBe(2); // 'high' maps to 2
		expect(result.workers[1].name).toBe('test-runner');
	});

	it('returns learning config', async () => {
		const result = await callLoad();

		expect(result.learning).toEqual(sampleSettings.claudeFlow.learning);
	});

	it('returns daemon state', async () => {
		const result = await callLoad();

		expect(result.daemonAutoStart).toBe(true);
		expect(result.daemonRunning).toBe(true);
		expect(result.daemonStartedAt).toBe('2026-03-01T00:00:00Z');
	});

	it('returns worker stats from daemon state', async () => {
		const result = await callLoad();

		expect(result.workerStats).toEqual(sampleDaemonState.workers);
		expect(result.workerConfigs).toEqual(sampleDaemonState.config.workers);
	});

	it('returns defaults when no settings found', async () => {
		mockedReadJson.mockResolvedValue(null);

		const result = await callLoad();

		expect(result.hooks).toEqual({});
		expect(result.workers).toEqual([]);
		expect(result.learning).toBeNull();
		expect(result.daemonAutoStart).toBe(false);
		expect(result.daemonRunning).toBe(false);
	});

	it('prefers project-specific settings over global', async () => {
		const projectHooks = { PreToolUse: [{ matcher: 'proj', hooks: [] }] };
		mockedReadJson.mockImplementation(async (path: any) => {
			const p = String(path);
			if (p.includes('test-proj')) return { hooks: projectHooks };
			if (p.includes('settings.json')) return sampleSettings;
			if (p.includes('daemon-state.json')) return sampleDaemonState;
			return null;
		});

		const result = await callLoad();

		expect(result.hooks).toEqual(projectHooks);
	});

	it('falls back to root path when project not found in scan', async () => {
		mockedScan.mockResolvedValue([] as any);

		// Should not throw, just use PATHS.root as fallback
		const result = await callLoad();
		expect(result.hooks).toBeDefined();
	});
});
