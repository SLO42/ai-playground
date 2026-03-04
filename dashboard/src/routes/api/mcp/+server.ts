import { json } from '@sveltejs/kit';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';

export async function GET() {
	const mcp = await readJsonFile(PATHS.mcpJson);
	return json(mcp ?? { mcpServers: {} });
}
