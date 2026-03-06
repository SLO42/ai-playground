import { env } from '$env/dynamic/private';

/**
 * Runtime feature flags — controlled via .env variables.
 * Each flag defaults to true (enabled) unless explicitly set to "false" or "0".
 */

const FLAG_PREFIX = 'FF_';

const FLAG_DEFAULTS: Record<string, boolean> = {
	FF_MEMORY: true,
	FF_SECURITY: true,
	FF_HOOKS: true,
	FF_REPORTS: true,
	FF_TASKS: true,
	FF_CHAT: true,
	FF_INBOX: true,
	FF_NOTIFICATIONS: true,
	FF_AUTOSCALE: true,
	FF_PREVIEW_NEW_PAGES: false
};

function isTruthy(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback;
	return value !== 'false' && value !== '0';
}

export interface FeatureFlags {
	memory: boolean;
	security: boolean;
	hooks: boolean;
	reports: boolean;
	tasks: boolean;
	chat: boolean;
	inbox: boolean;
	notifications: boolean;
	autoscale: boolean;
	previewNewPages: boolean;
}

export function getFeatureFlags(): FeatureFlags {
	return {
		memory: isTruthy(env.FF_MEMORY, FLAG_DEFAULTS.FF_MEMORY),
		security: isTruthy(env.FF_SECURITY, FLAG_DEFAULTS.FF_SECURITY),
		hooks: isTruthy(env.FF_HOOKS, FLAG_DEFAULTS.FF_HOOKS),
		reports: isTruthy(env.FF_REPORTS, FLAG_DEFAULTS.FF_REPORTS),
		tasks: isTruthy(env.FF_TASKS, FLAG_DEFAULTS.FF_TASKS),
		chat: isTruthy(env.FF_CHAT, FLAG_DEFAULTS.FF_CHAT),
		inbox: isTruthy(env.FF_INBOX, FLAG_DEFAULTS.FF_INBOX),
		notifications: isTruthy(env.FF_NOTIFICATIONS, FLAG_DEFAULTS.FF_NOTIFICATIONS),
		autoscale: isTruthy(env.FF_AUTOSCALE, FLAG_DEFAULTS.FF_AUTOSCALE),
		previewNewPages: isTruthy(env.FF_PREVIEW_NEW_PAGES, FLAG_DEFAULTS.FF_PREVIEW_NEW_PAGES)
	};
}

/** Map route paths to their feature flag key */
const ROUTE_FLAG_MAP: Record<string, keyof FeatureFlags> = {
	'/memory': 'memory',
	'/security': 'security',
	'/hooks': 'hooks',
	'/reports': 'reports',
	'/tasks': 'tasks',
	'/chat': 'chat',
	'/inbox': 'inbox',
	'/notifications': 'notifications',
	// '/agents' — ungated, agents page is ready
};

export function isRouteEnabled(pathname: string, flags: FeatureFlags): boolean {
	for (const [route, flag] of Object.entries(ROUTE_FLAG_MAP)) {
		if (pathname === route || pathname.startsWith(route + '/')) {
			return flags[flag];
		}
	}
	return true; // Routes without a flag are always enabled
}
