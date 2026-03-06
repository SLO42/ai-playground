import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { GraphState } from '$lib/types/graph.js';
import type { RankedContext, AutoMemoryEntry } from '$lib/types/memory.js';

export const load: PageServerLoad = async () => {
	const [graph, context, autoMemory, config] = await Promise.allSettled([
		readJsonFile<GraphState>(PATHS.graphState),
		readJsonFile<RankedContext>(PATHS.rankedContext),
		readJsonFile<AutoMemoryEntry[]>(PATHS.autoMemoryStore),
		readYamlFile(PATHS.configYaml)
	]);
	const configVal = config.status === 'fulfilled' ? config.value : null;
	return {
		graph: graph.status === 'fulfilled' ? graph.value : null,
		context: context.status === 'fulfilled' ? context.value : null,
		autoMemory: autoMemory.status === 'fulfilled' ? autoMemory.value : null,
		memoryConfig: (configVal as Record<string, unknown>)?.memory ?? null
	};
};
