import { json } from '@sveltejs/kit';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { SERVICES, PATHS } from '$lib/server/constants.js';
import type { Service } from '$lib/types/services.js';
import type { RequestHandler } from './$types.js';

const execAsync = promisify(exec);

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

async function getRamByPid(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execAsync(
			`tasklist 2>nul | findstr "${pid}"`,
			{ timeout: 5000, windowsHide: true }
		);
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

		let pid: number | null = null;
		try {
			const pidRaw = await readFile(PATHS.daemonState.replace('daemon-state.json', 'daemon.pid'), 'utf-8');
			pid = parseInt(pidRaw.trim(), 10);
			if (isNaN(pid)) pid = null;
		} catch { /* no pid file */ }

		// Verify PID is alive
		// On Windows/MINGW, process.kill(pid, 0) is unreliable — use tasklist instead
		if (pid) {
			let alive = false;
			if (process.platform === 'win32') {
				try {
					const { stdout } = await execAsync(
						`tasklist /FI "PID eq ${pid}" /NH`,
						{ timeout: 3000, windowsHide: true }
					);
					alive = stdout.includes(String(pid));
				} catch { /* tasklist failed */ }
			} else {
				try {
					process.kill(pid, 0);
					alive = true;
				} catch { /* signal failed — process not running */ }
			}
			if (!alive) {
				return { ...base, status: 'errored', pid, errorMessage: 'Daemon PID not found — may have crashed' };
			}
		}

		const startedAt = state.startedAt ? new Date(state.startedAt) : null;
		const uptime = startedAt ? formatUptime(Date.now() - startedAt.getTime()) : null;
		const workers = state.workers ? Object.entries(state.workers) : [];
		const activeWorkers = workers.filter(([, w]: [string, any]) => w.runCount > 0).length;
		const totalRuns = workers.reduce((s: number, [, w]: [string, any]) => s + (w.runCount ?? 0), 0);
		const ram = pid ? await getRamByPid(pid) : null;

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

async function checkHealth(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

interface PortProcMap {
	[port: number]: { pid: number; ram: string | null };
}

/** Single netstat + tasklist call for all ports at once */
async function getPortProcMap(ports: number[]): Promise<PortProcMap> {
	const map: PortProcMap = {};
	try {
		const { stdout } = await execAsync('netstat -ano | findstr LISTENING', {
			timeout: 3000,
			windowsHide: true
		});
		const pids = new Set<number>();
		for (const line of stdout.split('\n')) {
			for (const port of ports) {
				if (line.includes(`:${port} `) || line.includes(`:${port}\t`)) {
					const parts = line.trim().split(/\s+/);
					const pid = parseInt(parts[parts.length - 1], 10);
					if (!isNaN(pid) && pid > 0) {
						map[port] = { pid, ram: null };
						pids.add(pid);
					}
				}
			}
		}

		// Batch RAM lookup for all found PIDs
		if (pids.size > 0) {
			try {
				const pidArr = [...pids];
				const filters = pidArr.map((p) => `/FI "PID eq ${p}"`).join(' ');
				const { stdout: tasklist } = await execAsync(
					`tasklist ${filters} /FO CSV /NH`,
					{ timeout: 3000, windowsHide: true }
				);
				const ramByPid = new Map<number, string>();
				for (const line of tasklist.split('\n')) {
					const fields = line.trim().split('","');
					if (fields.length >= 5) {
						const pid = parseInt(fields[1]?.replace(/"/g, ''), 10);
						const ram = fields[4]?.replace(/"/g, '').trim();
						if (!isNaN(pid) && ram) ramByPid.set(pid, ram);
					}
				}
				for (const port of ports) {
					if (map[port] && ramByPid.has(map[port].pid)) {
						map[port].ram = ramByPid.get(map[port].pid)!;
					}
				}
			} catch {
				// tasklist failed, PIDs still available without RAM
			}
		}
	} catch {
		// netstat failed entirely
	}
	return map;
}

async function detectServices(): Promise<Service[]> {
	const defs = Object.values(SERVICES);

	// Run all health checks in parallel
	const healthResults = await Promise.all(
		defs.map((def) =>
			def.healthUrl ? checkHealth(def.healthUrl) : Promise.resolve(false)
		)
	);

	// Single batch proc lookup for all ports
	const ports = defs.map((d) => d.port).filter((p): p is number => p !== null);
	const procMap = await getPortProcMap(ports);

	const results: Service[] = [];
	for (let i = 0; i < defs.length; i++) {
		const def = defs[i];

		// Special handling for claude-flow daemon (no HTTP port)
		if (def.id === 'claude-flow') {
			results.push(await detectDaemon());
			continue;
		}

		const online = healthResults[i];
		const proc = def.port ? procMap[def.port] : undefined;

		const base: Service = {
			id: def.id,
			name: def.name,
			type: def.type,
			configPath: def.configPath,
			pid: proc?.pid ?? null,
			port: def.port,
			secondaryPort: null,
			status: 'stopped',
			uptime: null,
			ram: proc?.ram ?? null,
			cpu: null,
			errorMessage: null
		};

		if (online) results.push({ ...base, status: 'running' as const });
		else if (proc) results.push({ ...base, status: 'errored' as const, errorMessage: 'Process listening but health check failed' });
		else results.push(base);
	}
	return results;
}

interface CustomServiceEntry {
	id: string;
	name: string;
	type: string;
	command: string;
	port: number | null;
	workingDir: string;
	configDir: string;
	autoStart: boolean;
	healthMonitoring: boolean;
	createdAt: string;
}

async function readCustomServices(): Promise<CustomServiceEntry[]> {
	try {
		const raw = await readFile(PATHS.customServices, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

async function writeCustomServices(entries: CustomServiceEntry[]): Promise<void> {
	await mkdir(dirname(PATHS.customServices), { recursive: true });
	await writeFile(PATHS.customServices, JSON.stringify(entries, null, 2), 'utf-8');
}

export async function GET() {
	const services = await detectServices();

	// Also include custom (user-created) services
	const custom = await readCustomServices();
	for (const entry of custom) {
		const existing = services.find((s) => s.id === entry.id);
		if (!existing) {
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

	return json({ services, timestamp: new Date().toISOString() });
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	const services: Array<{
		name: string;
		type: string;
		command: string;
		port: number | null;
		workingDir: string;
	}> = body.services;

	if (!Array.isArray(services) || services.length === 0) {
		return json({ error: 'No services provided' }, { status: 400 });
	}

	const existing = await readCustomServices();
	const created: CustomServiceEntry[] = [];

	for (const svc of services) {
		if (!svc.name?.trim()) continue;
		const id = svc.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
		if (existing.some((e) => e.id === id)) continue;

		const entry: CustomServiceEntry = {
			id,
			name: svc.name.trim(),
			type: svc.type || 'Background Service',
			command: svc.command || '',
			port: svc.port ?? null,
			workingDir: svc.workingDir || './',
			configDir: body.configDir || '.openclaw/services/',
			autoStart: body.autoStart ?? false,
			healthMonitoring: body.healthMonitoring ?? false,
			createdAt: new Date().toISOString()
		};
		existing.push(entry);
		created.push(entry);
	}

	await writeCustomServices(existing);

	return json({
		created: created.map((c) => c.id),
		total: existing.length
	}, { status: 201 });
};
