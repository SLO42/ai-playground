import type { PageServerLoad } from './$types.js';
import { readdir } from 'fs/promises';
import { resolve } from 'path';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { GatewayConfig, ChannelConfig } from '$lib/types/channels.js';
import type { SecurityPolicy } from '$lib/types/security.js';

export const load: PageServerLoad = async () => {
	const [gateway, policy, channelConfigs] = await Promise.all([
		readYamlFile<GatewayConfig>(PATHS.gatewayYaml),
		readYamlFile<SecurityPolicy>(PATHS.networkPolicy),
		loadAllChannels()
	]);

	// Keep twitch as a separate prop for backward compat (allowlist section uses it)
	const twitch = channelConfigs.find((c) => c.channel === 'twitch') ?? null;

	return { gateway, twitch, policy, channelConfigs };
};

async function loadAllChannels(): Promise<ChannelConfig[]> {
	try {
		const files = await readdir(PATHS.channelsDir);
		const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
		const configs = await Promise.all(
			yamlFiles.map((f) => readYamlFile<ChannelConfig>(resolve(PATHS.channelsDir, f)))
		);
		return configs.filter((c): c is ChannelConfig => c !== null);
	} catch {
		return [];
	}
}
