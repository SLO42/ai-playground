/**
 * PID Registry — persistent tracking of all child processes spawned by the dashboard.
 *
 * Solves the orphaned-process problem: if the server crashes, HMR reloads, or
 * shutdown fails to kill everything, the registry file survives on disk.
 * On next startup, `reapStaleProcesses()` reads the file and kills anything
 * still running from the previous session.
 *
 * File: .playground/pid-registry.json
 * Format: { serverPid: number, startedAt: string, processes: Record<string, PidEntry> }
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { PATHS } from '../constants.js';

const REGISTRY_PATH = resolve(PATHS.root, '.playground/pid-registry.json');
const IS_WINDOWS = process.platform === 'win32';

export interface PidEntry {
	pid: number;
	label: string;          // human-readable: "agent:task-123", "mcp:claude-flow", etc.
	spawnedAt: string;
	category: 'agent' | 'mcp' | 'test' | 'service';
}

interface RegistryFile {
	serverPid: number;
	startedAt: string;
	processes: Record<string, PidEntry>;  // keyed by label for easy lookup
}

// In-memory mirror (always write-through to disk)
let registry: RegistryFile = {
	serverPid: process.pid,
	startedAt: new Date().toISOString(),
	processes: {}
};

async function loadRegistry(): Promise<RegistryFile> {
	try {
		const raw = await readFile(REGISTRY_PATH, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return {
			serverPid: process.pid,
			startedAt: new Date().toISOString(),
			processes: {}
		};
	}
}

async function saveRegistry(): Promise<void> {
	try {
		await mkdir(dirname(REGISTRY_PATH), { recursive: true });
		await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, '\t'), 'utf-8');
	} catch { /* best-effort — don't crash the heartbeat */ }
}

function isPidAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		if (IS_WINDOWS) {
			const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
				timeout: 3000, windowsHide: true, encoding: 'utf-8'
			});
			return out.includes(String(pid));
		}
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killPid(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		if (IS_WINDOWS) {
			// /T = kill child tree, /F = force
			execSync(`taskkill /F /T /PID ${pid}`, {
				timeout: 5000, windowsHide: true, stdio: 'ignore'
			});
		} else {
			process.kill(pid, 'SIGTERM');
			// Give 1s grace, then SIGKILL
			setTimeout(() => {
				try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
			}, 1000);
		}
		return true;
	} catch {
		return false; // already dead
	}
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Called once at heartbeat startup. Loads the previous registry from disk,
 * checks if the old server PID is dead (meaning it crashed), and kills
 * any orphaned child processes from the previous run.
 *
 * Returns a summary of what was cleaned up.
 */
export async function reapStaleProcesses(): Promise<{ reaped: string[]; alive: string[] }> {
	const previous = await loadRegistry();
	const reaped: string[] = [];
	const alive: string[] = [];

	// If the previous server is still running, this is a concurrent instance or HMR —
	// don't kill processes that may belong to the still-running server.
	if (previous.serverPid !== process.pid && isPidAlive(previous.serverPid)) {
		// Previous server still alive — skip reaping (likely HMR reload)
		// Just take over the registry
		registry = {
			serverPid: process.pid,
			startedAt: new Date().toISOString(),
			processes: previous.processes
		};
		await saveRegistry();
		return { reaped, alive: Object.keys(previous.processes) };
	}

	// Previous server is dead — any remaining children are orphans
	for (const [label, entry] of Object.entries(previous.processes)) {
		if (isPidAlive(entry.pid)) {
			if (killPid(entry.pid)) {
				reaped.push(`${label} (PID ${entry.pid})`);
			} else {
				alive.push(`${label} (PID ${entry.pid}) — kill failed`);
			}
		}
	}

	// Fresh registry for this server instance
	registry = {
		serverPid: process.pid,
		startedAt: new Date().toISOString(),
		processes: {}
	};
	await saveRegistry();

	return { reaped, alive };
}

/** Register a spawned child process. */
export async function registerPid(
	pid: number,
	label: string,
	category: PidEntry['category']
): Promise<void> {
	if (pid <= 0) return;
	registry.processes[label] = {
		pid,
		label,
		spawnedAt: new Date().toISOString(),
		category
	};
	await saveRegistry();
}

/** Unregister a process (it exited normally). */
export async function unregisterPid(label: string): Promise<void> {
	delete registry.processes[label];
	await saveRegistry();
}

/** Kill and unregister a specific process by label. */
export async function killAndUnregister(label: string): Promise<boolean> {
	const entry = registry.processes[label];
	if (!entry) return false;
	const killed = killPid(entry.pid);
	delete registry.processes[label];
	await saveRegistry();
	return killed;
}

/** Kill all registered processes (used by shutdown endpoint). */
export async function killAll(): Promise<{ killed: string[]; failed: string[] }> {
	const killed: string[] = [];
	const failed: string[] = [];

	for (const [label, entry] of Object.entries(registry.processes)) {
		if (isPidAlive(entry.pid)) {
			if (killPid(entry.pid)) {
				killed.push(label);
			} else {
				failed.push(label);
			}
		}
	}

	registry.processes = {};
	await saveRegistry();

	return { killed, failed };
}

/** Get all currently registered processes. */
export function getRegisteredProcesses(): Record<string, PidEntry> {
	return { ...registry.processes };
}
