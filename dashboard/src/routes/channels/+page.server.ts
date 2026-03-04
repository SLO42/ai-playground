import type { PageServerLoad } from './$types.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { GatewayConfig, ChannelConfig } from '$lib/types/channels.js';
import type { SecurityPolicy } from '$lib/types/security.js';

export const load: PageServerLoad = async () => {
	const [gateway, twitch, policy] = await Promise.all([
		readYamlFile<GatewayConfig>(PATHS.gatewayYaml),
		readYamlFile<ChannelConfig>(PATHS.twitchYaml),
		readYamlFile<SecurityPolicy>(PATHS.networkPolicy)
	]);

	return { gateway, twitch, policy };
};
