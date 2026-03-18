/**
 * Notification settings API — desktop/toast/sound toggles, quiet hours, per-category prefs.
 * Data stored at: .playground/notification-settings.json (global) or project-scoped equivalent.
 */
import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { scopedSettingsPath, type SettingsScope } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

interface CategoryPref {
	desktop: boolean;
	inApp: boolean;
}

interface NotificationSettings {
	desktop: boolean;
	inAppToasts: boolean;
	sound: boolean;
	quietHoursStart: string;
	quietHoursEnd: string;
	categories: Record<string, CategoryPref>;
	heartbeatEnabled: boolean;
	heartbeatIntervalMs: number;
}

function resolveFilePath(url: URL): string {
	const scope = (url.searchParams.get('scope') ?? 'global') as SettingsScope;
	const projectPath = url.searchParams.get('projectPath') ?? undefined;
	return scopedSettingsPath('notification-settings.json', scope, projectPath);
}

const VALID_CATEGORIES = ['task', 'service', 'agent', 'chat', 'memory', 'model', 'system'];

const NOTIF_DEFAULTS: NotificationSettings = {
	desktop: true,
	inAppToasts: true,
	sound: false,
	quietHoursStart: '23:00',
	quietHoursEnd: '08:00',
	categories: {
		task: { desktop: true, inApp: true },
		service: { desktop: true, inApp: true },
		agent: { desktop: true, inApp: true },
		chat: { desktop: false, inApp: true },
		memory: { desktop: false, inApp: true },
		model: { desktop: true, inApp: true },
		system: { desktop: true, inApp: true }
	},
	heartbeatEnabled: true,
	heartbeatIntervalMs: 60000
};

const TIME_RE = /^\d{2}:\d{2}$/;

function validateCategoryPref(raw: unknown): CategoryPref | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.desktop !== 'boolean' || typeof obj.inApp !== 'boolean') return null;
	return { desktop: obj.desktop, inApp: obj.inApp };
}

export const GET: RequestHandler = async ({ url }) => {
	const filePath = resolveFilePath(url);
	try {
		const raw = await readFile(filePath, 'utf-8');
		return json({ ...NOTIF_DEFAULTS, ...JSON.parse(raw) });
	} catch {
		return json(NOTIF_DEFAULTS);
	}
};

export const PUT: RequestHandler = async ({ request, url }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	// Validate and build categories from body, falling back to defaults per category
	const rawCats = typeof body.categories === 'object' && body.categories !== null
		? body.categories as Record<string, unknown>
		: {};
	const categories: Record<string, CategoryPref> = {};
	for (const cat of VALID_CATEGORIES) {
		const parsed = validateCategoryPref(rawCats[cat]);
		categories[cat] = parsed ?? NOTIF_DEFAULTS.categories[cat];
	}

	const rawInterval = Number(body.heartbeatIntervalMs);

	const settings: NotificationSettings = {
		desktop: typeof body.desktop === 'boolean' ? body.desktop : NOTIF_DEFAULTS.desktop,
		inAppToasts: typeof body.inAppToasts === 'boolean' ? body.inAppToasts : NOTIF_DEFAULTS.inAppToasts,
		sound: typeof body.sound === 'boolean' ? body.sound : NOTIF_DEFAULTS.sound,
		quietHoursStart: typeof body.quietHoursStart === 'string' && TIME_RE.test(body.quietHoursStart)
			? body.quietHoursStart : NOTIF_DEFAULTS.quietHoursStart,
		quietHoursEnd: typeof body.quietHoursEnd === 'string' && TIME_RE.test(body.quietHoursEnd)
			? body.quietHoursEnd : NOTIF_DEFAULTS.quietHoursEnd,
		categories,
		heartbeatEnabled: typeof body.heartbeatEnabled === 'boolean' ? body.heartbeatEnabled : NOTIF_DEFAULTS.heartbeatEnabled,
		heartbeatIntervalMs: !isNaN(rawInterval) && rawInterval >= 5000 && rawInterval <= 3600000
			? rawInterval : NOTIF_DEFAULTS.heartbeatIntervalMs
	};

	try {
		const filePath = resolveFilePath(url);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(settings, null, '\t'), 'utf-8');
		return json({ ok: true });
	} catch (e) {
		console.error('[api/settings/notifications] PUT failed:', e);
		return json({ error: 'Failed to save notification settings' }, { status: 500 });
	}
};
