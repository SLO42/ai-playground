import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { AgentInfo, AgentStatus } from '$lib/types/agents.js';
import { populateForProject, getProjectPoolStats, resetProjectPool } from '$lib/server/heartbeat/session-pool.js';
import { getActiveAgents, maxConcurrentAgents, loadProjectMaxAgents } from '$lib/server/heartbeat/shared.js';

interface ProjectAgentAssociation {
	agents: string[]; // agent filenames relative to agentsDir
}

function associationPath(projectPath: string): string {
	return resolve(projectPath, '.playground', 'agents.json');
}

async function readAssociation(projectPath: string): Promise<ProjectAgentAssociation> {
	try {
		const raw = await readFile(associationPath(projectPath), 'utf-8');
		return JSON.parse(raw);
	} catch {
		return { agents: [] };
	}
}

async function writeAssociation(projectPath: string, data: ProjectAgentAssociation): Promise<void> {
	const dir = resolve(projectPath, '.playground');
	await mkdir(dir, { recursive: true });
	await writeFile(associationPath(projectPath), JSON.stringify(data, null, '\t'), 'utf-8');
}

async function resolveProject(projectId: string) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	return projects.find((p) => p.id === projectId);
}

async function scanAvailableAgents(): Promise<AgentInfo[]> {
	const agents: AgentInfo[] = [];

	async function scan(dir: string, prefix: string) {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					await scan(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
				} else if (entry.name.endsWith('.md')) {
					try {
						const content = await readFile(join(dir, entry.name), 'utf-8');
						const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
						if (fmMatch) {
							const fm = fmMatch[1];
							const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? entry.name.replace('.md', '');
							const type = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? 'general';
							const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
							const filename = prefix ? `${prefix}/${entry.name}` : entry.name;
							agents.push({ name, type, description: desc, filename });
						}
					} catch { /* skip */ }
				}
			}
		} catch { /* dir missing */ }
	}

	await scan(PATHS.agentsDir, '');
	return agents;
}

/** GET /api/projects/[id]/agents — list agents associated with this project */
export const GET: RequestHandler = async ({ params, url }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '10', 10) || 10));

	const [association, allAgents, projectMaxAgents] = await Promise.all([
		readAssociation(project.path),
		scanAvailableAgents(),
		loadProjectMaxAgents(project.path, params.id)
	]);

	const associatedSet = new Set(association.agents);
	const associated = allAgents.filter((a) => associatedSet.has(a.filename));
	const available = allAgents.filter((a) => !associatedSet.has(a.filename));

	const typeCounts: Record<string, number> = {};
	for (const a of associated) {
		typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
	}

	const totalAssociated = associated.length;
	const totalPages = Math.max(1, Math.ceil(totalAssociated / pageSize));
	const safePage = Math.min(page, totalPages);
	const startIndex = (safePage - 1) * pageSize;
	const paginatedAgents = associated.slice(startIndex, startIndex + pageSize);

	return json({
		agents: paginatedAgents,
		availableAgents: available,
		summary: {
			associated: totalAssociated,
			available: available.length,
			total: allAgents.length,
			types: Object.keys(typeCounts).length
		},
		capacity: { current: totalAssociated, max: projectMaxAgents },
		pagination: {
			page: safePage,
			pageSize,
			totalItems: totalAssociated,
			totalPages
		}
	});
};

/** POST /api/projects/[id]/agents — add agent(s) to project */
export const POST: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = await request.json() as { agents: string[] };
	if (!body.agents || !Array.isArray(body.agents) || body.agents.length === 0) {
		return json({ error: 'agents array required' }, { status: 400 });
	}

	const association = await readAssociation(project.path);
	const added: string[] = [];
	for (const filename of body.agents) {
		if (typeof filename === 'string' && !association.agents.includes(filename)) {
			association.agents.push(filename);
			added.push(filename);
		}
	}

	await writeAssociation(project.path, association);
	return json({ ok: true, added, total: association.agents.length });
};

/** DELETE /api/projects/[id]/agents — remove agent(s) from project */
export const DELETE: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = await request.json() as { agents: string[] };
	if (!body.agents || !Array.isArray(body.agents) || body.agents.length === 0) {
		return json({ error: 'agents array required' }, { status: 400 });
	}

	const association = await readAssociation(project.path);
	const toRemove = new Set(body.agents);
	association.agents = association.agents.filter((a) => !toRemove.has(a));

	await writeAssociation(project.path, association);
	return json({ ok: true, removed: body.agents, total: association.agents.length });
};

/** PUT /api/projects/[id]/agents — manage project session pool */
export const PUT: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = await request.json() as { action: string };

	switch (body.action) {
		case 'spawn-pool': {
			const association = await readAssociation(project.path);
			if (association.agents.length === 0) {
				return json({ error: 'No agents associated with this project. Add agents first.' }, { status: 400 });
			}

			const activeAgents = getActiveAgents();
			if (activeAgents.size >= maxConcurrentAgents) {
				return json({
					error: `Pool is at capacity (${activeAgents.size}/${maxConcurrentAgents} agents running). Stop some agents before spawning more.`
				}, { status: 400 });
			}

			const allAgents = await scanAvailableAgents();
			const associatedSet = new Set(association.agents);
			const projectAgents = allAgents
				.filter(a => associatedSet.has(a.filename))
				.map(a => ({ filename: a.filename, name: a.name, type: a.type }));

			try {
				const result = await populateForProject(params.id, projectAgents);
				const pool = await getProjectPoolStats(params.id);
				return json({ success: true, ...result, pool });
			} catch (e) {
				return json({ error: e instanceof Error ? e.message : 'Failed to spawn pool' }, { status: 500 });
			}
		}
		case 'reset-pool': {
			await resetProjectPool(params.id);
			const pool = await getProjectPoolStats(params.id);
			return json({ success: true, pool });
		}
		case 'pool-stats': {
			const pool = await getProjectPoolStats(params.id);
			return json(pool);
		}
		default:
			return json({ error: `Unknown action: ${body.action}` }, { status: 400 });
	}
};
