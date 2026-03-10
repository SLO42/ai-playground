import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { loadAssets } from '$lib/server/art-experiments.js';
import {
	searchCivitAI, downloadFromCivitAI,
	searchHuggingFace, downloadFromHuggingFace,
	scanLocalModels, registerLocalModel, removeAsset,
	getComfyModels
} from '$lib/server/art-assets.js';

/** GET /api/art/assets — list registered assets and ComfyUI-visible models */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const view = url.searchParams.get('view');

		if (view === 'comfyui') {
			const models = await getComfyModels();
			return json(models);
		}

		if (view === 'scan') {
			const local = await scanLocalModels();
			return json(local);
		}

		const assets = await loadAssets();
		return json(assets);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to load assets';
		return json({ error: message }, { status: 500 });
	}
};

/** POST /api/art/assets — search, download, register, or remove assets */
export const POST: RequestHandler = async ({ request }) => {
	// Guard: only allow requests originating from the local dashboard (CSRF / remote-caller protection).
	// The Origin header is always sent by browsers for cross-origin POST requests.
	// Requests without Origin (e.g. server-to-server on localhost) are also permitted.
	const origin = request.headers.get('origin');
	if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { action } = body;

		switch (action) {
			case 'search-civitai': {
				const results = await searchCivitAI(body.query, body.type, body.limit);
				return json(results);
			}

			case 'download-civitai': {
				const asset = await downloadFromCivitAI(body.modelId, {
					versionId: body.versionId,
					type: body.type
				});
				return json(asset, { status: 201 });
			}

			case 'search-huggingface': {
				const results = await searchHuggingFace(body.query, body.limit);
				return json(results);
			}

			case 'download-huggingface': {
				const asset = await downloadFromHuggingFace(body.repoId, body.fileName, body.type);
				return json(asset, { status: 201 });
			}

			case 'register': {
				const asset = await registerLocalModel(body.fileName, body.type, {
					name: body.name,
					triggerWords: body.triggerWords,
					compatibleBases: body.compatibleBases
				});
				return json(asset, { status: 201 });
			}

			case 'remove': {
				const removed = await removeAsset(body.assetId, body.deleteFile ?? false);
				return json({ removed });
			}

			default:
				return json({ error: 'Unknown action' }, { status: 400 });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Asset operation failed';
		return json({ error: message }, { status: 500 });
	}
};
