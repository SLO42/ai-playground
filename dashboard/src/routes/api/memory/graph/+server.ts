import { json } from '@sveltejs/kit';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { GraphState } from '$lib/types/graph.js';

export async function GET() {
	const graph = await readJsonFile<GraphState>(PATHS.graphState);
	return json(graph);
}
