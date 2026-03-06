import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { scopedSettingsPath, type SettingsScope } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

function resolveFilePath(url: URL): string {
	const scope = (url.searchParams.get('scope') ?? 'global') as SettingsScope;
	const projectPath = url.searchParams.get('projectPath') ?? undefined;
	return scopedSettingsPath('notification-settings.json', scope, projectPath);
}

const NOTIF_DEFAULTS = {
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

export const GET: RequestHandler = async ({ url }) => {
	const filePath = resolveFilePath(url);
	try {
		const raw = await readFile(filePath, 'utf-8');
		return json(JSON.parse(raw));
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

	const filePath = resolveFilePath(url);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(body, null, '\t'), 'utf-8');
	return json({ ok: true });
};
