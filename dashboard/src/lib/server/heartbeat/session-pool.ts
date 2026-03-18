/**
 * On-demand agent slot management and spawn stats.
 *
 * Agents are spawned only when a concrete task needs execution.
 * No idle pre-population — slots are requested per-task and released on completion.
 *
 * This module tracks:
 * - Active slot allocations (taskId → AgentSlot)
 * - Cumulative spawn metrics for the dashboard
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from '../constants.js';
import { withLock } from '../async-mutex.js';
import {
	getActiveAgents, getMaxConcurrentAgents,
	countProjectAgents, getProjectLimits
} from './shared.js';

// ── Types ────────────────────────────────────────────────────────────

/** Active agent slot — allocated on-demand when a task is ready to execute. */
export interface AgentSlot {
	taskId: string;
	projectId: string;
	allocatedAt: string;
	model?: string;
}

/** Legacy SessionSlot — kept for API compatibility but no longer actively managed. */
export interface SessionSlot {
	slotId: string;
	sessionId: string;
	model: string;
	area: string;
	projectId?: string;
	createdAt: string;
	lastUsedAt: string;
	taskCount: number;
	totalTokens: number;
	totalCost: number;
	status: 'idle' | 'active';
}

export interface ScaleEvent {
	action: 'scale-up' | 'scale-down';
	slotsChanged: number;
	totalSlots: number;
	timestamp: string;
}

export interface SessionPool {
	slots: SessionSlot[];
	maxSlots: number;
	coldStarts: number;
	warmResumes: number;
	scaleEvents: ScaleEvent[];
}

// ── Stats storage ───────────────────────────────────────────────────

interface SpawnStats {
	totalSpawns: number;
	totalTokens: number;
	totalCost: number;
}

const STATS_PATH = resolve(PATHS.root, '.playground/spawn-stats.json');

const g = globalThis as Record<string, unknown>;
let stats: SpawnStats = (g.__claw_spawn_stats as SpawnStats) ?? {
	totalSpawns: 0,
	totalTokens: 0,
	totalCost: 0
};
let statsLoaded = !!(g.__claw_spawn_stats);

async function loadStats(): Promise<SpawnStats> {
	if (statsLoaded) return stats;
	try {
		const raw = await readFile(STATS_PATH, 'utf-8');
		stats = JSON.parse(raw) as SpawnStats;
		g.__claw_spawn_stats = stats;
	} catch {
		// First run
	}
	statsLoaded = true;
	return stats;
}

async function saveStats(): Promise<void> {
	g.__claw_spawn_stats = stats;
	try {
		await mkdir(dirname(STATS_PATH), { recursive: true });
		await writeFile(STATS_PATH, JSON.stringify(stats, null, '\t'), 'utf-8');
	} catch { /* best effort */ }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Record that an agent was spawned. Call at spawn time.
 */
export async function recordSpawn(): Promise<void> {
	await withLock(STATS_PATH, async () => {
		await loadStats();
		stats.totalSpawns++;
		await saveStats();
	});
}

/**
 * Record token usage and cost after an agent completes.
 */
export async function recordSpawnCompletion(tokens?: number, cost?: number): Promise<void> {
	await withLock(STATS_PATH, async () => {
		await loadStats();
		if (tokens) stats.totalTokens += tokens;
		if (cost) stats.totalCost += cost;
		await saveStats();
	});
}

/**
 * Get pool stats for the dashboard.
 * Returns the SessionPool shape for backward compatibility — slots is always empty.
 */
export async function getPoolStats(): Promise<SessionPool> {
	await loadStats();
	return {
		slots: [],
		maxSlots: 0,
		coldStarts: stats.totalSpawns,
		warmResumes: 0,
		scaleEvents: []
	};
}

/**
 * Reset stats.
 */
export async function resetPool(): Promise<void> {
	await withLock(STATS_PATH, async () => {
		stats = { totalSpawns: 0, totalTokens: 0, totalCost: 0 };
		await saveStats();
	});
}

// ── On-demand slot management ────────────────────────────────────────

/** In-memory map of active slot allocations. Survives HMR via globalThis. */
function getSlotMap(): Map<string, AgentSlot> {
	if (!g.__claw_slot_map) {
		g.__claw_slot_map = new Map<string, AgentSlot>();
	}
	return g.__claw_slot_map as Map<string, AgentSlot>;
}

/**
 * Request an agent slot for a task. Returns the slot if allocation succeeds,
 * or null if no capacity is available (global or per-project limit reached).
 *
 * Call this BEFORE spawning an agent. If it returns null, the task stays queued.
 */
export function requestSlot(taskId: string, projectId: string): AgentSlot | null {
	const slots = getSlotMap();
	const agents = getActiveAgents();

	// Already has a slot
	if (slots.has(taskId)) return slots.get(taskId)!;

	// Global limit check
	if (agents.size >= getMaxConcurrentAgents()) return null;

	// Per-project limit check
	const projectLimits = getProjectLimits();
	const projMax = projectLimits.get(projectId) ?? 2;
	const projActive = countProjectAgents(projectId);
	if (projActive >= projMax) return null;

	const slot: AgentSlot = {
		taskId,
		projectId,
		allocatedAt: new Date().toISOString()
	};
	slots.set(taskId, slot);
	return slot;
}

/**
 * Release a slot when an agent completes (success or failure).
 * Safe to call multiple times — idempotent.
 */
export function releaseSlot(taskId: string): void {
	getSlotMap().delete(taskId);
}

/**
 * Get all currently allocated slots (for dashboard display).
 */
export function getAllocatedSlots(): AgentSlot[] {
	return [...getSlotMap().values()];
}

/**
 * Suggest what kind of agent to spawn for a project based on its task.
 * Returns a preset hint (model tier, agent type) — does NOT allocate a slot.
 */
export function suggestAgentPreset(taskTags: string[], projectLanguage?: string): { model: string; type: string } {
	const tags = taskTags.map(t => t.toLowerCase());

	// Test tasks → Sonnet (cheaper, focused)
	if (tags.some(t => ['test', 'testing', 'e2e', 'unit-test'].includes(t))) {
		return { model: 'claude-sonnet-4-6', type: 'tester' };
	}

	// Review/audit tasks → Sonnet
	if (tags.some(t => ['review', 'audit', 'lint', 'security'].includes(t))) {
		return { model: 'claude-sonnet-4-6', type: 'reviewer' };
	}

	// Complex implementation → Opus
	if (tags.some(t => ['feature', 'refactor', 'architecture', 'api', 'integration'].includes(t))) {
		return { model: 'claude-opus-4-6', type: 'coder' };
	}

	// Default: coder with Sonnet for unknown tasks
	return { model: 'claude-sonnet-4-6', type: 'coder' };
}

// ── No-op legacy functions (keep API endpoints from breaking) ───────

/** @deprecated Use requestSlot() instead. */
export async function removeSlot(_slotId: string): Promise<boolean> {
	return false;
}

/** @deprecated No-op. Agents are now spawned on-demand per-task. */
export async function populateFromConfig(): Promise<{ created: number; skipped: number }> {
	return { created: 0, skipped: 0 };
}

/** @deprecated No-op. Agents are now spawned on-demand per-task via requestSlot(). */
export async function populateFromProjects(
	_scanProjects: () => Promise<{ id: string; path: string }[]>,
	_loadMaxAgents: (path: string, id: string) => Promise<number>
): Promise<{ projects: Array<{ projectId: string; maxAgents: number; created: number; skipped: number; preset: string[]; presetSaved: boolean }>; totalCreated: number; totalSkipped: number }> {
	return { projects: [], totalCreated: 0, totalSkipped: 0 };
}

/** @deprecated No-op. Agents are now spawned on-demand per-task via requestSlot(). */
export async function populateForProject(
	_projectId: string,
	_agents: { filename: string; name: string; type: string }[]
): Promise<{ created: number; skipped: number }> {
	return { created: 0, skipped: 0 };
}

export async function getProjectPoolStats(_projectId: string): Promise<SessionPool> {
	return getPoolStats();
}

export async function resetProjectPool(_projectId: string): Promise<void> {
	// no-op
}

// ── Auto-scale config (kept for settings API compat) ────────────────

export interface AutoScaleConfig {
	minSlots: number;
	maxSlots: number;
	tasksPerSlot: number;
	idleCooldownMs: number;
}

export function getAutoScaleDefaults(): AutoScaleConfig {
	return { minSlots: 4, maxSlots: 14, tasksPerSlot: 2, idleCooldownMs: 5 * 60 * 1000 };
}

// ── Agent pool config (reads agent-pool.yaml — still useful) ────────

export interface AgentPoolEntry {
	id: string;
	type: string;
	model: string;
	role: string;
	description: string;
}

const MODEL_MAP: Record<string, string> = {
	opus: 'claude-opus-4-6',
	sonnet: 'claude-sonnet-4-6',
	haiku: 'claude-haiku-4-5-20251001',
	claw: 'ollama/gpt-oss:20b'
};

function parseAgentPoolYaml(raw: string): AgentPoolEntry[] {
	const entries: AgentPoolEntry[] = [];
	const agentBlocks = raw.split(/\n\s+-\s+id:\s+/);
	for (let i = 1; i < agentBlocks.length; i++) {
		const block = agentBlocks[i];
		const id = block.split('\n')[0].trim();
		const type = block.match(/type:\s+(\S+)/)?.[1] ?? 'coder';
		const model = block.match(/model:\s+(\S+)/)?.[1] ?? 'opus';
		const role = block.match(/role:\s+(\S+)/)?.[1] ?? 'primary';
		const description = block.match(/description:\s+(.+)/)?.[1]?.trim() ?? '';
		entries.push({ id, type, model, role, description });
	}
	return entries;
}

export async function getConfigAgents(): Promise<AgentPoolEntry[]> {
	try {
		const configPath = resolve(PATHS.root, 'config/agent-pool.yaml');
		const raw = await readFile(configPath, 'utf-8');
		return parseAgentPoolYaml(raw);
	} catch {
		return [];
	}
}
