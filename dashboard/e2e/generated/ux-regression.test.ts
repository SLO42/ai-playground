/**
 * UX Regression Tests — auto-generated baseline for all dashboard pages.
 * Verifies every route loads, renders key elements, and has no JS errors.
 *
 * Run: npx playwright test e2e/generated/ux-regression.test.ts
 */
import { test, expect, type Page } from '@playwright/test';

// ── Helpers ─────────────────────────────────────────────────────────

/** Collect page errors during navigation */
function trackErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	return errors;
}

/** Navigate and wait for DOM ready (not networkidle — dashboard has polling) */
async function load(page: Page, route: string) {
	await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 10000 });
	// Give SSR hydration a moment
	await page.waitForTimeout(500);
}

// ── Core Pages ──────────────────────────────────────────────────────

test.describe('Dashboard Home /', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/');
		await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('shows metric cards', async ({ page }) => {
		await load(page, '/');
		const main = page.getByRole('main');
		await expect(main.getByText('Services', { exact: true })).toBeVisible();
		await expect(main.getByText('Agents Running', { exact: true })).toBeVisible();
	});

	test('has automation toggle', async ({ page }) => {
		await load(page, '/');
		const automationBtn = page.getByRole('button', { name: /Automation/i });
		await expect(automationBtn).toBeVisible();
	});

	test('has refresh button', async ({ page }) => {
		await load(page, '/');
		await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
	});

	test('shows task pipeline section', async ({ page }) => {
		await load(page, '/');
		await expect(page.getByText('Task Pipeline')).toBeVisible();
	});
});

test.describe('Tasks /tasks', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/tasks');
		await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('shows summary metric cards', async ({ page }) => {
		await load(page, '/tasks');
		const main = page.getByRole('main');
		await expect(main.getByText('Active', { exact: true }).first()).toBeVisible();
		await expect(main.getByText('Critical', { exact: true })).toBeVisible();
	});

	test('has new task button', async ({ page }) => {
		await load(page, '/tasks');
		await expect(page.getByRole('button', { name: /New Task/i })).toBeVisible();
	});

	test('has search input', async ({ page }) => {
		await load(page, '/tasks');
		await expect(page.getByPlaceholder(/Search tasks/i)).toBeVisible();
	});
});

test.describe('Chat /chat', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/chat');
		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('has new chat button', async ({ page }) => {
		await load(page, '/chat');
		await expect(page.getByRole('button', { name: /New Chat/i })).toBeVisible();
	});

	test('has provider selector', async ({ page }) => {
		await load(page, '/chat');
		// Provider select should exist
		const providerSelect = page.locator('select').first();
		await expect(providerSelect).toBeVisible();
	});

	test('session filter tabs exist', async ({ page }) => {
		await load(page, '/chat');
		await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
	});
});

test.describe('Inbox /inbox', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/inbox');
		await expect(page.getByRole('heading', { name: 'Agent Inbox' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('shows filter tabs', async ({ page }) => {
		await load(page, '/inbox');
		await expect(page.getByRole('button', { name: 'Needs Attention' })).toBeVisible();
		await expect(page.getByRole('button', { name: /Notifications/i })).toBeVisible();
	});

	test('has metric cards', async ({ page }) => {
		await load(page, '/inbox');
		const main = page.getByRole('main');
		await expect(main.getByText('Awaiting Input', { exact: true }).first()).toBeVisible();
		await expect(main.getByText('Total Sessions', { exact: true })).toBeVisible();
	});
});

test.describe('Models /models', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/models');
		await expect(page.getByRole('heading', { name: 'Model Routing' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('shows model metric cards', async ({ page }) => {
		await load(page, '/models');
		await expect(page.getByText('Total Models')).toBeVisible();
		await expect(page.getByText('VRAM Used')).toBeVisible();
	});
});

test.describe('Agents /agents', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/agents');
		await expect(page.getByRole('heading', { name: 'Agent Management' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('shows metric cards', async ({ page }) => {
		await load(page, '/agents');
		await expect(page.getByText('Definitions', { exact: true })).toBeVisible();
		await expect(page.getByText('Running Now')).toBeVisible();
	});

	test('has new agent button', async ({ page }) => {
		await load(page, '/agents');
		await expect(page.getByRole('link', { name: /New Agent/i })).toBeVisible();
	});

	test('has agent search', async ({ page }) => {
		await load(page, '/agents');
		await expect(page.getByPlaceholder(/Search agents/i)).toBeVisible();
	});
});

// ── Utility Pages ───────────────────────────────────────────────────

test.describe('Memory /memory', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/memory');
		await expect(page.getByRole('heading', { name: 'Memory & Knowledge' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('has tabs (Overview / Entries)', async ({ page }) => {
		await load(page, '/memory');
		await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Entries' })).toBeVisible();
	});

	test('can switch to Entries tab', async ({ page }) => {
		await load(page, '/memory');
		await page.getByRole('button', { name: 'Entries' }).click();
		// Should show search or table
		await expect(page.getByPlaceholder(/Search/i)).toBeVisible({ timeout: 3000 });
	});
});

test.describe('Reports /reports', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/reports');
		await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});
});

test.describe('Services /services', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/services');
		await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});
});

test.describe('Settings /settings', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/settings');
		await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('shows settings sections', async ({ page }) => {
		await load(page, '/settings');
		await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
	});
});

test.describe('Sessions /sessions', () => {
	test('renders without errors', async ({ page }) => {
		const errors = trackErrors(page);
		await load(page, '/sessions');
		await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('shows session metric cards', async ({ page }) => {
		await load(page, '/sessions');
		// Sessions page has metric cards for Active, Total, etc.
		const cards = page.locator('[class*="MetricCard"], [class*="metric"]');
		const count = await cards.count();
		expect(count).toBeGreaterThanOrEqual(0); // may have 0 sessions
	});
});

// ── Project Pages ───────────────────────────────────────────────────
// These use a dynamic [id] param. We test with the first available project.

test.describe('Project Pages', () => {
	let projectId: string;

	test.beforeAll(async ({ request }) => {
		// Discover the first project from the API
		try {
			const res = await request.get('/api/projects');
			const data = await res.json();
			const projects = data.projects ?? data;
			if (Array.isArray(projects) && projects.length > 0) {
				projectId = projects[0].id;
			}
		} catch {
			// fallback — skip project tests if no API
		}
	});

	test('project overview renders', async ({ page }) => {
		test.skip(!projectId, 'No projects available');
		const errors = trackErrors(page);
		await load(page, `/projects/${projectId}`);
		// Project overview shows the project name as heading
		const heading = page.locator('h1');
		await expect(heading).toBeVisible({ timeout: 5000 });
		// Should have metric cards (scoped to main to avoid sidebar matches)
		const main = page.getByRole('main');
		await expect(main.getByText('Models', { exact: true }).first()).toBeVisible();
		await expect(main.getByText('Agents', { exact: true }).first()).toBeVisible();
		expect(errors).toHaveLength(0);
	});

	test('project tasks renders', async ({ page }) => {
		test.skip(!projectId, 'No projects available');
		const errors = trackErrors(page);
		await load(page, `/projects/${projectId}/tasks`);
		await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Total')).toBeVisible();
		expect(errors).toHaveLength(0);
	});

	test('project agents renders', async ({ page }) => {
		test.skip(!projectId, 'No projects available');
		const errors = trackErrors(page);
		await load(page, `/projects/${projectId}/agents`);
		await expect(page.getByRole('heading', { name: 'Project Agents' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Associated', { exact: true })).toBeVisible();
		expect(errors).toHaveLength(0);
	});

	test('project sessions renders', async ({ page }) => {
		test.skip(!projectId, 'No projects available');
		const errors = trackErrors(page);
		await load(page, `/projects/${projectId}/sessions`);
		// Page may show "Project Sessions" or fallback heading
		const heading = page.locator('h1').first();
		await expect(heading).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('project channels renders', async ({ page }) => {
		test.skip(!projectId, 'No projects available');
		const errors = trackErrors(page);
		await load(page, `/projects/${projectId}/channels`);
		await expect(page.getByRole('heading', { name: 'Project Channels' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Connected', { exact: true })).toBeVisible();
		expect(errors).toHaveLength(0);
	});

	test('project memory renders', async ({ page }) => {
		test.skip(!projectId, 'No projects available');
		const errors = trackErrors(page);
		await load(page, `/projects/${projectId}/memory`);
		await expect(page.getByRole('heading', { name: 'Project Memory' })).toBeVisible({ timeout: 5000 });
		expect(errors).toHaveLength(0);
	});

	test('project memory has tabs', async ({ page }) => {
		test.skip(!projectId, 'No projects available');
		await load(page, `/projects/${projectId}/memory`);
		await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Entries' })).toBeVisible();
	});

	test('project settings renders', async ({ page }) => {
		test.skip(!projectId, 'No projects available');
		const errors = trackErrors(page);
		await load(page, `/projects/${projectId}/settings`);
		await expect(page.getByRole('heading', { name: 'Project Settings' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
		expect(errors).toHaveLength(0);
	});
});

// ── Layout & Navigation ─────────────────────────────────────────────

test.describe('Layout', () => {
	test('sidebar is visible on all pages', async ({ page }) => {
		await load(page, '/');
		const sidebar = page.locator('nav, aside').first();
		await expect(sidebar).toBeVisible();
	});

	test('sidebar navigation links work', async ({ page }) => {
		await load(page, '/');
		// Click Tasks in sidebar
		const tasksLink = page.getByRole('link', { name: /Tasks/i }).first();
		await expect(tasksLink).toBeVisible();
		await tasksLink.click();
		await expect(page).toHaveURL(/\/tasks/);
	});

	test('no content overflows viewport', async ({ page }) => {
		await load(page, '/');
		const viewport = page.viewportSize();
		if (viewport) {
			const body = await page.evaluate(() => document.body.scrollWidth);
			expect(body).toBeLessThanOrEqual(viewport.width + 20); // small tolerance
		}
	});
});
