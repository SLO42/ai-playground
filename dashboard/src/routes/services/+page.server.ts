import type { PageServerLoad } from './$types.js';
import type { Service } from '$lib/types/services.js';
import { SERVICES, PATHS } from '$lib/server/constants.js';
import { exec } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';

interface CustomServiceEntry {
	id: string;
	name: string;
	type: string;
	command: string;
	port: number | null;
	workingDir: string;
}

async function readCustomServices(): Promise<CustomServiceEntry[]> {
	try {
		const raw = await readFile(PATHS.customServices, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

const execAsync = promisify(exec);

async function checkHealth(url: string, timeoutMs = 3000): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

async function getPidByPort(port: number): Promise<number | null> {
	try {
		const { stdout } = await execAsync(
			`netstat -ano | findstr :${port} | findstr LISTENING`,
			{ timeout: 5000, windowsHide: true }
		);
		const lines = stdout.trim().split('\n');
		if (lines.length === 0) return null;
		const parts = lines[0].trim().split(/\s+/);
		const pid = parseInt(parts[parts.length - 1], 10);
		return isNaN(pid) || pid === 0 ? null : pid;
	} catch {
		return null;
	}
}

async function getRam(pid: number): Promise<string | null> {
	try {
		// Use tasklist piped through grep for MINGW64 compatibility
		const { stdout } = await execAsync(
			`tasklist 2>nul | findstr "${pid}"`,
			{ timeout: 5000, windowsHide: true }
		);
		// Output: "node.exe  37296 Console  1  83,268 K"
		const match = stdout.match(/(\d[\d,]+)\s*K/);
		if (match) {
			const kb = parseInt(match[1].replace(/,/g, ''), 10);
			return kb >= 1024 ? `${(kb / 1024).toFixed(0)} MB` : `${kb} KB`;
		}
		return null;
	} catch {
		return null;
	}
}

async function isPidAlive(pid: number): Promise<boolean> {
	try {
		// Use tasklist on Windows — process.kill(pid, 0) is unreliable on MINGW
		const { stdout } = await execAsync(
			`tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
			{ timeout: 5000, windowsHide: true }
		);
		return stdout.includes(String(pid));
	} catch {
		return false;
	}
}

async function detectDaemon(): Promise<Service> {
	const def = SERVICES['claude-flow'];
	const base: Service = {
		id: def.id,
		name: def.name,
		type: def.type,
		configPath: def.configPath,
		pid: null,
		port: null,
		secondaryPort: null,
		status: 'stopped',
		uptime: null,
		ram: null,
		cpu: null,
		errorMessage: null
	};

	try {
		const raw = await readFile(PATHS.daemonState, 'utf-8');
		const state = JSON.parse(raw);

		if (!state.running) return base;

		// Read PID from the pid file
		let pid: number | null = null;
		try {
			const pidRaw = await readFile(PATHS.daemonState.replace('daemon-state.json', 'daemon.pid'), 'utf-8');
			pid = parseInt(pidRaw.trim(), 10);
			if (isNaN(pid)) pid = null;
		} catch { /* no pid file */ }

		// Verify PID is alive
		if (pid && !(await isPidAlive(pid))) {
			return { ...base, status: 'errored', pid, errorMessage: 'Daemon PID not found — may have crashed' };
		}

		const startedAt = state.startedAt ? new Date(state.startedAt) : null;
		const uptime = startedAt ? formatUptime(Date.now() - startedAt.getTime()) : null;
		const workers = state.workers ? Object.entries(state.workers) : [];
		const activeWorkers = workers.filter(([, w]: [string, any]) => w.runCount > 0).length;
		const totalRuns = workers.reduce((s: number, [, w]: [string, any]) => s + (w.runCount ?? 0), 0);
		const ram = pid ? await getRam(pid) : null;

		return {
			...base,
			status: 'running',
			pid,
			ram,
			uptime,
			errorMessage: `${activeWorkers} workers active, ${totalRuns} total runs`
		};
	} catch {
		return base;
	}
}

function formatUptime(ms: number): string {
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

async function detectService(def: (typeof SERVICES)[keyof typeof SERVICES]): Promise<Service> {
	// Special handling for claude-flow daemon (no HTTP port)
	if (def.id === 'claude-flow') return detectDaemon();

	const base: Service = {
		id: def.id,
		name: def.name,
		type: def.type,
		configPath: def.configPath,
		pid: null,
		port: def.port,
		secondaryPort: null,
		status: 'stopped',
		uptime: null,
		ram: null,
		cpu: null,
		errorMessage: null
	};

	if (!def.healthUrl || !def.port) return base;

	const online = await checkHealth(def.healthUrl);
	const pid = await getPidByPort(def.port);

	if (online) {
		return { ...base, status: 'running', pid, ram: pid ? await getRam(pid) : null };
	}

	if (pid) {
		return {
			...base,
			status: 'errored',
			pid,
			ram: await getRam(pid),
			errorMessage: 'Process listening but health check failed'
		};
	}

	return base;
}

/** Overall timeout for the entire services detection pass */
const LOAD_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
	]);
}

export const load: PageServerLoad = async () => {
	const defs = Object.values(SERVICES);

	// Detect each service with an individual timeout so one hung service doesn't block others
	const services = await withTimeout(
		Promise.all(
			defs.map((def) =>
				withTimeout(detectService(def), LOAD_TIMEOUT_MS, {
					id: def.id,
					name: def.name,
					type: def.type,
					configPath: def.configPath,
					pid: null,
					port: def.port ?? null,
					secondaryPort: null,
					status: 'errored' as const,
					uptime: null,
					ram: null,
					cpu: null,
					errorMessage: 'Detection timed out'
				})
			)
		),
		LOAD_TIMEOUT_MS + 1_000, // outer timeout slightly longer than per-service
		defs.map((def) => ({
			id: def.id,
			name: def.name,
			type: def.type,
			configPath: def.configPath,
			pid: null,
			port: def.port ?? null,
			secondaryPort: null,
			status: 'errored' as const,
			uptime: null,
			ram: null,
			cpu: null,
			errorMessage: 'Page load timed out'
		}))
	);

	// Include user-created custom services
	const custom = await withTimeout(readCustomServices(), 3_000, []);
	for (const entry of custom) {
		if (!services.some((s) => s.id === entry.id)) {
			services.push({
				id: entry.id,
				name: entry.name,
				type: entry.type,
				configPath: entry.workingDir,
				pid: null,
				port: entry.port,
				secondaryPort: null,
				status: 'stopped',
				uptime: null,
				ram: null,
				cpu: null,
				errorMessage: null
			});
		}
	}

	const running = services.filter((s) => s.status === 'running').length;
	const stopped = services.filter((s) => s.status === 'stopped').length;
	const errored = services.filter((s) => s.status === 'errored').length;

	return {
		services,
		stats: { running, stopped, errored, total: services.length }
	};
};
