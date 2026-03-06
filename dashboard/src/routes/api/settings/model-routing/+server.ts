import { json } from '@sveltejs/kit';
import { scopedSettingsPath, type SettingsScope } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';
import {
	loadModelRoutingSettings,
	saveModelRoutingSettings,
	MODEL_ROUTING_DEFAULTS,
	type ModelRoutingSettings,
	type RoutingStrategy
} from '$lib/server/model-routing-settings.js';

const VALID_STRATEGIES: RoutingStrategy[] = ['local-first', 'cloud-first', 'round-robin', 'manual'];

function resolveFilePath(url: URL): string {
	const scope = (url.searchParams.get('scope') ?? 'global') as SettingsScope;
	const projectPath = url.searchParams.get('projectPath') ?? undefined;
	return scopedSettingsPath('model-routing.json', scope, projectPath);
}

export const GET: RequestHandler = async ({ url }) => {
	const filePath = resolveFilePath(url);
	const settings = await loadModelRoutingSettings(filePath);
	return json(settings);
};

export const PUT: RequestHandler = async ({ request, url }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const strategy = VALID_STRATEGIES.includes(body.strategy as RoutingStrategy)
		? (body.strategy as RoutingStrategy)
		: MODEL_ROUTING_DEFAULTS.strategy;

	const rawThreshold = Number(body.complexityThreshold);
	const complexityThreshold = !isNaN(rawThreshold) && rawThreshold >= 0 && rawThreshold <= 1
		? rawThreshold
		: MODEL_ROUTING_DEFAULTS.complexityThreshold;

	const settings: ModelRoutingSettings = {
		strategy,
		complexityThreshold,
		localModel: typeof body.localModel === 'string' && body.localModel ? body.localModel : MODEL_ROUTING_DEFAULTS.localModel,
		localProvider: typeof body.localProvider === 'string' && body.localProvider ? body.localProvider : MODEL_ROUTING_DEFAULTS.localProvider,
		cloudModel: typeof body.cloudModel === 'string' && body.cloudModel ? body.cloudModel : MODEL_ROUTING_DEFAULTS.cloudModel,
		cloudProvider: typeof body.cloudProvider === 'string' && body.cloudProvider ? body.cloudProvider : MODEL_ROUTING_DEFAULTS.cloudProvider
	};

	const filePath = resolveFilePath(url);
	await saveModelRoutingSettings(settings, filePath);
	return json({ ok: true });
};
