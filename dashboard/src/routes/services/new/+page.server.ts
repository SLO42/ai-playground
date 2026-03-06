import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { readFile } from 'fs/promises';
import { resolve, join } from 'path';

export interface DetectedService {
	name: string;
	type: string;
	command: string;
	port: number | null;
	selected: boolean;
}

const CONFIG_FILES = ['.mcp-agents.json', '.mcp.json'];

async function detectFromMcpConfig(filePath: string): Promise<DetectedService[]> {
	try {
		const raw = await readFile(filePath, 'utf-8');
		const config = JSON.parse(raw);
		if (!config.mcpServers || typeof config.mcpServers !== 'object') return [];

		return Object.entries(config.mcpServers).map(([name, def]: [string, any]) => {
			const cmd = def.command
				? [def.command, ...(def.args ?? [])].join(' ')
				: '';
			return { name, type: 'MCP Server', command: cmd, port: null, selected: true };
		});
	} catch {
		return [];
	}
}

export const load: PageServerLoad = async () => {
	const projectRoot = resolve(PATHS.root);
	const services: DetectedService[] = [];
	const seen = new Set<string>();

	for (const file of CONFIG_FILES) {
		const found = await detectFromMcpConfig(join(projectRoot, file));
		for (const svc of found) {
			if (!seen.has(svc.name)) {
				seen.add(svc.name);
				services.push(svc);
			}
		}
	}

	return {
		detectedServices: services,
		defaultConfigDir: resolve(projectRoot, '.openclaw', 'services')
	};
};
