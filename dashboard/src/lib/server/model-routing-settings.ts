import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { PATHS } from './constants.js';

export type RoutingStrategy = 'local-first' | 'cloud-first' | 'round-robin' | 'manual';

export interface ModelRoutingSettings {
	strategy: RoutingStrategy;
	complexityThreshold: number;
	localModel: string;
	localProvider: string;
	cloudModel: string;
	cloudProvider: string;
}

export const MODEL_ROUTING_DEFAULTS: ModelRoutingSettings = {
	strategy: 'local-first',
	complexityThreshold: 0.3,
	localModel: 'gpt-oss:20b',
	localProvider: 'ollama',
	cloudModel: 'claude-sonnet-4-6',
	cloudProvider: 'claude'
};

export async function loadModelRoutingSettings(filePath?: string): Promise<ModelRoutingSettings> {
	try {
		const raw = await readFile(filePath ?? PATHS.modelRoutingSettings, 'utf-8');
		return { ...MODEL_ROUTING_DEFAULTS, ...JSON.parse(raw) };
	} catch {
		return { ...MODEL_ROUTING_DEFAULTS };
	}
}

export async function saveModelRoutingSettings(settings: ModelRoutingSettings, filePath?: string): Promise<void> {
	const target = filePath ?? PATHS.modelRoutingSettings;
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, JSON.stringify(settings, null, '\t'), 'utf-8');
}

/** Round-robin state (in-memory, resets on restart) */
let rrIndex = 0;

/**
 * Given current routing settings and a request's complexity score,
 * resolve the provider and model to use.
 * If the request already specifies a provider (manual override), respect it.
 */
export function resolveRoute(
	settings: ModelRoutingSettings,
	complexity: number,
	requestProvider?: string,
	requestModel?: string
): { provider: string; model: string } {
	// Explicit provider from the request always wins (user selected it in the UI)
	if (requestProvider) {
		return { provider: requestProvider, model: requestModel || settings.localModel };
	}

	switch (settings.strategy) {
		case 'local-first':
			if (complexity >= settings.complexityThreshold) {
				return { provider: settings.cloudProvider, model: settings.cloudModel };
			}
			return { provider: settings.localProvider, model: settings.localModel };

		case 'cloud-first':
			if (complexity < settings.complexityThreshold) {
				return { provider: settings.localProvider, model: settings.localModel };
			}
			return { provider: settings.cloudProvider, model: settings.cloudModel };

		case 'round-robin': {
			const providers = [
				{ provider: settings.localProvider, model: settings.localModel },
				{ provider: settings.cloudProvider, model: settings.cloudModel }
			];
			const pick = providers[rrIndex % providers.length];
			rrIndex++;
			return pick;
		}

		case 'manual':
			// No request override — fall back to local
			return { provider: settings.localProvider, model: settings.localModel };

		default:
			return { provider: settings.localProvider, model: settings.localModel };
	}
}
