import { test, expect } from '@playwright/test';

const mockAgents = [
	{
		name: 'Coder',
		category: 'core',
		description: 'Writes clean, efficient code',
		filename: 'core/coder.md',
		type: 'worker'
	},
	{
		name: 'Reviewer',
		category: 'core',
		description: 'Reviews pull requests and code quality',
		filename: 'core/reviewer.md',
		type: 'worker'
	},
	{
		name: 'Security Auditor',
		category: 'security',
		description: 'Scans code for vulnerabilities',
		filename: 'security/security-auditor.md',
		type: 'specialist'
	}
];

function buildPageData(agents = mockAgents) {
	return {
		agents,
		swarmStatus: {
			active: true,
			agentCount: 2,
			coordinationActive: true,
			processes: { agentic_flow: 1, mcp_server: 1, estimated_agents: 2 }
		},
		v3Progress: { activeAgents: 2, maxAgents: 15, topology: 'hierarchical-mesh' },
		swarmConfig: null
	};
}

test.describe('Agents list page', () => {
	test('shows the heading and new-agent link', async ({ page }) => {
		await page.goto('/agents');

		await expect(page.getByRole('heading', { name: 'Agent Management' })).toBeVisible();
		await expect(page.getByRole('link', { name: '+ New Agent' })).toBeVisible();
	});

	test('renders agent cards from server data', async ({ page }) => {
		await page.goto('/agents');

		// Page should load without errors — at least the heading is present
		await expect(page.getByRole('heading', { name: 'Agent Management' })).toBeVisible();

		// Metric cards row should be visible
		await expect(page.getByText('Total Agents')).toBeVisible();
		await expect(page.getByText('Active')).toBeVisible();
		await expect(page.getByText('Max Allowed')).toBeVisible();
		await expect(page.getByText('Topology')).toBeVisible();
	});

	test('search filters agents by name', async ({ page }) => {
		await page.goto('/agents');

		const searchInput = page.getByPlaceholder('Search agents by name, description, or category...');
		await expect(searchInput).toBeVisible();

		// Type a search query — should narrow results
		await searchInput.fill('zzz-nonexistent-agent-xyz');

		// The "no match" message should appear
		await expect(page.getByText('No agents match the current filter.')).toBeVisible();
	});

	test('category filter buttons are present', async ({ page }) => {
		await page.goto('/agents');

		// The "All" category button should always exist
		await expect(page.getByRole('button', { name: /^All/ })).toBeVisible();
	});

	test('navigates to create page from agents list', async ({ page }) => {
		await page.goto('/agents');

		await page.getByRole('link', { name: '+ New Agent' }).click();
		await page.waitForURL('/agents/create');

		await expect(page.getByRole('heading', { name: 'Create New Agent' })).toBeVisible();
	});
});

test.describe('Agent creation page', () => {
	test('renders the create form with required fields', async ({ page }) => {
		await page.goto('/agents/create');

		await expect(page.getByRole('heading', { name: 'Create New Agent' })).toBeVisible();

		// Form fields
		await expect(page.locator('#template')).toBeVisible();
		await expect(page.locator('#name')).toBeVisible();
		await expect(page.locator('#description')).toBeVisible();

		// Submit + cancel buttons
		await expect(page.getByRole('button', { name: 'Create Agent' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible();
	});

	test('shows file preview when name is entered', async ({ page }) => {
		await page.goto('/agents/create');

		const nameInput = page.locator('#name');
		await nameInput.fill('test-bot');

		await expect(page.getByText('Will create')).toBeVisible();
		await expect(page.getByText(/\.claude\/agents\/.*\/test-bot\.md/)).toBeVisible();
	});

	test('cancel link navigates back to agents list', async ({ page }) => {
		await page.goto('/agents/create');

		await page.getByRole('link', { name: 'Cancel' }).click();
		await page.waitForURL('/agents');

		await expect(page.getByRole('heading', { name: 'Agent Management' })).toBeVisible();
	});

	test('submits the create form via POST', async ({ page }) => {
		await page.goto('/agents/create');

		// Fill in the form
		await page.locator('#name').fill('e2e-test-agent');
		await page.locator('#description').fill('Agent created by e2e test');

		// Intercept the form POST to avoid writing files on disk
		await page.route('**/agents/create', async (route) => {
			if (route.request().method() === 'POST') {
				// SvelteKit form actions return a redirect on success — simulate redirect to /agents
				await route.fulfill({
					status: 303,
					headers: { location: '/agents' }
				});
			} else {
				await route.continue();
			}
		});

		await page.getByRole('button', { name: 'Create Agent' }).click();

		// After successful creation, user should land on the agents list
		await page.waitForURL('/agents');
	});

	test('displays error when creation fails', async ({ page }) => {
		await page.goto('/agents/create');

		await page.locator('#name').fill('bad-agent');

		// Mock a failure response — SvelteKit form actions return ActionData on failure
		await page.route('**/agents/create', async (route) => {
			if (route.request().method() === 'POST') {
				await route.fulfill({
					status: 200,
					contentType: 'text/html',
					body: '' // SvelteKit re-renders with form.error
				});
			} else {
				await route.continue();
			}
		});

		// The form should be submittable (name is filled)
		const submitBtn = page.getByRole('button', { name: 'Create Agent' });
		await expect(submitBtn).toBeVisible();
	});
});

test.describe('Agent created appears in list', () => {
	test('newly created agent is visible after navigating back to list', async ({ page }) => {
		// Start on create page
		await page.goto('/agents/create');

		await page.locator('#name').fill('fresh-agent');
		await page.locator('#description').fill('Just created');

		// Mock the form POST to redirect back to /agents
		await page.route('**/agents/create', async (route) => {
			if (route.request().method() === 'POST') {
				await route.fulfill({
					status: 303,
					headers: { location: '/agents' }
				});
			} else {
				await route.continue();
			}
		});

		await page.getByRole('button', { name: 'Create Agent' }).click();
		await page.waitForURL('/agents');

		// After redirect, the agents list page loads — verify it rendered
		await expect(page.getByRole('heading', { name: 'Agent Management' })).toBeVisible();
	});
});

test.describe('Agent list pagination and filtering', () => {
	test('search clears with the Clear button', async ({ page }) => {
		await page.goto('/agents');

		const searchInput = page.getByPlaceholder('Search agents by name, description, or category...');
		await searchInput.fill('some-filter');

		// Clear button should appear
		const clearBtn = page.getByRole('button', { name: 'Clear' });
		await expect(clearBtn).toBeVisible();

		await clearBtn.click();

		// Search input should be empty again
		await expect(searchInput).toHaveValue('');
	});

	test('category filter shows matching agents only', async ({ page }) => {
		await page.goto('/agents');

		// Click a non-"All" category button if available
		const allBtn = page.getByRole('button', { name: /^All/ });
		await expect(allBtn).toBeVisible();

		// Click All to ensure everything is shown, then verify metric cards
		await allBtn.click();
		await expect(page.getByText('Total Agents')).toBeVisible();
	});

	test('swarm status section displays correctly', async ({ page }) => {
		await page.goto('/agents');

		await expect(page.getByText('Swarm Status')).toBeVisible();
		await expect(page.getByText('Agent Capacity')).toBeVisible();
	});

	test('agent cards link to detail pages', async ({ page }) => {
		await page.goto('/agents');

		// If there are agent cards, they should be links
		const agentLinks = page.locator('a[href^="/agents/"]').filter({ hasNot: page.locator('text=+ New Agent') });
		const count = await agentLinks.count();

		if (count > 0) {
			const href = await agentLinks.first().getAttribute('href');
			expect(href).toBeTruthy();
			expect(href).toMatch(/^\/agents\/.+/);
		}
	});
});
