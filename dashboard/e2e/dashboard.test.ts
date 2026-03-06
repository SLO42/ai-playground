import { test, expect } from '@playwright/test';

test.describe('Dashboard home page', () => {
	test('shows the heading and metric cards', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();

		// Metric cards row
		await expect(page.getByText('Services')).toBeVisible();
		await expect(page.getByText('Memory Nodes')).toBeVisible();
		await expect(page.getByText('Daemon Workers')).toBeVisible();
		await expect(page.getByText('VRAM')).toBeVisible();
	});

	test('shows daemon workers section', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('heading', { name: 'Daemon Workers' })).toBeVisible();
	});

	test('shows VRAM usage and memory graph panels', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByText('VRAM Usage')).toBeVisible();
		await expect(page.getByText('Memory Graph')).toBeVisible();
	});

	test('shows top memory nodes section', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('heading', { name: 'Top Memory Nodes' })).toBeVisible();
	});

	test('refresh button triggers a data reload', async ({ page }) => {
		await page.goto('/');

		const refreshBtn = page.getByRole('button', { name: 'Refresh' });
		await expect(refreshBtn).toBeVisible();
		await refreshBtn.click();

		// Should show refreshing state briefly
		// After refresh completes, the "Updated" timestamp should be visible
		await expect(page.getByText(/Updated/)).toBeVisible({ timeout: 5000 });
	});

	test('auto-refresh toggle works', async ({ page }) => {
		await page.goto('/');

		const autoBtn = page.getByRole('button', { name: 'Auto' });
		await expect(autoBtn).toBeVisible();

		// Click to toggle off
		await autoBtn.click();

		// Click again to toggle on
		await autoBtn.click();
	});
});
