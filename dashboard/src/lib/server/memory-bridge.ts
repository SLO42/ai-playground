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

async function syncProjectMap(): Promise<{ entries: AutoMemoryEntry[]; errors: string[] }> {
	const entries: AutoMemoryEntry[] = [];
	const errors: string[] = [];

	try {
		const registryPath = resolve(PATHS.root, '.playground/registry.json');
		const raw = await readFile(registryPath, 'utf-8');
		const registry = JSON.parse(raw) as { projects?: Array<{ id: string; name: string; path: string; description?: string; techStack?: string[]; tags?: string[] }> };

		if (!registry.projects?.length) return { entries, errors };

		for (const project of registry.projects) {
			const fullPath = project.path === '.' ? PATHS.root : resolve(PATHS.root, project.path);
			const lines: string[] = [];

			lines.push(`**Path**: \`${project.path}\``);
			if (project.description) lines.push(`**Description**: ${project.description}`);
			if (project.techStack?.length) lines.push(`**Stack**: ${project.techStack.join(', ')}`);
			if (project.tags?.length) lines.push(`**Tags**: ${project.tags.join(', ')}`);

			// Scan for key files
			try {
				const { readdirSync, statSync } = await import('fs');
				const keyFiles: string[] = [];
				const scanDir = (dir: string, prefix: string, depth: number) => {
					if (depth > 2) return;
					try {
						for (const entry of readdirSync(dir)) {
							if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
							const full = resolve(dir, entry);
							const st = statSync(full);
							if (st.isDirectory() && depth < 2) {
								scanDir(full, `${prefix}${entry}/`, depth + 1);
							} else if (st.isFile() && /\.(ts|svelte|json|yaml|py|rs)$/.test(entry)) {
								keyFiles.push(`${prefix}${entry}`);
							}
						}
					} catch { /* skip */ }
				};
				scanDir(fullPath, '', 0);
				if (keyFiles.length > 0) {
					lines.push(`**Key files** (${keyFiles.length}): ${keyFiles.slice(0, 15).join(', ')}${keyFiles.length > 15 ? '...' : ''}`);
				}
			} catch { /* skip */ }

			// Task summary
			try {
				const tasksPath = resolve(fullPath, '.playground/tasks.json');
				const tasksRaw = await readFile(tasksPath, 'utf-8');
				const tasks = JSON.parse(tasksRaw) as Array<{ status: string }>;
				const pending = tasks.filter(t => t.status === 'pending').length;
				const inProgress = tasks.filter(t => t.status === 'in_progress').length;
				const completed = tasks.filter(t => t.status === 'completed').length;
				lines.push(`**Tasks**: ${pending} pending, ${inProgress} active, ${completed} completed`);
			} catch { /* no tasks */ }

			const content = lines.join('\n');
			const key = `project-map-${project.id}`;

			entries.push({
				id: `mem-bridge-project-${project.id}`,
				key,
				content,
				summary: `Project: ${project.name}`,
				namespace: 'project-map',
				type: 'semantic',
				metadata: { bridge: 'project-map', projectId: project.id, projectName: project.name },
				createdAt: Date.now()
			});
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
