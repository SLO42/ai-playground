import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { getAutoScaleDefaults, type AutoScaleConfig } from '$lib/server/heartbeat/session-pool.js';
import { getFeatureFlags } from '$lib/server/feature-flags.js';
import type { RequestHandler } from './$types.js';

const AUTOSCALE_FILE = resolve(PATHS.root, '.playground/autoscale-settings.json');

async function loadAutoScaleSettings(): Promise<AutoScaleConfig> {
	try {
		const raw = await readFile(AUTOSCALE_FILE, 'utf-8');
		const parsed = JSON.parse(raw);
		const defaults = getAutoScaleDefaults();
		return {
			minSlots: typeof parsed.minSlots === 'number' ? parsed.minSlots : defaults.minSlots,
			maxSlots: typeof parsed.maxSlots === 'number' ? parsed.maxSlots : defaults.maxSlots,
			tasksPerSlot: typeof parsed.tasksPerSlot === 'number' ? parsed.tasksPerSlot : defaults.tasksPerSlot,
			idleCooldownMs: typeof parsed.idleCooldownMs === 'number' ? parsed.idleCooldownMs : defaults.idleCooldownMs
		};
	} catch {
		return getAutoScaleDefaults();
	}
}

export const GET: RequestHandler = async () => {
	if (!getFeatureFlags().autoscale) {
		return json({ error: 'Autoscale feature is disabled' }, { status: 403 });
	}
	const settings = await loadAutoScaleSettings();
	return json(settings);
};

export const PUT: RequestHandler = async ({ request }) => {
	if (!getFeatureFlags().autoscale) {
		return json({ error: 'Autoscale feature is disabled' }, { status: 403 });
	}
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const defaults = getAutoScaleDefaults();
	const minSlots = typeof body.minSlots === 'number' ? Math.max(1, Math.min(50, body.minSlots)) : defaults.minSlots;
	const maxSlots = typeof body.maxSlots === 'number' ? Math.max(1, Math.min(50, body.maxSlots)) : defaults.maxSlots;

	const settings: AutoScaleConfig = {
		minSlots: Math.min(minSlots, maxSlots),
		maxSlots: Math.max(minSlots, maxSlots),
		tasksPerSlot: typeof body.tasksPerSlot === 'number' ? Math.max(1, Math.min(10, body.tasksPerSlot)) : defaults.tasksPerSlot,
		idleCooldownMs: typeof body.idleCooldownMs === 'number' ? Math.max(30000, Math.min(3600000, body.idleCooldownMs)) : defaults.idleCooldownMs
	};

	await mkdir(dirname(AUTOSCALE_FILE), { recursive: true });
	await writeFile(AUTOSCALE_FILE, JSON.stringify(settings, null, '\t'), 'utf-8');
	return json({ ok: true });
};
