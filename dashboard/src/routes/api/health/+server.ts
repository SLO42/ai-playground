import { json } from '@sveltejs/kit';
import { readFile } from 'fs/promises';
import { isOllamaOnline } from '$lib/server/ollama-client.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import type { DaemonState } from '$lib/types/daemon.js';

async function checkHealth(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

export async function GET() {
	const [ollamaOnline, gatewayOnline, daemonState] = await Promise.all([
		isOllamaOnline(),
		checkHealth(SERVICES.openclaw.healthUrl!),
		readJsonFile<DaemonState>(PATHS.daemonState)
	]);

	// Daemon detection: check state file + PID liveness (no HTTP port)
	let daemonOnline = daemonState?.running ?? false;
	if (daemonOnline) {
		try {
			const pidRaw = await readFile(PATHS.daemonState.replace('daemon-state.json', 'daemon.pid'), 'utf-8');
			const pid = parseInt(pidRaw.trim(), 10);
			if (!isNaN(pid) && pid > 0) {
				try { process.kill(pid, 0); } catch { daemonOnline = false; }
			}
		} catch { /* no pid file, trust state */ }
	}

	return json({
		ollama: ollamaOnline,
		gateway: gatewayOnline,
		daemon: daemonOnline,
		daemonWorkers: daemonState
			? Object.values(daemonState.workers).filter((w) => w.runCount > 0).length
			: 0,
		timestamp: new Date().toLocaleTimeString()
	});
}
