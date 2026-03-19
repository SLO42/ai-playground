import { redirect, type Handle } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { startHeartbeat, stopHeartbeat, loadHeartbeatConfig, getHeartbeatConfig } from '$lib/server/heartbeat.js';
import { getFeatureFlags, isRouteEnabled } from '$lib/server/feature-flags.js';

// Stop any existing heartbeat (HMR reload), then only start if config says enabled
stopHeartbeat();
loadHeartbeatConfig().then(() => {
	const config = getHeartbeatConfig();
	if (config.enabled !== false) {
		startHeartbeat();
	} else {
		console.log('[heartbeat] Disabled in config — not starting');
	}
}).catch(() => {
	// Config load failed — start anyway as fallback
	startHeartbeat();
});

/**
 * Per-boot dashboard token — regenerated every time the server starts.
 * Set as an httpOnly, sameSite=strict cookie so only the browser that loaded
 * the dashboard can send it.  API endpoints that perform mutations can call
 * `validateDashboardToken(event)` to reject curl / server-to-server callers.
 */
export const DASHBOARD_TOKEN = randomBytes(32).toString('hex');
const COOKIE_NAME = 'dashboard_token';

export const handle: Handle = async ({ event, resolve }) => {
	const flags = getFeatureFlags();
	if (!isRouteEnabled(event.url.pathname, flags)) {
		throw redirect(302, '/');
	}

	// Stamp the token onto every response so the browser always has it.
	const response = await resolve(event);
	response.headers.append(
		'set-cookie',
		`${COOKIE_NAME}=${DASHBOARD_TOKEN}; HttpOnly; SameSite=Strict; Path=/`
	);
	return response;
};
