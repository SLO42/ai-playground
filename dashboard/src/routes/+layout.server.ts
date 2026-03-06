import type { LayoutServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import type { DaemonState } from '$lib/types/daemon.js';
import { getFeatureFlags } from '$lib/server/feature-flags.js';
import { readFile } from 'fs/promises';

async function probeHealth(url: string, timeoutMs = 1500): Promise<{ up: boolean; latencyMs: number }> {
	const start = performance.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return { up: res.ok || res.status < 500, latencyMs: Math.round(performance.now() - start) };
	} catch {
		return { up: false, latencyMs: Math.round(performance.now() - start) };
	}
}

export const load: LayoutServerLoad = async () => {
	const [ollamaProbe, gatewayProbe, daemonState] = await Promise.all([
		probeHealth(SERVICES.ollama.healthUrl!),
		probeHealth(SERVICES.openclaw.healthUrl!),
		readJsonFile<DaemonState>(PATHS.daemonState)
	]);

	let daemonOnline = daemonState?.running ?? false;
	let daemonPid: number | null = null;
	if (daemonOnline) {
		try {
			const pidRaw = await readFile(PATHS.daemonState.replace('daemon-state.json', 'daemon.pid'), 'utf-8');
			daemonPid = parseInt(pidRaw.trim(), 10);
			if (!isNaN(daemonPid) && daemonPid > 0) {
				try { process.kill(daemonPid, 0); } catch { daemonOnline = false; daemonPid = null; }
			} else { daemonPid = null; }
		} catch { /* no pid file, trust state */ }
	}

	const activeWorkers = daemonState
		? Object.values(daemonState.workers).filter((w) => w.runCount > 0).length
		: 0;

	return {
		health: {
			status: (ollamaProbe.up && gatewayProbe.up && daemonOnline) ? 'healthy' : 'degraded' as const,
			timestamp: new Date().toISOString(),
			services: {
				ollama: { status: ollamaProbe.up ? 'healthy' as const : 'down' as const, latencyMs: ollamaProbe.latencyMs },
				openclaw: { status: gatewayProbe.up ? 'healthy' as const : 'down' as const, latencyMs: gatewayProbe.latencyMs },
				'claude-flow': { status: daemonOnline ? 'healthy' as const : 'down' as const, latencyMs: null }
			},
			daemon: {
				online: daemonOnline,
				activeWorkers,
				pid: daemonPid
			}
		},
		featureFlags: getFeatureFlags()
	};
};
