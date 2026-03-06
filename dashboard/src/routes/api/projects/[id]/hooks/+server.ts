import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';

interface Hook {
	name: string;
	type: string;
	description: string;
	enabled: boolean;
	command?: string;
}

interface HooksData {
	hooks: Hook[];
}

function hooksPath(projectPath: string): string {
	return resolve(projectPath, '.playground', 'hooks.json');
}

async function readHooks(projectPath: string): Promise<HooksData> {
	try {
		const raw = await readFile(hooksPath(projectPath), 'utf-8');
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.hooks)) {
			return { hooks: [] };
		}
		return { hooks: parsed.hooks };
	} catch {
		return { hooks: [] };
	}
}

async function writeHooks(projectPath: string, data: HooksData): Promise<void> {
	const dir = resolve(projectPath, '.playground');
	await mkdir(dir, { recursive: true });
	await writeFile(hooksPath(projectPath), JSON.stringify(data, null, '\t'), 'utf-8');
}

async function resolveProject(projectId: string) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	return projects.find((p) => p.id === projectId);
}

/** GET /api/projects/[id]/hooks — list hooks for this project */
export const GET: RequestHandler = async ({ params }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const data = await readHooks(project.path);
	return json({ hooks: data.hooks, total: data.hooks.length });
};

/** POST /api/projects/[id]/hooks — add a hook */
export const POST: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = (await request.json()) as Hook;
	if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
		return json({ error: 'name is required' }, { status: 400 });
	}
	if (!body.type || typeof body.type !== 'string' || !body.type.trim()) {
		return json({ error: 'type is required' }, { status: 400 });
	}
	body.name = body.name.trim();
	body.type = body.type.trim();

	const data = await readHooks(project.path);

	if (data.hooks.some((h) => h.name === body.name)) {
		return json({ error: `Hook "${body.name}" already exists` }, { status: 409 });
	}

	const hook: Hook = {
		name: body.name,
		type: body.type,
		description: body.description || '',
		enabled: body.enabled !== false,
		command: body.command || ''
	};

	data.hooks.push(hook);
	await writeHooks(project.path, data);
	return json({ ok: true, hook, total: data.hooks.length });
};

/** DELETE /api/projects/[id]/hooks — remove a hook by name */
export const DELETE: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = (await request.json()) as { name: string };
	if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
		return json({ error: 'name is required' }, { status: 400 });
	}
	body.name = body.name.trim();

	const data = await readHooks(project.path);
	const before = data.hooks.length;
	data.hooks = data.hooks.filter((h) => h.name !== body.name);

	if (data.hooks.length === before) {
		return json({ error: `Hook "${body.name}" not found` }, { status: 404 });
	}

	await writeHooks(project.path, data);
	return json({ ok: true, removed: body.name, total: data.hooks.length });
};

/** PATCH /api/projects/[id]/hooks — update a hook by name */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = (await request.json()) as Partial<Hook> & { name: string };
	if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
		return json({ error: 'name is required' }, { status: 400 });
	}
	body.name = body.name.trim();

	const data = await readHooks(project.path);
	const hook = data.hooks.find((h) => h.name === body.name);
	if (!hook) {
		return json({ error: `Hook "${body.name}" not found` }, { status: 404 });
	}

	if (typeof body.type === 'string') hook.type = body.type;
	if (typeof body.description === 'string') hook.description = body.description;
	if (typeof body.enabled === 'boolean') hook.enabled = body.enabled;
	if (typeof body.command === 'string') hook.command = body.command;

	await writeHooks(project.path, data);
	return json({ ok: true, hook, total: data.hooks.length });
};
