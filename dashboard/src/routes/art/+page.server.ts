import type { PageServerLoad } from './$types.js';
import { loadExperiments, loadAssets, loadKnowledge } from '$lib/server/art-experiments.js';
import * as comfy from '$lib/server/comfyui-client.js';
import { getKnowledgeSummary } from '$lib/server/art-knowledge.js';

export const load: PageServerLoad = async () => {
	const [experiments, assets, knowledge, comfyOnline, summary] = await Promise.all([
		loadExperiments(),
		loadAssets(),
		loadKnowledge(),
		comfy.isComfyOnline(),
		getKnowledgeSummary()
	]);

	let comfyStats = null;
	if (comfyOnline) {
		comfyStats = await comfy.getSystemStats();
	}

	return {
		experiments,
		assets,
		knowledge,
		comfyOnline,
		comfyStats,
		summary
	};
};
