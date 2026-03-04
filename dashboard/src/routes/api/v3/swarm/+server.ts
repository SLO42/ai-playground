import { json } from '@sveltejs/kit';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { SwarmActivity } from '$lib/types/metrics.js';

export async function GET() {
	const data = await readJsonFile<SwarmActivity>(PATHS.swarmActivity);
	return json(data);
}
