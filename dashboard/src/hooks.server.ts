import { redirect, type Handle } from '@sveltejs/kit';
import { startHeartbeat, stopHeartbeat } from '$lib/server/heartbeat.js';
import { getFeatureFlags, isRouteEnabled } from '$lib/server/feature-flags.js';

// Stop any existing heartbeat (HMR reload) before starting fresh
stopHeartbeat();
startHeartbeat();

export const handle: Handle = async ({ event, resolve }) => {
	const flags = getFeatureFlags();
	if (!isRouteEnabled(event.url.pathname, flags)) {
		throw redirect(302, '/');
	}
	return resolve(event);
};
