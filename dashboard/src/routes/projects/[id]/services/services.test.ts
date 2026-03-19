// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
	readFile: vi.fn()
}));

vi.mock('$lib/server/project-scanner.js', () => ({
	scanAllProjects: vi.fn(),
	detectProjectMeta: vi.fn()
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		playgroundRegistry: '/mock/registry.json',
		root: '/mock/root'
	},
	SERVICES: {
		ollama: {
			id: 'ollama',
			name: 'Ollama Server',
			type: 'Model Runtime',
			configPath: 'config/openclaw/models.json5',
			port: 11434,
			healthUrl: 'http://127.0.0.1:11434/',
			logFile: null
		}
	}
}));

import { readFile } from 'fs/promises';
import { scanAllProjects, detectProjectMeta } from '$lib/server/project-scanner.js';
import { load } from './+page.server.js';

const mockedReadFile = vi.mocked(readFile);
const mockedScan = vi.mocked(scanAllProjects);
const mockedDetectMeta = vi.mocked(detectProjectMeta);

// Mock global fetch for health checks
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeParent(overrides: Record<string, any> = {}) {
	return () =>
		Promise.resolve({
			project: { id: 'test-proj', name: 'Test Project', path: '/tmp/test-proj', ...overrides }
		});
}

function callLoad(overrides: { params?: Record<string, string>; parent?: () => Promise<any> } = {}) {
	return load({
		params: { id: 'test-proj', ...overrides.params },
		parent: overrides.parent ?? makeParent()
	} as any) as ReturnType<typeof load>;
}

describe('Project Services +page.server load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedScan.mockResolvedValue([
			{ id: 'test-proj', name: 'Test Project', path: '/tmp/test-proj' }
		] as any);
		mockedDetectMeta.mockResolvedValue({ services: [] } as any);
		mockedReadFile.mockRejectedValue(new Error('ENOENT'));
		mockFetch.mockRejectedValue(new Error('Connection refused'));
	});

	describe('basic data loading', () => {
		it('returns correct structure with empty services', async () => {
			const result = await callLoad();

			expect(result.projectId).toBe('test-proj');
			expect(result.projectName).toBe('Test Project');
			expect(result.services).toBeDefined();
			expect(result.stats).toBeDefined();
			expect(result.scripts).toEqual({});
		});

		it('detects services from project meta', async () => {
			mockedDetectMeta.mockResolvedValue({
				services: [
					{ name: 'Dev Server', port: 3000, healthUrl: null, command: 'npm run dev' }
				]
			} as any);

			const result = await callLoad();

			const detected = result.services.filter((s) => s.source === 'detected');
			expect(detected).toHaveLength(1);
			expect(detected[0].name).toBe('Dev Server');
			expect(detected[0].port).toBe(3000);
		});

		it('includes global services', async () => {
			const result = await callLoad();

			const global = result.services.filter((s) => s.source === 'global');
			expect(global.length).toBeGreaterThanOrEqual(1);
			expect(global.some((s) => s.name === 'Ollama Server')).toBe(true);
		});

		it('deduplicates services by port', async () => {
			mockedDetectMeta.mockResolvedValue({
				services: [
					{ name: 'My Ollama', port: 11434, healthUrl: null }
				]
			} as any);

			const result = await callLoad();

			// Should not have both detected and global with same port
			const port11434 = result.services.filter((s) => s.port === 11434);
			expect(port11434).toHaveLength(1);
			expect(port11434[0].source).toBe('detected');
		});
	});

	describe('stats', () => {
		it('computes stats correctly', async () => {
			mockedDetectMeta.mockResolvedValue({
				services: [
					{ name: 'API', port: 8080, healthUrl: null },
					{ name: 'Worker', port: null, healthUrl: null }
				]
			} as any);

			const result = await callLoad();

			expect(result.stats.detected).toBe(2);
			expect(result.stats.total).toBeGreaterThanOrEqual(2);
		});
	});

	describe('scripts', () => {
		it('reads scripts from package.json', async () => {
			mockedReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('package.json')) {
					return JSON.stringify({ scripts: { dev: 'vite dev', build: 'vite build' } });
				}
				throw new Error('ENOENT');
			});

			const result = await callLoad();

			expect(result.scripts).toEqual({ dev: 'vite dev', build: 'vite build' });
		});
	});

	describe('error handling', () => {
		it('handles detectProjectMeta failure gracefully', async () => {
			mockedDetectMeta.mockRejectedValue(new Error('scan failed'));

			const result = await callLoad();

			expect(result.services).toBeDefined();
			expect(result.stats.detected).toBe(0);
		});

		it('falls back to parent project data when not found in scan', async () => {
			mockedScan.mockResolvedValue([] as any);

			const result = await callLoad();

			expect(result.projectName).toBe('Test Project');
		});
	});

	describe('health checks', () => {
		it('marks services as running when health check succeeds', async () => {
			mockedDetectMeta.mockResolvedValue({
				services: [
					{ name: 'API', port: 8080, healthUrl: 'http://localhost:8080/health', command: null }
				]
			} as any);
			mockFetch.mockImplementation(async (url: string) => {
				if (url === 'http://localhost:8080/health') return { ok: true };
				throw new Error('Connection refused');
			});

			const result = await callLoad();

			const api = result.services.find((s) => s.name === 'API');
			expect(api?.status).toBe('running');
		});

		it('marks services as stopped when health check fails', async () => {
			mockedDetectMeta.mockResolvedValue({
				services: [
					{ name: 'API', port: 8080, healthUrl: 'http://localhost:8080/health', command: null }
				]
			} as any);
			mockFetch.mockRejectedValue(new Error('Connection refused'));

			const result = await callLoad();

			const api = result.services.find((s) => s.name === 'API');
			expect(api?.status).toBe('stopped');
		});
	});
});
