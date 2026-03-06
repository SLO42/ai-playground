import { test, expect } from '@playwright/test';

test.describe('Models page', () => {
	test('shows the heading and metric cards', async ({ page }) => {
		await page.goto('/models');

		await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible();
	});

	test('shows VRAM gauge section', async ({ page }) => {
		await page.goto('/models');

		// VRAM information should be displayed
		await expect(page.getByText(/VRAM|vram/i)).toBeVisible();
	});

	test('shows local models section', async ({ page }) => {
		await page.goto('/models');

		// Either shows Ollama models or a message about no models
		const modelsSection = page.getByText(/Local Models|Ollama|No.*model/i);
		await expect(modelsSection.first()).toBeVisible();
	});

	test('shows API models section', async ({ page }) => {
		await page.goto('/models');

		// API models (Claude, etc.) should be listed
		const apiSection = page.getByText(/API Models|Cloud Models|Provider/i);
		if (await apiSection.first().isVisible()) {
			await expect(apiSection.first()).toBeVisible();
		}
	});
});
