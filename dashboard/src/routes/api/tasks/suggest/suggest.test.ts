import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock task-suggestions ─────────────────────────────────────────────

const mockSuggestTasks = vi.fn(() => Promise.resolve(1));
const mockPeekSuggestions = vi.fn(() => Promise.resolve([]));

vi.mock('$lib/server/task-suggestions.js', () => ({
	suggestTasks: (...args: unknown[]) => mockSuggestTasks(...args),
	peekSuggestions: (...args: unknown[]) => mockPeekSuggestions(...args)
}));

// ── Import after mocks ───────────────────────────────────────────────

import { POST, GET } from './+server.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makePostRequest(body: unknown) {
	return {
		request: {
			json: () => Promise.resolve(body)
		}
	} as Parameters<typeof POST>[0];
}

async function postJson(body: unknown) {
	const response = await POST(makePostRequest(body));
	return { status: response.status, data: await response.json() };
}

async function getJson() {
	const response = await GET({} as Parameters<typeof GET>[0]);
	return { status: response.status, data: await response.json() };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/tasks/suggest', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSuggestTasks.mockResolvedValue(1);
	});

	it('accepts a single suggestion with title', async () => {
		const { status, data } = await postJson({
			title: 'Add error boundary',
			description: 'Missing on settings page',
			priority: 'medium',
			tags: ['ui']
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.queued).toBe(1);
		expect(mockSuggestTasks).toHaveBeenCalledOnce();
		expect(mockSuggestTasks).toHaveBeenCalledWith([
			expect.objectContaining({
				title: 'Add error boundary',
				description: 'Missing on settings page',
				priority: 'medium',
				tags: ['ui'],
				source: 'api'
			})
		]);
	});

	it('accepts an array of suggestions', async () => {
		mockSuggestTasks.mockResolvedValue(3);

		const { status, data } = await postJson({
			suggestions: [
				{ title: 'Task A', source: 'agent:abc' },
				{ title: 'Task B', priority: 'high' },
				{ title: 'Task C', tags: ['testing'] }
			]
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.queued).toBe(3);
		expect(mockSuggestTasks).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ title: 'Task A', source: 'agent:abc' }),
				expect.objectContaining({ title: 'Task B', source: 'api' }),
				expect.objectContaining({ title: 'Task C', tags: ['testing'] })
			])
		);
	});

	it('returns 400 when body has neither suggestions nor title', async () => {
		const { status, data } = await postJson({ description: 'no title here' });
		expect(status).toBe(400);
		expect(data.error).toBeDefined();
	});

	it('returns 400 when all suggestions have empty titles', async () => {
		const { status, data } = await postJson({
			suggestions: [
				{ title: '' },
				{ title: '   ' }
			]
		});
		expect(status).toBe(400);
		expect(data.error).toContain('No valid suggestions');
	});

	it('filters out suggestions with empty titles before calling suggestTasks', async () => {
		mockSuggestTasks.mockResolvedValue(1);

		const { status, data } = await postJson({
			suggestions: [
				{ title: '' },
				{ title: 'Valid task' },
				{ title: '   ' }
			]
		});

		expect(status).toBe(200);
		expect(data.queued).toBe(1);
		expect(mockSuggestTasks).toHaveBeenCalledWith([
			expect.objectContaining({ title: 'Valid task' })
		]);
	});

	it('defaults source to "api" when not provided', async () => {
		await postJson({ title: 'No source' });

		expect(mockSuggestTasks).toHaveBeenCalledWith([
			expect.objectContaining({ source: 'api' })
		]);
	});

	it('preserves explicit source when provided', async () => {
		await postJson({ title: 'From agent', source: 'agent:xyz' });

		expect(mockSuggestTasks).toHaveBeenCalledWith([
			expect.objectContaining({ source: 'agent:xyz' })
		]);
	});
});

describe('GET /api/tasks/suggest', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns empty suggestions when inbox is empty', async () => {
		mockPeekSuggestions.mockResolvedValue([]);

		const { status, data } = await getJson();
		expect(status).toBe(200);
		expect(data.count).toBe(0);
		expect(data.suggestions).toEqual([]);
	});

	it('returns current suggestions from the inbox', async () => {
		const fakeSuggestions = [
			{ title: 'Fix login', source: 'user', suggestedAt: '2026-03-06T00:00:00Z' },
			{ title: 'Add tests', source: 'agent:abc', suggestedAt: '2026-03-06T01:00:00Z' }
		];
		mockPeekSuggestions.mockResolvedValue(fakeSuggestions);

		const { status, data } = await getJson();
		expect(status).toBe(200);
		expect(data.count).toBe(2);
		expect(data.suggestions).toEqual(fakeSuggestions);
	});
});
