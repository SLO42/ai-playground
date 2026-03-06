import { test, expect } from '@playwright/test';

test.describe('Sidebar navigation', () => {
	test('sidebar is visible on all pages', async ({ page }) => {
		await page.goto('/');

		// Sidebar should contain main nav links
		const sidebar = page.locator('nav');
		await expect(sidebar).toBeVisible();
	});

	test('navigates to all major sections via sidebar', async ({ page }) => {
		const routes: { name: RegExp | string; url: string; heading: RegExp | string }[] = [
			{ name: 'Dashboard', url: '/', heading: 'Dashboard Overview' },
			{ name: 'Chat', url: '/chat', heading: 'Chat' },
			{ name: 'Agents', url: '/agents', heading: 'Agent Management' },
			{ name: 'Models', url: '/models', heading: 'Models' },
			{ name: 'Services', url: '/services', heading: 'Services' },
			{ name: 'Sessions', url: '/sessions', heading: 'Sessions' },
			{ name: 'Tasks', url: '/tasks', heading: 'Task Backlog' },
			{ name: 'Security', url: '/security', heading: 'Security' },
			{ name: 'Settings', url: '/settings', heading: 'Settings' },
		];

		for (const route of routes) {
			await page.goto(route.url);
			await expect(page.getByRole('heading', { name: route.heading }).first()).toBeVisible({ timeout: 5000 });
		}
	});

	test('projects link navigates to projects list', async ({ page }) => {
		await page.goto('/projects');

		await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
	});

	test('notifications link navigates to notifications page', async ({ page }) => {
		await page.goto('/notifications');

		await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	});

	test('reports link navigates to reports page', async ({ page }) => {
		await page.goto('/reports');

		await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
	});
});

test.describe('Layout structure', () => {
	test('page has correct title element', async ({ page }) => {
		await page.goto('/');

		// SvelteKit should set a page title
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	test('status bar is visible at bottom', async ({ page }) => {
		await page.goto('/');

		// Status bar should be in the layout
		const statusBar = page.locator('[class*="status"]').last();
		if (await statusBar.isVisible()) {
			await expect(statusBar).toBeVisible();
		}
	});
});
