import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

export const load: PageServerLoad = async ({ params }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);

	if (!project) {
		return { overview: buildFallback(params.id) };
	}

	// Read config for services
	let configServices: { name: string; port?: number }[] = [];
	try {
		const configPath = resolve(project.path, '.playground/config.json');
		const raw = await readFile(configPath, 'utf-8');
		const config = JSON.parse(raw);
		configServices = config.services ?? [];
	} catch {
		// no config services
	}

	const services = configServices.map((s) => ({
		name: s.name,
		status: 'offline' as const,
		port: s.port ?? null
	}));

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
				{ label: 'Apps & MCP', href: 'services', stat: `${services.length} services`, accent: 'cyan' }
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
			{ label: 'Apps & MCP', href: 'services', stat: '-', accent: 'cyan' }
		]
	};
}
