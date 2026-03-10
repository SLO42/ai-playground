import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	loadExperiments, runExperiment, createQuickExperiment,
	getExperimentProgress
} from '$lib/server/art-experiments.js';
import { distillExperiment } from '$lib/server/art-knowledge.js';

/** GET /api/art/experiments — list all experiments */
export const GET: RequestHandler = async () => {
	const experiments = await loadExperiments();
	return json(experiments);
};

/** POST /api/art/experiments — create and optionally run an experiment */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { action } = body;

	if (action === 'progress') {
		const progress = getExperimentProgress(body.experimentId);
		return json(progress ?? { experimentId: body.experimentId, total: 0, completed: 0, failed: 0 });
	}

	// Create experiment
	const experiment = createQuickExperiment({
		name: body.name ?? 'Untitled Experiment',
		positive: body.positive ?? '',
		negative: body.negative,
		checkpoint: body.checkpoint ?? '',
		loras: body.loras,
		variables: body.variables ?? [],
		params: body.params
	});

	if (body.autoRun) {
		// Run async — don't block the response
		runExperiment(experiment, { autoEvaluate: body.autoEvaluate ?? true })
			.then(completed => distillExperiment(completed))
			.catch(() => { /* logged elsewhere */ });

		return json({ ...experiment, status: 'running' }, { status: 202 });
	}

	return json(experiment, { status: 201 });
};
