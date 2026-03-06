/**
 * Memory Bridge — syncs memories from all sources into the auto-memory store.
 *
 * Sources:
 * 1. Claude auto-memory files (~/.claude/projects/.../memory/*.md)
 * 2. Claude-flow MCP memory (.swarm/memory.db → memory_entries table)
 * 3. Agent analytics learnings (.playground/agent-analytics.json)
 *
 * The bridge runs during each heartbeat cycle. It deduplicates by key+namespace
 * and only adds genuinely new entries. Existing entries are updated if content changed.
 */
import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { homedir } from 'os';
import { PATHS } from './constants.js';
import type { AutoMemoryEntry } from '$lib/types/memory.js';

// ── Types ────────────────────────────────────────────────────────────

export interface BridgeSyncResult {
	added: number;
	updated: number;
	sources: string[];
	errors: string[];
}

// ── Auto-Memory Store I/O ────────────────────────────────────────────

async function loadStore(): Promise<AutoMemoryEntry[]> {
	try {
		const raw = await readFile(PATHS.autoMemoryStore, 'utf-8');
		return JSON.parse(raw) as AutoMemoryEntry[];
	} catch {
		return [];
	}
}

async function saveStore(entries: AutoMemoryEntry[]): Promise<void> {
	await mkdir(dirname(PATHS.autoMemoryStore), { recursive: true });
	await writeFile(PATHS.autoMemoryStore, JSON.stringify(entries, null, '\t'), 'utf-8');
}

// ── Source 1: Claude Auto-Memory Files ───────────────────────────────

/**
 * Parse markdown memory files into entries.
 * Splits on ## headings — each heading becomes a separate entry.
 */
function parseMarkdownMemory(content: string, fileName: string, sourceFile: string): AutoMemoryEntry[] {
	const entries: AutoMemoryEntry[] = [];
	const lines = content.split('\n');
	let currentHeading = '';
	let currentLines: string[] = [];

	function flush() {
		if (currentHeading && currentLines.length > 0) {
			const body = currentLines.join('\n').trim();
			if (body.length > 0) {
				const key = `claude-memory-${fileName}-${currentHeading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
				entries.push({
					id: `mem-bridge-${key}`,
					key,
					content: body,
					summary: currentHeading,
					namespace: 'claude-memory',
					type: 'semantic',
					metadata: { sourceFile, bridge: 'auto-memory-files', fileName },
					createdAt: Date.now()
				});
			}
		}
	}

	for (const line of lines) {
		const headingMatch = line.match(/^##\s+(.+)/);
		if (headingMatch) {
			flush();
			currentHeading = headingMatch[1].trim();
			currentLines = [];
		} else if (currentHeading) {
			currentLines.push(line);
		}
	}
	flush();

	return entries;
}

async function syncAutoMemoryFiles(): Promise<{ entries: AutoMemoryEntry[]; errors: string[] }> {
	const entries: AutoMemoryEntry[] = [];
	const errors: string[] = [];

	// Find the project-specific memory directory
	const projectKey = resolve(PATHS.root).replace(/[:\\\/]/g, '-').replace(/^-/, '');
	const memoryDir = resolve(homedir(), '.claude', 'projects', projectKey, 'memory');

	if (!existsSync(memoryDir)) {
		return { entries, errors };
	}

	try {
		const files = await readdir(memoryDir);
		for (const file of files) {
			if (!file.endsWith('.md')) continue;
			try {
				const filePath = resolve(memoryDir, file);
				const content = await readFile(filePath, 'utf-8');
				const fileName = basename(file, '.md');
				const parsed = parseMarkdownMemory(content, fileName, filePath);
				entries.push(...parsed);
			} catch (e) {
				errors.push(`auto-memory ${file}: ${e instanceof Error ? e.message : 'read failed'}`);
			}
		}
	} catch (e) {
		errors.push(`auto-memory dir: ${e instanceof Error ? e.message : 'readdir failed'}`);
	}

	return { entries, errors };
}

// ── Source 2: Claude-Flow MCP Memory (SQLite) ────────────────────────

async function syncClaudeFlowMemory(): Promise<{ entries: AutoMemoryEntry[]; errors: string[] }> {
	const entries: AutoMemoryEntry[] = [];
	const errors: string[] = [];
	const dbPath = resolve(PATHS.root, '.swarm/memory.db');

	if (!existsSync(dbPath)) {
		return { entries, errors };
	}

	try {
		// Use the MCP memory_list tool via HTTP if daemon is running,
		// otherwise read the DB directly via a child process
		const { execSync } = await import('child_process');

		// Query memory_entries table for active entries
		const query = `SELECT id, key, namespace, content, type, tags, metadata, created_at, access_count FROM memory_entries WHERE status = 'active' ORDER BY created_at DESC LIMIT 200;`;

		const raw = execSync(
			`sqlite3 -json "${dbPath}" "${query.replace(/"/g, '\\"')}"`,
			{ encoding: 'utf-8', timeout: 5000, windowsHide: true }
		).trim();

		if (!raw || raw === '[]') return { entries, errors };

		const rows = JSON.parse(raw) as Array<{
			id: string;
			key: string;
			namespace: string;
			content: string;
			type: string;
			tags?: string;
			metadata?: string;
			created_at: number;
			access_count: number;
		}>;

		for (const row of rows) {
			let tags: string[] = [];
			let metadata: Record<string, unknown> = {};
			try { if (row.tags) tags = JSON.parse(row.tags); } catch { /* */ }
			try { if (row.metadata) metadata = JSON.parse(row.metadata); } catch { /* */ }

			entries.push({
				id: `mem-bridge-cf-${row.id}`,
				key: `cf-${row.namespace}-${row.key}`,
				content: row.content,
				summary: row.key.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
				namespace: `claude-flow:${row.namespace}`,
				type: row.type || 'semantic',
				metadata: {
					...metadata,
					bridge: 'claude-flow-db',
					originalId: row.id,
					accessCount: row.access_count,
					tags
				},
				createdAt: row.created_at
			});
		}
	} catch (e) {
		// sqlite3 CLI might not be available — try better-sqlite3 or just skip
		const msg = e instanceof Error ? e.message : 'unknown';
		if (!msg.includes('not found') && !msg.includes('not recognized')) {
			errors.push(`claude-flow db: ${msg.slice(0, 100)}`);
		}
	}

	return { entries, errors };
}

// ── Source 3: Agent Analytics Learnings ──────────────────────────────

async function syncAgentLearnings(): Promise<{ entries: AutoMemoryEntry[]; errors: string[] }> {
	const entries: AutoMemoryEntry[] = [];
	const errors: string[] = [];
	const analyticsPath = resolve(PATHS.root, '.playground/agent-analytics.json');

	if (!existsSync(analyticsPath)) {
		return { entries, errors };
	}

	try {
		const raw = await readFile(analyticsPath, 'utf-8');
		const events = JSON.parse(raw) as Array<{
			id: string;
			taskId: string;
			taskTitle: string;
			type: string;
			timestamp: string;
			model?: string;
			modelTier?: string;
			provider?: string;
			costUsd?: number;
			durationMs?: number;
			classificationReason?: string;
			classificationMethod?: string;
			exitCode?: number;
			commitHash?: string;
			commitFiles?: number;
		}>;

		// Group completed tasks to create learning entries
		const taskCompletions = new Map<string, typeof events[0]>();
		const taskClassifications = new Map<string, typeof events[0]>();

		for (const e of events) {
			if (e.type === 'completed') taskCompletions.set(e.taskId, e);
			if (e.type === 'classified') taskClassifications.set(e.taskId, e);
		}

		// Create a summary entry for completed tasks with notable learnings
		for (const [taskId, completion] of taskCompletions) {
			const classification = taskClassifications.get(taskId);
			if (!classification) continue;

			const key = `agent-task-${taskId}`;
			const parts: string[] = [
				`Task: ${completion.taskTitle}`,
				`Route: ${classification.provider} (${classification.classificationMethod ?? 'unknown'})`,
				`Model: ${completion.model ?? 'unknown'} (${completion.modelTier ?? 'unknown'} tier)`,
			];
			if (completion.durationMs) parts.push(`Duration: ${(completion.durationMs / 1000).toFixed(0)}s`);
			if (completion.costUsd) parts.push(`Cost: $${completion.costUsd.toFixed(3)}`);
			if (completion.commitHash) parts.push(`Commit: ${completion.commitHash}`);
			if (classification.classificationReason) parts.push(`Routing reason: ${classification.classificationReason}`);

			entries.push({
				id: `mem-bridge-analytics-${taskId}`,
				key,
				content: parts.join('\n'),
				summary: `Completed: ${completion.taskTitle}`,
				namespace: 'agent-learnings',
				type: 'episodic',
				metadata: {
					bridge: 'agent-analytics',
					taskId,
					model: completion.model,
					modelTier: completion.modelTier,
					provider: completion.provider,
					costUsd: completion.costUsd,
					durationMs: completion.durationMs
				},
				createdAt: new Date(completion.timestamp).getTime()
			});
		}
	} catch (e) {
		errors.push(`agent-analytics: ${e instanceof Error ? e.message : 'read failed'}`);
	}

	return { entries, errors };
}

// ── Bridge Sync ──────────────────────────────────────────────────────

/**
 * Run a full sync from all sources into the auto-memory store.
 * Deduplicates by bridge entry ID — updates content if changed, adds if new.
 */
export async function syncMemoryBridge(): Promise<BridgeSyncResult> {
	const result: BridgeSyncResult = { added: 0, updated: 0, sources: [], errors: [] };

	// Load current store
	const store = await loadStore();
	const storeMap = new Map<string, AutoMemoryEntry>();
	for (const e of store) storeMap.set(e.id, e);

	// Collect from all sources in parallel
	const [autoMemory, claudeFlow, analytics] = await Promise.all([
		syncAutoMemoryFiles(),
		syncClaudeFlowMemory(),
		syncAgentLearnings()
	]);

	const allNew: AutoMemoryEntry[] = [
		...autoMemory.entries,
		...claudeFlow.entries,
		...analytics.entries
	];

	result.errors.push(...autoMemory.errors, ...claudeFlow.errors, ...analytics.errors);

	if (autoMemory.entries.length > 0) result.sources.push(`auto-memory (${autoMemory.entries.length})`);
	if (claudeFlow.entries.length > 0) result.sources.push(`claude-flow (${claudeFlow.entries.length})`);
	if (analytics.entries.length > 0) result.sources.push(`analytics (${analytics.entries.length})`);

	// Merge into store
	let changed = false;
	for (const entry of allNew) {
		const existing = storeMap.get(entry.id);
		if (!existing) {
			// New entry
			storeMap.set(entry.id, entry);
			result.added++;
			changed = true;
		} else if (existing.content !== entry.content) {
			// Content changed — update
			existing.content = entry.content;
			existing.summary = entry.summary;
			existing.metadata = entry.metadata;
			result.updated++;
			changed = true;
		}
		// Same content = skip (no-op)
	}

	if (changed) {
		await saveStore(Array.from(storeMap.values()));
	}

	return result;
}
