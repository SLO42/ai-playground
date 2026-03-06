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
	const url = new URL('http://localhost/projects/test-proj/agents');
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

const sampleApiResponse = {
	summary: { associated: 3, available: 10, total: 13, types: 4 },
	capacity: { current: 3, max: 15 },
	agents: [
		{ id: 'a1', name: 'Coder', type: 'coder', status: 'active' },
		{ id: 'a2', name: 'Tester', type: 'tester', status: 'idle' }
	],
	availableAgents: [{ id: 'a3', name: 'Reviewer', type: 'reviewer' }],
	pagination: { page: 1, pageSize: 10, totalItems: 3, totalPages: 1 }
};

describe('Project Agents +page.server load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedFlags.mockReturnValue({ previewNewPages: true } as any);
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(sampleApiResponse)
		});
	});

	describe('feature flag gating', () => {
		it('returns disabled state when previewNewPages is false', async () => {
			mockedFlags.mockReturnValue({ previewNewPages: false } as any);
			const result = await callLoad();

			expect(result.previewEnabled).toBe(false);
			expect(result.agents).toEqual([]);
			expect(result.summary).toEqual({ associated: 0, available: 0, total: 0, types: 0 });
			expect(result.capacity).toEqual({ current: 0, max: 15 });
		});

		it('returns enabled state when previewNewPages is true', async () => {
			const result = await callLoad();
			expect(result.previewEnabled).toBe(true);
		});
	});

	describe('data loading', () => {
		it('fetches agents from the API with correct project id', async () => {
			await callLoad({ params: { id: 'my-project' } });

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/api/projects/my-project/agents')
			);
		});

		it('returns agent data from API response', async () => {
			const result = await callLoad();

			expect(result.agents).toEqual(sampleApiResponse.agents);
			expect(result.summary).toEqual(sampleApiResponse.summary);
			expect(result.capacity).toEqual(sampleApiResponse.capacity);
			expect(result.availableAgents).toEqual(sampleApiResponse.availableAgents);
		});

		it('passes page and pageSize query params to API', async () => {
			await callLoad({ urlParams: { page: '3', pageSize: '25' } });

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('page=3&pageSize=25')
			);
		});

		it('defaults page to 1 and pageSize to 10', async () => {
			await callLoad();

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('page=1&pageSize=10')
			);
		});
	});

	describe('error handling', () => {
		it('returns error state on non-ok API response', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: 'Internal error' })
			});

			const result = await callLoad();
			expect(result.loadError).toBe('Internal error');
			expect(result.agents).toEqual([]);
			expect(result.summary.total).toBe(0);
		});

		it('handles API response that cannot be parsed as JSON', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 502,
				json: () => Promise.reject(new Error('not json'))
			});

			const result = await callLoad();
			expect(result.loadError).toBe('API error (502)');
			expect(result.agents).toEqual([]);
		});

		it('returns error state when fetch throws', async () => {
			mockFetch.mockRejectedValue(new Error('Network failure'));

			const result = await callLoad();
			expect(result.loadError).toBe('Network failure');
			expect(result.agents).toEqual([]);
		});

		it('returns generic error for non-Error throws', async () => {
			mockFetch.mockRejectedValue('string error');

			const result = await callLoad();
			expect(result.loadError).toBe('Failed to load agents');
		});

		it('preserves pageSize in error pagination', async () => {
			mockFetch.mockRejectedValue(new Error('fail'));

			const result = await callLoad({ urlParams: { pageSize: '25' } });
			expect(result.pagination.pageSize).toBe(25);
		});
	});

	describe('URL encoding', () => {
		it('encodes project id with special characters', async () => {
			await callLoad({ params: { id: 'my project/test' } });

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/api/projects/my%20project%2Ftest/agents')
			);
		});
	});
});
