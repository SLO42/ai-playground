import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';

interface ProjectSettings {
	name: string;
	description: string;
	branch: string;
	agentConfig: {
		topology: string;
		maxAgents: number;
		memoryBackend: string;
		consensus: string;
	};
	build: Record<string, { command: string; label: string }>;
}

function settingsPath(projectPath: string): string {
	return resolve(projectPath, '.playground', 'settings.json');
}

async function resolveProject(projectId: string) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	return projects.find((p) => p.id === projectId);
}

function defaultSettings(projectPath: string): ProjectSettings {
	return {
		name: projectPath.split(/[\\/]/).pop() ?? 'unknown',
		description: '',
		branch: 'main',
		agentConfig: {
			topology: 'hierarchical-mesh',
			maxAgents: 15,
			memoryBackend: 'hybrid (HNSW + SQLite)',
			consensus: 'raft'
		},
		build: {
			dev: { command: 'npm run dev', label: 'Development server' },
			build: { command: 'npm run build', label: 'Production build' },
			test: { command: 'npm test', label: 'Test suite' }
		}
	};
}

async function readSettings(projectPath: string): Promise<ProjectSettings> {
	try {
		const raw = await readFile(settingsPath(projectPath), 'utf-8');
		return { ...defaultSettings(projectPath), ...JSON.parse(raw) };
	} catch {
		return defaultSettings(projectPath);
	}
}

async function writeSettings(projectPath: string, data: ProjectSettings): Promise<void> {
	const dir = resolve(projectPath, '.playground');
	await mkdir(dir, { recursive: true });
	await writeFile(settingsPath(projectPath), JSON.stringify(data, null, '\t'), 'utf-8');
}

function validateSettings(body: unknown): { valid: true; data: ProjectSettings } | { valid: false; error: string } {
	if (!body || typeof body !== 'object') {
		return { valid: false, error: 'Request body must be an object' };
	}

	const b = body as Record<string, unknown>;

	if (typeof b.name !== 'string' || b.name.trim().length === 0) {
		return { valid: false, error: 'Project name is required' };
	}
	if (b.name.trim().length > 100) {
		return { valid: false, error: 'Project name must be 100 characters or fewer' };
	}
	if (typeof b.description !== 'string') {
		return { valid: false, error: 'Description must be a string' };
	}
	if (typeof b.branch !== 'string' || b.branch.trim().length === 0) {
		return { valid: false, error: 'Default branch is required' };
	}

	const ac = b.agentConfig;
	if (!ac || typeof ac !== 'object') {
		return { valid: false, error: 'agentConfig is required' };
	}
	const agent = ac as Record<string, unknown>;
	if (typeof agent.maxAgents !== 'number' || agent.maxAgents < 1 || agent.maxAgents > 100) {
		return { valid: false, error: 'Max agents must be between 1 and 100' };
	}

	return {
		valid: true,
		data: {
			name: b.name as string,
			description: (b.description as string) ?? '',
			branch: b.branch as string,
			agentConfig: {
				topology: (agent.topology as string) ?? 'hierarchical-mesh',
				maxAgents: agent.maxAgents as number,
				memoryBackend: (agent.memoryBackend as string) ?? 'hybrid (HNSW + SQLite)',
				consensus: (agent.consensus as string) ?? 'raft'
			},
			build: (b.build as Record<string, { command: string; label: string }>) ?? {}
		}
	};
}

/** GET /api/projects/[id]/settings */
export const GET: RequestHandler = async ({ params }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const settings = await readSettings(project.path);
	return json({ ...settings, path: project.path });
};

/** PUT /api/projects/[id]/settings */
export const PUT: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = await request.json();
	const result = validateSettings(body);

	if (!result.valid) {
		return json({ error: result.error }, { status: 400 });
	}

	await writeSettings(project.path, result.data);
	return json({ ok: true, settings: result.data });
};
