import { json } from '@sveltejs/kit';
import { isOllamaOnline } from '$lib/server/ollama-client.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import type { AuditStatus } from '$lib/types/security.js';
import type { SwarmActivity } from '$lib/types/metrics.js';

async function checkHealth(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

export async function GET() {
	const [ollama, gatewayOnline, audit, swarm] = await Promise.all([
		isOllamaOnline(),
		checkHealth(SERVICES.openclaw.healthUrl!),
		readJsonFile<AuditStatus>(PATHS.auditStatus),
		readJsonFile<SwarmActivity>(PATHS.swarmActivity)
	]);
	return json({
		ollama,
		gateway: gatewayOnline,
		swarm: swarm?.swarm?.active ?? false,
		security: audit?.status === 'CLEAN',
		timestamp: new Date().toISOString()
	});
}
