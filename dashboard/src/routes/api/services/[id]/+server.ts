import { json, error } from '@sveltejs/kit';
import { execSync, spawn } from 'child_process';
import { openSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SERVICES, PATHS } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';
import type { ServiceAction } from '$lib/types/services.js';

const LOGS_DIR = join(PATHS.root, '.claude-flow', 'logs');

function getLogFd(name: string): number {
	mkdirSync(LOGS_DIR, { recursive: true });
	return openSync(join(LOGS_DIR, `${name}.log`), 'a');
}

const ALLOWED_ACTIONS: ServiceAction[] = ['start', 'stop', 'restart'];

function killByPort(port: number): boolean {
	try {
		const netstat = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
			encoding: 'utf-8',
			timeout: 5000,
			windowsHide: true
		});
		const lines = netstat.trim().split('\n');
		for (const line of lines) {
			const parts = line.trim().split(/\s+/);
			const pid = parseInt(parts[parts.length - 1], 10);
			if (!isNaN(pid) && pid > 0) {
				execSync(`taskkill /PID ${pid} /F`, { timeout: 5000, windowsHide: true });
			}
		}
		return true;
	} catch {
		return false;
	}
}

function startService(id: string): { success: boolean; message: string } {
	try {
		switch (id) {
			case 'ollama': {
				spawn('ollama', ['serve'], {
					detached: true,
					stdio: 'ignore',
					shell: process.platform === 'win32',
					windowsHide: true
				}).unref();
				return { success: true, message: 'Ollama server starting...' };
			}
			case 'openclaw': {
				const fd = getLogFd('openclaw-gateway');
				const child = spawn('npx', ['openclaw', 'gateway', 'run', '--port', '18789', '--allow-unconfigured'], {
					detached: true,
					stdio: ['ignore', fd, fd],
					cwd: PATHS.root,
					shell: true,
					windowsHide: true
				});
				child.unref();
				return { success: true, message: 'OpenClaw gateway starting on :18789...' };
			}
			case 'claude-flow': {
				const child = spawn('bash', [join(PATHS.root, 'scripts', 'daemon-ctl.sh'), 'start'], {
					detached: true,
					stdio: 'ignore',
					cwd: PATHS.root,
					shell: process.platform === 'win32',
					windowsHide: true
				});
				child.unref();
				return { success: true, message: 'Claude Flow daemon starting...' };
			}
			default:
				return { success: false, message: `No start command configured for ${id}` };
		}
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : 'Start failed' };
	}
}

function stopService(id: string): { success: boolean; message: string } {
	const def = SERVICES[id];
	if (!def) return { success: false, message: `Unknown service: ${id}` };

	try {
		if (id === 'claude-flow') {
			execSync(`bash "${join(PATHS.root, 'scripts', 'daemon-ctl.sh')}" stop`, {
				cwd: PATHS.root,
				timeout: 15000,
				windowsHide: true
			});
			return { success: true, message: 'Claude Flow daemon stopped' };
		}

		if (!def.port) return { success: false, message: `No port configured for ${id}` };

		if (id === 'openclaw') {
			killByPort(def.port);
			return { success: true, message: 'OpenClaw gateway stopped' };
		}

		const killed = killByPort(def.port);
		if (killed) {
			return { success: true, message: `${def.name} stopped` };
		}
		return { success: false, message: `No process found on port ${def.port}` };
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : 'Stop failed' };
	}
}

export const POST: RequestHandler = async ({ params, request }) => {
	const id = params.id;
	if (!id || !(id in SERVICES)) {
		throw error(404, `Unknown service: ${id}`);
	}

	let body: { action?: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const action = body.action as ServiceAction;
	if (!action || !ALLOWED_ACTIONS.includes(action)) {
		throw error(400, `Invalid action. Allowed: ${ALLOWED_ACTIONS.join(', ')}`);
	}

	let result: { success: boolean; message: string };

	switch (action) {
		case 'start':
			result = startService(id);
			break;
		case 'stop':
			result = stopService(id);
			break;
		case 'restart':
			stopService(id);
			// Brief delay to let process release port
			await new Promise((r) => setTimeout(r, 1500));
			result = startService(id);
			if (result.success) {
				result.message = `${SERVICES[id].name} restarting...`;
			}
			break;
		default:
			result = { success: false, message: 'Unknown action' };
	}

	return json(result, { status: result.success ? 200 : 500 });
};
