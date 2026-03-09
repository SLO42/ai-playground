/**
 * Shared state, types, and helpers used across all heartbeat modules.
 * Uses globalThis to survive HMR module reloads in dev mode.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '../constants.js';
import { loadAgentDefaults } from '../agent-defaults.js';
import type { ChatSession, ChatSessionMeta, ChatSender } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

export const DEFAULT_INTERVAL_MS = 60_000;
export const MONITOR_SESSION_ID = 'claw-monitor';
export const DEFAULT_MAX_AGENTS = 5;

// Agent color palette — assigned round-robin to spawned agents
const AGENT_COLORS = ['#a78bfa', '#f97316', '#22d3ee', '#f472b6', '#84cc16', '#facc15', '#e879f7'];
const g = globalThis as Record<string, unknown>;
let agentColorIdx = (g.__claw_color_idx as number) ?? 0;

export const CLAW_SENDER: ChatSender = { id: 'claw', label: 'Claw', color: '#06b6d4' };

export function agentSender(taskId: string, label: string): ChatSender {
	const color = AGENT_COLORS[agentColorIdx % AGENT_COLORS.length];
	agentColorIdx++;
	g.__claw_color_idx = agentColorIdx;
	return { id: `agent-${taskId}`, label, color };
}

// ── Active agents ────────────────────────────────────────────────────

export interface ActiveAgent {
	taskId: string;
	pid: number;
	startedAt: string;
	sender: ChatSender;
	logFile: string;
	lastLogPos: number;
	reportSessionId: string;
	gitBaseline?: Set<string>;
}

export function getActiveAgents(): Map<string, ActiveAgent> {
	if (!g.__claw_active_agents) {
		g.__claw_active_agents = new Map();
	}
	return g.__claw_active_agents as Map<string, ActiveAgent>;
}

// ── Orphaned agent cleanup ───────────────────────────────────────────

/**
 * Check all active agents for PID liveness. Remove entries whose
 * processes are no longer running (orphaned by HMR, crash, etc.).
 * Returns the number of stale agents cleaned up.
 */
export async function reapOrphanedAgents(): Promise<number> {
	const agents = getActiveAgents();
	if (agents.size === 0) return 0;

	let reaped = 0;
	for (const [taskId, info] of agents) {
		if (info.pid === 0) continue; // OpenClaw agents have pid 0

		const alive = await isPidAlive(info.pid);
		if (!alive) {
			agents.delete(taskId);
			getProjectAgentMap().delete(taskId);
			reaped++;
		}
	}

	return reaped;
}

async function isPidAlive(pid: number): Promise<boolean> {
	if (pid <= 0) return false;
	try {
		if (process.platform === 'win32') {
			const { execFile } = await import('child_process');
			const out = await new Promise<string>((resolve, reject) => {
				execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
					timeout: 3000, windowsHide: true, encoding: 'utf-8'
				}, (err, stdout) => {
					if (err) reject(err);
					else resolve(stdout);
				});
			});
			return out.includes(String(pid));
		}
		// POSIX: signal 0 checks existence without killing
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ── Discussion map ───────────────────────────────────────────────────

export function getDiscussionMap(): Map<string, string> {
	if (!g.__claw_discussion_map) {
		g.__claw_discussion_map = new Map();
	}
	return g.__claw_discussion_map as Map<string, string>;
}

// ── Max agents ───────────────────────────────────────────────────────

let _maxConcurrentAgents = (g.__claw_max_agents as number) ?? DEFAULT_MAX_AGENTS;

export function getMaxConcurrentAgents(): number {
	return _maxConcurrentAgents;
}

export async function loadMaxAgents(): Promise<number> {
	try {
		const settings = await loadAgentDefaults();
		_maxConcurrentAgents = settings.maxConcurrentAgents ?? DEFAULT_MAX_AGENTS;
		g.__claw_max_agents = _maxConcurrentAgents;
	} catch { /* use last known value */ }
	return _maxConcurrentAgents;
}

// ── Per-project agent limits ─────────────────────────────────────────

const DEFAULT_PROJECT_MAX_AGENTS = 2;

/** Cache of per-project max agents, refreshed each heartbeat cycle. */
export function getProjectLimits(): Map<string, number> {
	if (!g.__claw_project_limits) {
		g.__claw_project_limits = new Map<string, number>();
	}
	return g.__claw_project_limits as Map<string, number>;
}

/** Load a project's maxAgents from its .playground/settings.json or config.json */
export async function loadProjectMaxAgents(projectPath: string, projectId: string): Promise<number> {
	const limits = getProjectLimits();
	// Try settings.json first (user-configured via UI), then config.json (auto-detected)
	for (const file of ['settings.json', 'config.json']) {
		try {
			const raw = await readFile(resolve(projectPath, '.playground', file), 'utf-8');
			const parsed = JSON.parse(raw);
			const max = parsed.agentConfig?.maxAgents ?? parsed.agents?.maxAgents;
			if (typeof max === 'number' && max > 0) {
				limits.set(projectId, max);
				return max;
			}
		} catch { /* try next */ }
	}
	limits.set(projectId, DEFAULT_PROJECT_MAX_AGENTS);
	return DEFAULT_PROJECT_MAX_AGENTS;
}

/** Count how many active agents belong to a given project. */
export function countProjectAgents(projectId: string): number {
	const agents = getActiveAgents();
	const projectAgentMap = getProjectAgentMap();
	let count = 0;
	for (const taskId of agents.keys()) {
		if (projectAgentMap.get(taskId) === projectId) count++;
	}
	return count;
}

/** Maps taskId → projectId for active agents. */
export function getProjectAgentMap(): Map<string, string> {
	if (!g.__claw_project_agent_map) {
		g.__claw_project_agent_map = new Map<string, string>();
	}
	return g.__claw_project_agent_map as Map<string, string>;
}

// ── Session helpers ──────────────────────────────────────────────────

export async function ensureChatsDir() {
	await mkdir(PATHS.chatsDir, { recursive: true });
}

export async function loadMonitorSession(): Promise<ChatSession> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/${MONITOR_SESSION_ID}.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		const now = new Date().toISOString();
		return {
			id: MONITOR_SESSION_ID,
			model: 'system',
			provider: 'internal',
			createdAt: now,
			updatedAt: now,
			messages: [{
				role: 'system',
				content: 'Claw System Monitor — logs heartbeat cycles, service checks, task scans, and agent spawns.'
			}],
			source: 'claw',
			status: 'idle'
		};
	}
}

export async function saveMonitorSession(session: ChatSession) {
	session.updatedAt = new Date().toISOString();
	await writeFile(
		`${PATHS.chatsDir}/${session.id}.json`,
		JSON.stringify(session, null, '\t'),
		'utf-8'
	);

	await upsertSessionMeta({
		id: session.id,
		title: 'Claw System Monitor',
		model: session.model,
		provider: session.provider,
		messageCount: session.messages.length,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		source: 'claw',
		status: session.status
	});
}

// Simple async lock to prevent concurrent index writes
let indexWriteLock: Promise<void> = Promise.resolve();

export async function readSessionIndex(): Promise<ChatSessionMeta[]> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/index.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

export async function upsertSessionMeta(meta: ChatSessionMeta): Promise<void> {
	const prev = indexWriteLock;
	let unlock: () => void;
	indexWriteLock = new Promise<void>((res) => { unlock = res; });
	await prev;
	try {
		const index = await readSessionIndex();
		const idx = index.findIndex((s) => s.id === meta.id);
		if (idx >= 0) {
			index[idx] = meta;
		} else {
			index.unshift(meta);
		}
		await writeFile(`${PATHS.chatsDir}/index.json`, JSON.stringify(index, null, '\t'), 'utf-8');
	} finally {
		unlock!();
	}
}

export function log(session: ChatSession, content: string, sender: ChatSender = CLAW_SENDER) {
	session.messages.push({ role: 'assistant', content, sender });
}

export function trimSession(session: ChatSession) {
	const MAX_MESSAGES = 200;
	if (session.messages.length > MAX_MESSAGES) {
		const system = session.messages[0];
		session.messages = [system, ...session.messages.slice(-MAX_MESSAGES + 1)];
	}
}

export function taskSessionId(taskId: string): string {
	return `task-${taskId}`;
}

export async function ensureTaskSession(task: Task, sender: ChatSender): Promise<string> {
	const sessionId = taskSessionId(task.id);
	const sessionPath = `${PATHS.chatsDir}/${sessionId}.json`;

	try {
		await readFile(sessionPath, 'utf-8');
		return sessionId;
	} catch { /* doesn't exist yet */ }

	const now = new Date().toISOString();
	const session: ChatSession = {
		id: sessionId,
		model: 'system',
		provider: 'internal',
		createdAt: now,
		updatedAt: now,
		messages: [
			{
				role: 'system',
				content: `Task session: ${task.title}`
			},
			{
				role: 'assistant',
				content: `**Task**: ${task.title}\n**Priority**: ${task.priority}\n**Tags**: ${task.tags.join(', ') || 'none'}\n${task.description ? `**Description**: ${task.description}\n` : ''}\nStarting autonomous work...`,
				sender
			}
		],
		source: 'claw',
		status: 'streaming'
	};

	await writeFile(sessionPath, JSON.stringify(session, null, '\t'), 'utf-8');

	await upsertSessionMeta({
		id: sessionId,
		title: `Task: ${task.title.slice(0, 30)}`,
		model: session.model,
		provider: session.provider,
		messageCount: session.messages.length,
		createdAt: now,
		updatedAt: now,
		source: 'claw',
		status: 'streaming'
	});

	return sessionId;
}
