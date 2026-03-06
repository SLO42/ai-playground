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
	const url = new URL('http://localhost/projects/test-proj/sessions');
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url;
}

function callLoad(overrides: { params?: Record<string, string>; urlParams?: Record<string, string> } = {}) {
	return load({
		params: { id: 'test-proj', ...overrides.params },
		url: makeUrl(overrides.urlParams),
		fetch: mockFetch
	} as any) as ReturnType<typeof load>;
}

const sampleApiResponse = {
	summary: { active: 2, paused: 1, completed: 5, totalTurns: 42 },
	sessions: [
		{ id: 's1', status: 'active', turns: 10, startedAt: '2026-01-01T00:00:00Z' },
		{ id: 's2', status: 'completed', turns: 32, startedAt: '2026-01-01T01:00:00Z' }
	],
	timeline: [{ date: '2026-01-01', count: 2 }],
	resources: {
		apiTokens: { value: 1000, cost: '$0.03' },
		localTokens: { value: 5000, cost: '$0.00 (Ollama)' },
		memoryNodes: { value: 15, label: '15 indexed' }
	},
	pagination: { page: 1, perPage: 10, totalSessions: 8, totalPages: 1 }
};

describe('Project Sessions +page.server load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedFlags.mockReturnValue({ previewNewPages: true } as any);
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(sampleApiResponse)
		});
	});

	describe('feature flag gating', () => {
		it('throws 404 when previewNewPages is false', async () => {
			mockedFlags.mockReturnValue({ previewNewPages: false } as any);
			await expect(callLoad()).rejects.toThrow();
		});
	});

	describe('data loading', () => {
		it('fetches sessions from the API with correct project id', async () => {
			await callLoad({ params: { id: 'my-project' } });

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/api/projects/my-project/sessions')
			);
		});

		it('returns session data from API response', async () => {
			const result = await callLoad();

			expect(result.sessions).toEqual(sampleApiResponse.sessions);
			expect(result.summary).toEqual(sampleApiResponse.summary);
			expect(result.resources).toEqual(sampleApiResponse.resources);
			expect(result.error).toBeNull();
		});

		it('passes page and perPage query params to API', async () => {
			await callLoad({ urlParams: { page: '2', perPage: '25' } });

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('page=2&perPage=25')
			);
		});

		it('defaults page to 1 and perPage to 10', async () => {
			await callLoad();

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('page=1&perPage=10')
			);
		});

		it('returns timeline data', async () => {
			const result = await callLoad();
			expect(result.timeline).toEqual(sampleApiResponse.timeline);
		});

		it('returns pagination from API', async () => {
			const result = await callLoad();
			expect(result.pagination).toEqual(sampleApiResponse.pagination);
		});
	});

	describe('error handling', () => {
		it('returns error state on non-ok API response', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				statusText: 'Internal Server Error',
				json: () => Promise.resolve({ error: 'Database error' })
			});

			const result = await callLoad();
			expect(result.error).toBe('Database error');
			expect(result.sessions).toEqual([]);
			expect(result.summary.active).toBe(0);
		});

		it('uses statusText when API error response has no error field', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 503,
				statusText: 'Service Unavailable',
				json: () => Promise.resolve({})
			});

			const result = await callLoad();
			expect(result.error).toContain('Failed to load sessions');
		});

		it('handles API response that fails JSON parse', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 502,
				statusText: 'Bad Gateway',
				json: () => Promise.reject(new Error('not json'))
			});

			const result = await callLoad();
			expect(result.error).toBe('Bad Gateway');
		});

		it('returns error when fetch throws', async () => {
			mockFetch.mockRejectedValue(new Error('Network failure'));

			const result = await callLoad();
			expect(result.error).toBe('Failed to connect to sessions API');
		});

		it('returns empty defaults in error state', async () => {
			mockFetch.mockRejectedValue(new Error('fail'));

			const result = await callLoad();
			expect(result.sessions).toEqual([]);
			expect(result.timeline).toEqual([]);
			expect(result.summary).toEqual({ active: 0, paused: 0, completed: 0, totalTurns: 0 });
			expect(result.resources.apiTokens.value).toBe(0);
			expect(result.resources.localTokens.value).toBe(0);
			expect(result.resources.memoryNodes.value).toBe(0);
		});

		it('returns valid pagination in error state', async () => {
			mockFetch.mockRejectedValue(new Error('fail'));

			const result = await callLoad();
			expect(result.pagination).toEqual({
				page: 1,
				perPage: 10,
				totalSessions: 0,
				totalPages: 1
			});
		});
	});

	describe('URL encoding', () => {
		it('encodes project id with special characters', async () => {
			await callLoad({ params: { id: 'project with spaces' } });

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/api/projects/project%20with%20spaces/sessions')
			);
		});
	});
});
