/**
 * Shared agent scanning/parsing utilities.
 * Used by /agents, /api/agents, and /api/agents/catalog endpoints.
 */
import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import type { AgentDefinition } from '$lib/types/agents.js';

export interface AgentConfig {
	name: string;
	description: string;
	type: string;
	category: string;
	file: string;
}

/** Recursively find all .md files under a directory. */
export async function findMdFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...(await findMdFiles(fullPath)));
			} else if (entry.name.endsWith('.md')) {
				results.push(fullPath);
			}
		}
	} catch {
		// Directory may not exist
	}
	return results;
}

/** Parse agent frontmatter from a markdown file into an AgentDefinition. */
export function parseAgentFrontmatter(content: string, filePath: string, agentsDir: string): AgentDefinition | null {
	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return null;

	const endIdx = lines.indexOf('---', 1);
	if (endIdx === -1) return null;

	const frontmatter = lines.slice(1, endIdx).join('\n');

	let name = '';
	let description = '';
	let type = '';
	let color = '';
	let priority = '';
	const capabilities: string[] = [];
	let inCapabilities = false;

	for (const line of frontmatter.split('\n')) {
		const nameMatch = line.match(/^name:\s*(.+)/);
		if (nameMatch) { name = nameMatch[1].trim().replace(/^["']|["']$/g, ''); inCapabilities = false; continue; }

		const descMatch = line.match(/^description:\s*(.+)/);
		if (descMatch) { description = descMatch[1].trim().replace(/^["']|["']$/g, ''); inCapabilities = false; continue; }

		const typeMatch = line.match(/^type:\s*(.+)/);
		if (typeMatch) { type = typeMatch[1].trim().replace(/^["']|["']$/g, ''); inCapabilities = false; continue; }

		const colorMatch = line.match(/^color:\s*(.+)/);
		if (colorMatch) { color = colorMatch[1].trim().replace(/^["']|["']$/g, ''); inCapabilities = false; continue; }

		const priorityMatch = line.match(/^priority:\s*(.+)/);
		if (priorityMatch) { priority = priorityMatch[1].trim().replace(/^["']|["']$/g, ''); inCapabilities = false; continue; }

		if (line.match(/^capabilities:/)) { inCapabilities = true; continue; }

		if (inCapabilities) {
			const capMatch = line.match(/^\s+-\s+(\S+)/);
			if (capMatch) { capabilities.push(capMatch[1]); continue; }
			if (!line.match(/^\s/) && line.trim()) inCapabilities = false;
		}
	}

	if (!name) return null;

	const relative = filePath.replace(/\\/g, '/').replace(agentsDir.replace(/\\/g, '/') + '/', '');
	const category = relative.split('/')[0] || 'uncategorized';

	return {
		name,
		category,
		description: description || 'No description available',
		filename: relative,
		type: type || 'general',
		status: 'idle' as const,
		color: color || undefined,
		capabilities: capabilities.length > 0 ? capabilities : undefined,
		priority: priority || undefined
	};
}

/** Scan agents directory and return full AgentDefinition objects. */
export async function scanAgents(agentsDir?: string): Promise<AgentDefinition[]> {
	const dir = agentsDir ?? PATHS.agentsDir;
	const mdFiles = await findMdFiles(dir);
	const agents: AgentDefinition[] = [];

	const fileContents = await Promise.all(
		mdFiles.map(async (filePath) => {
			try {
				const content = await readFile(filePath, 'utf-8');
				return { filePath, content };
			} catch {
				return null;
			}
		})
	);

	for (const result of fileContents) {
		if (!result) continue;
		const agent = parseAgentFrontmatter(result.content, result.filePath, dir);
		if (agent) agents.push(agent);
	}

	agents.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
	return agents;
}

/**
 * Scan agents directory returning lightweight AgentConfig objects.
 * Used by the /api/agents endpoint for CRUD operations.
 */
export async function scanAgentConfigs(dir: string, category: string): Promise<AgentConfig[]> {
	const agents: AgentConfig[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.md')) {
				try {
					const content = await readFile(resolve(dir, entry.name), 'utf-8');
					const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
					if (fmMatch) {
						const fm = fmMatch[1];
						const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? entry.name.replace('.md', '');
						const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
						const type = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? 'general';
						agents.push({ name, description: desc, type, category, file: `${category}/${entry.name}` });
					}
				} catch { /* skip unreadable */ }
			} else if (entry.isDirectory()) {
				const sub = await scanAgentConfigs(resolve(dir, entry.name), `${category}/${entry.name}`);
				agents.push(...sub);
			}
		}
	} catch { /* dir doesn't exist */ }
	return agents;
}

/** Resolve an agent filename to a safe absolute path under agentsDir. */
export function resolveAgentPath(filename: string): string {
	const sanitized = filename.replace(/\.\./g, '').replace(/^\/+/, '');
	return resolve(PATHS.agentsDir, sanitized);
}

/** List subdirectory names (categories) under the agents directory. */
export async function getCategories(agentsDir?: string): Promise<string[]> {
	const dir = agentsDir ?? PATHS.agentsDir;
	const cats: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) cats.push(entry.name);
		}
	} catch { /* */ }
	return cats.sort();
}

/** Parse generic YAML frontmatter and body from a markdown string. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: content };

	const endIdx = lines.indexOf('---', 1);
	if (endIdx === -1) return { frontmatter: {}, body: content };

	const fmLines = lines.slice(1, endIdx);
	const frontmatter: Record<string, string> = {};
	for (const line of fmLines) {
		const match = line.match(/^(\w[\w-]*):\s*(.+)/);
		if (match) {
			frontmatter[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
		}
	}

	const body = lines.slice(endIdx + 1).join('\n').trim();
	return { frontmatter, body };
}
