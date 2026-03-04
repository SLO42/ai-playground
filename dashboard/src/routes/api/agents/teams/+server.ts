import { json } from '@sveltejs/kit';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';

interface Settings {
	agentTeams?: Record<string, unknown>;
	[key: string]: unknown;
}

export async function GET() {
	const settings = await readJsonFile<Settings>(PATHS.settingsJson);
	return json(settings?.agentTeams ?? {});
}
