import type { PageServerLoad } from './$types.js';
import { readdir } from 'fs/promises';
import { resolve } from 'path';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { ChannelConfig } from '$lib/types/channels.js';

interface ChannelEntry {
	id: string;
	name: string;
	type: string;
	status: string;
	enabled: boolean;
	uptime: string;
	connectedAt?: string;
	description?: string;
}

interface ProjectChannelFile {
	channels: Array<{
		id: string;
		type: string;
		name: string;
		enabled: boolean;
		connectedAt: string;
		config?: Record<string, unknown>;
	}>;
}

/** Scan all available channel configs from the gateway channels directory */
async function scanGatewayChannels(): Promise<ChannelConfig[]> {
	const channels: ChannelConfig[] = [];
	try {
		const files = await readdir(PATHS.channelsDir);
		const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
		const results = await Promise.all(
			yamlFiles.map((f) => readYamlFile<ChannelConfig>(resolve(PATHS.channelsDir, f)).catch(() => null))
		);
		for (const ch of results) {
			if (ch) channels.push(ch);
		}
	} catch {
		/* channelsDir may not exist */
	}
	return channels;
}

function timeSince(dateStr?: string): string {
	if (!dateStr) return '--';
	const ms = Date.now() - new Date(dateStr).getTime();
	if (ms < 0) return '--';
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	const days = Math.floor(hrs / 24);
	return `${days}d`;
}

export const load: PageServerLoad = async ({ params }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	const projectPath = project?.path ?? PATHS.root;

	const channelsFilePath = resolve(projectPath, '.playground', 'channels.json');

	const [projectChannels, gatewayConfigs] = await Promise.all([
		readJsonFile<ProjectChannelFile>(channelsFilePath).then(
			(data) => data ?? { channels: [] }
		),
		scanGatewayChannels()
	]);

	// Build channel entries from project config, enriched with gateway data
	const gatewayMap = new Map(gatewayConfigs.map((g) => [g.channel, g]));
	const connectedChannels: ChannelEntry[] = projectChannels.channels.map((pc) => {
		const gw = gatewayMap.get(pc.id);
		return {
			id: pc.id,
			name: pc.name,
			type: pc.type,
			status: pc.enabled ? 'connected' : 'disconnected',
			enabled: pc.enabled,
			uptime: pc.enabled ? timeSince(pc.connectedAt) : '--',
			connectedAt: pc.connectedAt,
			description: (gw as Record<string, unknown>)?.description as string | undefined
		};
	});

	// Available (not yet connected) channels from gateway
	const connectedIds = new Set(projectChannels.channels.map((c) => c.id));
	const availableChannels = gatewayConfigs
		.filter((g) => !connectedIds.has(g.channel))
		.map((g) => ({
			id: g.channel,
			type: g.channel,
			name: g.channel.charAt(0).toUpperCase() + g.channel.slice(1),
			enabled: g.enabled,
			activation: g.activation,
			description: (g as Record<string, unknown>)?.description as string | null ?? null
		}));

	const connected = connectedChannels.filter((c) => c.status === 'connected').length;

	return {
		channels: connectedChannels,
		availableChannels,
		summary: {
			total: connectedChannels.length,
			connected,
			available: availableChannels.length
		}
	};
};
