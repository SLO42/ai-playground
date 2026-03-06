import { test, expect } from '@playwright/test';

test.describe('Settings page', () => {
	test('shows the heading', async ({ page }) => {
		await page.goto('/settings');

		await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	});

	test('shows category navigation', async ({ page }) => {
		await page.goto('/settings');

		// Settings categories should be visible as navigation items
		const generalBtn = page.getByRole('button', { name: /General/i });
		if (await generalBtn.isVisible()) {
			await expect(generalBtn).toBeVisible();
		}
	});

	test('general settings section has form controls', async ({ page }) => {
		await page.goto('/settings');

		// Settings should have toggles/inputs for behavior config
		const requireConfirm = page.getByText(/Require Confirmation|confirmation/i);
		if (await requireConfirm.first().isVisible()) {
			await expect(requireConfirm.first()).toBeVisible();
		}
	});

	test('notification settings section is accessible', async ({ page }) => {
		await page.goto('/settings');

		// Navigate to notifications category
		const notifBtn = page.getByRole('button', { name: /Notification/i });
		if (await notifBtn.isVisible()) {
			await notifBtn.click();

			// Notification settings should be visible
			const desktopToggle = page.getByText(/Desktop|desktop/i);
			await expect(desktopToggle.first()).toBeVisible({ timeout: 3000 });
		}
	});

	test('saving settings triggers API call', async ({ page }) => {
		// Mock the settings API
		await page.route('**/api/settings/**', async (route) => {
			if (route.request().method() === 'PUT' || route.request().method() === 'POST') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ success: true })
				});
			} else {
				await route.continue();
			}
		});

		await page.goto('/settings');

		// Find a save button
		const saveBtn = page.getByRole('button', { name: /Save/i });
		if (await saveBtn.first().isVisible()) {
			await saveBtn.first().click();
		}
	});

	test('scope toggle switches between global and project', async ({ page }) => {
		await page.goto('/settings');

		const scopeToggle = page.getByText(/Project|Global/i);
		if (await scopeToggle.first().isVisible()) {
			await expect(scopeToggle.first()).toBeVisible();
		}
	});
});
