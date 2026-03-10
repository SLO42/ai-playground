import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { generatePrompt, generatePromptVariations, planExperiment } from '$lib/server/art-prompt-gen.js';
import { getComfyModels } from '$lib/server/art-assets.js';

/** POST /api/art/generate — prompt generation and experiment planning */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { action } = body;

		switch (action) {
			case 'prompt': {
				const result = await generatePrompt(body.description, body.style, body.model);
				return json(result);
			}

			case 'variations': {
				const variations = await generatePromptVariations(
					body.positive,
					body.negative ?? 'low quality, blurry, deformed',
					body.count ?? 5
				);
				return json(variations);
			}

			case 'plan': {
				const models = await getComfyModels();
				const plan = await planExperiment(
					body.goal,
					models.checkpoints,
					models.loras,
					models.samplers,
					body.context
				);
				return json(plan);
			}

			default:
				return json({ error: 'Unknown action. Use: prompt, variations, plan' }, { status: 400 });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Generation failed';
		return json({ error: message }, { status: 500 });
	}
};
