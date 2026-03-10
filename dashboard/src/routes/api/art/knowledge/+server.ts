import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { loadKnowledge } from '$lib/server/art-experiments.js';
import { getKnowledgeSummary, distillExperiment } from '$lib/server/art-knowledge.js';
import { loadExperiments } from '$lib/server/art-experiments.js';

/** GET /api/art/knowledge — get knowledge base or summary */
export const GET: RequestHandler = async ({ url }) => {
	const view = url.searchParams.get('view');

	if (view === 'summary') {
		const summary = await getKnowledgeSummary();
		return json(summary);
	}

	const knowledge = await loadKnowledge();
	return json(knowledge);
};

/** POST /api/art/knowledge — distill experiment results into knowledge */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	if (body.action === 'distill-all') {
		const experiments = await loadExperiments();
		let knowledge = await loadKnowledge();
		for (const exp of experiments.filter(e => e.status === 'complete')) {
			knowledge = await distillExperiment(exp);
		}
		return json(knowledge);
	}

	if (body.experimentId) {
		const experiments = await loadExperiments();
		const exp = experiments.find(e => e.id === body.experimentId);
		if (!exp) return json({ error: 'Experiment not found' }, { status: 404 });
		const knowledge = await distillExperiment(exp);
		return json(knowledge);
	}

	return json({ error: 'Provide experimentId or action=distill-all' }, { status: 400 });
};
