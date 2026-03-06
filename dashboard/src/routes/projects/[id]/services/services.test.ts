// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/project-scanner.js', () => ({
	scanAllProjects: vi.fn()
}));

vi.mock('$lib/server/feature-flags.js', () => ({
	getFeatureFlags: vi.fn()
}));

import { scanAllProjects } from '$lib/server/project-scanner.js';
import { getFeatureFlags } from '$lib/server/feature-flags.js';
import { load } from './+page.server.js';

const mockedScan = vi.mocked(scanAllProjects);
const mockedFlags = vi.mocked(getFeatureFlags);

function makeUrl(params: Record<string, string> = {}) {
	const url = new URL('http://localhost/projects/test-proj/services');
	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, v);
	}
	return url;
}

function makeFetchResponse(data: any, ok = true, status = 200) {
	return Promise.resolve({
		ok,
		status,
		json: () => Promise.resolve(data)
	});
}

function makeService(overrides: Record<string, any> = {}) {
	return {
		name: 'Test Service',
		status: 'stopped',
		type: 'test-type',
		port: 8080,
		pid: null,
		uptime: null,
		configPath: null,
		...overrides
	};
}

function callLoad(overrides: {
	params?: Record<string, string>;
	urlParams?: Record<string, string>;
	fetch?: (...args: any[]) => any;
} = {}) {
	const mockFetch = overrides.fetch ?? (() => makeFetchResponse({ services: [] }));
	return load({
		params: { id: 'test-proj', ...overrides.params },
		url: makeUrl(overrides.urlParams),
		fetch: mockFetch
	} as any);
}

describe('Project Services +page.server load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedFlags.mockReturnValue({ previewNewPages: true } as any);
		mockedScan.mockResolvedValue([{ id: 'test-proj', name: 'Test Project', path: '/tmp' }] as any);
	});

	describe('basic data loading', () => {
		it('returns services from API with correct shape', async () => {
			const services = [makeService({ name: 'Ollama', status: 'running', port: 11434 })];
			const result = await callLoad({
				fetch: () => makeFetchResponse({ services })
			});

			expect(result.error).toBeNull();
			expect(result.services).toHaveLength(1);
			expect(result.services[0].name).toBe('Ollama');
			expect(result.services[0].status).toBe('running');
		});

		it('maps Service fields to ServiceEntry fields', async () => {
			const services = [makeService({
				name: 'Svc',
				type: 'some-type',
				port: 9999,
				configPath: '.mcp-agents.json'
			})];
			const result = await callLoad({
				fetch: () => makeFetchResponse({ services })
			});

			expect(result.services[0]).toEqual({
				name: 'Svc',
				status: 'stopped',
				description: 'some-type',
				port: 9999,
				pid: null,
				uptime: null,
				configFile: '.mcp-agents.json'
			});
		});

		it('returns projectName from scanned project', async () => {
			const result = await callLoad();
			expect(result.projectName).toBe('Test Project');
		});

		it('falls back to params.id when project not found', async () => {
			mockedScan.mockResolvedValue([]);
			const result = await callLoad();
			expect(result.projectName).toBe('test-proj');
		});
	});

	describe('summary counts', () => {
		it('counts running and stopped services correctly', async () => {
			const services = [
				makeService({ name: 'A', status: 'running' }),
				makeService({ name: 'B', status: 'stopped' }),
				makeService({ name: 'C', status: 'stopped' })
			];
			const result = await callLoad({
				fetch: () => makeFetchResponse({ services })
			});

			expect(result.summary.running).toBe(1);
			expect(result.summary.stopped).toBe(2);
		});

		it('counts fromConfig and manual correctly', async () => {
			const services = [
				makeService({ name: 'A', configPath: '.mcp-agents.json' }),
				makeService({ name: 'B', configPath: '.mcp-agents.json' }),
				makeService({ name: 'C', configPath: null })
			];
			const result = await callLoad({
				fetch: () => makeFetchResponse({ services })
			});

			expect(result.summary.fromConfig).toBe(2);
			expect(result.summary.manual).toBe(1);
		});

		it('deduplicates configSource entries', async () => {
			const services = [
				makeService({ name: 'A', configPath: '.mcp-agents.json' }),
				makeService({ name: 'B', configPath: '.mcp-agents.json' }),
				makeService({ name: 'C', configPath: 'other.json' })
			];
			const result = await callLoad({
				fetch: () => makeFetchResponse({ services })
			});

			expect(result.summary.configSource).toEqual(['.mcp-agents.json', 'other.json']);
		});
	});

	describe('pagination', () => {
		it('defaults to page 1 with PAGE_SIZE 10', async () => {
			const result = await callLoad();
			expect(result.pagination.page).toBe(1);
			expect(result.pagination.pageSize).toBe(10);
		});

		it('respects page query parameter', async () => {
			const services = Array.from({ length: 5 }, (_, i) => makeService({ name: `svc-${i}` }));
			const result = await callLoad({
				fetch: () => makeFetchResponse({ services }),
				urlParams: { page: '2', pageSize: '2' }
			});
			expect(result.pagination.page).toBe(2);
			expect(result.services[0].name).toBe('svc-2');
		});

		it('clamps page to minimum 1 for invalid values', async () => {
			const result = await callLoad({ urlParams: { page: '0' } });
			expect(result.pagination.page).toBe(1);
		});

		it('clamps page to minimum 1 for negative values', async () => {
			const result = await callLoad({ urlParams: { page: '-5' } });
			expect(result.pagination.page).toBe(1);
		});

		it('clamps page to totalPages when exceeding', async () => {
			const services = [makeService({ name: 'only-one' })];
			const result = await callLoad({
				fetch: () => makeFetchResponse({ services }),
				urlParams: { page: '99' }
			});
			expect(result.pagination.page).toBe(1);
		});

		it('caps pageSize at 50', async () => {
			const result = await callLoad({ urlParams: { pageSize: '100' } });
			expect(result.pagination.pageSize).toBe(50);
		});

		it('enforces minimum pageSize of 1', async () => {
			const result = await callLoad({ urlParams: { pageSize: '0' } });
			expect(result.pagination.pageSize).toBe(10);
		});

		it('returns correct slice for page 2', async () => {
			const services = Array.from({ length: 5 }, (_, i) => makeService({ name: `svc-${i}` }));
			const fetchFn = () => makeFetchResponse({ services });

			const page1 = await callLoad({ fetch: fetchFn, urlParams: { pageSize: '2', page: '1' } });
			const page2 = await callLoad({ fetch: fetchFn, urlParams: { pageSize: '2', page: '2' } });

			expect(page1.services).toHaveLength(2);
			expect(page2.services).toHaveLength(2);
			const names1 = page1.services.map((s: any) => s.name);
			const names2 = page2.services.map((s: any) => s.name);
			const overlap = names1.filter((n: string) => names2.includes(n));
			expect(overlap).toHaveLength(0);
		});
	});

	describe('error handling', () => {
		it('returns error state when scanAllProjects throws', async () => {
			mockedScan.mockRejectedValue(new Error('scan failed'));

			const result = await callLoad();
			expect(result.error).toBe('scan failed');
			expect(result.services).toEqual([]);
			expect(result.summary.running).toBe(0);
			expect(result.summary.stopped).toBe(0);
		});

		it('returns generic error message for non-Error throws', async () => {
			mockedScan.mockRejectedValue('string error');

			const result = await callLoad();
			expect(result.error).toBe('Failed to load services');
		});

		it('returns valid pagination in error state', async () => {
			mockedScan.mockRejectedValue(new Error('fail'));

			const result = await callLoad();
			expect(result.pagination).toEqual({
				page: 1,
				pageSize: 10,
				total: 0,
				totalPages: 1
			});
		});

		it('returns empty autoStart and logs in error state', async () => {
			mockedScan.mockRejectedValue(new Error('fail'));

			const result = await callLoad();
			expect(result.autoStart).toEqual([]);
			expect(result.logs).toEqual([]);
		});

		it('returns error when API responds with non-ok status', async () => {
			const result = await callLoad({
				fetch: () => Promise.resolve({
					ok: false,
					status: 500,
					json: () => Promise.resolve({ error: 'Internal server error' })
				})
			});

			expect(result.error).toBe('Internal server error');
			expect(result.services).toEqual([]);
		});

		it('returns fallback error when API error body has no error field', async () => {
			const result = await callLoad({
				fetch: () => Promise.resolve({
					ok: false,
					status: 502,
					json: () => Promise.resolve({})
				})
			});

			expect(result.error).toBe('API returned 502');
		});

		it('handles API error response where json() parsing fails', async () => {
			const result = await callLoad({
				fetch: () => Promise.resolve({
					ok: false,
					status: 500,
					json: () => Promise.reject(new SyntaxError('Unexpected token'))
				})
			});

			expect(result.error).toBe('Unknown error');
		});
	});

	describe('fetch timeout and network errors', () => {
		it('handles fetch rejection (connection refused)', async () => {
			const result = await callLoad({
				fetch: () => Promise.reject(new Error('fetch failed: connection refused'))
			});

			expect(result.error).toBe('fetch failed: connection refused');
			expect(result.services).toEqual([]);
			expect(result.summary.running).toBe(0);
			expect(result.summary.stopped).toBe(0);
		});

		it('handles AbortError from fetch timeout', async () => {
			const abortError = new DOMException('The operation was aborted', 'AbortError');
			const result = await callLoad({
				fetch: () => Promise.reject(abortError)
			});

			expect(result.error).toBe('The operation was aborted');
			expect(result.services).toEqual([]);
		});

		it('handles TypeError from invalid URL or network failure', async () => {
			const result = await callLoad({
				fetch: () => Promise.reject(new TypeError('Failed to fetch'))
			});

			expect(result.error).toBe('Failed to fetch');
			expect(result.services).toEqual([]);
		});

		it('returns params.id as projectName when fetch fails', async () => {
			const result = await callLoad({
				fetch: () => Promise.reject(new Error('timeout'))
			});

			expect(result.projectName).toBe('test-proj');
		});

		it('handles fetch that never resolves (simulated timeout)', async () => {
			const loadPromise = callLoad({
				fetch: () => new Promise(() => {})
			});
			const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50));

			const winner = await Promise.race([loadPromise, timeout]);
			expect(winner).toBe('timeout');
		});
	});

	describe('race conditions between scanAllProjects and fetch', () => {
		it('handles scan succeeding but fetch failing', async () => {
			mockedScan.mockResolvedValue([{ id: 'test-proj', name: 'Good', path: '/tmp' }] as any);

			const result = await callLoad({
				fetch: () => Promise.reject(new Error('API down'))
			});

			expect(result.error).toBe('API down');
			expect(result.services).toEqual([]);
		});

		it('handles fetch succeeding but scan failing', async () => {
			mockedScan.mockRejectedValue(new Error('filesystem error'));

			const result = await callLoad({
				fetch: () => makeFetchResponse({ services: [makeService()] })
			});

			expect(result.error).toBe('filesystem error');
			expect(result.services).toEqual([]);
		});

		it('handles both scan and fetch failing simultaneously', async () => {
			mockedScan.mockRejectedValue(new Error('scan broken'));

			const result = await callLoad({
				fetch: () => Promise.reject(new Error('fetch broken'))
			});

			expect(result.error).toBeTruthy();
			expect(result.services).toEqual([]);
			expect(result.pagination.total).toBe(0);
		});

		it('handles slow scan completing after fast fetch', async () => {
			mockedScan.mockImplementation(() =>
				new Promise((resolve) =>
					setTimeout(() => resolve([{ id: 'test-proj', name: 'Slow Scan', path: '/tmp' }] as any), 50)
				)
			);

			const result = await callLoad({
				fetch: () => makeFetchResponse({ services: [makeService({ name: 'Fast Svc' })] })
			});

			expect(result.error).toBeNull();
			expect(result.projectName).toBe('Slow Scan');
			expect(result.services[0].name).toBe('Fast Svc');
		});

		it('handles slow fetch completing after fast scan', async () => {
			mockedScan.mockResolvedValue([{ id: 'test-proj', name: 'Fast Scan', path: '/tmp' }] as any);

			const result = await callLoad({
				fetch: () =>
					new Promise((resolve) =>
						setTimeout(() => resolve({
							ok: true,
							status: 200,
							json: () => Promise.resolve({ services: [makeService({ name: 'Slow Svc' })] })
						}), 50)
					)
			});

			expect(result.error).toBeNull();
			expect(result.projectName).toBe('Fast Scan');
			expect(result.services[0].name).toBe('Slow Svc');
		});

		it('handles slow scan rejecting after fast fetch succeeds', async () => {
			mockedScan.mockImplementation(() =>
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('delayed scan failure')), 50)
				)
			);

			const result = await callLoad({
				fetch: () => makeFetchResponse({ services: [makeService()] })
			});

			expect(result.error).toBe('delayed scan failure');
			expect(result.services).toEqual([]);
		});
	});

	describe('feature flags', () => {
		it('throws 404 when previewNewPages is disabled', async () => {
			mockedFlags.mockReturnValue({ previewNewPages: false } as any);

			await expect(callLoad()).rejects.toThrow();
		});
	});

	describe('autoStart and logs', () => {
		it('returns empty autoStart array', async () => {
			const result = await callLoad();
			expect(result.autoStart).toEqual([]);
		});

		it('returns empty logs array', async () => {
			const result = await callLoad();
			expect(result.logs).toEqual([]);
		});
	});
});
