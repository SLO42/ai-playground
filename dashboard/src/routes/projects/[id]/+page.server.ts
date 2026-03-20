import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

async function checkHealth(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);

	if (!project) {
		return { overview: buildFallback(params.id) };
	}

	// Read config for services
	let configServices: { name: string; port?: number; healthUrl?: string }[] = [];
	try {
		const configPath = resolve(project.path, '.playground/config.json');
		const raw = await readFile(configPath, 'utf-8');
		const config = JSON.parse(raw);
		configServices = config.services ?? [];
	} catch {
		// no config services
	}

	const services = await Promise.all(
		configServices.map(async (s) => {
			const port = s.port ?? null;
			const healthUrl = s.healthUrl ?? (port ? `http://127.0.0.1:${port}/` : null);
			let status: 'running' | 'stopped' | 'unknown' = 'unknown';
			if (healthUrl) {
				status = (await checkHealth(healthUrl)) ? 'running' : 'stopped';
			}
			return { name: s.name, status, port };
		})
	);

	return {
		overview: {
			description: project.description,
			techStack: project.techStack,
			tags: project.tags,
			stats: {
				agents: project.agents,
				sessions: project.sessions,
				memoryNodes: project.memoryNodes,
				hooks: 0,
				channels: 0,
				models: 0
			},
			health: project.health,
			services,
			recentActivity: [],
			quickLinks: [
				{ label: 'Models', href: 'models', stat: '-', accent: 'blue' },
				{ label: 'Agents', href: 'agents', stat: `${project.agents} defined`, accent: 'green' },
				{ label: 'Channels', href: 'channels', stat: '-', accent: 'cyan' },
				{ label: 'Sessions', href: 'sessions', stat: `${project.sessions} files`, accent: 'purple' },
				{ label: 'Memory', href: 'memory', stat: `${project.memoryNodes} nodes`, accent: 'blue' },
				{ label: 'Hooks', href: 'hooks', stat: '-', accent: 'yellow' },
				{ label: 'Security', href: 'security', stat: '-', accent: 'green' },
				{ label: 'Apps & MCP', href: 'services', stat: `${services.length} services`, accent: 'cyan' },
				{ label: 'Pipelines', href: 'pipelines', stat: '-', accent: 'purple' },
				{ label: 'Releases', href: 'releases', stat: '-', accent: 'cyan' }
			]
		}
	};
};

function buildFallback(id: string) {
	return {
		description: `Project workspace for ${id}`,
		techStack: [],
		tags: [],
		stats: { agents: 0, sessions: 0, memoryNodes: 0, hooks: 0, channels: 0, models: 0 },
		health: 'unknown',
		services: [],
		recentActivity: [],
		quickLinks: [
			{ label: 'Models', href: 'models', stat: '-', accent: 'blue' },
			{ label: 'Agents', href: 'agents', stat: '-', accent: 'green' },
			{ label: 'Channels', href: 'channels', stat: '-', accent: 'cyan' },
			{ label: 'Sessions', href: 'sessions', stat: '-', accent: 'purple' },
			{ label: 'Memory', href: 'memory', stat: '-', accent: 'blue' },
			{ label: 'Hooks', href: 'hooks', stat: '-', accent: 'yellow' },
			{ label: 'Security', href: 'security', stat: '-', accent: 'green' },
			{ label: 'Apps & MCP', href: 'services', stat: '-', accent: 'cyan' },
			{ label: 'Pipelines', href: 'pipelines', stat: '-', accent: 'purple' },
			{ label: 'Releases', href: 'releases', stat: '-', accent: 'cyan' }
		]
	};
}
