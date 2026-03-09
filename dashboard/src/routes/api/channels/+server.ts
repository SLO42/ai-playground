import { json } from '@sveltejs/kit';
import { resolve } from 'path';
import { access, readdir } from 'fs/promises';
import { readYamlFile, writeYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS, isPathAllowed } from '$lib/server/constants.js';
import { CHANNEL_TEMPLATES, CHANNEL_NAME_MAP } from '$lib/server/channel-templates.js';
import type { GatewayConfig, ChannelConfig } from '$lib/types/channels.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async () => {
	const gateway = await readYamlFile<GatewayConfig>(PATHS.gatewayYaml);

	// Scan all channel YAML files in the channels directory
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
	} catch {
		// channelsDir may not exist yet
	}

	return json({ gateway, channels });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const name: string = body?.name;

	if (!name || typeof name !== 'string') {
		return json({ error: 'Missing channel name' }, { status: 400 });
	}

	const key = CHANNEL_NAME_MAP[name];
	if (!key) {
		return json({ error: `Unknown channel: ${name}` }, { status: 400 });
	}

	const template = CHANNEL_TEMPLATES[key];
	if (!template) {
		return json({ error: `No template for channel: ${key}` }, { status: 400 });
	}

	const filePath = resolve(PATHS.channelsDir, `${key}.yaml`);

	if (!isPathAllowed(filePath)) {
		return json({ error: 'Path not allowed' }, { status: 403 });
	}

	try {
		await access(filePath);
		return json({ error: `Channel config already exists: ${key}.yaml` }, { status: 409 });
	} catch {
		// File doesn't exist — good, we'll create it
	}

	await writeYamlFile(filePath, template.header, template.data);

	return json({ ok: true, file: `config/openclaw/channels/${key}.yaml` }, { status: 201 });
};
