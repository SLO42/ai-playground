/**
 * Agent spawn stats — lightweight tracker for cumulative spawn metrics.
 *
 * Each task gets a fresh Claude Code session (no --resume). This avoids
 * accumulated context from prior tasks eating memory and tokens.
 *
 * This module tracks spawn counts, token usage, and costs for the dashboard.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from '../constants.js';
import { withLock } from '../async-mutex.js';

// ── Types ────────────────────────────────────────────────────────────

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

// ── No-op legacy functions (keep API endpoints from breaking) ───────

export async function removeSlot(_slotId: string): Promise<boolean> {
	return false;
}

export async function populateFromConfig(): Promise<{ created: number; skipped: number }> {
	return { created: 0, skipped: 0 };
}

export async function populateFromProjects(
	_scanProjects: () => Promise<{ id: string; path: string }[]>,
	_loadMaxAgents: (path: string, id: string) => Promise<number>
): Promise<{ projects: Array<{ projectId: string; maxAgents: number; created: number; skipped: number; preset: string[]; presetSaved: boolean }>; totalCreated: number; totalSkipped: number }> {
	return { projects: [], totalCreated: 0, totalSkipped: 0 };
}

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
