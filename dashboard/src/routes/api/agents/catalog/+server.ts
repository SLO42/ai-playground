import { json } from '@sveltejs/kit';
import { readdir, readFile } from 'fs/promises';
import { resolve, join } from 'path';
import { PATHS } from '$lib/server/constants.js';
import type { AgentDefinition } from '$lib/types/agents.js';

let cache: { data: AgentDefinition[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

async function findMdFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await findMdFiles(fullPath)));
		} else if (entry.name.endsWith('.md')) {
			results.push(fullPath);
		}
	}
	return results;
}

function parseAgentFrontmatter(content: string, filePath: string, agentsDir: string): AgentDefinition | null {
	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return null;

	const endIdx = lines.indexOf('---', 1);
	if (endIdx === -1) return null;

	const frontmatter = lines.slice(1, endIdx).join('\n');

	let name = '';
	let description = '';

	for (const line of frontmatter.split('\n')) {
		const nameMatch = line.match(/^name:\s*(.+)/);
		if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '');

		const descMatch = line.match(/^description:\s*(.+)/);
		if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
	}

	if (!name) return null;

	// Category is the first subdirectory under agents/
	const relative = filePath.replace(/\\/g, '/').replace(agentsDir.replace(/\\/g, '/') + '/', '');
	const category = relative.split('/')[0] || 'uncategorized';

	return {
		name,
		category,
		description: description || 'No description available',
		filename: relative
	};
}

export async function GET() {
	if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
		return json(cache.data);
	}

	try {
		const agentsDir = PATHS.agentsDir;
		const mdFiles = await findMdFiles(agentsDir);
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
			const agent = parseAgentFrontmatter(result.content, result.filePath, agentsDir);
			if (agent) agents.push(agent);
		}

		agents.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

		cache = { data: agents, timestamp: Date.now() };
		return json(agents);
	} catch {
		return json([], { status: 500 });
	}
}
