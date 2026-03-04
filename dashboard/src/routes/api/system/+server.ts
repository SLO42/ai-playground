import { json } from '@sveltejs/kit';
import { isOllamaOnline } from '$lib/server/ollama-client.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { AuditStatus } from '$lib/types/security.js';
import type { SwarmActivity } from '$lib/types/metrics.js';

export async function GET() {
	const [ollama, audit, swarm] = await Promise.all([
		isOllamaOnline(),
		readJsonFile<AuditStatus>(PATHS.auditStatus),
		readJsonFile<SwarmActivity>(PATHS.swarmActivity)
	]);
	return json({
		ollama,
		gateway: false,
		swarm: swarm?.swarm?.active ?? false,
		security: audit?.status === 'CLEAN',
		timestamp: new Date().toISOString()
	});
}
