/**
 * General settings API — confirmation prompts, auto-approve, timeouts.
 * Data stored at: .playground/settings.json (global) or project-scoped equivalent.
 */
import { json } from '@sveltejs/kit';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { scopedSettingsPath, type SettingsScope } from '$lib/server/constants.js';
import { loadGeneralSettings, GENERAL_DEFAULTS, type GeneralSettings } from '$lib/server/general-settings.js';
import type { RequestHandler } from './$types.js';

function resolveFilePath(url: URL): string {
	const scope = (url.searchParams.get('scope') ?? 'global') as SettingsScope;
	const projectPath = url.searchParams.get('projectPath') ?? undefined;
	return scopedSettingsPath('settings.json', scope, projectPath);
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const filePath = resolveFilePath(url);
		const settings = await loadGeneralSettings(filePath);
		return json(settings);
	} catch (e) {
		console.error('[api/settings/general] GET failed:', e);
		return json({ error: 'Failed to load general settings' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, url }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const settings: GeneralSettings = {
		requireConfirmation: typeof body.requireConfirmation === 'boolean' ? body.requireConfirmation : GENERAL_DEFAULTS.requireConfirmation,
		autoApproveLowRisk: typeof body.autoApproveLowRisk === 'boolean' ? body.autoApproveLowRisk : GENERAL_DEFAULTS.autoApproveLowRisk,
		showCommandsInInputBar: typeof body.showCommandsInInputBar === 'boolean' ? body.showCommandsInInputBar : GENERAL_DEFAULTS.showCommandsInInputBar,
		defaultTimeout: typeof body.defaultTimeout === 'string' ? body.defaultTimeout : GENERAL_DEFAULTS.defaultTimeout,
		projectOverride: typeof body.projectOverride === 'boolean' ? body.projectOverride : GENERAL_DEFAULTS.projectOverride
	};

	try {
		const filePath = resolveFilePath(url);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(settings, null, '\t'), 'utf-8');
		return json({ ok: true });
	} catch (e) {
		console.error('[api/settings/general] PUT failed:', e);
		return json({ error: 'Failed to save general settings' }, { status: 500 });
	}
};
