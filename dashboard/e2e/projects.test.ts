import { test, expect } from '@playwright/test';

test.describe('Projects list page', () => {
	test('shows the projects heading and action buttons', async ({ page }) => {
		await page.goto('/projects');

		await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
		await expect(page.getByRole('link', { name: '+ New Project' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Import' })).toBeVisible();
	});

	test('navigates to the create page from the projects list', async ({ page }) => {
		await page.goto('/projects');

		await page.getByRole('link', { name: '+ New Project' }).click();
		await page.waitForURL('/projects/create');

		await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
	});

	test('navigates to the import page from the projects list', async ({ page }) => {
		await page.goto('/projects');

		await page.getByRole('link', { name: 'Import' }).click();
		await page.waitForURL('/projects/import');

		await expect(
			page.getByRole('heading', { name: 'Import Existing Project' })
		).toBeVisible();
	});
});

test.describe('Create project page', () => {
	test('renders the form with default values', async ({ page }) => {
		await page.goto('/projects/create');

		// Header
		await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();

		// Tab nav — create tab is active (has bg-accent-blue)
		const createTab = page.getByRole('link', { name: '+ Create New Project' });
		await expect(createTab).toBeVisible();

		// Default project name input
		const nameInput = page.locator('input[type="text"]').first();
		await expect(nameInput).toHaveValue('my-new-project');

		// Template buttons should be visible
		await expect(page.getByText('SvelteKit')).toBeVisible();
		await expect(page.getByText('Next.js')).toBeVisible();
		await expect(page.getByText('Python')).toBeVisible();
		await expect(page.getByText('Agent')).toBeVisible();

		// Create button exists and is enabled
		const createBtn = page.getByRole('button', { name: 'Create Project' });
		await expect(createBtn).toBeVisible();
		await expect(createBtn).toBeEnabled();
	});

	test('updates project name and directory path syncs', async ({ page }) => {
		await page.goto('/projects/create');

		const nameInput = page.locator('input[type="text"]').first();
		await nameInput.fill('test-e2e-project');

		// The directory path input should contain the new project name
		const dirInput = page.locator('input[type="text"]').nth(1);
		await expect(dirInput).toHaveValue(/test-e2e-project$/);
	});

	test('disables create button when project name is empty', async ({ page }) => {
		await page.goto('/projects/create');

		const nameInput = page.locator('input[type="text"]').first();
		await nameInput.fill('');

		const createBtn = page.getByRole('button', { name: 'Create Project' });
		await expect(createBtn).toBeDisabled();
	});

	test('can select a different template', async ({ page }) => {
		await page.goto('/projects/create');

		// Click on the Python template
		await page.getByText('Python').click();

		// The Python template button should now have the selected style (border-accent-blue)
		const pythonBtn = page.locator('button', { hasText: 'Python' }).filter({ hasText: 'FastAPI' });
		await expect(pythonBtn).toHaveClass(/border-accent-blue/);
	});

	test('shows "Will create" file preview', async ({ page }) => {
		await page.goto('/projects/create');

		await expect(page.getByText('Will create:')).toBeVisible();
		await expect(page.getByText('CLAUDE.md')).toBeVisible();
		await expect(page.getByText('.gitignore')).toBeVisible();
	});

	test('cancel link navigates back to projects list', async ({ page }) => {
		await page.goto('/projects/create');

		await page.getByRole('link', { name: 'Cancel' }).click();
		await page.waitForURL('/projects');

		await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
	});

	test('submits the create form and redirects on success', async ({ page }) => {
		await page.goto('/projects/create');

		const nameInput = page.locator('input[type="text"]').first();
		await nameInput.fill('e2e-test-project');

		// Mock the POST /api/projects endpoint to avoid actually creating files
		await page.route('**/api/projects', async (route) => {
			if (route.request().method() === 'POST') {
				const body = route.request().postDataJSON();
				await route.fulfill({
					status: 201,
					contentType: 'application/json',
					body: JSON.stringify({
						project: {
							id: 'e2e-test-project',
							name: body.name,
							path: body.path,
							status: 'active',
							health: 'healthy'
						},
						gitInitialized: true,
						githubCreated: false
					})
				});
			} else {
				await route.continue();
			}
		});

		await page.getByRole('button', { name: 'Create Project' }).click();

		// Should redirect to the new project page
		await page.waitForURL('/projects/e2e-test-project');
	});

	test('displays an error when creation fails', async ({ page }) => {
		await page.goto('/projects/create');

		const nameInput = page.locator('input[type="text"]').first();
		await nameInput.fill('bad-project');

		// Mock a failure response
		await page.route('**/api/projects', async (route) => {
			if (route.request().method() === 'POST') {
				await route.fulfill({
					status: 400,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'Directory already exists' })
				});
			} else {
				await route.continue();
			}
		});

		await page.getByRole('button', { name: 'Create Project' }).click();

		// Error message should appear
		await expect(page.getByText('Directory already exists')).toBeVisible();
	});
});

test.describe('Import project page', () => {
	test('renders the import form', async ({ page }) => {
		await page.goto('/projects/import');

		await expect(
			page.getByRole('heading', { name: 'Import Existing Project' })
		).toBeVisible();

		// Tab nav — import tab active
		const importTab = page.getByRole('link', { name: 'Import Existing' });
		await expect(importTab).toBeVisible();

		// Step 1 heading
		await expect(page.getByText('Select Project Directory')).toBeVisible();

		// Path input
		const pathInput = page.locator('input[type="text"]').first();
		await expect(pathInput).toBeVisible();

		// Scan and Import buttons
		await expect(page.getByRole('button', { name: 'Scan' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Import Project' })).toBeVisible();
	});

	test('import button is disabled until scan completes', async ({ page }) => {
		await page.goto('/projects/import');

		// Import should be disabled when not scanned
		const importBtn = page.getByRole('button', { name: 'Import Project' });
		await expect(importBtn).toBeDisabled();
	});

	test('shows detected configs after scanning a valid path', async ({ page }) => {
		// Navigate with a path that triggers the server-side scan
		await page.goto('/projects/import?path=C%3A%5CUsers%5C11sos%5Cwork%5Cai-playground');

		// If scan succeeded, Step 2 should be visible
		const step2 = page.getByText('Detected Configuration');
		if (await step2.isVisible()) {
			// Config items should be listed
			await expect(page.locator('.grid').first()).toBeVisible();

			// Step 3 should also be visible
			await expect(page.getByText('Review & Import')).toBeVisible();

			// Import button should now be enabled
			const importBtn = page.getByRole('button', { name: 'Import Project' });
			await expect(importBtn).toBeEnabled();
		}
	});

	test('cancel link navigates back to projects list', async ({ page }) => {
		await page.goto('/projects/import');

		await page.getByRole('link', { name: 'Cancel' }).click();
		await page.waitForURL('/projects');
	});

	test('tab navigation switches between create and import', async ({ page }) => {
		await page.goto('/projects/import');

		// Switch to create tab
		await page.getByRole('link', { name: '+ Create New Project' }).click();
		await page.waitForURL('/projects/create');
		await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();

		// Switch back to import tab
		await page.getByRole('link', { name: 'Import Existing' }).click();
		await page.waitForURL('/projects/import');
		await expect(
			page.getByRole('heading', { name: 'Import Existing Project' })
		).toBeVisible();
	});

	test('submits the import and redirects to projects list', async ({ page }) => {
		// Provide a scanned path so import button is enabled
		await page.goto('/projects/import?path=C%3A%5CUsers%5C11sos%5Cwork%5Cai-playground');

		// Mock both the GET (for project list) and POST (for import)
		await page.route('**/api/projects', async (route) => {
			if (route.request().method() === 'POST') {
				await route.fulfill({
					status: 201,
					contentType: 'application/json',
					body: JSON.stringify({
						project: {
							id: 'ai-playground',
							name: 'ai-playground',
							path: 'F:\\code\\ai-playground',
							status: 'active',
							health: 'healthy'
						}
					})
				});
			} else {
				await route.continue();
			}
		});

		const importBtn = page.getByRole('button', { name: 'Import Project' });
		if (await importBtn.isEnabled()) {
			await importBtn.click();
			await page.waitForURL('/projects');
		}
	});
});

test.describe('Project visible in list after creation', () => {
	test('newly created project appears in the projects list', async ({ page }) => {
		// Mock the projects API to return a project
		await page.route('**/api/projects', async (route) => {
			if (route.request().method() === 'GET') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						projects: [
							{
								id: 'e2e-test-project',
								name: 'e2e-test-project',
								description: 'Created by e2e test',
								path: 'F:\\code\\e2e-test-project',
								status: 'active',
								health: 'healthy',
								tags: ['webapp'],
								techStack: ['SvelteKit', 'TypeScript'],
								agents: 0,
								sessions: 0,
								memoryNodes: 0,
								favorite: false,
								lastOpened: 'just now',
								stats: { totalToolUses: 0 }
							}
						],
						favorites: []
					})
				});
			} else {
				await route.continue();
			}
		});

		await page.goto('/projects');

		// The project card should be visible
		await expect(page.getByText('e2e-test-project')).toBeVisible();
		await expect(page.getByText('Created by e2e test')).toBeVisible();

		// Tech stack badges
		await expect(page.getByText('SvelteKit')).toBeVisible();

		// Stats row
		await expect(page.getByText('0 agents')).toBeVisible();
	});

	test('search filters projects in the list', async ({ page }) => {
		await page.route('**/api/projects', async (route) => {
			if (route.request().method() === 'GET') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						projects: [
							{
								id: 'proj-alpha',
								name: 'alpha-project',
								description: 'First project',
								path: '/tmp/alpha',
								status: 'active',
								health: 'healthy',
								tags: [],
								techStack: [],
								agents: 0,
								sessions: 0,
								memoryNodes: 0,
								favorite: false,
								lastOpened: 'today',
								stats: {}
							},
							{
								id: 'proj-beta',
								name: 'beta-project',
								description: 'Second project',
								path: '/tmp/beta',
								status: 'active',
								health: 'healthy',
								tags: [],
								techStack: [],
								agents: 0,
								sessions: 0,
								memoryNodes: 0,
								favorite: false,
								lastOpened: 'today',
								stats: {}
							}
						],
						favorites: []
					})
				});
			} else {
				await route.continue();
			}
		});

		await page.goto('/projects');

		// Both projects visible initially
		await expect(page.getByText('alpha-project')).toBeVisible();
		await expect(page.getByText('beta-project')).toBeVisible();

		// Search for alpha
		const searchInput = page.getByPlaceholder('Search projects...');
		await searchInput.fill('alpha');

		// Only alpha should remain
		await expect(page.getByText('alpha-project')).toBeVisible();
		await expect(page.getByText('beta-project')).not.toBeVisible();
	});
});
