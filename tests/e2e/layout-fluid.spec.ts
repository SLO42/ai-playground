import { test, expect } from '@playwright/test';

// TASK 14.2 VERIFY (operator + audit, layout cluster) — real browser, real DB:
//   (a) pages are FLUID full-width (no 980–1200px caps): at 1920/2560 the page
//       root spans the content column, while prose ledes KEEP a readable measure;
//       vertical fill: the page root stretches to the content height (no dead
//       bottom band when content is short).
//   (b) the project section tab strip scrolls (not clips) at 375px — every tab
//       stays reachable.
//   (c) the mobile nav drawer: Esc closes; focus moves in on open and returns
//       to the hamburger on close (RightTray pattern).
// F-010: waitUntil 'load', never 'networkidle' (the open SSE stream never settles).

// Geometry: sidebar 248px (--shell-sidebar-w) + 24px gutter each side (--page-gutter).

test.describe('14.2a — fluid full-width pages', () => {
	test('home spans the content column at 1920w (no 1000px cap)', async ({ page }) => {
		await page.setViewportSize({ width: 1920, height: 1080 });
		await page.goto('/', { waitUntil: 'load' });

		const home = page.locator('section.home');
		const box = await home.boundingBox();
		expect(box).not.toBeNull();
		// 1920 - sidebar(248) - 2*gutter(24) = 1624 available; the old cap was 1000.
		expect(box!.width).toBeGreaterThan(1500);

		// Prose keeps its measure: the lede must NOT stretch to the full column.
		const lede = await page.locator('.lede').first().boundingBox();
		expect(lede).not.toBeNull();
		expect(lede!.width).toBeLessThan(1000); // 64ch of mono body ≪ 1000px
	});

	test('home fills the content height at 1920w (no dead bottom band)', async ({ page }) => {
		await page.setViewportSize({ width: 1920, height: 1080 });
		await page.goto('/', { waitUntil: 'load' });

		const fill = await page.evaluate(() => {
			const content = document.querySelector('main.content')!;
			const root = document.querySelector('main.content > *')!;
			const cs = getComputedStyle(content);
			const inner =
				content.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
			return { page: root.getBoundingClientRect().height, inner };
		});
		// The page root stretches to at least the content's inner height.
		expect(fill.page).toBeGreaterThanOrEqual(fill.inner - 1);
	});

	test('reports spans the content column at 2560w (no 1100px cap)', async ({ page }) => {
		await page.setViewportSize({ width: 2560, height: 1200 });
		await page.goto('/reports', { waitUntil: 'load' });

		const box = await page.locator('section.page').boundingBox();
		expect(box).not.toBeNull();
		// 2560 - 248 - 48 = 2264 available; the old cap was 1100.
		expect(box!.width).toBeGreaterThan(2100);
	});
});

test.describe('14.2b — project tab strip at 375px', () => {
	test('the section tabs scroll instead of clipping; the last tab is reachable', async ({
		page
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto('/projects/e2e_demo', { waitUntil: 'load' });

		const strip = page.locator('nav[aria-label="project sections"]');
		await expect(strip).toBeVisible();

		// The strip overflows at 375px (10 sections) and is a scroll container.
		const dims = await strip.evaluate((el) => ({
			scrollWidth: el.scrollWidth,
			clientWidth: el.clientWidth,
			overflowX: getComputedStyle(el).overflowX
		}));
		expect(dims.overflowX).toBe('auto');
		expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);

		// Every tab stays reachable: bring the LAST tab into view and activate it.
		const last = strip.locator('button.tab').last();
		await last.scrollIntoViewIfNeeded();
		await expect(last).toBeInViewport();
		await last.click();
		await expect(last).toHaveAttribute('data-active', 'true');

		// The strip actually scrolled to get there (clipping would make this 0).
		const scrolled = await strip.evaluate((el) => el.scrollLeft);
		expect(scrolled).toBeGreaterThan(0);
	});
});

test.describe('14.2c — mobile nav drawer keyboard + focus', () => {
	test('focus moves into the drawer on open, Esc closes, focus returns', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto('/', { waitUntil: 'load' });

		const toggle = page.getByRole('button', { name: 'Toggle navigation' });
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');

		// Open: aria-expanded flips and focus lands INSIDE the drawer.
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		const focusedInSidebar = await page.evaluate(() => {
			const sidebar = document.getElementById('app-sidebar');
			return sidebar?.contains(document.activeElement) ?? false;
		});
		expect(focusedInSidebar).toBe(true);

		// Esc closes the drawer and focus RETURNS to the hamburger.
		await page.keyboard.press('Escape');
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await expect(toggle).toBeFocused();
	});

	test('Tab cycles within the open drawer (focus trap while it overlays)', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto('/', { waitUntil: 'load' });

		const toggle = page.getByRole('button', { name: 'Toggle navigation' });
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');

		// Tab a full lap: focus must remain inside the drawer the whole way.
		const linkCount = await page.locator('#app-sidebar a[href]').count();
		for (let i = 0; i <= linkCount; i++) {
			await page.keyboard.press('Tab');
			const inside = await page.evaluate(() => {
				const sidebar = document.getElementById('app-sidebar');
				return sidebar?.contains(document.activeElement) ?? false;
			});
			expect(inside, `focus stayed in the drawer after ${i + 1} Tabs`).toBe(true);
		}

		// Close again for a clean teardown (focus restored).
		await page.keyboard.press('Escape');
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	});
});
