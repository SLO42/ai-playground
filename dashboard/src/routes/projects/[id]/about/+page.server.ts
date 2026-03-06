import type { PageServerLoad } from './$types.js';
import { readFile, readdir } from 'fs/promises';
import { resolve } from 'path';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { getAllTasks } from '$lib/server/task-store.js';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { projectId, project } = await parent();
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const proj = projects.find((p) => p.id === params.id);
	const projectPath = proj?.path ?? PATHS.root;

	// Read package.json for version/description
	let pkgName = project.name;
	let pkgVersion = 'unknown';
	let pkgDescription = '';
	try {
		const raw = await readFile(resolve(projectPath, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		pkgName = pkg.name ?? project.name;
		pkgVersion = pkg.version ?? 'unknown';
		pkgDescription = pkg.description ?? '';
	} catch {
		// no package.json
	}

	// Detect tech stack from project scanner data
	const techStack = proj?.techStack ?? [];

	// Check MCP servers from .mcp-agents.json
	const mcpServers: { name: string; status: string; description: string }[] = [];
	try {
		const raw = await readFile(resolve(PATHS.root, '.mcp-agents.json'), 'utf-8');
		const mcp = JSON.parse(raw);
		const servers = mcp.mcpServers ?? mcp.servers ?? {};
		for (const [name, cfg] of Object.entries(servers)) {
			const c = cfg as any;
			mcpServers.push({
				name,
				status: 'configured',
				description: c.command ? `${c.command} ${(c.args ?? []).slice(0, 2).join(' ')}` : 'MCP Server'
			});
		}
	} catch {
		// no mcp config
	}

	// Check core service health
	const coreTech: { name: string; version: string; status: string; badge: string }[] = [];
	for (const [, svc] of Object.entries(SERVICES)) {
		let status = 'stopped';
		if (svc.healthUrl) {
			try {
				const res = await fetch(svc.healthUrl, { signal: AbortSignal.timeout(2000) });
				status = (res.ok || res.status < 500) ? 'running' : 'stopped';
			} catch {
				status = 'stopped';
			}
		}
		coreTech.push({
			name: svc.name,
			version: svc.type,
			status,
			badge: svc.type.toLowerCase()
		});
	}

	// Read channel configs
	const channels: { name: string; status: string; badge: string }[] = [];
	try {
		const entries = await readdir(PATHS.channelsDir);
		for (const file of entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
			const name = file.replace(/\.(yaml|yml)$/, '');
			channels.push({ name: name.charAt(0).toUpperCase() + name.slice(1), status: 'configured', badge: 'channel' });
		}
	} catch {
		// no channels dir
	}

	// Read tasks
	let tasks: { id: string; title: string; priority: string; status: string; description: string }[] = [];
	try {
		const allTasks = await getAllTasks(projectPath);
		tasks = allTasks.slice(0, 10).map((t: any) => ({
			id: t.id ?? '',
			title: t.title ?? '',
			priority: t.priority ?? 'medium',
			status: t.status ?? 'pending',
			description: t.description ?? ''
		}));
	} catch {
		// no tasks
	}

	// Detect languages from tech stack
	const langMap: Record<string, { color: string }> = {
		typescript: { color: 'accent-blue' },
		javascript: { color: 'accent-yellow' },
		svelte: { color: 'accent-red' },
		python: { color: 'accent-green' },
		rust: { color: 'accent-purple' },
		go: { color: 'accent-cyan' }
	};
	const languages = techStack
		.filter((t) => langMap[t.toLowerCase()])
		.map((t, i) => ({
			name: t,
			files: 0,
			pct: 0,
			color: langMap[t.toLowerCase()]?.color ?? 'accent-blue'
		}));

	return {
		identity: {
			name: pkgName,
			version: `v${pkgVersion}`,
			description: pkgDescription || proj?.description || 'No description',
			status: proj?.health ?? 'unknown'
		},
		coreTech,
		languages,
		frameworks: techStack.filter((t) => !langMap[t.toLowerCase()]),
		tools: mcpServers.map((s) => s.name),
		mcpServers,
		channels,
		tasks
	};
};
