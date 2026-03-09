/**
 * Service auto-start — starts services by name and polls for health.
 * Used during project creation to bring up selected services.
 */
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { PATHS, SERVICES } from './constants.js';

export interface ServiceStartResult {
	service: string;
	started: boolean;
	healthy: boolean;
	error: string | null;
	pid: number | null;
}

/** Map UI display names to internal service IDs */
const NAME_TO_ID: Record<string, string> = {
	'Claude Flow Daemon': 'daemon',
	'Dev Server (Vite)': 'dev-server',
	'Ollama Server': 'ollama',
	'MCP Servers': 'mcp',
	'OpenClaw Gateway': 'gateway',
	daemon: 'daemon',
	'dev-server': 'dev-server',
	ollama: 'ollama',
	gateway: 'gateway',
	mcp: 'mcp'
};

/** Start commands keyed by internal service ID */
const START_COMMANDS: Record<string, { cmd: string; args: string[]; cwd?: string }> = {
	ollama: { cmd: 'ollama', args: ['serve'] },
	daemon: { cmd: 'bash', args: [resolve(PATHS.root, 'scripts/daemon-ctl.sh'), 'start'] },
	gateway: { cmd: 'npm', args: ['run', 'openclaw:start'] }
};

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function checkHttpHealth(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

async function checkPidFile(): Promise<boolean> {
	try {
		const statePath = PATHS.daemonState;
		const raw = await readFile(statePath, 'utf-8');
		const data = JSON.parse(raw);
		if (!data.pid) return false;
		// On Windows, use tasklist to verify PID
		if (process.platform === 'win32') {
			const { execFile } = await import('child_process');
			const { promisify } = await import('util');
			const execFileAsync = promisify(execFile);
			try {
				const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${data.pid}`]);
				return stdout.includes(String(data.pid));
			} catch {
				return false;
			}
		}
		// On Unix, signal 0 checks existence
		try {
			process.kill(data.pid, 0);
			return true;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

async function checkServiceHealth(serviceId: string): Promise<boolean> {
	switch (serviceId) {
		case 'ollama': {
			const def = SERVICES['ollama'];
			return def?.healthUrl ? checkHttpHealth(def.healthUrl) : false;
		}
		case 'gateway': {
			const def = SERVICES['openclaw'];
			return def?.healthUrl ? checkHttpHealth(def.healthUrl) : false;
		}
		case 'daemon':
			return checkPidFile();
		case 'dev-server':
			// Dev server health depends on the project; check common port
			return checkHttpHealth('http://127.0.0.1:5173/');
		default:
			return false;
	}
}

/** Poll for service health with retries (default 3, 2s delay between). */
export async function healthCheck(serviceName: string, retries = 3): Promise<boolean> {
	const id = NAME_TO_ID[serviceName] ?? serviceName;
	for (let i = 0; i < retries; i++) {
		if (await checkServiceHealth(id)) return true;
		if (i < retries - 1) await delay(2000);
	}
	return false;
}

/** Start a single service by name. Spawns detached, then polls health. */
export async function startService(
	serviceName: string,
	projectPath?: string
): Promise<ServiceStartResult> {
	const id = NAME_TO_ID[serviceName] ?? serviceName;
	const result: ServiceStartResult = {
		service: serviceName,
		started: false,
		healthy: false,
		error: null,
		pid: null
	};

	// Build the command for this service
	let entry = START_COMMANDS[id];

	if (id === 'dev-server' && projectPath) {
		// Read devCommand from project config, fallback to npm run dev
		let devCmd = 'npm run dev';
		try {
			const cfgRaw = await readFile(resolve(projectPath, '.playground/config.json'), 'utf-8');
			const cfg = JSON.parse(cfgRaw);
			if (cfg.devCommand) devCmd = cfg.devCommand;
		} catch {
			// fallback is fine
		}
		const parts = devCmd.split(' ');
		entry = { cmd: parts[0], args: parts.slice(1), cwd: projectPath };
	}

	if (!entry) {
		result.error = `No start command configured for service: ${serviceName}`;
		return result;
	}

	try {
		const child = spawn(entry.cmd, entry.args, {
			detached: true,
			stdio: 'ignore',
			shell: true,
			windowsHide: true,
			cwd: entry.cwd ?? PATHS.root
		});
		child.unref();
		result.started = true;
		result.pid = child.pid ?? null;
	} catch (e: unknown) {
		const err = e as { message?: string };
		result.error = err.message ?? 'Failed to spawn process';
		return result;
	}

	// Brief delay then health check
	await delay(1500);
	result.healthy = await healthCheck(id, 3);
	return result;
}

/** Start all services from a project's .playground/config.json services array. */
export async function startProjectServices(
	projectPath: string
): Promise<ServiceStartResult[]> {
	let serviceNames: string[] = [];

	try {
		const raw = await readFile(resolve(projectPath, '.playground/config.json'), 'utf-8');
		const config = JSON.parse(raw);
		if (Array.isArray(config.services)) {
			serviceNames = config.services
				.map((s: { name?: string }) => s.name)
				.filter((n: unknown): n is string => typeof n === 'string');
		}
	} catch {
		return [];
	}

	if (serviceNames.length === 0) return [];

	// Start services sequentially to avoid port conflicts
	const results: ServiceStartResult[] = [];
	for (const name of serviceNames) {
		const r = await startService(name, projectPath);
		results.push(r);
	}

	return results;
}
