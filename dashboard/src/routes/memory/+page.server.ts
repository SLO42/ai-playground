import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import { loadMemorySettings } from '$lib/server/memory-settings.js';
import type { GraphState } from '$lib/types/graph.js';
import type { RankedContext, AutoMemoryEntry, MemoryConfig, MemoryPageData } from '$lib/types/memory.js';

export const load: PageServerLoad = async (): Promise<MemoryPageData> => {
	const memSettings = await loadMemorySettings();
	const graphEnabled = memSettings.memoryGraphEnabled;

	const [graph, context, autoMemory, config] = await Promise.allSettled([
		graphEnabled ? readJsonFile<GraphState>(PATHS.graphState) : Promise.resolve(null),
		readJsonFile<RankedContext>(PATHS.rankedContext),
		readJsonFile<AutoMemoryEntry[]>(PATHS.autoMemoryStore),
		readYamlFile<{ memory?: MemoryConfig }>(PATHS.configYaml)
	]);
	const configVal = config.status === 'fulfilled' ? config.value : null;

	// Surface load errors so the UI can distinguish "no data" from "fetch failed"
	const errors: string[] = [];
	if (graph.status === 'rejected') errors.push(`Graph: ${graph.reason?.message ?? 'unknown error'}`);
	if (context.status === 'rejected') errors.push(`Context: ${context.reason?.message ?? 'unknown error'}`);
	if (autoMemory.status === 'rejected') errors.push(`AutoMemory: ${autoMemory.reason?.message ?? 'unknown error'}`);

	return {
		graph: graph.status === 'fulfilled' ? graph.value : null,
		context: context.status === 'fulfilled' ? context.value : null,
		autoMemory: autoMemory.status === 'fulfilled' ? autoMemory.value : null,
		memoryConfig: configVal?.memory ?? null,
		memoryGraphEnabled: graphEnabled,
		loadErrors: errors.length > 0 ? errors : null
	};
};
