import type { PageServerLoad } from './$types.js';
import { getModels, getRunningModels } from '$lib/server/ollama-client.js';
import { readTextFile, readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import { getRoutingStats } from '$lib/server/routing-telemetry.js';

interface ModelsConfig {
	models?: {
		defaults?: {
			primary?: string;
			escalation?: string;
			fallbacks?: string[];
		};
	};
}

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

function formatSize(bytes: number): string {
	const gb = bytes / (1024 ** 3);
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	const mb = bytes / (1024 ** 2);
	return `${Math.round(mb)} MB`;
}

export const load: PageServerLoad = async () => {
	const [ollamaModels, runningModels, modelsRaw, routingStats] = await Promise.all([
		getModels(),
		getRunningModels(),
		readTextFile(PATHS.modelsJson5),
		getRoutingStats()
	]);

	const modelsConfig = modelsRaw ? parseJson5(modelsRaw) : null;
	const defaults = modelsConfig?.models?.defaults;

	// Build routing chain from config
	const routingChain: { name: string; tier: string; provider: string; latency: string; cost: string; status: string }[] = [];
	if (defaults?.primary) {
		const isLoaded = runningModels.some((m: any) => m.name === defaults.primary || m.model === defaults.primary);
		routingChain.push({
			name: defaults.primary,
			tier: 'Primary',
			provider: 'Ollama (local)',
			latency: '~80ms',
			cost: '$0',
			status: isLoaded ? 'active' : 'standby'
		});
	}
	if (defaults?.escalation) {
		routingChain.push({
			name: defaults.escalation,
			tier: 'Escalation',
			provider: 'Anthropic API',
			latency: '~2s',
			cost: '$0.003/1K',
			status: 'standby'
		});
	}
	for (const fb of (defaults?.fallbacks ?? [])) {
		routingChain.push({
			name: fb,
			tier: 'Fallback',
			provider: 'Anthropic API',
			latency: '~500ms',
			cost: '$0.0002/1K',
			status: 'standby'
		});
	}

	// Build model list from Ollama
	const loadedNames = new Set(runningModels.map((m: any) => m.name ?? m.model));
	const models = ollamaModels.map((m: any) => ({
		name: m.name,
		size: formatSize(m.size ?? 0),
		quantization: m.details?.quantization_level ?? 'unknown',
		params: m.details?.parameter_size ?? 'unknown',
		context: 0,
		modified: m.modified_at?.split('T')[0] ?? '',
		status: loadedNames.has(m.name) ? 'loaded' : 'available',
		vram: 0,
		tokensPerSec: 0
	}));

	// Enrich loaded models with VRAM/performance data from running models
	let totalVram = 0;
	for (const rm of runningModels) {
		const name = (rm as any).name ?? (rm as any).model;
		const model = models.find((m) => m.name === name);
		if (model) {
			const vramBytes = (rm as any).size_vram ?? (rm as any).size ?? 0;
			model.vram = parseFloat((vramBytes / (1024 ** 3)).toFixed(1));
			totalVram += model.vram;
		}
	}

	const activeCount = runningModels.length;

	// Routing intelligence from real telemetry
	let routingIntelligence = { accuracy: 0, localHandled: 0, escalated: 0, fallback: 0 };
	if (routingStats && routingStats.decisions) {
		const decisions = routingStats.decisions as any[];
		const total = decisions.length || 1;
		const local = decisions.filter((d: any) => d.model?.includes('ollama') || d.provider === 'ollama').length;
		const escalated = decisions.filter((d: any) => d.model?.includes('sonnet') || d.model?.includes('opus')).length;
		const fallback = decisions.filter((d: any) => d.model?.includes('haiku')).length;
		routingIntelligence = {
			accuracy: total > 0 ? Math.round((1 - (fallback / total)) * 100) : 0,
			localHandled: Math.round((local / total) * 100),
			escalated: Math.round((escalated / total) * 100),
			fallback: Math.round((fallback / total) * 100)
		};
	}

	return {
		summary: {
			total: models.length,
			active: activeCount,
			vramUsed: totalVram,
			vramTotal: 24.0
		},
		routingChain,
		models,
		routingIntelligence
	};
};
