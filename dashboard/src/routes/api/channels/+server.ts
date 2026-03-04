import { json } from '@sveltejs/kit';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { GatewayConfig, ChannelConfig } from '$lib/types/channels.js';

export async function GET() {
	const [gateway, twitch] = await Promise.all([
		readYamlFile<GatewayConfig>(PATHS.gatewayYaml),
		readYamlFile<ChannelConfig>(PATHS.twitchYaml)
	]);

	return json({ gateway, channels: [twitch].filter(Boolean) });
}
