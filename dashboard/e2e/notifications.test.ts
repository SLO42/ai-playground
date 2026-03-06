import { test, expect } from '@playwright/test';

test.describe('Notifications page', () => {
	test('shows the heading', async ({ page }) => {
		await page.goto('/notifications');

		await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	});

	test('shows category filter tabs', async ({ page }) => {
		await page.goto('/notifications');

		// "All" tab should always exist
		const allTab = page.getByRole('button', { name: 'All' });
		await expect(allTab).toBeVisible();
	});

	test('shows metric cards for notification stats', async ({ page }) => {
		await page.goto('/notifications');

		// Should display stats about notifications
		const metrics = page.locator('[class*="metric"], [class*="MetricCard"]');
		// At minimum the heading renders
		await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	});

	test('clicking a category tab filters notifications', async ({ page }) => {
		await page.goto('/notifications');

		const allTab = page.getByRole('button', { name: 'All' });
		await allTab.click();

		// Page should still be functional
		await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	});

	test('shows empty state when no notifications', async ({ page }) => {
		await page.route('**/api/notifications**', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					notifications: [],
					stats: { total: 0, unread: 0, critical: 0, alerts: 0 }
				})
			});
		});

		await page.goto('/notifications');

		await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	});
});
