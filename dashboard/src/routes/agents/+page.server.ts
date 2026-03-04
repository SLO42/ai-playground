import type { PageServerLoad } from './$types.js';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { AgentDefinition } from '$lib/types/agents.js';
import type { V3Progress, SwarmActivity } from '$lib/types/metrics.js';

async function findMdFiles(dir: string): Promise<string[]> {
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

	const relative = filePath.replace(/\\/g, '/').replace(agentsDir.replace(/\\/g, '/') + '/', '');
	const category = relative.split('/')[0] || 'uncategorized';

	return {
		name,
		category,
		description: description || 'No description available',
		filename: relative
	};
}

export const load: PageServerLoad = async () => {
	const agentsDir = PATHS.agentsDir;

	const [mdFiles, v3Progress, swarmActivity, swarmConfig] = await Promise.all([
		findMdFiles(agentsDir),
		readJsonFile<V3Progress>(PATHS.v3Progress),
		readJsonFile<SwarmActivity>(PATHS.swarmActivity),
		readYamlFile<Record<string, unknown>>(PATHS.configYaml)
	]);

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

	return {
		agents,
		swarmStatus: {
			active: swarmActivity?.swarm?.active ?? false,
			agentCount: swarmActivity?.swarm?.agent_count ?? 0,
			coordinationActive: swarmActivity?.swarm?.coordination_active ?? false,
			processes: swarmActivity?.processes ?? null
		},
		v3Progress: {
			activeAgents: v3Progress?.swarm?.activeAgents ?? 0,
			maxAgents: v3Progress?.swarm?.maxAgents ?? 15,
			topology: v3Progress?.swarm?.topology ?? 'hierarchical-mesh'
		},
		swarmConfig: swarmConfig ?? null
	};
};
