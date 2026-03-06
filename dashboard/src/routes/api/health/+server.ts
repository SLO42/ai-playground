import { json } from '@sveltejs/kit';
import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import type { DaemonState } from '$lib/types/daemon.js';

interface ServiceHealth {
	status: 'healthy' | 'degraded' | 'down';
	latencyMs: number | null;
	message?: string;
}

interface HealthResponse {
	status: 'healthy' | 'degraded' | 'down';
	version: string;
	uptime: number;
	timestamp: string;
	services: Record<string, ServiceHealth>;
	database: {
		status: 'healthy' | 'down';
		sizeBytes: number | null;
		path: string;
	};
	daemon: {
		online: boolean;
		activeWorkers: number;
		pid: number | null;
	};
	system: {
		memoryUsedMb: number;
		memoryTotalMb: number;
		cpuUsage: number;
	};
}

const startTime = Date.now();

async function probeService(url: string, timeoutMs = 2000): Promise<ServiceHealth> {
	const start = performance.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		const latencyMs = Math.round(performance.now() - start);
		if (res.ok) return { status: 'healthy', latencyMs };
		if (res.status < 500) return { status: 'degraded', latencyMs, message: `HTTP ${res.status}` };
		return { status: 'down', latencyMs, message: `HTTP ${res.status}` };
	} catch (err) {
		const latencyMs = Math.round(performance.now() - start);
		return { status: 'down', latencyMs, message: err instanceof Error ? err.message : 'Connection failed' };
	}
}

async function checkMemoryDb(): Promise<{ status: 'healthy' | 'down'; sizeBytes: number | null }> {
	const dbPath = resolve(PATHS.root, '.swarm/memory.db');
	try {
		const info = await stat(dbPath);
		return { status: 'healthy', sizeBytes: info.size };
	} catch {
		return { status: 'down', sizeBytes: null };
	}
}

async function getDaemonInfo(daemonState: DaemonState | null): Promise<{ online: boolean; activeWorkers: number; pid: number | null }> {
	let online = daemonState?.running ?? false;
	let pid: number | null = null;

	if (online) {
		try {
			const pidRaw = await readFile(PATHS.daemonState.replace('daemon-state.json', 'daemon.pid'), 'utf-8');
			pid = parseInt(pidRaw.trim(), 10);
			if (!isNaN(pid) && pid > 0) {
				try { process.kill(pid, 0); } catch { online = false; pid = null; }
			} else {
				pid = null;
			}
		} catch { /* no pid file, trust state */ }
	}

	const activeWorkers = daemonState
		? Object.values(daemonState.workers).filter((w) => w.runCount > 0).length
		: 0;

	return { online, activeWorkers, pid };
}

export async function GET() {
	const serviceEntries = Object.entries(SERVICES);

	const [daemonState, dbInfo, ...serviceResults] = await Promise.all([
		readJsonFile<DaemonState>(PATHS.daemonState),
		checkMemoryDb(),
		...serviceEntries.map(([, svc]) =>
			svc.healthUrl
				? probeService(svc.healthUrl)
				: Promise.resolve<ServiceHealth>({ status: 'down', latencyMs: null, message: 'No health URL configured' })
		)
	]);

	// Build services map (override daemon with PID-based check)
	const services: Record<string, ServiceHealth> = {};
	const daemonInfo = await getDaemonInfo(daemonState);

	for (let i = 0; i < serviceEntries.length; i++) {
		const [key, svc] = serviceEntries[i];
		if (key === 'claude-flow') {
			services[key] = {
				status: daemonInfo.online ? 'healthy' : 'down',
				latencyMs: null,
				...(daemonInfo.online ? {} : { message: 'Daemon process not running' })
			};
		} else {
			services[key] = serviceResults[i];
		}
	}

	// Compute overall status
	const statuses = Object.values(services).map(s => s.status);
	const overallStatus: 'healthy' | 'degraded' | 'down' =
		statuses.every(s => s === 'healthy') && dbInfo.status === 'healthy'
			? 'healthy'
			: statuses.every(s => s === 'down') && dbInfo.status === 'down'
				? 'down'
				: 'degraded';

	const mem = process.memoryUsage();
	const osMem = await import('os').then(os => ({ total: os.totalmem(), free: os.freemem() }));
	const cpuUsage = process.cpuUsage();
	const cpuPercent = process.uptime() > 0
		? Math.round(((cpuUsage.user + cpuUsage.system) / 1_000_000 / process.uptime()) * 100) / 100
		: 0;

	const response: HealthResponse = {
		status: overallStatus,
		version: '2026.3.x',
		uptime: Math.round((Date.now() - startTime) / 1000),
		timestamp: new Date().toISOString(),
		services,
		database: {
			status: dbInfo.status,
			sizeBytes: dbInfo.sizeBytes,
			path: '.swarm/memory.db'
		},
		daemon: {
			online: daemonInfo.online,
			activeWorkers: daemonInfo.activeWorkers,
			pid: daemonInfo.pid
		},
		system: {
			memoryUsedMb: Math.round(mem.rss / 1_048_576),
			memoryTotalMb: Math.round(osMem.total / 1_048_576),
			cpuUsage: cpuPercent
		}
	};

	const httpStatus = overallStatus === 'down' ? 503 : 200;
	return json(response, { status: httpStatus });
}
