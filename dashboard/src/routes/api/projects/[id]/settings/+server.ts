/**
 * Per-project settings API — name, description, branch, agent config, build commands.
 * Data stored at: <projectPath>/.playground/settings.json.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { recordEvent } from '$lib/server/heartbeat/agent-analytics.js';

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
	try {
		const project = await resolveProject(params.id);
		if (!project) {
			return json({ error: 'Project not found' }, { status: 404 });
		}
		const settings = await readSettings(project.path);
		return json({ ...settings, path: project.path });
	} catch (e) {
		console.error('[api/projects/settings] GET failed:', e);
		return json({ error: 'Failed to load project settings' }, { status: 500 });
	}
};

async function handleSave(params: { id: string }, request: Request) {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json() as Record<string, unknown>;
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	// Merge with existing settings so callers can send partial updates
	const existing = await readSettings(project.path);

	// Normalize: frontend may wrap general fields in a `general` envelope
	const general = body.general as Record<string, unknown> | undefined;
	const normalized: Record<string, unknown> = {
		name: general?.name ?? body.name ?? existing.name,
		description: general?.description ?? body.description ?? existing.description,
		branch: general?.branch ?? body.branch ?? existing.branch,
		agentConfig: body.agentConfig ?? existing.agentConfig,
		build: body.build ?? existing.build
	};

	// Validate shape, required fields, and value ranges
	const result = validateSettings(normalized);
	if (!result.valid) {
		return json({ error: result.error }, { status: 400 });
	}
	const settings = result.data;

	await writeSettings(project.path, settings);

	// Track which top-level keys changed
	const keysChanged = (Object.keys(settings) as (keyof ProjectSettings)[]).filter(
		(k) => JSON.stringify(existing[k]) !== JSON.stringify(settings[k])
	);
	if (keysChanged.length > 0) {
		recordEvent({ type: 'settings_saved', projectId: params.id, keysChanged }).catch(() => {});
	}

	// Sync heartbeat + agent config into .playground/config.json so the heartbeat reads it
	try {
		const configPath = resolve(project.path, '.playground', 'config.json');
		let config: Record<string, unknown> = {};
		try {
			config = JSON.parse(await readFile(configPath, 'utf-8'));
		} catch { /* no config yet */ }

		// Sync agent maxAgents
		if (!config.agents || typeof config.agents !== 'object') config.agents = {};
		(config.agents as Record<string, unknown>).maxAgents = settings.agentConfig.maxAgents;

		// Sync heartbeat config (per-project automation control)
		// Validate shape: only allow known fields with correct types
		if (body.heartbeat && typeof body.heartbeat === 'object') {
			const hb = body.heartbeat as Record<string, unknown>;
			const PHASE_KEYS = ['taskScanning', 'agentSpawning', 'githubSync', 'reviewCycle', 'testing'] as const;
			const phases: Record<string, boolean> = {};
			if (hb.phases && typeof hb.phases === 'object' && !Array.isArray(hb.phases)) {
				const raw = hb.phases as Record<string, unknown>;
				for (const key of PHASE_KEYS) {
					if (typeof raw[key] === 'boolean') phases[key] = raw[key] as boolean;
				}
			}
			const maxAgents = typeof hb.maxAgents === 'number'
				? Math.max(1, Math.min(20, Math.floor(hb.maxAgents)))
				: undefined;

			const validated: Record<string, unknown> = {};
			if (typeof hb.enabled === 'boolean') validated.enabled = hb.enabled;
			if (Object.keys(phases).length > 0) validated.phases = phases;
			if (maxAgents !== undefined) validated.maxAgents = maxAgents;

			if (Object.keys(validated).length > 0) {
				config.heartbeat = { ...(typeof config.heartbeat === 'object' && config.heartbeat ? config.heartbeat : {}), ...validated };
			}
		}

		// Sync build commands
		config.buildCommand = settings.build?.build?.command;
		config.testCommand = settings.build?.test?.command;
		config.devCommand = settings.build?.dev?.command;

		await mkdir(resolve(project.path, '.playground'), { recursive: true });
		await writeFile(configPath, JSON.stringify(config, null, '\t'), 'utf-8');
	} catch { /* best effort */ }

	return json({ ok: true, settings });
}

/** PUT /api/projects/[id]/settings */
export const PUT: RequestHandler = async ({ params, request }) => {
	try {
		return await handleSave(params, request);
	} catch (e) {
		console.error('[api/projects/settings] PUT failed:', e);
		return json({ error: 'Failed to save project settings' }, { status: 500 });
	}
};

/** POST /api/projects/[id]/settings — same as PUT, for frontend compatibility */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		return await handleSave(params, request);
	} catch (e) {
		console.error('[api/projects/settings] POST failed:', e);
		return json({ error: 'Failed to save project settings' }, { status: 500 });
	}
};
