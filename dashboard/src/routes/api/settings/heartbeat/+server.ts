import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
<<<<<<< HEAD
import {
	startHeartbeat, stopHeartbeat, isHeartbeatRunning,
	getHeartbeatConfig, updateHeartbeatConfig,
} from '$lib/server/heartbeat.js';
import type { HeartbeatConfig } from '$lib/server/heartbeat.js';

export const GET: RequestHandler = async () => {
	const config = getHeartbeatConfig();
	return json({ ...config, enabled: isHeartbeatRunning() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json() as Partial<HeartbeatConfig>;

	// Handle enabled/disabled toggle (start/stop the heartbeat timer)
	if (typeof body.enabled === 'boolean') {
		if (body.enabled) {
			startHeartbeat();
		} else {
			stopHeartbeat();
		}
	}

	// Persist any config changes (phases, intervals, enabled flag)
	const updated = await updateHeartbeatConfig(body);

	return json({ ...updated, enabled: isHeartbeatRunning() });
=======
import { readJsonFile, writeJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';

interface HeartbeatPhase {
	id: string;
	name: string;
	enabled: boolean;
	intervalSeconds: number;
}

interface HeartbeatConfig {
	enabled: boolean;
	phases: HeartbeatPhase[];
}

const VALID_PHASE_IDS = new Set([
	'health-checks',
	'task-scanning',
	'agent-spawning',
	'review-cycle',
	'memory-sync'
]);

export const GET: RequestHandler = async () => {
	const config = await readJsonFile<HeartbeatConfig>(PATHS.heartbeatConfig);
	return json(config ?? { enabled: true, phases: [] });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	if (typeof body.enabled !== 'boolean') {
		return json({ error: 'enabled must be a boolean' }, { status: 400 });
	}

	if (!Array.isArray(body.phases)) {
		return json({ error: 'phases must be an array' }, { status: 400 });
	}

	const phases: HeartbeatPhase[] = [];
	for (const phase of body.phases) {
		if (!VALID_PHASE_IDS.has(phase.id)) {
			return json({ error: `Invalid phase id: ${phase.id}` }, { status: 400 });
		}
		if (typeof phase.enabled !== 'boolean') {
			return json({ error: `Phase ${phase.id}: enabled must be a boolean` }, { status: 400 });
		}
		const interval = Number(phase.intervalSeconds);
		if (!Number.isFinite(interval) || interval < 5 || interval > 3600) {
			return json(
				{ error: `Phase ${phase.id}: intervalSeconds must be 5-3600` },
				{ status: 400 }
			);
		}
		phases.push({
			id: phase.id,
			name: String(phase.name),
			enabled: phase.enabled,
			intervalSeconds: interval
		});
	}

	const config: HeartbeatConfig = { enabled: body.enabled, phases };
	const ok = await writeJsonFile(PATHS.heartbeatConfig, config);

	if (!ok) {
		return json({ error: 'Failed to save heartbeat config' }, { status: 500 });
	}

	return json({ success: true, config });
>>>>>>> worktree-agent-a97739c0
};
