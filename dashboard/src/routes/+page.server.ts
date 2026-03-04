import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { getRunningModels } from '$lib/server/ollama-client.js';
import { PATHS } from '$lib/server/constants.js';
import type { V3Progress, Learning, SwarmActivity } from '$lib/types/metrics.js';
import type { RankedContext } from '$lib/types/memory.js';

export const load: PageServerLoad = async () => {
	const [v3Progress, learning, rankedContext, swarmActivity, runningModels] = await Promise.all([
		readJsonFile<V3Progress>(PATHS.v3Progress),
		readJsonFile<Learning>(PATHS.learning),
		readJsonFile<RankedContext>(PATHS.rankedContext),
		readJsonFile<SwarmActivity>(PATHS.swarmActivity),
		getRunningModels()
	]);

	const topEntries = (rankedContext?.entries ?? [])
		.sort((a, b) => b.pageRank - a.pageRank)
		.slice(0, 5);

	return {
		v3Progress,
		learning,
		topEntries,
		swarmActivity,
		runningModels
	};
};
