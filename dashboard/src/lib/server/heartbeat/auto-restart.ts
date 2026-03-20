/**
 * Auto-restart — detects offline services and attempts to restart them.
 * Integrated into the heartbeat cycle after health checks.
 */
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { PATHS } from '../constants.js';
import { registerPid, unregisterPid } from './pid-registry.js';
import { recordEvent } from './agent-analytics.js';
import { emit } from '../event-bus.js';

// ── Types ────────────────────────────────────────────────────────────

export interface RestartConfig {
	enabled: boolean;
	maxAttempts: number;
	cooldownMs: number;
	services: string[];
}

export interface ServiceRestartState {
	serviceName: string;
	attempts: number;
	lastAttempt: string | null;
	lastSuccess: string | null;
	status: 'healthy' | 'restarting' | 'failed' | 'cooldown';
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RestartConfig = {
	enabled: false,
	maxAttempts: 3,
	cooldownMs: 30_000,
	services: ['ollama', 'gateway', 'daemon']
};

// ── Restart commands ─────────────────────────────────────────────────

const RESTART_COMMANDS: Record<string, { cmd: string; args: string[]; shell: boolean }> = {
	ollama: {
		cmd: 'ollama',
		args: ['serve'],
		shell: true
	},
	gateway: {
		cmd: 'npm',
		args: ['run', 'openclaw:start'],
		shell: true
	},
	daemon: {
		cmd: 'bash',
		args: [resolve(PATHS.root, 'scripts/daemon-ctl.sh'), 'start'],
		shell: true
	}
};

// ── In-memory state (survives HMR via globalThis) ────────────────────

const g = globalThis as Record<string, unknown>;

function getStateMap(): Map<string, ServiceRestartState> {
	if (!g.__claw_restart_state) {
		g.__claw_restart_state = new Map<string, ServiceRestartState>();
	}
	return g.__claw_restart_state as Map<string, ServiceRestartState>;
}

function ensureState(serviceName: string): ServiceRestartState {
	const map = getStateMap();
	if (!map.has(serviceName)) {
		map.set(serviceName, {
			serviceName,
			attempts: 0,
			lastAttempt: null,
			lastSuccess: null,
			status: 'healthy'
		});
	}
	return map.get(serviceName)!;
}

// ── Public API ───────────────────────────────────────────────────────

/** Load restart config from .playground/config.json (field: autoRestart). */
export function loadRestartConfig(): RestartConfig {
	try {
		// Synchronous-safe: we cache after first async read in heartbeat,
		// but for simplicity we read inline. The heartbeat already loaded this file.
		// We use a sync fallback via the cached global.
		const cached = g.__claw_restart_config as RestartConfig | undefined;
		if (cached) return cached;
		return { ...DEFAULT_CONFIG };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Async version — reads from disk, caches in globalThis. */
export async function loadRestartConfigAsync(): Promise<RestartConfig> {
	try {
		const raw = await readFile(PATHS.playgroundConfig, 'utf-8');
		const parsed = JSON.parse(raw);
		const ar = parsed.autoRestart;
		if (!ar || typeof ar !== 'object') {
			g.__claw_restart_config = { ...DEFAULT_CONFIG };
			return { ...DEFAULT_CONFIG };
		}
		const config: RestartConfig = {
			enabled: ar.enabled === true,
			maxAttempts: typeof ar.maxAttempts === 'number' ? ar.maxAttempts : DEFAULT_CONFIG.maxAttempts,
			cooldownMs: typeof ar.cooldownMs === 'number' ? ar.cooldownMs : DEFAULT_CONFIG.cooldownMs,
			services: Array.isArray(ar.services) ? ar.services : DEFAULT_CONFIG.services
		};
		g.__claw_restart_config = config;
		return config;
	} catch {
		g.__claw_restart_config = { ...DEFAULT_CONFIG };
		return { ...DEFAULT_CONFIG };
	}
}

/** Get current restart state for all tracked services. */
export function getRestartState(): Map<string, ServiceRestartState> {
	return getStateMap();
}

/** Check whether we should attempt a restart for the given service. */
export function shouldRestart(serviceName: string, config?: RestartConfig): boolean {
	const cfg = config ?? loadRestartConfig();
	if (!cfg.enabled) return false;
	if (!cfg.services.includes(serviceName)) return false;

	const state = ensureState(serviceName);

	// Already hit max attempts — don't retry until manually reset or service comes back
	if (state.attempts >= cfg.maxAttempts) {
		state.status = 'failed';
		return false;
	}

	// Cooldown: don't restart too frequently
	if (state.lastAttempt) {
		const elapsed = Date.now() - new Date(state.lastAttempt).getTime();
		if (elapsed < cfg.cooldownMs) {
			state.status = 'cooldown';
			return false;
		}
	}

	return true;
}

/**
 * Attempt to restart a service. Spawns the process detached (fire-and-forget).
 * Returns true if the spawn was initiated, false if no command is configured.
 */
export async function attemptRestart(serviceName: string): Promise<boolean> {
	const entry = RESTART_COMMANDS[serviceName];
	if (!entry) return false;

	const state = ensureState(serviceName);
	state.status = 'restarting';
	state.attempts++;
	state.lastAttempt = new Date().toISOString();

	const reason = state.attempts === 1 ? 'service_offline' : 'retry_after_failure';
	const attempt = state.attempts;

	recordEvent({ type: 'auto_restart_triggered', serviceName, reason, attempt }).catch(() => {});

	emit({ channel: 'services', type: 'restarting', data: { name: serviceName }, timestamp: new Date().toISOString() });

	const restartStartMs = Date.now();

	try {
		const child = spawn(entry.cmd, entry.args, {
			detached: true,
			stdio: 'ignore',
			shell: entry.shell,
			windowsHide: true,
			cwd: PATHS.root
		});
		child.unref();

		// Track the spawned PID in the registry
		if (child.pid) {
			registerPid(child.pid, `restart:${serviceName}`, 'service').catch(() => {});
		}

		const durationMs = Date.now() - restartStartMs;
		recordEvent({ type: 'auto_restart_result', serviceName, success: true, durationMs }).catch(() => {});

		emit({ channel: 'services', type: 'restarted', data: { name: serviceName, success: true }, timestamp: new Date().toISOString() });

		// Schedule a post-restart health check
		setTimeout(async () => {
			try {
				const svc = (await import('../constants.js')).SERVICES[serviceName];
				if (svc?.healthUrl) {
					const res = await fetch(svc.healthUrl, { signal: AbortSignal.timeout(5000) });
					if (res.ok) {
						resetRestartCount(serviceName);
					}
				}
			} catch {
				// Health check failed — service may still be starting
			} finally {
				if (child.pid) {
					unregisterPid(`restart:${serviceName}`).catch(() => {});
				}
			}
		}, 10_000);

		return true;
	} catch {
		const durationMs = Date.now() - restartStartMs;
		recordEvent({ type: 'auto_restart_result', serviceName, success: false, durationMs }).catch(() => {});
		emit({ channel: 'services', type: 'restarted', data: { name: serviceName, success: false }, timestamp: new Date().toISOString() });
		return false;
	}
}

/** Called when a service comes back online — resets its attempt counter. */
export function resetRestartCount(serviceName: string): void {
	const state = ensureState(serviceName);
	state.attempts = 0;
	state.lastSuccess = new Date().toISOString();
	state.status = 'healthy';
}

/** Get the restart command map (for UI display / diagnostics). */
export function getRestartCommands(): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, entry] of Object.entries(RESTART_COMMANDS)) {
		result[name] = `${entry.cmd} ${entry.args.join(' ')}`;
	}
	return result;
}
