/**
 * Memory Guardian — monitors and enforces memory limits for spawned agents
 * and the heartbeat system itself.
 *
 * Prevents unbounded growth of:
 * - Agent process RSS (via tasklist/proc monitoring)
 * - Log files on disk (rotation after configurable age)
 * - Session message arrays (trim all sessions, not just monitor)
 * - Discussion entries (expire unanswered after TTL)
 * - In-memory data structures (project limits, analytics cache, etc.)
 *
 * When an agent approaches its memory limit, the guardian signals it to
 * wrap up gracefully before force-killing as a last resort.
 */
import { readFile, writeFile, readdir, stat, unlink } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '../constants.js';
import {
	getActiveAgents, getDiscussionMap, getProjectLimits,
	trimSession, log, CLAW_SENDER
} from './shared.js';
import { unregisterPid } from './pid-registry.js';
import { recordEvent } from './agent-analytics.js';
import type { ChatSession } from '$lib/types/chat.js';

// ── Configuration ────────────────────────────────────────────────────

export interface MemoryGuardianConfig {
	/** Max RSS in bytes for a single agent process (default: 1.5 GB) */
	agentMaxRssBytes: number;
	/** Soft limit — warn and signal graceful shutdown (default: 80% of max) */
	agentSoftLimitRatio: number;
	/** Max age in ms for log files before rotation/deletion (default: 7 days) */
	logMaxAgeMs: number;
	/** Max total size in bytes for all log files combined (default: 2 GB) */
	logMaxTotalBytes: number;
	/** Max messages per task/discussion session (default: 300) */
	sessionMaxMessages: number;
	/** Max age in ms for unanswered discussions before expiry (default: 24h) */
	discussionExpiryMs: number;
	/** Max entries in project limits cache before pruning (default: 200) */
	projectLimitsCacheMax: number;
	/** How often the full guardian cycle runs — in heartbeat ticks (default: 3) */
	runEveryNHeartbeats: number;
}

const DEFAULT_CONFIG: MemoryGuardianConfig = {
	agentMaxRssBytes: 1.5 * 1024 * 1024 * 1024,  // 1.5 GB
	agentSoftLimitRatio: 0.8,
	logMaxAgeMs: 7 * 24 * 60 * 60 * 1000,          // 7 days
	logMaxTotalBytes: 2 * 1024 * 1024 * 1024,       // 2 GB
	sessionMaxMessages: 300,
	discussionExpiryMs: 24 * 60 * 60 * 1000,        // 24 hours
	projectLimitsCacheMax: 200,
	runEveryNHeartbeats: 3
};

const g = globalThis as Record<string, unknown>;
let guardianTick = (g.__claw_guardian_tick as number) ?? 0;

// ── Public API ───────────────────────────────────────────────────────

export interface GuardianReport {
	agentsChecked: number;
	agentsWarned: number;
	agentsKilled: number;
	logsRotated: number;
	logBytesFreed: number;
	sessionsTrimmed: number;
	discussionsExpired: number;
	projectLimitsPruned: number;
}

/**
 * Run the full memory guardian cycle. Call from the heartbeat loop.
 * Returns a report of actions taken.
 */
export async function runMemoryGuardian(
	monitorSession: ChatSession,
	config: Partial<MemoryGuardianConfig> = {}
): Promise<GuardianReport | null> {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	guardianTick++;
	g.__claw_guardian_tick = guardianTick;

	// Only run full cycle every N heartbeats
	if (guardianTick % cfg.runEveryNHeartbeats !== 0) {
		return null;
	}

	const startTime = Date.now();
	recordEvent({ type: 'memory_consolidation_started' }).catch(() => {});

	const report: GuardianReport = {
		agentsChecked: 0,
		agentsWarned: 0,
		agentsKilled: 0,
		logsRotated: 0,
		logBytesFreed: 0,
		sessionsTrimmed: 0,
		discussionsExpired: 0,
		projectLimitsPruned: 0
	};

	// Run all checks concurrently where possible
	const [agentResult, logResult] = await Promise.all([
		checkAgentMemory(cfg).catch(() => ({ checked: 0, warned: 0, killed: 0 })),
		rotateLogFiles(cfg).catch(() => ({ rotated: 0, bytesFreed: 0 }))
	]);

	report.agentsChecked = agentResult.checked;
	report.agentsWarned = agentResult.warned;
	report.agentsKilled = agentResult.killed;
	report.logsRotated = logResult.rotated;
	report.logBytesFreed = logResult.bytesFreed;

	// These are fast in-memory operations, run sequentially
	report.sessionsTrimmed = await trimAllSessions(cfg).catch(() => 0);
	report.discussionsExpired = await expireStaleDiscussions(cfg).catch(() => 0);
	report.projectLimitsPruned = pruneProjectLimitsCache(cfg);

	// Record pruning analytics if anything was pruned/trimmed
	const prunedCount = report.sessionsTrimmed + report.logsRotated + report.discussionsExpired + report.projectLimitsPruned;
	if (prunedCount > 0) {
		recordEvent({ type: 'memory_entries_pruned', count: prunedCount }).catch(() => {});
	}

	// Log summary if anything happened
	const actions: string[] = [];
	if (report.agentsWarned > 0) actions.push(`${report.agentsWarned} agent(s) warned`);
	if (report.agentsKilled > 0) actions.push(`${report.agentsKilled} agent(s) killed`);
	if (report.logsRotated > 0) actions.push(`${report.logsRotated} log(s) rotated (${(report.logBytesFreed / 1024 / 1024).toFixed(1)} MB freed)`);
	if (report.sessionsTrimmed > 0) actions.push(`${report.sessionsTrimmed} session(s) trimmed`);
	if (report.discussionsExpired > 0) actions.push(`${report.discussionsExpired} discussion(s) expired`);
	if (report.projectLimitsPruned > 0) actions.push(`${report.projectLimitsPruned} stale cache entries pruned`);

	if (actions.length > 0) {
		log(monitorSession, `[guardian] Memory check: ${actions.join(', ')}`, CLAW_SENDER);
	}

	recordEvent({ type: 'memory_consolidation_completed', durationMs: Date.now() - startTime }).catch(() => {});

	return report;
}

// ── Agent process memory monitoring ──────────────────────────────────

interface AgentMemoryResult {
	checked: number;
	warned: number;
	killed: number;
}

async function checkAgentMemory(cfg: MemoryGuardianConfig): Promise<AgentMemoryResult> {
	const agents = getActiveAgents();
	if (agents.size === 0) return { checked: 0, warned: 0, killed: 0 };

	const result: AgentMemoryResult = { checked: 0, warned: 0, killed: 0 };
	const softLimit = cfg.agentMaxRssBytes * cfg.agentSoftLimitRatio;

	// Batch PID memory queries — one tasklist call for all PIDs
	const pids = [...agents.values()]
		.filter(a => a.pid > 0)
		.map(a => a.pid);

	if (pids.length === 0) return result;

	const memoryMap = await getProcessMemory(pids);
	result.checked = memoryMap.size;

	for (const [taskId, agent] of agents) {
		if (agent.pid <= 0) continue;
		const rss = memoryMap.get(agent.pid);
		if (rss === undefined) continue;

		if (rss >= cfg.agentMaxRssBytes) {
			// Hard limit exceeded — kill the process
			await killAgent(agent.pid, taskId, 'hard limit exceeded');
			result.killed++;
		} else if (rss >= softLimit) {
			// Soft limit — signal graceful wrap-up
			await signalGracefulShutdown(agent.pid, taskId);
			result.warned++;
		}
	}

	return result;
}

/**
 * Query RSS for multiple PIDs in a single system call.
 * Returns Map<pid, rssBytes>.
 */
async function getProcessMemory(pids: number[]): Promise<Map<number, number>> {
	const map = new Map<number, number>();
	if (pids.length === 0) return map;

	try {
		if (process.platform === 'win32') {
			// Windows: use tasklist with CSV output — one call for all PIDs
			const { execFile } = await import('child_process');
			const output = await new Promise<string>((resolve, reject) => {
				// tasklist /FO CSV shows all processes; we filter by PID set
				execFile('tasklist', ['/FO', 'CSV', '/NH'], {
					timeout: 10000,
					windowsHide: true,
					encoding: 'utf-8',
					maxBuffer: 10 * 1024 * 1024
				}, (err, stdout) => {
					if (err) reject(err);
					else resolve(stdout);
				});
			});

			const pidSet = new Set(pids);
			for (const line of output.split('\n')) {
				// CSV format: "process.exe","PID","Session Name","Session#","Mem Usage"
				const match = line.match(/"[^"]*","(\d+)","[^"]*","[^"]*","([\d,]+)\s*K"/);
				if (!match) continue;
				const pid = parseInt(match[1], 10);
				if (!pidSet.has(pid)) continue;
				// Memory reported in K — convert to bytes
				const kbStr = match[2].replace(/,/g, '');
				const kb = parseInt(kbStr, 10);
				if (!isNaN(kb)) {
					map.set(pid, kb * 1024);
				}
			}
		} else {
			// POSIX: read /proc/[pid]/status for VmRSS
			await Promise.all(pids.map(async (pid) => {
				try {
					const status = await readFile(`/proc/${pid}/status`, 'utf-8');
					const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
					if (match) {
						map.set(pid, parseInt(match[1], 10) * 1024);
					}
				} catch { /* process may have exited */ }
			}));
		}
	} catch { /* system call failed */ }

	return map;
}

/**
 * Signal an agent to wrap up gracefully. On Windows, we write a sentinel
 * file that the agent's stdin watcher can detect. On POSIX, send SIGTERM.
 */
async function signalGracefulShutdown(pid: number, taskId: string): Promise<void> {
	try {
		// Write a shutdown sentinel file the agent can check
		const sentinelPath = resolve(PATHS.headlessLogsDir, `shutdown-${taskId}.signal`);
		await writeFile(sentinelPath, JSON.stringify({
			reason: 'memory_limit_approaching',
			pid,
			taskId,
			timestamp: new Date().toISOString(),
			message: 'Please wrap up current work and exit cleanly.'
		}), 'utf-8');

		// On POSIX, also send SIGTERM for a cleaner signal
		if (process.platform !== 'win32') {
			try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
		}
	} catch { /* best effort */ }
}

/**
 * Force-kill an agent that exceeded its hard memory limit.
 */
async function killAgent(pid: number, taskId: string, reason: string): Promise<void> {
	try {
		if (process.platform === 'win32') {
			const { execFile } = await import('child_process');
			await new Promise<void>((resolve) => {
				execFile('taskkill', ['/F', '/PID', String(pid)], {
					timeout: 5000,
					windowsHide: true
				}, () => resolve());
			});
		} else {
			try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
		}

		// Clean up tracking state
		const agents = getActiveAgents();
		agents.delete(taskId);
		unregisterPid(`agent:${taskId}`).catch(() => {});

		// Leave a marker so the heartbeat knows this was a guardian kill
		const markerPath = resolve(PATHS.headlessLogsDir, `guardian-kill-${taskId}.json`);
		await writeFile(markerPath, JSON.stringify({
			reason,
			pid,
			taskId,
			timestamp: new Date().toISOString()
		}), 'utf-8');
	} catch { /* best effort */ }
}

// ── Log file rotation ────────────────────────────────────────────────

interface LogRotationResult {
	rotated: number;
	bytesFreed: number;
}

async function rotateLogFiles(cfg: MemoryGuardianConfig): Promise<LogRotationResult> {
	const result: LogRotationResult = { rotated: 0, bytesFreed: 0 };

	try {
		const logsDir = PATHS.headlessLogsDir;
		const files = await readdir(logsDir);
		const now = Date.now();

		// Gather file info
		interface LogInfo {
			name: string;
			path: string;
			size: number;
			mtimeMs: number;
		}
		const logFiles: LogInfo[] = [];
		let totalSize = 0;

		await Promise.all(files.map(async (file) => {
			if (!file.endsWith('.log') && !file.endsWith('.signal') && !file.startsWith('guardian-kill-')) return;
			try {
				const filePath = resolve(logsDir, file);
				const info = await stat(filePath);
				const entry = { name: file, path: filePath, size: info.size, mtimeMs: info.mtimeMs };
				logFiles.push(entry);
				if (file.endsWith('.log')) totalSize += info.size;
			} catch { /* skip */ }
		}));

		// Phase 1: Delete files older than maxAge
		for (const file of logFiles) {
			const age = now - file.mtimeMs;
			if (age > cfg.logMaxAgeMs) {
				try {
					await unlink(file.path);
					result.rotated++;
					result.bytesFreed += file.size;
					totalSize -= file.size;
				} catch { /* skip locked files */ }
			}
		}

		// Phase 2: If still over total size limit, delete oldest first
		if (totalSize > cfg.logMaxTotalBytes) {
			const remaining = logFiles
				.filter(f => f.name.endsWith('.log'))
				.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

			for (const file of remaining) {
				if (totalSize <= cfg.logMaxTotalBytes) break;
				try {
					await unlink(file.path);
					result.rotated++;
					result.bytesFreed += file.size;
					totalSize -= file.size;
				} catch { /* skip */ }
			}
		}

		// Phase 3: Clean up stale signal/kill marker files (> 1 hour old)
		const SIGNAL_MAX_AGE = 60 * 60 * 1000;
		for (const file of logFiles) {
			if (file.name.endsWith('.signal') || file.name.startsWith('guardian-kill-')) {
				if (now - file.mtimeMs > SIGNAL_MAX_AGE) {
					await unlink(file.path).catch(() => {});
				}
			}
		}
	} catch { /* logs dir may not exist */ }

	return result;
}

// ── Session message trimming ─────────────────────────────────────────

/**
 * Trim all task and discussion sessions to prevent unbounded message growth.
 * The monitor session is already trimmed by the heartbeat; this covers the rest.
 */
async function trimAllSessions(cfg: MemoryGuardianConfig): Promise<number> {
	let trimmed = 0;

	try {
		const chatsDir = PATHS.chatsDir;
		const files = await readdir(chatsDir);

		for (const file of files) {
			// Only process task-* and discuss-* sessions, skip monitor and index
			if (!file.startsWith('task-') && !file.startsWith('discuss-')) continue;
			if (!file.endsWith('.json')) continue;

			try {
				const filePath = resolve(chatsDir, file);
				const raw = await readFile(filePath, 'utf-8');
				const session: ChatSession = JSON.parse(raw);

				if (session.messages.length > cfg.sessionMaxMessages) {
					const before = session.messages.length;
					// Preserve system message + keep last N messages
					const system = session.messages[0];
					session.messages = [system, ...session.messages.slice(-(cfg.sessionMaxMessages - 1))];
					session.updatedAt = new Date().toISOString();
					await writeFile(filePath, JSON.stringify(session, null, '\t'), 'utf-8');
					trimmed++;
				}
			} catch { /* skip corrupt/locked files */ }
		}
	} catch { /* chats dir may not exist */ }

	return trimmed;
}

// ── Discussion expiry ────────────────────────────────────────────────

/**
 * Expire discussions that have been waiting for user response beyond the TTL.
 * Removes them from the discussion map so the task can be re-evaluated.
 */
async function expireStaleDiscussions(cfg: MemoryGuardianConfig): Promise<number> {
	const discussions = getDiscussionMap();
	if (discussions.size === 0) return 0;

	let expired = 0;
	const now = Date.now();

	for (const [taskId, sessionId] of discussions) {
		try {
			const filePath = `${PATHS.chatsDir}/${sessionId}.json`;
			const raw = await readFile(filePath, 'utf-8');
			const session: ChatSession = JSON.parse(raw);

			// Check if the session has been waiting too long
			const lastUpdate = new Date(session.updatedAt).getTime();
			const age = now - lastUpdate;

			if (age > cfg.discussionExpiryMs && session.status === 'waiting') {
				// Mark as expired and remove from active discussions
				session.status = 'idle';
				session.messages.push({
					role: 'assistant',
					content: `[guardian] Discussion expired after ${Math.round(age / 3600000)}h without response. Task will be re-evaluated on the next heartbeat cycle.`,
					sender: CLAW_SENDER
				});
				session.updatedAt = new Date().toISOString();
				await writeFile(filePath, JSON.stringify(session, null, '\t'), 'utf-8');

				discussions.delete(taskId);
				expired++;
			}
		} catch {
			// Session file missing — clean up the map entry
			discussions.delete(taskId);
			expired++;
		}
	}

	return expired;
}

// ── In-memory cache pruning ──────────────────────────────────────────

/**
 * Prune the project limits cache if it grows beyond the configured max.
 * Keeps the most recently used entries.
 */
function pruneProjectLimitsCache(cfg: MemoryGuardianConfig): number {
	const limits = getProjectLimits();
	if (limits.size <= cfg.projectLimitsCacheMax) return 0;

	// Map preserves insertion order — delete oldest entries
	const excess = limits.size - cfg.projectLimitsCacheMax;
	let pruned = 0;
	for (const key of limits.keys()) {
		if (pruned >= excess) break;
		limits.delete(key);
		pruned++;
	}

	return pruned;
}

// ── Config loading ───────────────────────────────────────────────────

/**
 * Load guardian config from .playground/guardian.json, falling back to defaults.
 */
export async function loadGuardianConfig(): Promise<MemoryGuardianConfig> {
	try {
		const configPath = resolve(PATHS.root, '.playground', 'guardian.json');
		const raw = await readFile(configPath, 'utf-8');
		const parsed = JSON.parse(raw);
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return DEFAULT_CONFIG;
	}
}
