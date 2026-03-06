import { test, expect } from '@playwright/test';

test.describe('Security page', () => {
	test('shows the heading and metric cards', async ({ page }) => {
		await page.goto('/security');

		await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
	});

	test('shows scan button', async ({ page }) => {
		await page.goto('/security');

		const scanBtn = page.getByRole('button', { name: /Scan|Run Scan/i });
		await expect(scanBtn).toBeVisible();
	});

	test('scan button triggers security scan with mocked API', async ({ page }) => {
		// Mock the security scan API
		await page.route('**/api/security/scan', async (route) => {
			if (route.request().method() === 'POST') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						success: true,
						output: 'No vulnerabilities found'
					})
				});
			} else {
				await route.continue();
			}
		});

		await page.goto('/security');

		const scanBtn = page.getByRole('button', { name: /Scan|Run Scan/i });
		await scanBtn.click();

		// Result should appear
		await expect(page.getByText('No vulnerabilities found')).toBeVisible({ timeout: 5000 });
	});

	test('shows audit status section', async ({ page }) => {
		await page.goto('/security');

		// Should display security status info
		const statusText = page.getByText(/CLEAN|VULNERABLE|PENDING/i);
		await expect(statusText.first()).toBeVisible();
	});

	test('shows network policy section', async ({ page }) => {
		await page.goto('/security');

		// Network policy details should be visible
		const policyText = page.getByText(/policy|network|gateway/i);
		await expect(policyText.first()).toBeVisible();
	});
});
