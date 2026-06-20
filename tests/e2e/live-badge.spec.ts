import { test, expect } from '@playwright/test';

// live-query-reconnect F-008 surface VERIFY: a degraded server-side LIVE subscription
// must be SEEN by the operator — never silently present frozen rows as current.
//
// The honest map (phase → label/variant) is proven exhaustively by the unit tests
// (src/lib/client/live-badge-core.test.ts) over all 5 phases. This spec locks the LIVE
// reactive surface: the LiveBadge is silent while cleanly live, and renders the degraded
// badge (with a screen-reader label + role=status) the moment a region's `liveStatus`
// flips. The real 1h-TTL subscription-death trigger is infeasible in a bounded verify, so
// we drive the SAME reactive `liveStatus` map the server's `live_status` frame writes via
// the window.atelier control bridge (the existing e2e affordance).

test('/projects LiveBadge: silent when live, visible+labelled when the project feed degrades', async ({
	page
}) => {
	// F-010: 'load', never 'networkidle' (the open SSE stream never settles networkidle).
	await page.goto('/projects', { waitUntil: 'load' });
	await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

	// Clean live default: NO degraded badge. We only surface a badge when NOT cleanly live,
	// so a healthy region carries no "live: …" chrome (silent healthy default).
	await expect(page.getByText(/^live: (reconnecting|disconnected|offline|unknown)$/)).toHaveCount(
		0
	);

	// Drive the server's 'reconnecting' phase for the `project` table through the real
	// reactive map (exactly what the live_status SSE frame does).
	await page.evaluate(() => {
		const s = (window as unknown as { atelier?: { stream?: { liveStatus: Record<string, string> } } })
			.atelier?.stream;
		if (!s) throw new Error('atelier.stream control bridge not exposed');
		s.liveStatus = { ...s.liveStatus, project: 'reconnecting' };
	});

	// The badge appears with role=status and the honest, screen-reader-spoken label.
	const reconnecting = page.getByRole('status', { name: 'live: reconnecting' });
	await expect(reconnecting).toBeVisible();
	await expect(reconnecting).toContainText('live: reconnecting');

	// Flip to 'disconnected' (the subscription gave up) — badge updates in place, honestly.
	await page.evaluate(() => {
		const s = (window as unknown as { atelier?: { stream?: { liveStatus: Record<string, string> } } })
			.atelier?.stream;
		s!.liveStatus = { ...s!.liveStatus, project: 'disconnected' };
	});
	const disconnected = page.getByRole('status', { name: 'live: disconnected' });
	await expect(disconnected).toBeVisible();
	await expect(page.getByRole('status', { name: 'live: reconnecting' })).toHaveCount(0);

	// Recovery: server reports 'live' again → the badge goes silent (no stale degraded chrome).
	await page.evaluate(() => {
		const s = (window as unknown as { atelier?: { stream?: { liveStatus: Record<string, string> } } })
			.atelier?.stream;
		s!.liveStatus = { ...s!.liveStatus, project: 'live' };
	});
	await expect(page.getByRole('status', { name: /^live: / })).toHaveCount(0);
});
