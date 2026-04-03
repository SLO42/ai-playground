/**
 * Memory Bridge — syncs memories from all sources into the auto-memory store.
 *
 * Sources:
 * 1. Claude auto-memory files (~/.claude/projects/.../memory/*.md)
 * 2. Claude-flow MCP memory (.swarm/memory.db → memory_entries table)
 * 3. Project map (compact project profiles from registry)
 *
 * The bridge runs during each heartbeat cycle. It deduplicates by key+namespace
 * and only adds genuinely new entries. Existing entries are updated if content changed.
 */
import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { homedir } from 'os';
import { PATHS } from './constants.js';
import { getAllTasks } from './task-store-sql.js';
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
					metadata: { sourceFile, bridge: 'auto-memory-files', fileName, projectId: 'ai-playground' },
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

// ── Source 2: Claude-Flow MCP Memory ─────────────────────────────────

/**
 * Sync from claude-flow memory via the MCP memory_list tool.
 * Requires the claude-flow daemon to be running.
 * Falls back gracefully if daemon is offline — no CLI dependencies needed.
 */
async function syncClaudeFlowMemory(): Promise<{ entries: AutoMemoryEntry[]; errors: string[] }> {
	const entries: AutoMemoryEntry[] = [];
	const errors: string[] = [];

	try {
		// Try the MCP memory list endpoint (claude-flow daemon must be running)
		const res = await fetch('http://127.0.0.1:3577/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'bridge-sync',
				method: 'tools/call',
				params: { name: 'memory_list', arguments: { limit: 200 } }
			}),
			signal: AbortSignal.timeout(3000)
		});

		if (!res.ok) return { entries, errors };

		const rpc = await res.json() as {
			result?: {
				content?: Array<{ text?: string }>;
			};
		};

		const text = rpc.result?.content?.[0]?.text;
		if (!text) return { entries, errors };

		const parsed = JSON.parse(text) as {
			entries?: Array<{
				id: string;
				key: string;
				namespace: string;
				content: string;
				type?: string;
				tags?: string[];
				metadata?: Record<string, unknown>;
				created_at?: number;
				access_count?: number;
			}>;
		};

		for (const row of parsed.entries ?? []) {
			entries.push({
				id: `mem-bridge-cf-${row.id}`,
				key: `cf-${row.namespace}-${row.key}`,
				content: row.content,
				summary: row.key.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
				namespace: `claude-flow:${row.namespace}`,
				type: row.type || 'semantic',
				metadata: {
					...(row.metadata ?? {}),
					bridge: 'claude-flow-mcp',
					originalId: row.id,
					accessCount: row.access_count ?? 0,
					tags: row.tags ?? []
				},
				createdAt: row.created_at ?? Date.now()
			});
		}
	} catch {
		// Daemon not running or MCP unavailable — skip silently
		// This is expected when the daemon isn't started
	}

	return { entries, errors };
}

// Source 3: Compact Project Map
// Maintains a single auto-updated memory entry per project so agents can
// understand the project landscape via memory_search. Gets UPSERTED each
// sync cycle — never appends, always replaces with current state.

// Cache for key-files scans — only re-scan a project every 5 minutes
const _keyFilesCache = new Map<string, { files: string[]; expiresAt: number }>();
const KEY_FILES_CACHE_TTL = 5 * 60_000;

/** Async directory scan — yields to the event loop between directories. */
async function scanKeyFilesAsync(dir: string, prefix: string, depth: number): Promise<string[]> {
	if (depth > 2) return [];
	const SKIP = new Set(['.', '..', 'node_modules', 'dist', 'build', '.git', '.svelte-kit', '__pycache__', 'target', '.next']);
	const SOURCE_EXT = /\.(ts|svelte|json|yaml|py|rs|go|java|cs|jsx|tsx|vue)$/;
	const keyFiles: string[] = [];

	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
			if (entry.isDirectory() && depth < 2) {
				const sub = await scanKeyFilesAsync(resolve(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
				keyFiles.push(...sub);
			} else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
				keyFiles.push(`${prefix}${entry.name}`);
			}
			// Cap at 200 files to prevent runaway on huge projects
			if (keyFiles.length >= 200) break;
		}
	} catch { /* dir inaccessible */ }

	return keyFiles;
}

async function getKeyFilesForProject(projectPath: string): Promise<string[]> {
	const cached = _keyFilesCache.get(projectPath);
	if (cached && Date.now() < cached.expiresAt) return cached.files;

	const files = await scanKeyFilesAsync(projectPath, '', 0);
	_keyFilesCache.set(projectPath, { files, expiresAt: Date.now() + KEY_FILES_CACHE_TTL });
	return files;
}

async function syncProjectMap(): Promise<{ entries: AutoMemoryEntry[]; errors: string[] }> {
	const entries: AutoMemoryEntry[] = [];
	const errors: string[] = [];

	try {
		const registryPath = resolve(PATHS.root, '.playground/registry.json');
		const raw = await readFile(registryPath, 'utf-8');
		const registry = JSON.parse(raw) as { projects?: Array<{ id: string; name: string; path: string; description?: string; techStack?: string[]; tags?: string[] }> };

		if (!registry.projects?.length) return { entries, errors };

		// Process projects concurrently (bounded to avoid I/O saturation)
		const CONCURRENCY = 4;
		for (let i = 0; i < registry.projects.length; i += CONCURRENCY) {
			const batch = registry.projects.slice(i, i + CONCURRENCY);
			const results = await Promise.allSettled(batch.map(async (project) => {
				const fullPath = project.path === '.' ? PATHS.root : resolve(PATHS.root, project.path);
				const lines: string[] = [];

				lines.push(`**Path**: \`${project.path}\``);
				if (project.description) lines.push(`**Description**: ${project.description}`);
				if (project.techStack?.length) lines.push(`**Stack**: ${project.techStack.join(', ')}`);
				if (project.tags?.length) lines.push(`**Tags**: ${project.tags.join(', ')}`);

				// Async key files scan with caching
				try {
					const keyFiles = await getKeyFilesForProject(fullPath);
					if (keyFiles.length > 0) {
						lines.push(`**Key files** (${keyFiles.length}): ${keyFiles.slice(0, 15).join(', ')}${keyFiles.length > 15 ? '...' : ''}`);
					}
				} catch { /* skip */ }

				// Task summary — use v2 task store
				try {
					const tasks = await getAllTasks(fullPath);
					const pending = tasks.filter(t => t.status === 'pending').length;
					const inProgress = tasks.filter(t => t.status === 'in_progress').length;
					const completed = tasks.filter(t => t.status === 'completed').length;
					lines.push(`**Tasks**: ${pending} pending, ${inProgress} active, ${completed} completed`);
				} catch { /* no tasks */ }

				return {
					id: `mem-bridge-project-${project.id}`,
					key: `project-map-${project.id}`,
					content: lines.join('\n'),
					summary: `Project: ${project.name}`,
					namespace: 'project-map' as const,
					type: 'semantic' as const,
					metadata: { bridge: 'project-map', projectId: project.id, projectName: project.name },
					createdAt: Date.now()
				};
			}));

			for (const r of results) {
				if (r.status === 'fulfilled') entries.push(r.value as AutoMemoryEntry);
			}
		}
	} catch (e) {
		errors.push(`project-map: ${e instanceof Error ? e.message : 'scan failed'}`);
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
	const [autoMemory, claudeFlow, projectMap] = await Promise.all([
		syncAutoMemoryFiles(),
		syncClaudeFlowMemory(),
		syncProjectMap()
	]);

	const allNew: AutoMemoryEntry[] = [
		...autoMemory.entries,
		...claudeFlow.entries,
		...projectMap.entries
	];

	result.errors.push(...autoMemory.errors, ...claudeFlow.errors, ...projectMap.errors);

	if (autoMemory.entries.length > 0) result.sources.push(`auto-memory (${autoMemory.entries.length})`);
	if (claudeFlow.entries.length > 0) result.sources.push(`claude-flow (${claudeFlow.entries.length})`);
	if (projectMap.entries.length > 0) result.sources.push(`project-map (${projectMap.entries.length})`);

	// Build set of IDs from all sources — entries NOT in this set are stale
	const freshIds = new Set(allNew.map(e => e.id));

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

	// Prune entries from bridge sources that no longer exist in the source
	// Only prune entries that came from the bridge (have bridge metadata),
	// not user-created entries or entries from other systems
	let pruned = 0;
	for (const [id, entry] of storeMap) {
		const bridge = (entry.metadata as Record<string, unknown>)?.bridge as string | undefined;
		if (bridge && !freshIds.has(id)) {
			storeMap.delete(id);
			pruned++;
			changed = true;
		}
	}

	if (changed) {
		await saveStore(Array.from(storeMap.values()));
	}

	if (pruned > 0) {
		result.sources.push(`pruned ${pruned} stale`);
	}

	return result;
}
