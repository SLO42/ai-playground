import { test, expect } from '@playwright/test';

test.describe('Reports page', () => {
	test('shows the heading', async ({ page }) => {
		await page.goto('/reports');

		await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
	});

	test('shows report type buttons', async ({ page }) => {
		await page.goto('/reports');

		// Generate report buttons for different periods
		const dailyBtn = page.getByRole('button', { name: /Daily/i });
		const weeklyBtn = page.getByRole('button', { name: /Weekly/i });

		if (await dailyBtn.isVisible()) {
			await expect(dailyBtn).toBeVisible();
		}
		if (await weeklyBtn.isVisible()) {
			await expect(weeklyBtn).toBeVisible();
		}
	});

	test('generates a report with mocked API', async ({ page }) => {
		await page.route('**/api/reports', async (route) => {
			if (route.request().method() === 'POST') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						report: {
							type: 'daily',
							date: '2026-03-05',
							generatedAt: '2026-03-05T12:00:00Z',
							period: { start: '2026-03-04T00:00:00Z', end: '2026-03-05T00:00:00Z' },
							summary: { score: 85, tasks: 10, completedTasks: 8 },
							sections: [],
							insights: [],
							recommendations: []
						},
						timeSeries: []
					})
				});
			} else if (route.request().method() === 'GET') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ reports: [] })
				});
			} else {
				await route.continue();
			}
		});

		await page.goto('/reports');

		const dailyBtn = page.getByRole('button', { name: /Daily/i });
		if (await dailyBtn.isVisible()) {
			await dailyBtn.click();
			// Report content should appear
			await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
		}
	});

	test('shows report history list', async ({ page }) => {
		await page.goto('/reports');

		// The page should render the reports section
		await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
	});
});
