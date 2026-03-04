import { json } from '@sveltejs/kit';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { Learning } from '$lib/types/metrics.js';

export async function GET() {
	const data = await readJsonFile<Learning>(PATHS.learning);
	return json(data);
}
