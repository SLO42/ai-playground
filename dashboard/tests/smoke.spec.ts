import { test, expect, type ConsoleMessage } from '@playwright/test';

let consoleErrors: ConsoleMessage[] = [];

test.beforeEach(async ({ page }) => {
	consoleErrors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') {
			consoleErrors.push(msg);
		}
	});
});

test.afterEach(async () => {
	expect(
		consoleErrors.map((e) => e.text()),
		'Expected zero console errors'
	).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Helper: visit a route and assert basic health
// ---------------------------------------------------------------------------
async function smokeCheck(page: import('@playwright/test').Page, route: string) {
	const response = await page.goto(route, { waitUntil: 'load' });
	expect(response?.status(), `${route} should return 200`).toBe(200);

	// Page should have a visible <main> or <body> content area
	const main = page.locator('main');
	const body = page.locator('body');
	const hasMain = (await main.count()) > 0;
	if (hasMain) {
		await expect(main.first()).toBeVisible();
	} else {
		await expect(body).toBeVisible();
	}

	// No SvelteKit error overlay
	await expect(page.locator('.error-overlay, [data-sveltekit-error]')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Top-level routes (22)
// ---------------------------------------------------------------------------
test.describe('Top-level routes', () => {
	const routes = [
		['/', 'dashboard home'],
		['/about', 'about'],
		['/agents', 'agents list'],
		['/agents/create', 'agents create'],
		['/apps', 'apps'],
		['/channels', 'channels'],
		['/chat', 'chat'],
		['/hooks', 'hooks'],
		['/inbox', 'inbox'],
		['/memory', 'memory'],
		['/models', 'models'],
		['/notifications', 'notifications'],
		['/projects', 'projects list'],
		['/projects/create', 'projects create'],
		['/projects/import', 'projects import'],
		['/reports', 'reports'],
		['/security', 'security'],
		['/services', 'services'],
		['/services/new', 'services new'],
		['/sessions', 'sessions'],
		['/settings', 'settings'],
		['/tasks', 'tasks'],
		['/diagnostics', 'diagnostics'],
		['/projects/create-ai', 'create with AI'],
		['/templates', 'templates']
	] as const;

	for (const [route, label] of routes) {
		test(`${route} — ${label}`, async ({ page }) => {
			await smokeCheck(page, route);
		});
	}
});

// ---------------------------------------------------------------------------
// Project sub-pages (16) — using ai-playground as test project
// ---------------------------------------------------------------------------
test.describe('Project sub-pages (/projects/ai-playground)', () => {
	const slug = 'ai-playground';
	const subPages = [
		['', 'project overview'],
		['/about', 'about'],
		['/agents', 'agents'],
		['/channels', 'channels'],
		['/chat', 'chat'],
		['/hooks', 'hooks'],
		['/memory', 'memory'],
		['/models', 'models'],
		['/pipelines', 'pipelines'],
		['/pm', 'pm'],
		['/releases', 'releases'],
		['/security', 'security'],
		['/services', 'services'],
		['/sessions', 'sessions'],
		['/settings', 'settings'],
		['/tasks', 'tasks']
	] as const;

	for (const [sub, label] of subPages) {
		test(`/projects/${slug}${sub} — ${label}`, async ({ page }) => {
			await smokeCheck(page, `/projects/${slug}${sub}`);
		});
	}
});

// ---------------------------------------------------------------------------
// Service detail pages (4)
// ---------------------------------------------------------------------------
test.describe('Service detail pages', () => {
	const routes = [
		['/services/ollama', 'ollama overview'],
		['/services/ollama/config', 'ollama config'],
		['/services/ollama/logs', 'ollama logs'],
		['/services/openclaw', 'openclaw overview']
	] as const;

	for (const [route, label] of routes) {
		test(`${route} — ${label}`, async ({ page }) => {
			await smokeCheck(page, route);
		});
	}
});

// ---------------------------------------------------------------------------
// Feature interaction tests
// ---------------------------------------------------------------------------
test.describe('Feature interactions', () => {
	test('404 shows styled error page', async ({ page }) => {
		// 404 page triggers a console error from the failed resource — exclude it
		consoleErrors = [];
		page.removeAllListeners('console');
		const response = await page.goto('/this-route-does-not-exist', { waitUntil: 'load' });
		expect(response?.status()).toBe(404);
		await expect(page.locator('text=Page not found')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Go Home' })).toBeVisible();
	});

	test('/diagnostics shows health checks', async ({ page }) => {
		await page.goto('/diagnostics', { waitUntil: 'load' });
		await expect(page.locator('text=Node.js')).toBeVisible();
		await expect(page.getByText('Git', { exact: true })).toBeVisible();
	});

	test('/projects/create-ai has prompt input and template grid', async ({ page }) => {
		await page.goto('/projects/create-ai', { waitUntil: 'load' });
		await expect(page.locator('textarea')).toBeVisible();
		await expect(page.locator('text=Blank')).toBeVisible();
	});
});
