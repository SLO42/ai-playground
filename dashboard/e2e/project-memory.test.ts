import { test, expect } from '@playwright/test';

// Shared mock data factories
function makeMemoryResponse(overrides: Record<string, unknown> = {}) {
	return {
		entries: [
			{
				key: 'pattern-auth',
				summary: 'JWT authentication pattern',
				content: 'Use refresh tokens with short-lived access tokens',
				namespace: 'patterns',
				type: 'auto'
			},
			{
				key: 'decision-db',
				summary: 'PostgreSQL selected for persistence',
				content: 'Chose PostgreSQL over SQLite for concurrent writes',
				namespace: 'decisions',
				type: 'auto'
			}
		],
		context: {
			entries: [
				{
					id: 'ctx-auth',
					summary: 'Auth module context',
					category: 'architecture',
					confidence: 0.92,
					pageRank: 0.15,
					accessCount: 42
				},
				{
					id: 'ctx-db',
					summary: 'Database layer context',
					category: 'decision',
					confidence: 0.87,
					pageRank: 0.1,
					accessCount: 28
				}
			]
		},
		graph: {
			nodes: {
				'pattern-auth': { id: 'pattern-auth', weight: 3 },
				'decision-db': { id: 'decision-db', weight: 2 }
			},
			edges: [{ source: 'pattern-auth', target: 'decision-db', weight: 1 }],
			pageRanks: { 'pattern-auth': 0.6, 'decision-db': 0.4 }
		},
		...overrides
	};
}

const PROJECT_ID = 'test-project';
const MEMORY_URL = `/projects/${PROJECT_ID}/memory`;
const API_PATTERN = `**/api/projects/${PROJECT_ID}/memory`;

/** Intercept the server-side load AND client-side fetches for the memory page */
async function mockMemoryApi(
	page: import('@playwright/test').Page,
	response: ReturnType<typeof makeMemoryResponse>,
	statusCode = 200
) {
	await page.route(API_PATTERN, async (route) => {
		await route.fulfill({
			status: statusCode,
			contentType: 'application/json',
			body: JSON.stringify(response)
		});
	});
}

test.describe('Project Memory page — graph display', () => {
	test('renders graph section with nodes and edges when data is present', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse());
		await page.goto(MEMORY_URL);

		// Page heading
		await expect(page.getByRole('heading', { name: 'Project Memory' })).toBeVisible();

		// Graph section should exist
		const graphSection = page.locator('section', { has: page.locator('#memory-graph-heading') });
		await expect(graphSection).toBeVisible();
		await expect(page.locator('#memory-graph-heading')).toHaveText('Memory Graph');

		// The graph visualization container should report node/edge counts
		const graphViz = page.locator('[role="img"][aria-label*="nodes"]');
		// Either BubbleGraph rendered or the "Loading graph" fallback shows
		const vizOrLoading = graphViz.or(page.getByText('Loading graph...'));
		await expect(vizOrLoading.first()).toBeVisible();
	});

	test('shows metric cards with correct values', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse());
		await page.goto(MEMORY_URL);

		// Total nodes = entries (2) + context entries (2) = 4
		await expect(page.getByText('Total Nodes')).toBeVisible();
		await expect(page.getByText('4').first()).toBeVisible();

		// Namespaces: patterns, decisions = 2
		await expect(page.getByText('Namespaces')).toBeVisible();

		// Categories: architecture, decision = 2
		await expect(page.getByText('Categories')).toBeVisible();
	});

	test('shows namespace and category distribution charts', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse());
		await page.goto(MEMORY_URL);

		// Namespace distribution
		await expect(page.locator('#ns-chart-heading')).toHaveText('Namespace Distribution');
		await expect(page.getByText('patterns').first()).toBeVisible();
		await expect(page.getByText('decisions').first()).toBeVisible();

		// Category distribution
		await expect(page.locator('#cat-chart-heading')).toHaveText('Category Distribution');
		await expect(page.getByText('architecture').first()).toBeVisible();
	});
});

test.describe('Project Memory page — refresh / graph mutation', () => {
	test('refresh button fetches new data and updates the graph', async ({ page }) => {
		const initial = makeMemoryResponse();
		await mockMemoryApi(page, initial);
		await page.goto(MEMORY_URL);

		// Verify initial state — 2 entries visible
		await expect(page.getByText('JWT authentication pattern')).toBeVisible();
		await expect(page.getByText('PostgreSQL selected for persistence')).toBeVisible();

		// Prepare updated data with an extra node
		const updated = makeMemoryResponse({
			entries: [
				...initial.entries,
				{
					key: 'pattern-cache',
					summary: 'Redis caching strategy',
					content: 'Cache invalidation via pub/sub',
					namespace: 'patterns',
					type: 'auto'
				}
			],
			graph: {
				nodes: {
					'pattern-auth': { id: 'pattern-auth', weight: 3 },
					'decision-db': { id: 'decision-db', weight: 2 },
					'pattern-cache': { id: 'pattern-cache', weight: 1 }
				},
				edges: [
					{ source: 'pattern-auth', target: 'decision-db', weight: 1 },
					{ source: 'pattern-auth', target: 'pattern-cache', weight: 1 }
				],
				pageRanks: { 'pattern-auth': 0.5, 'decision-db': 0.3, 'pattern-cache': 0.2 }
			}
		});

		// Re-mock the API with updated data
		await page.unrouteAll({ behavior: 'wait' });
		await mockMemoryApi(page, updated);

		// Click refresh
		const refreshBtn = page.getByRole('button', { name: 'Refresh memory data' });
		await refreshBtn.click();

		// Wait for the new entry to appear
		await expect(page.getByText('Redis caching strategy')).toBeVisible();

		// The status badge should reflect the new count (5 nodes: 3 entries + 2 context)
		await expect(page.getByText('5 nodes')).toBeVisible();
	});

	test('refresh shows loading state during fetch', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse());
		await page.goto(MEMORY_URL);

		// Delay the response to observe loading state
		await page.unrouteAll({ behavior: 'wait' });
		await page.route(API_PATTERN, async (route) => {
			await new Promise((r) => setTimeout(r, 500));
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(makeMemoryResponse())
			});
		});

		const refreshBtn = page.getByRole('button', { name: 'Refresh memory data' });
		await refreshBtn.click();

		// Loading indicator should appear
		await expect(page.getByText('Loading memory data...')).toBeVisible();

		// After response, loading should disappear
		await expect(page.getByText('Loading memory data...')).not.toBeVisible({ timeout: 5000 });
	});
});

test.describe('Project Memory page — network failure', () => {
	test('shows error banner when refresh fails', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse());
		await page.goto(MEMORY_URL);

		// Initial data should be present
		await expect(page.getByText('JWT authentication pattern')).toBeVisible();

		// Mock a network failure on refresh
		await page.unrouteAll({ behavior: 'wait' });
		await mockMemoryApi(page, { error: 'Internal server error' } as any, 500);

		const refreshBtn = page.getByRole('button', { name: 'Refresh memory data' });
		await refreshBtn.click();

		// Error banner should appear
		const errorBanner = page.locator('[role="alert"]');
		await expect(errorBanner).toBeVisible();
		await expect(errorBanner).toContainText('Failed to load memory');

		// Dismiss the error
		await page.getByRole('button', { name: 'Dismiss error' }).click();
		await expect(errorBanner).not.toBeVisible();
	});

	test('shows error state when initial page load returns an error', async ({ page }) => {
		// The server-side load may pass the error via data.loadError.
		// We mock the client API; the SSR load will likely fail too, showing the error state.
		await page.route(API_PATTERN, async (route) => {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'Database connection failed' })
			});
		});

		await page.goto(MEMORY_URL);

		// Either the error banner or the "Failed to load memory" state should show
		const errorIndicator = page
			.getByText('Failed to load memory')
			.or(page.locator('[role="alert"]'))
			.or(page.getByText('Error'));
		await expect(errorIndicator.first()).toBeVisible();
	});

	test('retry button after load error triggers a new fetch', async ({ page }) => {
		// First load fails
		let callCount = 0;
		await page.route(API_PATTERN, async (route) => {
			callCount++;
			if (callCount <= 1) {
				await route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'Temporary failure' })
				});
			} else {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(makeMemoryResponse())
				});
			}
		});

		await page.goto(MEMORY_URL);

		// Look for Try Again or Refresh button
		const retryBtn = page
			.getByRole('button', { name: 'Try Again' })
			.or(page.getByRole('button', { name: 'Refresh memory data' }));

		await retryBtn.first().click();

		// After retry with success, data should appear
		await expect(page.getByText('JWT authentication pattern')).toBeVisible({ timeout: 5000 });
	});
});

test.describe('Project Memory page — empty data', () => {
	test('shows empty state when no memory entries exist', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse({
			entries: [],
			context: { entries: [] },
			graph: { nodes: {}, edges: [], pageRanks: {} }
		}));

		await page.goto(MEMORY_URL);

		await expect(page.getByRole('heading', { name: 'Project Memory' })).toBeVisible();

		// Empty state message
		await expect(page.getByText('No memory data yet')).toBeVisible();
		await expect(
			page.getByText('Memory entries will appear here as the project stores patterns')
		).toBeVisible();

		// The "Empty" status badge
		await expect(page.getByText('Empty')).toBeVisible();
	});

	test('shows "no graph data" when graph is empty but entries exist', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse({
			graph: { nodes: {}, edges: [], pageRanks: {} }
		}));

		await page.goto(MEMORY_URL);

		// Entries should still render
		await expect(page.getByText('JWT authentication pattern')).toBeVisible();

		// Graph section should show the empty message
		await expect(
			page.getByText('No graph data')
		).toBeVisible();
	});
});

test.describe('Project Memory page — search and interaction', () => {
	test('search filters memory entries', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse());
		await page.goto(MEMORY_URL);

		// Both entries visible initially
		await expect(page.getByText('JWT authentication pattern')).toBeVisible();
		await expect(page.getByText('PostgreSQL selected for persistence')).toBeVisible();

		// Search for "auth"
		const searchInput = page.getByLabel('Search memory entries');
		await searchInput.fill('auth');

		// Only auth entry should remain
		await expect(page.getByText('JWT authentication pattern')).toBeVisible();
		await expect(page.getByText('PostgreSQL selected for persistence')).not.toBeVisible();

		// Filter count should show "1 of 2"
		await expect(page.getByText('1 of 2')).toBeVisible();
	});

	test('clicking a memory entry expands its content', async ({ page }) => {
		await mockMemoryApi(page, makeMemoryResponse());
		await page.goto(MEMORY_URL);

		// Content should not be visible initially
		await expect(page.getByText('Use refresh tokens with short-lived access tokens')).not.toBeVisible();

		// Click the entry to expand
		const entryButton = page.getByRole('listitem').filter({ hasText: 'JWT authentication pattern' }).locator('button');
		await entryButton.click();

		// Content should now be visible
		await expect(page.getByText('Use refresh tokens with short-lived access tokens')).toBeVisible();

		// Click again to collapse
		await entryButton.click();
		await expect(page.getByText('Use refresh tokens with short-lived access tokens')).not.toBeVisible();
	});
});
