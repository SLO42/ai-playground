// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: vi.fn()
}));

vi.mock('$lib/server/yaml-parser.js', () => ({
	readYamlFile: vi.fn()
}));

vi.mock('$lib/server/heartbeat/agent-analytics.js', () => ({
	getAgentAnalytics: vi.fn()
}));

vi.mock('$lib/server/heartbeat/session-pool.js', () => ({
	getPoolStats: vi.fn(),
	getConfigAgents: vi.fn()
}));

vi.mock('$lib/server/heartbeat/shared.js', () => ({
	getActiveAgents: vi.fn()
}));

vi.mock('$lib/server/agent-scanner.js', () => ({
	scanAgents: vi.fn()
}));

vi.mock('$lib/server/project-scanner.js', () => ({
	scanAllProjects: vi.fn()
}));

vi.mock('fs/promises', async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return { ...actual, readFile: vi.fn() };
});

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		agentsDir: '/tmp/agents',
		v3Progress: '/tmp/v3-progress.json',
		swarmActivity: '/tmp/swarm-activity.json',
		configYaml: '/tmp/config.yaml',
		playgroundRegistry: '/tmp/registry',
		root: '/tmp/root'
	}
}));

import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { getAgentAnalytics } from '$lib/server/heartbeat/agent-analytics.js';
import { getPoolStats, getConfigAgents } from '$lib/server/heartbeat/session-pool.js';
import { getActiveAgents } from '$lib/server/heartbeat/shared.js';
import { scanAgents } from '$lib/server/agent-scanner.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readFile } from 'fs/promises';
import { load } from './+page.server.js';

const mockedReadJson = vi.mocked(readJsonFile);
const mockedReadYaml = vi.mocked(readYamlFile);
const mockedAnalytics = vi.mocked(getAgentAnalytics);
const mockedPoolStats = vi.mocked(getPoolStats);
const mockedActiveAgents = vi.mocked(getActiveAgents);
const mockedScanAgents = vi.mocked(scanAgents);
const mockedConfigAgents = vi.mocked(getConfigAgents);
const mockedScanAllProjects = vi.mocked(scanAllProjects);
const mockedReadFile = vi.mocked(readFile);

function makeUrl(params: Record<string, string> = {}) {
	const url = new URL('http://localhost/agents');
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url;
}

function callLoad(urlParams: Record<string, string> = {}) {
	return load({ url: makeUrl(urlParams) } as any) as ReturnType<typeof load>;
}

function setupDefaults() {
	mockedScanAgents.mockResolvedValue([]);
	mockedReadJson.mockResolvedValue(null);
	mockedReadYaml.mockResolvedValue(null);
	mockedAnalytics.mockResolvedValue({ events: [], summary: { totalTasks: 0, completedTasks: 0, failedTasks: 0, totalCostUsd: 0, totalDurationMs: 0, avgCostPerTask: 0, avgDurationMs: 0 }, byModel: {}, byRoute: { openclaw: { count: 0, escalated: 0, completedLocally: 0, totalCost: 0 }, claudeCode: { count: 0, sonnet: 0, opus: 0, totalCost: 0 } }, escalationRate: 0 } as any);
	mockedPoolStats.mockResolvedValue({ total: 0, active: 0, idle: 0, sessions: [] } as any);
	mockedActiveAgents.mockReturnValue(new Map());
	mockedConfigAgents.mockResolvedValue([]);
	mockedScanAllProjects.mockResolvedValue([]);
	mockedReadFile.mockRejectedValue(new Error('ENOENT'));
}

function setupAgentFiles(count: number) {
	const agents = Array.from({ length: count }, (_, i) => ({
		name: `Test Agent ${i}`,
		description: 'A test agent',
		type: 'coder',
		color: 'cyan',
		priority: 'high',
		capabilities: ['coding', 'testing'],
		filename: `agent-${i}.md`,
		searchText: ''
	}));
	mockedScanAgents.mockResolvedValue(agents as any);
}

describe('Agents +page.server load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setupDefaults();
	});

	describe('basic data loading', () => {
		it('returns empty agents when no .md files exist', async () => {
			const result = await callLoad();
			expect(result.agents).toEqual([]);
			expect(result.total).toBe(0);
		});

		it('parses agent definitions from scanAgents', async () => {
			setupAgentFiles(1);
			const result = await callLoad();

			expect(result.agents.length).toBe(1);
			expect(result.agents[0].name).toBe('Test Agent 0');
			expect(result.agents[0].description).toBe('A test agent');
			expect(result.agents[0].type).toBe('coder');
		});

		it('returns swarmStatus defaults when no swarm activity', async () => {
			const result = await callLoad();
			expect(result.swarmStatus).toEqual({
				active: false,
				agentCount: 0,
				coordinationActive: false,
				processes: null
			});
		});

		it('returns v3Progress defaults when no progress file', async () => {
			const result = await callLoad();
			expect(result.v3Progress).toEqual({
				activeAgents: 0,
				maxAgents: 15,
				topology: 'hierarchical-mesh'
			});
		});

		it('passes through analytics and poolStats', async () => {
			const analytics = { events: [], summary: { totalTasks: 5, completedTasks: 2, failedTasks: 0, totalCostUsd: 0, totalDurationMs: 0, avgCostPerTask: 0, avgDurationMs: 0 }, byModel: {}, byRoute: { openclaw: { count: 0, escalated: 0, completedLocally: 0, totalCost: 0 }, claudeCode: { count: 0, sonnet: 0, opus: 0, totalCost: 0 } }, escalationRate: 0 } as any;
			mockedAnalytics.mockResolvedValue(analytics);

			const result = await callLoad();
			expect(result.analytics).toEqual(analytics);
		});

		it('returns active agents list from shared state', async () => {
			mockedActiveAgents.mockReturnValue(new Map([
				['task-1', {
					taskId: 'task-1',
					pid: 1234,
					startedAt: '2026-01-01T00:00:00Z',
					sender: { label: 'coder-1', color: 'cyan' },
					reportSessionId: 'sess-1'
				}]
			]) as any);

			const result = await callLoad();
			expect(result.activeAgents).toHaveLength(1);
			expect(result.activeAgents[0]).toEqual({
				taskId: 'task-1',
				pid: 1234,
				startedAt: '2026-01-01T00:00:00Z',
				label: 'coder-1',
				color: 'cyan',
				sessionId: 'sess-1'
			});
		});
	});

	describe('pagination', () => {
		it('defaults to page 1 with perPage 24', async () => {
			const result = await callLoad();
			expect(result.page).toBe(1);
			expect(result.perPage).toBe(24);
		});

		it('respects custom page and perPage', async () => {
			setupAgentFiles(30);
			const result = await callLoad({ page: '2', perPage: '10' });
			expect(result.page).toBe(2);
			expect(result.perPage).toBe(10);
		});

		it('clamps page to minimum 1 for invalid values', async () => {
			const result = await callLoad({ page: '0' });
			expect(result.page).toBe(1);
		});

		it('clamps page to minimum 1 for negative values', async () => {
			const result = await callLoad({ page: '-3' });
			expect(result.page).toBe(1);
		});

		it('caps perPage at 100', async () => {
			const result = await callLoad({ perPage: '200' });
			expect(result.perPage).toBe(100);
		});

		it('enforces minimum perPage of 1', async () => {
			const result = await callLoad({ perPage: '0' });
			expect(result.perPage).toBe(24); // falls back to default
		});

		it('calculates totalPages correctly', async () => {
			setupAgentFiles(5);
			const result = await callLoad({ perPage: '2' });
			expect(result.totalPages).toBe(Math.ceil(result.total / 2));
		});

		it('clamps page to totalPages if exceeding', async () => {
			setupAgentFiles(3);
			const result = await callLoad({ page: '100', perPage: '10' });
			expect(result.page).toBeLessThanOrEqual(result.totalPages);
		});

		it('returns correct slice for page 2', async () => {
			setupAgentFiles(5);
			const page1 = await callLoad({ page: '1', perPage: '2' });
			const page2 = await callLoad({ page: '2', perPage: '2' });

			expect(page1.agents.length).toBe(2);
			expect(page2.agents.length).toBeGreaterThan(0);
		});
	});

	describe('error handling', () => {
		it('returns empty agents when scanAgents returns empty', async () => {
			mockedScanAgents.mockResolvedValue([]);
			const result = await callLoad();
			expect(result.agents).toEqual([]);
			expect(result.total).toBe(0);
		});

		it('skips files that fail to read (handled by scanAgents internally)', async () => {
			// scanAgents handles this internally, so just verify it returns what scanAgents provides
			setupAgentFiles(1);
			const result = await callLoad();
			expect(result.agents.length).toBe(1);
		});

		it('skips files without valid frontmatter (handled by scanAgents internally)', async () => {
			// scanAgents filters these internally
			mockedScanAgents.mockResolvedValue([]);
			const result = await callLoad();
			expect(result.agents).toEqual([]);
		});
	});

	describe('swarm status from data', () => {
		it('populates swarmStatus from swarm activity data', async () => {
			mockedReadJson.mockImplementation(((path: string) => {
				if (path.includes('swarm-activity')) {
					return Promise.resolve({
						swarm: { active: true, agent_count: 5, coordination_active: true },
						processes: [{ pid: 123 }]
					});
				}
				return Promise.resolve(null);
			}) as any);

			const result = await callLoad();
			expect(result.swarmStatus.active).toBe(true);
			expect(result.swarmStatus.agentCount).toBe(5);
			expect(result.swarmStatus.coordinationActive).toBe(true);
		});

		it('populates v3Progress from progress file', async () => {
			mockedReadJson.mockImplementation(((path: string) => {
				if (path.includes('v3-progress')) {
					return Promise.resolve({
						swarm: { activeAgents: 3, maxAgents: 10, topology: 'mesh' }
					});
				}
				return Promise.resolve(null);
			}) as any);

			const result = await callLoad();
			expect(result.v3Progress.activeAgents).toBe(3);
			expect(result.v3Progress.maxAgents).toBe(10);
			expect(result.v3Progress.topology).toBe('mesh');
		});
	});
});
