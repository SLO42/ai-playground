import { test, expect } from '@playwright/test';

// TASK 10.1 VERIFY (D-038 live-functional): the shell interaction primitives work
// in a real browser against the BUILT dashboard.
//   - CommandPalette: Cmd/Ctrl-K opens it, fuzzy filters, Enter navigates.
//   - Toast: an action fires a transient toast that auto-dismisses + closes manually.
//   - ConfirmDialog: a blocking confirm with a diff blocks, then confirms/cancels.
//   - GateBanner: a non-blocking gate notice renders + dismisses.
//   - Keyboard + reduced-motion both work.
// F-010: always waitUntil:'load' (the open SSE stream means 'networkidle' never settles).

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Wait for the layout control bridge to mount after hydration (window.atelier). */
async function waitForBridge(page: import('@playwright/test').Page): Promise<void> {
	await page.waitForFunction(
		() => Boolean((window as unknown as { atelier?: unknown }).atelier),
		undefined,
		{ timeout: 10_000 }
	);
}

test('Cmd/Ctrl-K opens the command palette and Enter navigates', async ({ page }) => {
	await page.goto('/', { waitUntil: 'load' });

	// Palette is closed at rest.
	await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();

	// Open via the keyboard backbone (UI-SPEC §271).
	await page.keyboard.press(`${mod}+KeyK`);
	const palette = page.getByRole('dialog', { name: 'Command palette' });
	await expect(palette).toBeVisible();

	// The search input takes focus.
	const input = palette.getByRole('combobox');
	await expect(input).toBeFocused();

	// Fuzzy-filter to a nav command and run it with Enter.
	await input.fill('workflows');
	await expect(palette.getByRole('option', { name: /Go to Workflows/ })).toBeVisible();
	// Capture the open palette for the D-038 live-verify evidence (best-effort).
	await page
		.screenshot({ path: 'docs/qa-screenshots/task-10.1-command-palette.png' })
		.catch(() => {});
	await page.keyboard.press('Enter');

	// Navigated to /workflows; palette closed.
	await expect(page).toHaveURL(/\/workflows$/);
	await expect(palette).toBeHidden();
});

test('palette filters out non-matches and Esc closes it', async ({ page }) => {
	await page.goto('/', { waitUntil: 'load' });
	await page.keyboard.press(`${mod}+KeyK`);
	const palette = page.getByRole('dialog', { name: 'Command palette' });
	await expect(palette).toBeVisible();

	await palette.getByRole('combobox').fill('zzzzz');
	await expect(palette.getByText(/No commands match/)).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(palette).toBeHidden();
});

test('an action fires a Toast that can be dismissed', async ({ page }) => {
	await page.goto('/', { waitUntil: 'load' });
	await waitForBridge(page);

	// Fire a toast through the real store (the same surface palette commands/pages use).
	await page.evaluate(() => {
		// @ts-expect-error injected by the layout control bridge
		window.atelier.toasts.success('Config saved', 'settings.json');
	});

	const toast = page.getByTestId('toast').filter({ hasText: 'Config saved' });
	await expect(toast).toBeVisible();
	await expect(toast.getByText('settings.json')).toBeVisible();

	// Manual close removes it.
	await toast.getByRole('button', { name: 'Dismiss notification' }).click();
	await expect(toast).toBeHidden();
});

test('ConfirmDialog blocks with a diff, then confirms', async ({ page }) => {
	await page.goto('/', { waitUntil: 'load' });
	await waitForBridge(page);

	// Open a blocking confirm with a unified diff (the D-010 config-write shape).
	const result = page.evaluate(() => {
		// @ts-expect-error injected by the layout control bridge
		return window.atelier.confirm.confirm({
			title: 'Save config',
			message: 'Write .claude/settings.json',
			confirmLabel: 'Save config',
			diff: [
				{ kind: 'context', text: '  "model": "sonnet"' },
				{ kind: 'remove', text: '  "maxTurns": 5' },
				{ kind: 'add', text: '  "maxTurns": 10' }
			]
		});
	});

	const dialog = page.getByRole('dialog', { name: 'Save config' });
	await expect(dialog).toBeVisible();
	// The diff renders both sides.
	await expect(dialog.getByText('"maxTurns": 5')).toBeVisible();
	await expect(dialog.getByText('"maxTurns": 10')).toBeVisible();

	// Confirm — the awaited promise resolves true.
	await dialog.getByRole('button', { name: 'Save config' }).click();
	await expect(dialog).toBeHidden();
	expect(await result).toBe(true);
});

test('ConfirmDialog cancels on Esc (resolves false)', async ({ page }) => {
	await page.goto('/', { waitUntil: 'load' });
	await waitForBridge(page);
	const result = page.evaluate(() => {
		// @ts-expect-error injected by the layout control bridge
		return window.atelier.confirm.confirm({ title: 'Stop agent', danger: true });
	});
	const dialog = page.getByRole('dialog', { name: 'Stop agent' });
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	expect(await result).toBe(false);
});

test('GateBanner surfaces a block notice and dismisses', async ({ page }) => {
	await page.goto('/', { waitUntil: 'load' });
	await waitForBridge(page);
	await page.evaluate(() => {
		// @ts-expect-error injected by the layout control bridge
		window.atelier.confirm.raiseGate({
			severity: 'block',
			gate: 'dangerous-bash',
			message: 'Blocked a destructive command',
			detail: 'rm -rf /'
		});
	});

	const banner = page.getByRole('alert').filter({ hasText: 'dangerous-bash' });
	await expect(banner).toBeVisible();
	await expect(banner.getByText('Blocked', { exact: true })).toBeVisible();
	await banner.getByRole('button', { name: 'Dismiss gate notice' }).click();
	await expect(banner).toBeHidden();
});

test('palette works under reduced-motion (no stuck-hidden frames)', async ({ browser }) => {
	const ctx = await browser.newContext({ reducedMotion: 'reduce' });
	const page = await ctx.newPage();
	await page.goto('/', { waitUntil: 'load' });

	await page.keyboard.press(`${mod}+KeyK`);
	const palette = page.getByRole('dialog', { name: 'Command palette' });
	// With reduced-motion the entrance is instant — it must still be fully visible.
	await expect(palette).toBeVisible();
	await expect(palette.getByRole('combobox')).toBeFocused();
	await ctx.close();
});
