/**
 * Agent Session Pool — maintains persistent Claude Code sessions to avoid
 * cold-start context loading costs (~44K tokens / ~$0.05 per cold start).
 *
 * Sessions are reused via `--resume <session-id>` which gives cache hits
 * on CLAUDE.md, project structure, and prior conversation context.
 *
 * Pool slots are keyed by code area (routes, server, components, etc.)
 * so related tasks reuse the same session and benefit from accumulated context.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { PATHS } from '../constants.js';
import type { Task } from '$lib/types/tasks.js';

// ── Types ────────────────────────────────────────────────────────────

export interface SessionSlot {
	slotId: string;
	sessionId: string;        // Claude Code session UUID
	model: string;            // Model this session was started with
	area: string;             // Code area (routes, server, components, etc.)
	createdAt: string;
	lastUsedAt: string;
	taskCount: number;        // Number of tasks run in this session
	totalTokens: number;      // Cumulative tokens used
	totalCost: number;        // Cumulative cost
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
	coldStarts: number;       // Times we had to create a new session
	warmResumes: number;      // Times we reused an existing session
	scaleEvents: ScaleEvent[];  // Recent auto-scale activity (last 20)
}

// ── Storage ──────────────────────────────────────────────────────────

const POOL_PATH = resolve(PATHS.root, '.playground/session-pool.json');

// In-memory cache
const g = globalThis as Record<string, unknown>;
let pool: SessionPool = (g.__claw_session_pool as SessionPool) ?? {
	slots: [],
	maxSlots: 8,
	coldStarts: 0,
	warmResumes: 0,
	scaleEvents: []
};

async function loadPool(): Promise<SessionPool> {
	try {
		const raw = await readFile(POOL_PATH, 'utf-8');
		pool = JSON.parse(raw) as SessionPool;
		g.__claw_session_pool = pool;
		return pool;
	} catch {
		return pool;
	}
}

async function savePool(): Promise<void> {
	g.__claw_session_pool = pool;
	try {
		await mkdir(dirname(POOL_PATH), { recursive: true });
		await writeFile(POOL_PATH, JSON.stringify(pool, null, '\t'), 'utf-8');
	} catch { /* best effort */ }
}

// ── Area classification ──────────────────────────────────────────────

/**
 * Classify a task into a code area for session affinity.
 * Tasks in the same area benefit from shared session context.
 */
export function classifyArea(task: Task): string {
	const text = `${task.title} ${task.description ?? ''} ${task.tags.join(' ')}`.toLowerCase();

	const areas: [string, RegExp[]][] = [
		['routes/chat', [/\bchat\b/, /\bmessage\b/, /\bconversation\b/]],
		['routes/projects', [/\bproject\b/, /\bimport\b.*project/]],
		['routes/tasks', [/\btask\b/, /\bbacklog\b/]],
		['routes/models', [/\bmodel\b/, /\brouting\b/, /\bollama\b/]],
		['routes/agents', [/\bagent\b/, /\bspawn\b/]],
		['routes/services', [/\bservice\b/]],
		['routes/settings', [/\bsetting\b/, /\bconfig\b/, /\bpreference\b/]],
		['routes/inbox', [/\binbox\b/, /\bnotification\b/]],
		['routes/reports', [/\breport\b/, /\banalytics\b/]],
		['routes/security', [/\bsecurity\b/, /\bscan\b/]],
		['server/heartbeat', [/\bheartbeat\b/, /\bclaw\b/, /\bspawn\b/]],
		['server/api', [/\bapi\b/, /\bendpoint\b/, /\bwire\b/]],
		['components', [/\bcomponent\b/, /\bsidebar\b/, /\blayout\b/, /\bui\b/]],
		['styles', [/\btailwind\b/, /\bcss\b/, /\bstyle\b/, /\btheme\b/]],
		['testing', [/\btest\b/, /\be2e\b/, /\bunit test\b/]],
		['ci', [/\bgithub\b/, /\bci\b/, /\bworkflow\b/, /\brelease\b/]],
	];

	for (const [area, patterns] of areas) {
		if (patterns.some(p => p.test(text))) return area;
	}

	return 'general';
}

// ── Claude Code session validation ───────────────────────────────────

/**
 * Check if a Claude Code session ID is still valid on disk.
 * Claude Code stores sessions under ~/.claude/projects/<project-hash>/sessions/
 * or ~/.claude/sessions/ — we check both locations.
 */
function isSessionValid(sessionId: string): boolean {
	if (!sessionId) return false;

	// Claude Code stores conversation data keyed by session ID.
	// The primary location is ~/.claude/ with project-scoped subdirs.
	const home = homedir();
	const claudeDir = resolve(home, '.claude');

	try {
		// Check for session in the projects directory (most common case)
		// Sessions are stored as JSON files named by their UUID
		const projectsDir = resolve(claudeDir, 'projects');
		if (existsSync(projectsDir)) {
			// Scan project dirs for a matching session file
			const { readdirSync, statSync } = require('fs') as typeof import('fs');
			const projectDirs = readdirSync(projectsDir);
			for (const dir of projectDirs) {
				const sessionsPath = resolve(projectsDir, dir, '.sessions');
				if (existsSync(sessionsPath) && statSync(sessionsPath).isDirectory()) {
					const sessionFile = resolve(sessionsPath, `${sessionId}.json`);
					if (existsSync(sessionFile)) return true;
				}
			}
		}

		// Fallback: check the flat sessions directory
		const flatSessionFile = resolve(claudeDir, 'sessions', `${sessionId}.json`);
		if (existsSync(flatSessionFile)) return true;
	} catch {
		// If we can't check, assume valid to avoid unnecessary cold starts
		return true;
	}

	return false;
}

/**
 * Extract a Claude Code session ID from a stream-json log file.
 * Looks for the `init` system message that contains the session UUID.
 */
export function extractSessionIdFromLog(logFile: string): string | null {
	try {
		if (!existsSync(logFile)) return null;
		const content = readFileSync(logFile, 'utf-8');
		// stream-json outputs one JSON object per line
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('{')) continue;
			try {
				const msg = JSON.parse(trimmed);
				if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
					return msg.session_id;
				}
			} catch { continue; }
		}
	} catch { /* best effort */ }
	return null;
}

/**
 * Watch a log file for a Claude Code session ID init message.
 * Retries with exponential backoff up to ~15 seconds total.
 * Returns the session ID or null if not found.
 */
export async function watchForSessionId(
	logFile: string,
	slotId: string,
	maxWaitMs = 15_000
): Promise<string | null> {
	const intervals = [500, 1000, 2000, 3000, 5000]; // ~11.5s total
	let elapsed = 0;

	for (const delay of intervals) {
		if (elapsed >= maxWaitMs) break;
		await new Promise(r => setTimeout(r, delay));
		elapsed += delay;

		const sessionId = extractSessionIdFromLog(logFile);
		if (sessionId) {
			await registerSession(slotId, sessionId);
			return sessionId;
		}
	}

	return null;
}

// ── Session resolution ───────────────────────────────────────────────

export interface SessionResolution {
	sessionId: string | null;  // null = cold start (no --resume)
	isResume: boolean;
	slotId: string;
	area: string;
}

/**
 * Find or create a session slot for a task.
 * Returns a session ID to resume if one exists, or null for cold start.
 */
export async function resolveSession(task: Task, model: string): Promise<SessionResolution> {
	await loadPool();

	const area = classifyArea(task);

	// Look for an existing idle slot with matching area AND model
	const match = pool.slots.find(s =>
		s.area === area &&
		s.model === model &&
		s.status === 'idle'
	);

	if (match) {
		// Validate the session ID is still valid on disk before attempting --resume
		const hasValidSession = match.sessionId && isSessionValid(match.sessionId);

		if (!hasValidSession && match.sessionId) {
			// Session expired or was cleaned up — clear it for a cold start
			match.sessionId = '';
		}

		match.status = 'active';
		match.lastUsedAt = new Date().toISOString();
		match.taskCount++;

		if (hasValidSession) {
			pool.warmResumes++;
		} else {
			pool.coldStarts++;
		}

		await savePool();
		return {
			sessionId: hasValidSession ? match.sessionId : null,
			isResume: hasValidSession as boolean,
			slotId: match.slotId,
			area
		};
	}

	// No matching slot — check if we can create a new one
	if (pool.slots.length < pool.maxSlots) {
		const slotId = `slot-${area.replace(/\//g, '-')}-${Date.now()}`;
		const slot: SessionSlot = {
			slotId,
			sessionId: '',  // Will be filled after first run
			model,
			area,
			createdAt: new Date().toISOString(),
			lastUsedAt: new Date().toISOString(),
			taskCount: 1,
			totalTokens: 0,
			totalCost: 0,
			status: 'active'
		};
		pool.slots.push(slot);
		pool.coldStarts++;
		await savePool();
		return { sessionId: null, isResume: false, slotId, area };
	}

	// Pool is full — evict the oldest idle slot
	const idleSlots = pool.slots
		.filter(s => s.status === 'idle')
		.sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());

	if (idleSlots.length > 0) {
		const evicted = idleSlots[0];
		evicted.sessionId = '';
		evicted.model = model;
		evicted.area = area;
		evicted.lastUsedAt = new Date().toISOString();
		evicted.taskCount = 1;
		evicted.totalTokens = 0;
		evicted.totalCost = 0;
		evicted.status = 'active';
		pool.coldStarts++;
		await savePool();
		return { sessionId: null, isResume: false, slotId: evicted.slotId, area };
	}

	// All slots busy — cold start without a slot (won't be tracked)
	pool.coldStarts++;
	await savePool();
	return { sessionId: null, isResume: false, slotId: `temp-${Date.now()}`, area };
}

// ── Session lifecycle ────────────────────────────────────────────────

/**
 * Register the Claude Code session ID after first cold start.
 * Called when we parse the init message from stream-json output.
 */
export async function registerSession(slotId: string, sessionId: string): Promise<void> {
	await loadPool();
	const slot = pool.slots.find(s => s.slotId === slotId);
	if (slot) {
		slot.sessionId = sessionId;
		await savePool();
	}
}

/**
 * Mark a slot as idle after the agent completes.
 */
export async function releaseSession(slotId: string, tokens?: number, cost?: number): Promise<void> {
	await loadPool();
	const slot = pool.slots.find(s => s.slotId === slotId);
	if (slot) {
		slot.status = 'idle';
		if (tokens) slot.totalTokens += tokens;
		if (cost) slot.totalCost += cost;
		await savePool();
	}
}

/**
 * Get pool stats for the analytics dashboard.
 */
export async function getPoolStats(): Promise<SessionPool> {
	await loadPool();
	return { ...pool, scaleEvents: pool.scaleEvents ?? [] };
}

/**
 * Agent pool config entry (from config/agent-pool.yaml)
 */
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

/**
 * Parse agent entries from config/agent-pool.yaml
 */
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

/**
 * Load agent pool config entries from config/agent-pool.yaml.
 */
export async function getConfigAgents(): Promise<AgentPoolEntry[]> {
	try {
		const configPath = resolve(PATHS.root, 'config/agent-pool.yaml');
		const raw = await readFile(configPath, 'utf-8');
		return parseAgentPoolYaml(raw);
	} catch {
		return [];
	}
}

/**
 * Populate the session pool from config/agent-pool.yaml.
 * Creates one session slot per configured agent.
 */
export async function populateFromConfig(): Promise<{ created: number; skipped: number }> {
	const configPath = resolve(PATHS.root, 'config/agent-pool.yaml');
	const raw = await readFile(configPath, 'utf-8');
	const agents = parseAgentPoolYaml(raw);

	await loadPool();

	let created = 0;
	let skipped = 0;

	for (const agent of agents) {
		// Skip if slot with this ID already exists
		if (pool.slots.some(s => s.slotId === agent.id)) {
			skipped++;
			continue;
		}

		const slot: SessionSlot = {
			slotId: agent.id,
			sessionId: '',
			model: MODEL_MAP[agent.model] ?? agent.model,
			area: `${agent.role}/${agent.type}`,
			createdAt: new Date().toISOString(),
			lastUsedAt: new Date().toISOString(),
			taskCount: 0,
			totalTokens: 0,
			totalCost: 0,
			status: 'idle'
		};
		pool.slots.push(slot);
		created++;
	}

	pool.maxSlots = Math.max(pool.maxSlots, pool.slots.length);
	await savePool();

	return { created, skipped };
}

/**
 * Reset the pool — remove all slots and start fresh.
 */
export async function resetPool(): Promise<void> {
	pool = {
		slots: [],
		maxSlots: 14,
		coldStarts: 0,
		warmResumes: 0,
		scaleEvents: []
	};
	await savePool();
}

/**
 * Remove a specific slot by ID.
 */
export async function removeSlot(slotId: string): Promise<boolean> {
	await loadPool();
	const idx = pool.slots.findIndex(s => s.slotId === slotId);
	if (idx === -1) return false;
	pool.slots.splice(idx, 1);
	await savePool();
	return true;
}

// ── Per-project pool management ─────────────────────────────────────

/**
 * Populate session pool slots for a specific project's associated agents.
 * Slots are prefixed with `proj-{projectId}-` for identification.
 */
export async function populateForProject(
	projectId: string,
	agents: { filename: string; name: string; type: string }[]
): Promise<{ created: number; skipped: number }> {
	await loadPool();

	let created = 0;
	let skipped = 0;

	for (const agent of agents) {
		const slotId = `proj-${projectId}-${agent.filename.replace(/[/.]/g, '-')}`;

		if (pool.slots.some(s => s.slotId === slotId)) {
			skipped++;
			continue;
		}

		const slot: SessionSlot = {
			slotId,
			sessionId: '',
			model: 'claude-opus-4-6',
			area: `projects/${projectId}/${agent.type}`,
			createdAt: new Date().toISOString(),
			lastUsedAt: new Date().toISOString(),
			taskCount: 0,
			totalTokens: 0,
			totalCost: 0,
			status: 'idle'
		};
		pool.slots.push(slot);
		created++;
	}

	pool.maxSlots = Math.max(pool.maxSlots, pool.slots.length);
	await savePool();

	return { created, skipped };
}

/**
 * Get pool stats filtered to a specific project.
 */
export async function getProjectPoolStats(projectId: string): Promise<SessionPool> {
	await loadPool();
	const prefix = `proj-${projectId}-`;
	return {
		slots: pool.slots.filter(s => s.slotId.startsWith(prefix)),
		maxSlots: pool.maxSlots,
		coldStarts: pool.coldStarts,
		warmResumes: pool.warmResumes,
		scaleEvents: pool.scaleEvents ?? []
	};
}

/**
 * Reset pool slots for a specific project only.
 */
export async function resetProjectPool(projectId: string): Promise<void> {
	await loadPool();
	const prefix = `proj-${projectId}-`;
	pool.slots = pool.slots.filter(s => !s.slotId.startsWith(prefix));
	await savePool();
}

// ── Auto-scaling ────────────────────────────────────────────────────

export interface AutoScaleConfig {
	/** Minimum pool slots (never scale below this) */
	minSlots: number;
	/** Maximum pool slots (never scale above this) */
	maxSlots: number;
	/** Pending tasks per slot — when exceeded, scale up */
	tasksPerSlot: number;
	/** Idle duration (ms) before a slot is eligible for scale-down */
	idleCooldownMs: number;
}

const DEFAULT_AUTOSCALE: AutoScaleConfig = {
	minSlots: 4,
	maxSlots: 14,
	tasksPerSlot: 2,
	idleCooldownMs: 5 * 60 * 1000 // 5 minutes
};

export interface AutoScaleResult {
	action: 'scale-up' | 'scale-down' | 'no-op';
	previousMaxSlots: number;
	newMaxSlots: number;
	slotsAdded: number;
	slotsRemoved: number;
	pendingTasks: number;
	activeSlots: number;
	idleSlots: number;
}

/**
 * Auto-scale the session pool based on task queue depth.
 *
 * Scale-up: When pending tasks exceed (idle slots × tasksPerSlot),
 *   increase maxSlots and pre-create empty slots for the overflow.
 *
 * Scale-down: When idle slots exceed what's needed for the current
 *   queue depth and have been idle past the cooldown, remove them.
 *
 * @param pendingTaskCount - Number of tasks in pending/in_progress status
 * @param config - Override default thresholds
 */
export async function autoScale(
	pendingTaskCount: number,
	config?: Partial<AutoScaleConfig>
): Promise<AutoScaleResult> {
	const cfg = { ...DEFAULT_AUTOSCALE, ...config };
	await loadPool();

	const now = Date.now();
	const previousMaxSlots = pool.maxSlots;

	const activeSlots = pool.slots.filter(s => s.status === 'active');
	const idleSlots = pool.slots.filter(s => s.status === 'idle');

	// How many slots do we need to handle the pending queue?
	const desiredSlots = Math.max(
		cfg.minSlots,
		Math.min(cfg.maxSlots, activeSlots.length + Math.ceil(pendingTaskCount / cfg.tasksPerSlot))
	);

	let slotsAdded = 0;
	let slotsRemoved = 0;
	let action: AutoScaleResult['action'] = 'no-op';

	if (desiredSlots > pool.slots.length && pendingTaskCount > idleSlots.length) {
		// ── Scale up ──────────────────────────────────────────────────
		action = 'scale-up';
		const toAdd = desiredSlots - pool.slots.length;

		for (let i = 0; i < toAdd; i++) {
			const slot: SessionSlot = {
				slotId: `auto-${Date.now()}-${i}`,
				sessionId: '',
				model: 'claude-opus-4-6',
				area: 'general',
				createdAt: new Date().toISOString(),
				lastUsedAt: new Date().toISOString(),
				taskCount: 0,
				totalTokens: 0,
				totalCost: 0,
				status: 'idle'
			};
			pool.slots.push(slot);
			slotsAdded++;
		}

		pool.maxSlots = Math.max(pool.maxSlots, pool.slots.length);
	} else if (
		desiredSlots < pool.slots.length &&
		pendingTaskCount === 0 &&
		idleSlots.length > cfg.minSlots
	) {
		// ── Scale down ────────────────────────────────────────────────
		// Only remove auto-created idle slots past the cooldown period
		const removable = idleSlots
			.filter(s => s.slotId.startsWith('auto-'))
			.filter(s => now - new Date(s.lastUsedAt).getTime() > cfg.idleCooldownMs)
			.sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());

		const excess = pool.slots.length - Math.max(cfg.minSlots, desiredSlots);
		const toRemove = Math.min(removable.length, excess);

		if (toRemove > 0) {
			action = 'scale-down';
			const removeIds = new Set(removable.slice(0, toRemove).map(s => s.slotId));
			pool.slots = pool.slots.filter(s => !removeIds.has(s.slotId));
			slotsRemoved = toRemove;
		}
	}

	// Record scale events for dashboard visibility
	if (action !== 'no-op') {
		if (!pool.scaleEvents) pool.scaleEvents = [];
		pool.scaleEvents.push({
			action,
			slotsChanged: slotsAdded || slotsRemoved,
			totalSlots: pool.slots.length,
			timestamp: new Date().toISOString()
		});
		// Keep only the last 20 events
		if (pool.scaleEvents.length > 20) {
			pool.scaleEvents = pool.scaleEvents.slice(-20);
		}
	}

	await savePool();

	return {
		action,
		previousMaxSlots,
		newMaxSlots: pool.maxSlots,
		slotsAdded,
		slotsRemoved,
		pendingTasks: pendingTaskCount,
		activeSlots: activeSlots.length,
		idleSlots: idleSlots.length
	};
}

/**
 * Get the current auto-scale config defaults.
 */
export function getAutoScaleDefaults(): AutoScaleConfig {
	return { ...DEFAULT_AUTOSCALE };
}

/**
 * Load persisted auto-scale config from the pool file, falling back to defaults.
 */
export async function loadPersistedAutoScaleConfig(): Promise<Partial<AutoScaleConfig>> {
	await loadPool();
	// Pool file may contain an autoScaleConfig override; otherwise use defaults
	const any = pool as unknown as Record<string, unknown>;
	if (any.autoScaleConfig && typeof any.autoScaleConfig === 'object') {
		return any.autoScaleConfig as Partial<AutoScaleConfig>;
	}
	return {};
}
