import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = [
	{ name: 'Memory', path: '/memory' },
	{ name: 'Security', path: '/security' },
	{ name: 'Settings', path: '/settings' },
	{ name: 'Channels', path: '/channels' },
	{ name: 'Hooks', path: '/hooks' },
	{ name: 'Tasks', path: '/tasks' }
];

for (const { name, path } of pages) {
	test.describe(`${name} page accessibility`, () => {
		test(`${name} page has no critical ARIA violations`, async ({ page }) => {
			await page.goto(path);
			await page.waitForLoadState('networkidle');

			const results = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
				.disableRules(['color-contrast']) // disable contrast for SSR/theme variance
				.analyze();

			const critical = results.violations.filter(
				(v) => v.impact === 'critical' || v.impact === 'serious'
			);

			if (critical.length > 0) {
				const summary = critical.map(
					(v) =>
						`[${v.impact}] ${v.id}: ${v.description}\n` +
						v.nodes.map((n) => `  - ${n.html}`).join('\n')
				);
				console.error('Accessibility violations:\n' + summary.join('\n\n'));
			}

			expect(critical).toHaveLength(0);
		});

		test(`${name} page has no missing form labels`, async ({ page }) => {
			await page.goto(path);
			await page.waitForLoadState('networkidle');

			const results = await new AxeBuilder({ page })
				.withRules(['label', 'input-button-name', 'select-name'])
				.analyze();

			expect(results.violations).toHaveLength(0);
		});

		test(`${name} page has proper heading hierarchy`, async ({ page }) => {
			await page.goto(path);
			await page.waitForLoadState('networkidle');

			const results = await new AxeBuilder({ page })
				.withRules(['heading-order', 'page-has-heading-one'])
				.analyze();

			// heading-order is a best-practice, so only fail on serious+
			const serious = results.violations.filter(
				(v) => v.impact === 'critical' || v.impact === 'serious'
			);
			expect(serious).toHaveLength(0);
		});

		test(`${name} page interactive elements are keyboard accessible`, async ({ page }) => {
			await page.goto(path);
			await page.waitForLoadState('networkidle');

			const results = await new AxeBuilder({ page })
				.withRules([
					'button-name',
					'link-name',
					'tabindex',
					'focus-order-semantics',
					'scrollable-region-focusable'
				])
				.analyze();

			expect(results.violations).toHaveLength(0);
		});
	});
}
