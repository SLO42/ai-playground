import type { PageServerLoad } from './$types.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';

interface ChannelEntry {
	name: string;
	type: string;
	status: string;
	messages: number;
	uptime: string;
}

interface ProjectChannelData {
	channels: ChannelEntry[];
	dmPolicy: { mode: string; approvalRequired: boolean; pairingTimeout: string; maxSessions: number };
	allowlist: Array<{ username: string; platform: string; role: string; added: string }>;
	recentMessages: Array<{ channel: string; user: string; message: string; time: string }>;
}

async function readProjectChannels(projectPath: string): Promise<{ data: ProjectChannelData; error: string | null }> {
	try {
		const raw = await readFile(resolve(projectPath, '.playground', 'channels.json'), 'utf-8');
		return { data: JSON.parse(raw), error: null };
	} catch (err: unknown) {
		const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
		return {
			data: {
				channels: [],
				dmPolicy: { mode: 'pairing', approvalRequired: true, pairingTimeout: '5m', maxSessions: 3 },
				allowlist: [],
				recentMessages: []
			},
			error: isNotFound ? null : `Failed to read channels: ${err instanceof Error ? err.message : 'Unknown error'}`
		};
	}
}

export const load: PageServerLoad = async ({ params, url }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	const projectPath = project?.path ?? PATHS.root;

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
	const perPage = Math.max(1, Math.min(50, parseInt(url.searchParams.get('perPage') ?? '12', 10)));
	const typeFilter = url.searchParams.get('type') ?? '';

	const { data, error: readError } = await readProjectChannels(projectPath);

	// Also try to discover gateway channels from config
	let gatewayChannels: ChannelEntry[] = [];
	try {
		const twitchConfig = await readYamlFile<Record<string, unknown>>(PATHS.twitchYaml);
		if (twitchConfig) {
			gatewayChannels.push({
				name: String((twitchConfig as any)?.channel?.name ?? 'twitch'),
				type: 'twitch',
				status: 'disconnected',
				messages: 0,
				uptime: '—'
			});
		}
	} catch { /* no gateway channels */ }

	// Merge project channels with gateway-discovered channels (avoid dupes)
	const allChannels = [...data.channels];
	for (const gc of gatewayChannels) {
		if (!allChannels.some((c) => c.name === gc.name && c.type === gc.type)) {
			allChannels.push(gc);
		}
	}

	// Apply type filter
	const filtered = typeFilter
		? allChannels.filter((c) => c.type === typeFilter)
		: allChannels;

	// Pagination
	const total = filtered.length;
	const totalPages = Math.max(1, Math.ceil(total / perPage));
	const safePage = Math.min(page, totalPages);
	const offset = (safePage - 1) * perPage;
	const channels = filtered.slice(offset, offset + perPage);

	const connected = allChannels.filter((c) => c.status === 'connected').length;
	const totalMessages = allChannels.reduce((sum, c) => sum + (c.messages ?? 0), 0);
	const types = [...new Set(allChannels.map((c) => c.type))].sort();

	return {
		channels,
		summary: {
			total: allChannels.length,
			connected,
			messages: totalMessages,
			users: data.allowlist.length
		},
		pagination: { page: safePage, perPage, total, totalPages },
		types,
		typeFilter,
		dmPolicy: data.dmPolicy,
		allowlist: data.allowlist,
		recentMessages: data.recentMessages,
		loadError: readError
	};
};
