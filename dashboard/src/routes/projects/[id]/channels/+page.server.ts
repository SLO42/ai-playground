import type { PageServerLoad } from './$types.js';
import { readFile, readdir } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import type { ChannelConfig } from '$lib/types/channels.js';

interface ChannelEntry {
	id: string;
	name: string;
	type: string;
	status: string;
	enabled: boolean;
	messages: number;
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

async function readProjectChannels(projectPath: string): Promise<{ data: ProjectChannelFile; error: string | null }> {
	try {
		const raw = await readFile(resolve(projectPath, '.playground', 'channels.json'), 'utf-8');
		return { data: JSON.parse(raw), error: null };
	} catch (err: unknown) {
		const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
		return {
			data: { channels: [] },
			error: isNotFound ? null : `Failed to read channels: ${err instanceof Error ? err.message : 'Unknown error'}`
		};
	}
}

/** Scan all available channel configs from the gateway channels directory */
async function scanGatewayChannels(): Promise<ChannelConfig[]> {
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

export const load: PageServerLoad = async ({ params, url }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	const projectPath = project?.path ?? PATHS.root;

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
	const perPage = Math.max(1, Math.min(50, parseInt(url.searchParams.get('perPage') ?? '12', 10)));
	const typeFilter = url.searchParams.get('type') ?? '';

	const [{ data, error: readError }, gatewayConfigs] = await Promise.all([
		readProjectChannels(projectPath),
		scanGatewayChannels()
	]);

	// Build channel entries from project config, enriched with gateway data
	const gatewayMap = new Map(gatewayConfigs.map(g => [g.channel, g]));
	const connectedChannels: ChannelEntry[] = data.channels.map(pc => {
		const gw = gatewayMap.get(pc.id);
		return {
			id: pc.id,
			name: pc.name,
			type: pc.type,
			status: pc.enabled ? 'connected' : 'disconnected',
			enabled: pc.enabled,
			messages: 0,
			uptime: pc.enabled ? timeSince(pc.connectedAt) : '—',
			connectedAt: pc.connectedAt,
			description: (gw as any)?.description ?? undefined
		};
	});

	// Available (not yet connected) channels from gateway
	const connectedIds = new Set(data.channels.map(c => c.id));
	const availableChannels = gatewayConfigs
		.filter(g => !connectedIds.has(g.channel))
		.map(g => ({
			id: g.channel,
			type: (g as any).type ?? g.channel,
			name: g.channel.charAt(0).toUpperCase() + g.channel.slice(1),
			enabled: g.enabled,
			activation: g.activation,
			description: (g as any).description ?? null
		}));

	// Apply type filter
	const filtered = typeFilter
		? connectedChannels.filter((c) => c.type === typeFilter)
		: connectedChannels;

	// Pagination
	const total = filtered.length;
	const totalPages = Math.max(1, Math.ceil(total / perPage));
	const safePage = Math.min(page, totalPages);
	const offset = (safePage - 1) * perPage;
	const channels = filtered.slice(offset, offset + perPage);

	const connected = connectedChannels.filter((c) => c.status === 'connected').length;
	const types = [...new Set(connectedChannels.map((c) => c.type))].sort();

	return {
		channels,
		availableChannels,
		summary: {
			total: connectedChannels.length,
			connected,
			available: availableChannels.length,
			messages: 0
		},
		pagination: { page: safePage, perPage, total, totalPages },
		types,
		typeFilter,
		loadError: readError
	};
};

function timeSince(dateStr?: string): string {
	if (!dateStr) return '—';
	const ms = Date.now() - new Date(dateStr).getTime();
	if (ms < 0) return '—';
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	const days = Math.floor(hrs / 24);
	return `${days}d`;
}
