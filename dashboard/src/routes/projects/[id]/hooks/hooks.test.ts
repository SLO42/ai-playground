// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/feature-flags.js', () => ({
	getFeatureFlags: vi.fn()
}));

import { getFeatureFlags } from '$lib/server/feature-flags.js';
import { load } from './+page.server.js';

const mockedFlags = vi.mocked(getFeatureFlags);
const mockFetch = vi.fn();

function makeUrl(params: Record<string, string> = {}) {
	const url = new URL('http://localhost/projects/test-proj/hooks');
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url;
}

function callLoad(overrides: { params?: Record<string, string>; urlParams?: Record<string, string> } = {}) {
	return load({
		params: { id: 'test-proj', ...overrides.params },
		url: makeUrl(overrides.urlParams),
		fetch: mockFetch
	} as any);
}

const sampleHooks = [
	{ name: 'pre-commit', type: 'pre-task', description: 'Run before commit', enabled: true, command: 'lint' },
	{ name: 'post-deploy', type: 'post-task', description: 'After deploy', enabled: false, command: 'notify' },
	{ name: 'format', type: 'pre-edit', description: 'Auto format', enabled: true },
	{ name: 'test-hook', type: 'pre-task', description: 'Run tests', enabled: true, command: 'npm test' }
];

describe('Project Hooks +page.server load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedFlags.mockReturnValue({ previewNewPages: true } as any);
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ hooks: sampleHooks })
		});
	});

	describe('feature flag gating', () => {
		it('throws 404 when previewNewPages is false', async () => {
			mockedFlags.mockReturnValue({ previewNewPages: false } as any);
			await expect(callLoad()).rejects.toThrow();
		});
	});

	describe('data loading', () => {
		it('fetches hooks from the API with correct project id', async () => {
			await callLoad({ params: { id: 'my-project' } });

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/api/projects/my-project/hooks')
			);
		});

		it('returns hooks from API response', async () => {
			const result = await callLoad();

			expect(result.hooks.length).toBeGreaterThan(0);
			expect(result.hooks[0].name).toBe('pre-commit');
			expect(result.projectId).toBe('test-proj');
		});

		it('returns total count of all hooks', async () => {
			const result = await callLoad();
			expect(result.total).toBe(sampleHooks.length);
		});
	});

	describe('pagination', () => {
		it('defaults to page 1 with pageSize 10', async () => {
			const result = await callLoad();
			expect(result.page).toBe(1);
			expect(result.pageSize).toBe(10);
		});

		it('respects custom page parameter', async () => {
			const result = await callLoad({ urlParams: { page: '1', pageSize: '2' } });
			expect(result.pageSize).toBe(2);
			expect(result.hooks.length).toBe(2);
		});

		it('clamps page to minimum 1', async () => {
			const result = await callLoad({ urlParams: { page: '0' } });
			expect(result.page).toBe(1);
		});

		it('clamps page to minimum 1 for negative values', async () => {
			const result = await callLoad({ urlParams: { page: '-5' } });
			expect(result.page).toBe(1);
		});

		it('caps pageSize at 50', async () => {
			const result = await callLoad({ urlParams: { pageSize: '100' } });
			expect(result.pageSize).toBe(50);
		});

		it('enforces minimum pageSize of 1', async () => {
			const result = await callLoad({ urlParams: { pageSize: '0' } });
			expect(result.pageSize).toBe(10); // falls back to default
		});

		it('calculates totalPages correctly', async () => {
			const result = await callLoad({ urlParams: { pageSize: '2' } });
			expect(result.totalPages).toBe(Math.ceil(sampleHooks.length / 2));
		});

		it('clamps page to totalPages if exceeding', async () => {
			const result = await callLoad({ urlParams: { page: '100', pageSize: '2' } });
			expect(result.page).toBeLessThanOrEqual(result.totalPages);
		});

		it('returns correct slice for page 2', async () => {
			const page1 = await callLoad({ urlParams: { page: '1', pageSize: '2' } });
			const page2 = await callLoad({ urlParams: { page: '2', pageSize: '2' } });

			expect(page1.hooks.length).toBe(2);
			expect(page2.hooks.length).toBe(2);

			const names1 = page1.hooks.map((h: any) => h.name);
			const names2 = page2.hooks.map((h: any) => h.name);
			const overlap = names1.filter((n: string) => names2.includes(n));
			expect(overlap).toHaveLength(0);
		});
	});

	describe('error handling', () => {
		it('returns error state on non-ok API response', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: 'Server error' })
			});

			const result = await callLoad();
			expect(result.error).toBe('Server error');
			expect(result.hooks).toEqual([]);
			expect(result.total).toBe(0);
		});

		it('handles API response that fails to parse as JSON', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 502,
				json: () => Promise.reject(new Error('not json'))
			});

			const result = await callLoad();
			expect(result.error).toBe('Failed to load hooks');
			expect(result.hooks).toEqual([]);
		});

		it('returns valid pagination in error state', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: 'fail' })
			});

			const result = await callLoad();
			expect(result.page).toBe(1);
			expect(result.pageSize).toBe(10);
			expect(result.totalPages).toBe(1);
		});

		it('handles empty hooks array from API', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ hooks: [] })
			});

			const result = await callLoad();
			expect(result.hooks).toEqual([]);
			expect(result.total).toBe(0);
			expect(result.totalPages).toBe(1);
		});

		it('handles missing hooks key in API response', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({})
			});

			const result = await callLoad();
			expect(result.hooks).toEqual([]);
			expect(result.total).toBe(0);
		});
	});
});
