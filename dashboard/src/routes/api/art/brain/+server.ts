import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	testAsset, runAutonomousSession, runCustomTest,
	getBrainProgress
} from '$lib/server/art-brain.js';
import { researchAsset, researchCivitAIModelById } from '$lib/server/art-researcher.js';
import { loadAssets } from '$lib/server/art-experiments.js';

/** POST /api/art/brain — brain operations */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { action } = body;

		switch (action) {
			case 'research': {
				// Research a specific asset
				const assets = await loadAssets();
				const asset = assets.find(a => a.id === body.assetId);
				if (!asset) return json({ error: 'Asset not found' }, { status: 404 });
				const research = await researchAsset(asset);
				return json(research);
			}

			case 'research-civitai': {
				// Research a CivitAI model by ID (before downloading)
				const research = await researchCivitAIModelById(body.modelId);
				return json(research);
			}

			case 'test-asset': {
				// Test a single asset autonomously
				const assets = await loadAssets();
				const asset = assets.find(a => a.id === body.assetId);
				if (!asset) return json({ error: 'Asset not found' }, { status: 404 });

				// Run async
				const runId = body.runId ?? asset.id;
				testAsset(asset, { runId, checkpoint: body.checkpoint })
					.catch(err => console.error(`Brain test failed for ${asset.name}:`, err));

				return json({ runId, status: 'started' }, { status: 202 });
			}

			case 'test-all': {
				// Run autonomous session across all untested assets
				const runId = body.runId ?? `session-${Date.now()}`;
				runAutonomousSession({
					runId,
					maxAssets: body.maxAssets ?? 10,
					assetTypes: body.assetTypes
				}).catch(err => console.error('Brain autonomous session failed:', err));

				return json({ runId, status: 'started' }, { status: 202 });
			}

			case 'custom-test': {
				// Run a custom test from natural language description
				if (!body.description) {
					return json({ error: 'description required' }, { status: 400 });
				}
				const runId = body.runId ?? `custom-${Date.now()}`;
				runCustomTest(body.description, { runId })
					.catch(err => console.error('Brain custom test failed:', err));

				return json({ runId, status: 'started' }, { status: 202 });
			}

			case 'progress': {
				const progress = getBrainProgress(body.runId);
				return json(progress ?? { phase: 'unknown' });
			}

			default:
				return json({ error: 'Unknown action' }, { status: 400 });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Brain operation failed';
		return json({ error: message }, { status: 500 });
	}
};
