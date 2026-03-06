import { json } from '@sveltejs/kit';
import { getFeatureFlags } from '$lib/server/feature-flags.js';
import type { RequestHandler } from './$types.js';
import {
	loadMemorySettings,
	saveMemorySettings,
	MEMORY_DEFAULTS,
	type MemorySettings,
	type MemoryBackend
} from '$lib/server/memory-settings.js';

const VALID_BACKENDS: MemoryBackend[] = ['hybrid', 'sqlite', 'hnsw'];

export const GET: RequestHandler = async () => {
	if (!getFeatureFlags().memory) {
		return json({ error: 'Memory feature is disabled' }, { status: 403 });
	}
	const settings = await loadMemorySettings();
	return json(settings);
};

export const PUT: RequestHandler = async ({ request }) => {
	if (!getFeatureFlags().memory) {
		return json({ error: 'Memory feature is disabled' }, { status: 403 });
	}
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const backend = VALID_BACKENDS.includes(body.backend as MemoryBackend)
		? (body.backend as MemoryBackend)
		: MEMORY_DEFAULTS.backend;

	const rawCache = Number(body.cacheSize);
	const cacheSize = !isNaN(rawCache) && rawCache >= 10 && rawCache <= 10000
		? rawCache
		: MEMORY_DEFAULTS.cacheSize;

	const settings: MemorySettings = {
		backend,
		enableHNSW: typeof body.enableHNSW === 'boolean' ? body.enableHNSW : MEMORY_DEFAULTS.enableHNSW,
		cacheSize,
		persistPath: typeof body.persistPath === 'string' && body.persistPath ? body.persistPath : MEMORY_DEFAULTS.persistPath,
		learningBridgeEnabled: typeof body.learningBridgeEnabled === 'boolean' ? body.learningBridgeEnabled : MEMORY_DEFAULTS.learningBridgeEnabled,
		memoryGraphEnabled: typeof body.memoryGraphEnabled === 'boolean' ? body.memoryGraphEnabled : MEMORY_DEFAULTS.memoryGraphEnabled
	};

	await saveMemorySettings(settings);
	return json({ ok: true });
};
