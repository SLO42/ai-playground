import { json, error } from '@sveltejs/kit';
import { resolve } from 'path';
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import type { ChannelConfig } from '$lib/types/channels.js';

interface ProjectChannelEntry {
	id: string;
	type: string;
	name: string;
	enabled: boolean;
	connectedAt: string;
	config?: Record<string, unknown>;
}

interface ProjectChannelsFile {
	channels: ProjectChannelEntry[];
}

async function getProjectPath(id: string): Promise<string> {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === id);
	if (!project) throw error(404, 'Project not found');
	return project.path;
}

async function readProjectChannels(projectPath: string): Promise<ProjectChannelsFile> {
	try {
		const raw = await readFile(resolve(projectPath, '.playground', 'channels.json'), 'utf-8');
		return JSON.parse(raw);
	} catch {
		return { channels: [] };
	}
}

async function writeProjectChannels(projectPath: string, data: ProjectChannelsFile): Promise<void> {
	const dir = resolve(projectPath, '.playground');
	await mkdir(dir, { recursive: true });
	await writeFile(resolve(dir, 'channels.json'), JSON.stringify(data, null, '\t'), 'utf-8');
}

/** Scan all available channel configs from the gateway channels directory */
async function getAvailableChannels(): Promise<ChannelConfig[]> {
	const channels: ChannelConfig[] = [];
	try {
		const files = await readdir(PATHS.channelsDir);
		const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
		const results = await Promise.all(
			yamlFiles.map(f => readYamlFile<ChannelConfig>(resolve(PATHS.channelsDir, f)).catch(() => null))
		);
		for (const ch of results) {
			if (ch) channels.push(ch);
		}
	} catch { /* channelsDir may not exist */ }
	return channels;
}

/** GET — list project channels + available channels to connect */
export async function GET({ params, url }) {
	const projectPath = await getProjectPath(params.id);
	const projectData = await readProjectChannels(projectPath);

	if (url.searchParams.get('available') === 'true') {
		const available = await getAvailableChannels();
		const connectedIds = new Set(projectData.channels.map(c => c.id));
		return json({
			connected: projectData.channels,
			available: available
				.filter(ch => !connectedIds.has(ch.channel))
				.map(ch => ({
					id: ch.channel,
					type: (ch as any).type ?? ch.channel,
					name: ch.channel.charAt(0).toUpperCase() + ch.channel.slice(1),
					enabled: ch.enabled,
					activation: ch.activation,
					description: (ch as any).description ?? null
				}))
		});
	}

	return json({ channels: projectData.channels });
}

/** POST — connect a channel to this project */
export async function POST({ params, request }) {
	const projectPath = await getProjectPath(params.id);
	const body = await request.json();
	const channelId: string = body?.channelId;
	const displayName: string = body?.name;

	if (!channelId || typeof channelId !== 'string') {
		return json({ error: 'Missing channelId' }, { status: 400 });
	}

	// Verify channel exists in gateway config
	const available = await getAvailableChannels();
	const channelDef = available.find(ch => ch.channel === channelId);
	if (!channelDef) {
		return json({ error: `Channel not found: ${channelId}` }, { status: 404 });
	}

	const data = await readProjectChannels(projectPath);

	// Check not already connected
	if (data.channels.some(c => c.id === channelId)) {
		return json({ error: `Channel already connected: ${channelId}` }, { status: 409 });
	}

	const entry: ProjectChannelEntry = {
		id: channelId,
		type: (channelDef as any).type ?? channelId,
		name: displayName || channelId.charAt(0).toUpperCase() + channelId.slice(1),
		enabled: true,
		connectedAt: new Date().toISOString(),
		config: body?.config
	};

	data.channels.push(entry);
	await writeProjectChannels(projectPath, data);

	return json({ ok: true, channel: entry }, { status: 201 });
}

/** DELETE — disconnect a channel from this project */
export async function DELETE({ params, request }) {
	const projectPath = await getProjectPath(params.id);
	const body = await request.json();
	const channelId: string = body?.channelId;

	if (!channelId) {
		return json({ error: 'Missing channelId' }, { status: 400 });
	}

	const data = await readProjectChannels(projectPath);
	const idx = data.channels.findIndex(c => c.id === channelId);
	if (idx === -1) {
		return json({ error: `Channel not connected: ${channelId}` }, { status: 404 });
	}

	data.channels.splice(idx, 1);
	await writeProjectChannels(projectPath, data);

	return json({ ok: true });
}

/** PATCH — update a channel's config or toggle enabled */
export async function PATCH({ params, request }) {
	const projectPath = await getProjectPath(params.id);
	const body = await request.json();
	const channelId: string = body?.channelId;

	if (!channelId) {
		return json({ error: 'Missing channelId' }, { status: 400 });
	}

	const data = await readProjectChannels(projectPath);
	const channel = data.channels.find(c => c.id === channelId);
	if (!channel) {
		return json({ error: `Channel not connected: ${channelId}` }, { status: 404 });
	}

	if (typeof body.enabled === 'boolean') channel.enabled = body.enabled;
	if (typeof body.name === 'string') channel.name = body.name;
	if (body.config && typeof body.config === 'object') {
		channel.config = { ...channel.config, ...body.config };
	}

	await writeProjectChannels(projectPath, data);

	return json({ ok: true, channel });
}
