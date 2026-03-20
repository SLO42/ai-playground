import { error } from '@sveltejs/kit';
import { SERVICES, PATHS } from '$lib/server/constants.js';
import type { PageServerLoad } from './$types.js';
import type { Service } from '$lib/types/services.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

async function checkHealth(url: string, timeoutMs = 3000): Promise<{ ok: boolean; latencyMs: number }> {
	const start = Date.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return { ok: res.ok || res.status < 500, latencyMs: Date.now() - start };
	} catch {
		return { ok: false, latencyMs: Date.now() - start };
	}
}

async function getPidInfo(port: number): Promise<{ pid: number | null; ram: string | null }> {
	try {
		const { stdout } = await execAsync(
			`netstat -ano | findstr :${port} | findstr LISTENING`,
			{ timeout: 5000, windowsHide: true }
		);
		const lines = stdout.trim().split('\n');
		if (lines.length === 0) return { pid: null, ram: null };
		const parts = lines[0].trim().split(/\s+/);
		const pid = parseInt(parts[parts.length - 1], 10);
		if (isNaN(pid) || pid === 0) return { pid: null, ram: null };

		let ram: string | null = null;
		try {
			const { stdout: tasklist } = await execAsync(
				`tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
				{ timeout: 5000, windowsHide: true }
			);
			const fields = tasklist.trim().split('\n')[0]?.split('","');
			ram = fields && fields.length >= 5 ? fields[4]?.replace(/"/g, '').trim() || null : null;
		} catch { /* ignore */ }

		return { pid, ram };
	} catch {
		return { pid: null, ram: null };
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const def = SERVICES[params.id as keyof typeof SERVICES];
	if (!def) throw error(404, 'Service not found');

	const health = def.healthUrl ? await checkHealth(def.healthUrl) : { ok: false, latencyMs: 0 };
	const proc = def.port ? await getPidInfo(def.port) : { pid: null, ram: null };

	// For claude-flow: check PID file + daemon state instead of port/health
	if (params.id === 'claude-flow') {
		const pidFile = join(PATHS.root, '.claude-flow', 'daemon.pid');
		const stateFile = join(PATHS.root, '.claude-flow', 'daemon-state.json');
		let daemonPid: number | null = null;
		let daemonRunning = false;

		if (existsSync(pidFile)) {
			const raw = readFileSync(pidFile, 'utf-8').trim();
			const parsed = parseInt(raw, 10);
			if (!isNaN(parsed) && parsed > 0) {
				daemonPid = parsed;
				// Verify process is alive via tasklist
				try {
					const { stdout } = await execAsync(
						`tasklist /FI "PID eq ${parsed}" /FO CSV /NH`,
						{ timeout: 5000, windowsHide: true }
					);
					daemonRunning = stdout.includes(String(parsed));
					if (daemonRunning) {
						const fields = stdout.trim().split('\n')[0]?.split('","');
						proc.ram = fields && fields.length >= 5 ? fields[4]?.replace(/"/g, '').trim() || null : null;
					}
				} catch { /* not running */ }
			}
		}

		// Also check daemon-state.json
		if (!daemonRunning && existsSync(stateFile)) {
			try {
				const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
				daemonRunning = state.running === true;
			} catch { /* ignore */ }
		}

		proc.pid = daemonPid;
		health.ok = daemonRunning;
	}

	let status: Service['status'] = 'stopped';
	let errorMessage: string | null = null;
	if (health.ok) {
		status = 'running';
	} else if (proc.pid) {
		status = 'errored';
		errorMessage = params.id === 'claude-flow'
			? 'Daemon PID not found — may have crashed'
			: 'Process listening but health check failed';
	}

	return {
		service: {
			id: def.id,
			name: def.name,
			type: def.type,
			configPath: def.configPath,
			port: def.port,
			healthUrl: def.healthUrl,
			pid: proc.pid,
			ram: proc.ram,
			status,
			errorMessage,
			latencyMs: health.latencyMs
		}
	};
};
