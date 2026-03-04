import type { PageServerLoad } from './$types.js';
import { getModels, getRunningModels } from '$lib/server/ollama-client.js';
import { readTextFile, readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { ModelsConfig } from '$lib/types/models.js';

function parseJson5(raw: string): ModelsConfig | null {
	try {
		const stripped = raw
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('//'))
			.join('\n');
		return JSON.parse(stripped) as ModelsConfig;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async () => {
	const [ollamaModels, runningModels, modelsRaw, learning] = await Promise.all([
		getModels(),
		getRunningModels(),
		readTextFile(PATHS.modelsJson5),
		readJsonFile<Record<string, unknown>>(PATHS.learning)
	]);

	const modelsConfig = modelsRaw ? parseJson5(modelsRaw) : null;

	return {
		ollamaModels,
		runningModels,
		modelsConfig,
		learning
	};
};
