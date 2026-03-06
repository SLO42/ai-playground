import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock task-store ────────────────────────────────────────────────────

function makeTasks(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		id: `task-${String(i + 1).padStart(3, '0')}`,
		title: `Task ${i + 1}`,
		status: i % 5 === 0 ? 'completed' : 'pending' as const,
		priority: (['low', 'medium', 'high', 'critical'] as const)[i % 4],
		assignee: null,
		tags: i % 3 === 0 ? ['api', 'testing'] : ['ui'],
		feature: null,
		createdBy: 'test',
		updatedAt: new Date().toISOString(),
		completedAt: null,
		flagDiscussion: false,
		bucket: 'backlog' as const
	}));
}

const MOCK_TASKS = makeTasks(25);

vi.mock('$lib/server/task-store.js', () => ({
	listTasks: vi.fn(() => Promise.resolve([...MOCK_TASKS]))
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: { root: '/fake/root' }
}));

// ── Import after mocks ────────────────────────────────────────────────

import { GET } from './+server.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeRequest(params: Record<string, string> = {}) {
	const url = new URL('http://localhost/api/tasks');
	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, v);
	}
	return { url } as Parameters<typeof GET>[0];
}

async function fetchJson(params: Record<string, string> = {}) {
	const response = await GET(makeRequest(params));
	return response.json();
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('GET /api/tasks — pagination', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns all tasks when no pagination params', async () => {
		const data = await fetchJson();
		expect(data.tasks).toHaveLength(25);
		expect(data.total).toBe(25);
		expect(data.page).toBe(1);
		expect(data.perPage).toBe(25);
		expect(data.totalPages).toBe(1);
	});

	it('paginates with page and perPage', async () => {
		const data = await fetchJson({ page: '2', perPage: '10' });
		expect(data.tasks).toHaveLength(10);
		expect(data.total).toBe(25);
		expect(data.page).toBe(2);
		expect(data.perPage).toBe(10);
		expect(data.totalPages).toBe(3);
		// Should be tasks 11-20
		expect(data.tasks[0].id).toBe('task-011');
		expect(data.tasks[9].id).toBe('task-020');
	});

	it('returns partial last page', async () => {
		const data = await fetchJson({ page: '3', perPage: '10' });
		expect(data.tasks).toHaveLength(5);
		expect(data.total).toBe(25);
		expect(data.page).toBe(3);
		expect(data.totalPages).toBe(3);
		expect(data.tasks[0].id).toBe('task-021');
	});

	it('clamps page to totalPages when page > total', async () => {
		const data = await fetchJson({ page: '999', perPage: '10' });
		// Should clamp to last page (3) — returns tasks 21-25
		expect(data.page).toBe(3);
		expect(data.tasks).toHaveLength(5);
		expect(data.tasks[0].id).toBe('task-021');
	});

	it('clamps perPage to max 100', async () => {
		const data = await fetchJson({ perPage: '500' });
		expect(data.perPage).toBe(100);
		expect(data.tasks).toHaveLength(25); // only 25 tasks exist
	});

	it('treats perPage=0 as no pagination', async () => {
		const data = await fetchJson({ perPage: '0' });
		expect(data.tasks).toHaveLength(25);
		expect(data.page).toBe(1);
		expect(data.totalPages).toBe(1);
	});

	it('treats negative page as page 1', async () => {
		const data = await fetchJson({ page: '-5', perPage: '10' });
		expect(data.page).toBe(1);
		expect(data.tasks[0].id).toBe('task-001');
	});

	it('treats non-numeric page/perPage as defaults', async () => {
		const data = await fetchJson({ page: 'abc', perPage: 'xyz' });
		expect(data.tasks).toHaveLength(25);
		expect(data.page).toBe(1);
	});

	it('returns correct metadata for perPage=1', async () => {
		const data = await fetchJson({ page: '1', perPage: '1' });
		expect(data.tasks).toHaveLength(1);
		expect(data.total).toBe(25);
		expect(data.totalPages).toBe(25);
		expect(data.perPage).toBe(1);
	});

	it('ensures no data overlap between consecutive pages', async () => {
		const page1 = await fetchJson({ page: '1', perPage: '10' });
		const page2 = await fetchJson({ page: '2', perPage: '10' });
		const page3 = await fetchJson({ page: '3', perPage: '10' });

		const allIds = [
			...page1.tasks.map((t: { id: string }) => t.id),
			...page2.tasks.map((t: { id: string }) => t.id),
			...page3.tasks.map((t: { id: string }) => t.id)
		];
		const uniqueIds = new Set(allIds);
		expect(uniqueIds.size).toBe(25);
		expect(allIds).toHaveLength(25);
	});

	it('returns empty tasks for page 1 when perPage > 0 but no tasks match filter', async () => {
		const data = await fetchJson({ status: 'nonexistent', perPage: '10' });
		expect(data.tasks).toHaveLength(0);
		expect(data.total).toBe(0);
		expect(data.totalPages).toBe(1);
		expect(data.page).toBe(1);
	});
});

describe('GET /api/tasks — filtering', () => {
	it('filters by status', async () => {
		const data = await fetchJson({ status: 'completed' });
		expect(data.tasks.length).toBeGreaterThan(0);
		expect(data.tasks.every((t: { status: string }) => t.status === 'completed')).toBe(true);
		expect(data.total).toBe(data.tasks.length);
	});

	it('filters by priority', async () => {
		const data = await fetchJson({ priority: 'high' });
		expect(data.tasks.length).toBeGreaterThan(0);
		expect(data.tasks.every((t: { priority: string }) => t.priority === 'high')).toBe(true);
	});

	it('filters by tag', async () => {
		const data = await fetchJson({ tag: 'api' });
		expect(data.tasks.length).toBeGreaterThan(0);
		expect(data.tasks.every((t: { tags: string[] }) => t.tags.includes('api'))).toBe(true);
	});

	it('filters by search term (title)', async () => {
		const data = await fetchJson({ search: 'Task 1' });
		expect(data.tasks.length).toBeGreaterThan(0);
		expect(data.tasks.every((t: { title: string }) => t.title.toLowerCase().includes('task 1'))).toBe(true);
	});

	it('pagination works correctly with filters', async () => {
		// Get all pending tasks
		const allPending = await fetchJson({ status: 'pending' });
		const pendingCount = allPending.total;

		// Paginate through pending tasks
		const page1 = await fetchJson({ status: 'pending', perPage: '5', page: '1' });
		expect(page1.total).toBe(pendingCount);
		expect(page1.tasks).toHaveLength(5);
		expect(page1.totalPages).toBe(Math.ceil(pendingCount / 5));

		// Second page should have different tasks
		const page2 = await fetchJson({ status: 'pending', perPage: '5', page: '2' });
		const ids1 = page1.tasks.map((t: { id: string }) => t.id);
		const ids2 = page2.tasks.map((t: { id: string }) => t.id);
		expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
	});
});
