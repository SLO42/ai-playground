import { json } from '@sveltejs/kit';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';

export async function GET() {
	const settings = await readJsonFile<any>(PATHS.settingsJson);
	return json({
		hooks: settings?.hooks ?? {},
		daemon: settings?.claudeFlow?.daemon ?? null,
		learning: settings?.claudeFlow?.learning ?? null
	});
}
