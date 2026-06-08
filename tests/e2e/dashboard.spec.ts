import { test, expect } from '@playwright/test';
import { readHandoff } from './db-harness';

// TASK 1.5 VERIFY (exact intent):
//   - a page renders LIVE DB data with NO mocks (F-008): the seeded `project` row
//     surfaces in /projects, served by the built dashboard off a real SurrealDB.
//   - the load test uses waitUntil:'load' NOT networkidle (F-010): the dashboard
//     holds an open SSE stream, so 'networkidle' would never settle and hang.

const { seededProjectName } = readHandoff();

test('app shell renders (sidebar nav + project context)', async ({ page }) => {
	// F-010: 'load', never 'networkidle' (open SSE keeps the network busy forever).
	await page.goto('/projects', { waitUntil: 'load' });

	// The shell: global nav links from the Sidebar.
	await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Claude Code' })).toBeVisible();

	// The page heading.
	await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
});

test('/projects renders the LIVE seeded project row from the DB (F-008, no mocks)', async ({
	page
}) => {
	await page.goto('/projects', { waitUntil: 'load' });

	// The real seeded row — proves live DB data reached the rendered page.
	await expect(page.getByText(seededProjectName, { exact: true })).toBeVisible();
	// Its real fields render too (status + root_path from the seeded row).
	await expect(page.getByText('F:/code/e2e-demo')).toBeVisible();
});

test('home shows a live project count from the DB (not a fabricated metric)', async ({ page }) => {
	await page.goto('/', { waitUntil: 'load' });

	await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
	// Exactly one seeded project → the live count must read "1", not "—".
	const count = page.locator('.metric-value').first();
	await expect(count).toHaveText('1');
});
