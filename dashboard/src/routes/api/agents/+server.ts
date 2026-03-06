import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAgentConfigs, resolveAgentPath } from '$lib/server/agent-scanner.js';

export const GET: RequestHandler = async ({ url }) => {
	const category = url.searchParams.get('category');
	const file = url.searchParams.get('file');
	const name = url.searchParams.get('name');

	// Read a specific agent file by relative path
	if (file) {
		const agentPath = resolveAgentPath(file);
		try {
			const content = await readFile(agentPath, 'utf-8');
			return json({ filename: file, content });
		} catch {
			return json({ error: 'Agent file not found' }, { status: 404 });
		}
	}

	// If requesting a specific agent by name
	if (name) {
		const agentPath = resolve(PATHS.agentsDir, name.endsWith('.md') ? name : `${name}.md`);
		try {
			const content = await readFile(agentPath, 'utf-8');
			return json({ name, content });
		} catch {
			const allAgents = await scanAgentConfigs(PATHS.agentsDir, '');
			const match = allAgents.find((a) => a.name === name);
			if (match) {
				const fullPath = resolve(PATHS.agentsDir, match.file);
				const content = await readFile(fullPath, 'utf-8');
				return json({ name: match.name, content, ...match });
			}
			return json({ error: 'Agent not found' }, { status: 404 });
		}
	}

	// List all agents with optional pagination and filtering
	let agents = await scanAgentConfigs(PATHS.agentsDir, '');

	// Filter by category
	if (category) {
		agents = agents.filter((a) =>
			a.category.includes(category) || a.type === category
		);
	}

	// Filter by search query
	const search = url.searchParams.get('search')?.toLowerCase();
	if (search) {
		agents = agents.filter((a) =>
			a.name.toLowerCase().includes(search) ||
			a.description.toLowerCase().includes(search) ||
			a.category.toLowerCase().includes(search)
		);
	}

	// Sort
	agents.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

	const total = agents.length;

	// Pagination
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('perPage') ?? '0', 10) || 0));

	let paginatedAgents = agents;
	let totalPages = 1;
	if (perPage > 0) {
		totalPages = Math.max(1, Math.ceil(total / perPage));
		const safePage = Math.min(page, totalPages);
		const start = (safePage - 1) * perPage;
		paginatedAgents = agents.slice(start, start + perPage);
	}

	// Build category groups
	const categories: Record<string, AgentConfig[]> = {};
	for (const agent of paginatedAgents) {
		const cat = agent.category.split('/')[0] || 'root';
		if (!categories[cat]) categories[cat] = [];
		categories[cat].push(agent);
	}

	return json({ agents: paginatedAgents, categories, total, page: perPage > 0 ? Math.min(page, totalPages) : 1, perPage: perPage || total, totalPages });
};

export const PUT: RequestHandler = async ({ request }) => {
	const { filename, content } = await request.json() as { filename: string; content: string };
	if (!filename || !content) {
		return json({ error: 'filename and content required' }, { status: 400 });
	}

	const agentPath = resolveAgentPath(filename);
	try {
		await readFile(agentPath, 'utf-8');
	} catch {
		return json({ error: 'Agent file not found' }, { status: 404 });
	}

	await writeFile(agentPath, content, 'utf-8');
	return json({ ok: true, filename });
};

export const POST: RequestHandler = async ({ request }) => {
	const { filename, content } = await request.json() as { filename: string; content: string };
	if (!filename || !content) {
		return json({ error: 'filename and content required' }, { status: 400 });
	}

	const agentPath = resolveAgentPath(filename);
	try {
		await readFile(agentPath, 'utf-8');
		return json({ error: 'Agent file already exists' }, { status: 409 });
	} catch {
		// File doesn't exist, good to create
	}

	await mkdir(dirname(agentPath), { recursive: true });
	await writeFile(agentPath, content, 'utf-8');
	return json({ ok: true, filename });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const file = url.searchParams.get('file');
	if (!file) {
		return json({ error: 'file parameter required' }, { status: 400 });
	}

	const agentPath = resolveAgentPath(file);
	try {
		await readFile(agentPath, 'utf-8');
	} catch {
		return json({ error: 'Agent file not found' }, { status: 404 });
	}

	await unlink(agentPath);
	return json({ ok: true, filename: file });
};
