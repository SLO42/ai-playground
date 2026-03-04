import { json } from '@sveltejs/kit';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { SecurityPolicy } from '$lib/types/security.js';

export async function GET() {
	const data = await readYamlFile<SecurityPolicy>(PATHS.networkPolicy);
	return json(data);
}
