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

// ────────────────────────────────────────────────────────────────────────────
// 14.2d REGRESSION (operator: "dead space below the app shell")
//
// The defect class: the shell is `height: 100vh; overflow: hidden`, so the
// document must NEVER scroll — `.content` is the one scroller. But `.shell` and
// `.content` were both `position: static`, so any absolutely-positioned
// descendant (every visually-hidden `.sr-only` legend/label) resolved against
// the INITIAL containing block, escaped `.shell`'s clip, and pushed
// `documentElement.scrollHeight` down to its static offset — an outer document
// scrollbar plus a dead band where the sidebar background stops. Measured on
// /agents before the fix: innerHeight 861 vs documentElement.scrollHeight 1316.
//
// Fix: `position: relative` on `.content` (+layout.svelte). These tests assert
// the INVARIANT ("the document never scrolls"), not the one page that exposed
// it, so any future abspos descendant that escapes the scroller fails here.
// A pure unit test cannot catch this: it is a computed-layout property of the
// live cascade + box tree, which jsdom does not implement.
// ────────────────────────────────────────────────────────────────────────────

/** innerHeight vs documentElement.scrollHeight — the outer-scrollbar probe. */
async function docOverflow(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		const content = document.querySelector('main.content') as HTMLElement | null;
		const cs = content ? getComputedStyle(content) : null;
		return {
			innerHeight: window.innerHeight,
			docScrollHeight: document.documentElement.scrollHeight,
			bodyScrollHeight: document.body.scrollHeight,
			contentPosition: cs?.position ?? null,
			contentZIndex: cs?.zIndex ?? null,
			contentTransform: cs?.transform ?? null,
			contentFilter: cs?.filter ?? null,
			contentScrollHeight: content?.scrollHeight ?? 0,
			contentClientHeight: content?.clientHeight ?? 0
		};
	});
}

test.describe('14.2d — the shell never grows an outer document scrollbar', () => {
	test('the content scroller is the containing block, and makes no stacking context', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/', { waitUntil: 'load' });

		const m = await docOverflow(page);
		// The fix itself.
		expect(m.contentPosition).toBe('relative');
		// …and the fix must not become a new defect: `relative` only creates a
		// stacking context with a non-auto z-index, and only captures
		// `position: fixed` via transform/filter. All three must stay untouched,
		// or the four fixed overlays (palette/confirm/tray/toasts) and the
		// full-height graph canvas would be re-parented into the scroller.
		expect(m.contentZIndex).toBe('auto');
		expect(m.contentTransform).toBe('none');
		expect(m.contentFilter).toBe('none');
	});

	test('an abspos sr-only descendant far down a tall page cannot escape the scroller', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/', { waitUntil: 'load' });

		// Synthesise the exact shape of the defect rather than depending on which
		// page happens to ship one today: a tall block inside the scroller,
		// followed by a visually-hidden abspos element (the shared `.sr-only`
		// primitive, base.css:76) at a static offset well below the fold.
		await page.evaluate(() => {
			const root = document.querySelector('main.content > *') as HTMLElement;
			const spacer = document.createElement('div');
			spacer.id = 'regress-spacer';
			spacer.style.height = '3000px';
			const hidden = document.createElement('span');
			hidden.id = 'regress-sr-only';
			hidden.className = 'sr-only';
			hidden.textContent = 'probe';
			root.append(spacer, hidden);
		});

		// The probe really is absolutely positioned (i.e. the shared primitive is
		// loaded) — otherwise this test would pass vacuously.
		expect(
			await page.evaluate(
				() => getComputedStyle(document.getElementById('regress-sr-only')!).position
			)
		).toBe('absolute');

		const m = await docOverflow(page);
		// THE INVARIANT. Before the fix this read ~3900 against an 900px viewport.
		// 1px of tolerance for sub-pixel rounding only.
		expect(
			m.docScrollHeight,
			`document must not scroll: scrollHeight ${m.docScrollHeight} vs innerHeight ${m.innerHeight}`
		).toBeLessThanOrEqual(m.innerHeight + 1);
		expect(m.bodyScrollHeight).toBeLessThanOrEqual(m.innerHeight + 1);
		// The overflow went where it belongs — INTO the content scroller.
		expect(m.contentScrollHeight).toBeGreaterThan(m.contentClientHeight);
	});

	test('a real page carrying sr-only legends does not scroll the document (/settings)', async ({
		page
	}) => {
		// /settings ships three `<legend class="sr-only">` (:177, :290, :442) and
		// showed 97px of the same dead band. Small viewport ⇒ guaranteed taller
		// than the fold, so the escape would be unmissable.
		await page.setViewportSize({ width: 1280, height: 700 });
		await page.goto('/settings', { waitUntil: 'load' });

		const legends = await page.locator('main.content legend.sr-only').count();
		expect(legends, 'the page under test must still carry sr-only legends').toBeGreaterThan(0);
		// The local duplicate was removed — they inherit the shared base.css rule.
		expect(
			await page.locator('main.content legend.sr-only').first().evaluate((el) => {
				const cs = getComputedStyle(el);
				return { position: cs.position, width: cs.width };
			})
		).toEqual({ position: 'absolute', width: '1px' });

		const m = await docOverflow(page);
		expect(m.docScrollHeight).toBeLessThanOrEqual(m.innerHeight + 1);
	});

	test('shadow path — a page SHORTER than the viewport still never scrolls the document', async ({
		page
	}) => {
		// The zero-overflow case: nothing to scroll anywhere. A fix that swapped
		// the outer scrollbar for a permanent inner one would fail here.
		await page.setViewportSize({ width: 1920, height: 1400 });
		await page.goto('/', { waitUntil: 'load' });

		const m = await docOverflow(page);
		expect(m.docScrollHeight).toBeLessThanOrEqual(m.innerHeight + 1);
		expect(m.contentScrollHeight).toBeLessThanOrEqual(m.contentClientHeight + 1);
	});

	test('shadow path — the invariant holds at 375px, where the sidebar goes fixed', async ({
		page
	}) => {
		// Below 767px the sidebar leaves the flex flow (`position: fixed`), so the
		// shell's box tree is a different shape. The scroller invariant is the same.
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto('/settings', { waitUntil: 'load' });

		const m = await docOverflow(page);
		expect(m.contentPosition).toBe('relative');
		expect(m.docScrollHeight).toBeLessThanOrEqual(m.innerHeight + 1);
	});

	test('no regression — a fixed overlay stays viewport-anchored above the relative scroller', async ({
		page
	}) => {
		// `position: relative` never captures `position: fixed` (only
		// transform/filter/will-change/contain do). Proven, not assumed: scroll
		// the content far down, then open the palette and check it is still
		// pinned to the viewport rather than to the scrolled content box.
		await page.setViewportSize({ width: 1280, height: 700 });
		await page.goto('/settings', { waitUntil: 'load' });
		await page.evaluate(() => {
			(document.querySelector('main.content') as HTMLElement).scrollTop = 600;
		});

		const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
		await page.keyboard.press(`${mod}+KeyK`);
		const palette = page.getByRole('dialog', { name: 'Command palette' });
		await expect(palette).toBeVisible();

		// The scrim is the fixed, inset:0 layer — it must still cover the viewport.
		const scrim = await page.evaluate(() => {
			const el = document.querySelector('main.content') as HTMLElement;
			const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
			const r = dialog.getBoundingClientRect();
			return { scrollTop: el.scrollTop, top: r.top, height: r.height, vh: window.innerHeight };
		});
		expect(scrim.scrollTop).toBeGreaterThan(0); // the scroller really did scroll
		// A captured overlay would be offset UP by scrollTop; a fixed one is not.
		expect(scrim.top).toBeGreaterThanOrEqual(0);
		expect(scrim.top).toBeLessThan(scrim.vh);

		// And the document still does not scroll while an overlay is mounted.
		const m = await docOverflow(page);
		expect(m.docScrollHeight).toBeLessThanOrEqual(m.innerHeight + 1);

		await page.keyboard.press('Escape');
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
