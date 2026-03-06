import { json } from '@sveltejs/kit';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { RankedContext, AutoMemoryEntry, MemoryContextResponse } from '$lib/types/memory.js';

export async function GET() {
	const [context, autoMemory] = await Promise.all([
		readJsonFile<RankedContext>(PATHS.rankedContext),
		readJsonFile<AutoMemoryEntry[]>(PATHS.autoMemoryStore)
	]);
	const body: MemoryContextResponse = { context, autoMemory };
	return json(body);
}
