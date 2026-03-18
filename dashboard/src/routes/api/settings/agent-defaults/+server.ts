/**
 * Agent defaults API — default model, max concurrent agents, default topology.
 * Data stored at: .playground/agent-defaults.json (global) or project-scoped equivalent.
 */
import { json } from '@sveltejs/kit';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { scopedSettingsPath, type SettingsScope } from '$lib/server/constants.js';
import { loadAgentDefaults, AGENT_DEFAULTS, type AgentDefaultsSettings } from '$lib/server/agent-defaults.js';
import type { RequestHandler } from './$types.js';

const VALID_TOPOLOGIES = ['hierarchical', 'mesh', 'hierarchical-mesh', 'star', 'ring'];

function resolveFilePath(url: URL): string {
	const scope = (url.searchParams.get('scope') ?? 'global') as SettingsScope;
	const projectPath = url.searchParams.get('projectPath') ?? undefined;
	return scopedSettingsPath('agent-defaults.json', scope, projectPath);
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const filePath = resolveFilePath(url);
		const settings = await loadAgentDefaults(filePath);
		return json(settings);
	} catch (e) {
		console.error('[api/settings/agent-defaults] GET failed:', e);
		return json({ error: 'Failed to load agent defaults' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, url }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const maxAgents = typeof body.maxConcurrentAgents === 'number'
		? Math.max(1, Math.min(15, Math.floor(body.maxConcurrentAgents)))
		: AGENT_DEFAULTS.maxConcurrentAgents;

	const topology = typeof body.defaultTopology === 'string' && VALID_TOPOLOGIES.includes(body.defaultTopology)
		? body.defaultTopology
		: AGENT_DEFAULTS.defaultTopology;

	const settings: AgentDefaultsSettings = {
		defaultModel: typeof body.defaultModel === 'string' && body.defaultModel.trim()
			? body.defaultModel.trim()
			: AGENT_DEFAULTS.defaultModel,
		maxConcurrentAgents: maxAgents,
		defaultTopology: topology
	};

	try {
		const filePath = resolveFilePath(url);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(settings, null, '\t'), 'utf-8');
		return json({ ok: true });
	} catch (e) {
		console.error('[api/settings/agent-defaults] PUT failed:', e);
		return json({ error: 'Failed to save agent defaults' }, { status: 500 });
	}
};
