import type { LayoutServerLoad } from './$types.js';
import { isOllamaOnline } from '$lib/server/ollama-client.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import type { DaemonState } from '$lib/types/daemon.js';
import { getFeatureFlags } from '$lib/server/feature-flags.js';

async function checkHealth(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

export const load: LayoutServerLoad = async () => {
	const [ollamaOnline, gatewayOnline, daemonOnline, daemonState] = await Promise.all([
		isOllamaOnline(),
		checkHealth(SERVICES.openclaw.healthUrl!),
		checkHealth(SERVICES['claude-flow'].healthUrl!),
		readJsonFile<DaemonState>(PATHS.daemonState)
	]);

	return {
		health: {
			ollama: ollamaOnline,
			gateway: gatewayOnline,
			daemon: daemonOnline || (daemonState?.running ?? false),
			daemonWorkers: daemonState
				? Object.values(daemonState.workers).filter((w) => w.runCount > 0).length
				: 0,
			timestamp: new Date().toLocaleTimeString()
		},
		featureFlags: getFeatureFlags()
	};
};
