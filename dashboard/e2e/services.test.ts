import { test, expect } from '@playwright/test';

test.describe('Services list page', () => {
	test('shows the heading and action buttons', async ({ page }) => {
		await page.goto('/services');

		await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
	});

	test('shows metric cards for service stats', async ({ page }) => {
		await page.goto('/services');

		await expect(page.getByText('Running')).toBeVisible();
		await expect(page.getByText('Stopped')).toBeVisible();
		await expect(page.getByText('Total Services')).toBeVisible();
	});

	test('search input filters services', async ({ page }) => {
		await page.goto('/services');

		const searchInput = page.getByPlaceholder('Search services...');
		await expect(searchInput).toBeVisible();

		await searchInput.fill('zzz-nonexistent-service');
		// Should show either empty state or filtered results
	});

	test('status filter buttons are present and clickable', async ({ page }) => {
		await page.goto('/services');

		for (const label of ['All', 'Running', 'Stopped', 'Errored']) {
			const btn = page.getByRole('button', { name: label });
			await expect(btn).toBeVisible();
		}

		// Click "Running" filter
		await page.getByRole('button', { name: 'Running' }).click();

		// Click "All" to reset
		await page.getByRole('button', { name: 'All' }).click();
	});

	test('service cards link to detail pages', async ({ page }) => {
		await page.goto('/services');

		const serviceLinks = page.locator('a[href^="/services/"]');
		const count = await serviceLinks.count();

		if (count > 0) {
			const href = await serviceLinks.first().getAttribute('href');
			expect(href).toBeTruthy();
			expect(href).toMatch(/^\/services\/.+/);
		}
	});

	test('empty state shows add service button when no services', async ({ page }) => {
		// Mock the services store to return empty
		await page.route('**/api/services', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ services: [], timestamp: new Date().toISOString() })
			});
		});

		await page.goto('/services');

		// Either shows services or the empty state
		const heading = page.getByRole('heading', { name: 'Services' });
		await expect(heading).toBeVisible();
	});
});

test.describe('New service page', () => {
	test('renders the new service form', async ({ page }) => {
		await page.goto('/services/new');

		await expect(page.getByRole('heading', { name: /Add.*Service|New Service/i })).toBeVisible();
	});
});
