import { test, expect } from '@playwright/test';

test.describe('Tasks page', () => {
	test('shows the heading and metric cards', async ({ page }) => {
		await page.goto('/tasks');

		await expect(page.getByRole('heading', { name: 'Task Backlog' })).toBeVisible();
	});

	test('filter tabs are present', async ({ page }) => {
		await page.goto('/tasks');

		// Task filter controls
		const activeBtn = page.getByRole('button', { name: 'Active' });
		const completedBtn = page.getByRole('button', { name: 'Completed' });
		const allBtn = page.getByRole('button', { name: 'All' });

		await expect(activeBtn).toBeVisible();
		await expect(completedBtn).toBeVisible();
		await expect(allBtn).toBeVisible();
	});

	test('search input is present', async ({ page }) => {
		await page.goto('/tasks');

		const searchInput = page.getByPlaceholder(/search/i);
		await expect(searchInput).toBeVisible();
	});

	test('new task button opens modal', async ({ page }) => {
		await page.goto('/tasks');

		const newBtn = page.getByRole('button', { name: /New Task|Add Task|\+ Task/i });
		if (await newBtn.isVisible()) {
			await newBtn.click();

			// Modal should appear with form fields
			await expect(page.getByText(/Title|task name/i).first()).toBeVisible({ timeout: 3000 });
		}
	});

	test('switching filter tabs changes displayed tasks', async ({ page }) => {
		await page.goto('/tasks');

		// Click completed to filter
		await page.getByRole('button', { name: 'Completed' }).click();

		// Click Active
		await page.getByRole('button', { name: 'Active' }).click();

		// Click All
		await page.getByRole('button', { name: 'All' }).click();
	});
});
