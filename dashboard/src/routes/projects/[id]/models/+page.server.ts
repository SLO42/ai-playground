import { resolve } from 'path';
import { readFile } from 'fs/promises';
import type { PageServerLoad } from './$types.js';
<<<<<<< HEAD
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
=======
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readTextFile, readJsonFile } from '$lib/server/file-reader.js';
import type { ModelsConfig } from '$lib/types/models.js';
import { getRoutingStats } from '$lib/server/routing-telemetry.js';

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

interface ProjectModelOverrides {
	primary?: string;
	fallbacks?: string[];
	strategy?: string;
	preferences?: string[];
}

interface RoutingChainEntry {
	name: string;
	tier: string;
	provider: string;
	status: 'active' | 'standby' | 'unavailable';
}

interface AgentUsageEntry {
	taskId: string;
	taskTitle: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
	model: string;
	durationMs: number;
	timestamp: string;
	projectId?: string;
}

interface ModelUsageStat {
	model: string;
	count: number;
	totalTokens: number;
	costUsd: number;
	avgDurationMs: number;
}

interface ProjectModelsData {
	projectId: string;
	hasOverrides: boolean;
	overrides: ProjectModelOverrides;
	globalConfig: ModelsConfig | null;
	routingChain: RoutingChainEntry[];
	strategy: string;
	usageByModel: ModelUsageStat[];
	totalRequests: number;
	totalTokens: number;
	totalCost: number;
	routingAccuracy: number;
}

export const load: PageServerLoad = async ({ params, parent }): Promise<ProjectModelsData> => {
	const { project } = await parent();

	const empty: ProjectModelsData = {
		projectId: params.id,
		hasOverrides: false,
		overrides: {},
		globalConfig: null,
		routingChain: [],
		strategy: 'default',
		usageByModel: [],
		totalRequests: 0,
		totalTokens: 0,
		totalCost: 0,
		routingAccuracy: 0
	};

	// Load global models config and project-specific overrides in parallel
	const [modelsRaw, projectConfig, agentUsageRaw, routingStats] = await Promise.all([
		readTextFile(PATHS.modelsJson5),
		readJsonFile<{ agents?: { modelPreferences?: string[] }; modelRouting?: ProjectModelOverrides }>(
			resolve(project.path, '.playground/config.json')
		),
		readFile(resolve(PATHS.root, '.playground/agent-usage.json'), 'utf-8').catch(() => '[]'),
		getRoutingStats()
	]);

	const globalConfig = modelsRaw ? parseJson5(modelsRaw) : null;

	// Check for project-level model routing overrides
	const overrides: ProjectModelOverrides = projectConfig?.modelRouting ?? {};
	const hasOverrides = !!(overrides.primary || overrides.fallbacks?.length || overrides.strategy);

	// Determine effective strategy
	const strategy = overrides.strategy ?? 'cascade';

	// Build routing chain from config
	const routingChain: RoutingChainEntry[] = [];
	if (globalConfig) {
		const defaults = globalConfig.models.defaults;
		const effectivePrimary = overrides.primary ?? defaults.primary;
		const effectiveFallbacks = overrides.fallbacks ?? defaults.fallbacks;

		// Find provider for a model id
		function findProvider(modelId: string): string {
			for (const [provKey, prov] of Object.entries(globalConfig!.models.providers)) {
				if (prov.models.some((m) => m.id === modelId)) {
					return provKey;
				}
			}
			return 'unknown';
		}

		if (effectivePrimary) {
			routingChain.push({
				name: effectivePrimary,
				tier: 'Primary',
				provider: findProvider(effectivePrimary),
				status: 'active'
			});
		}

		for (const fb of effectiveFallbacks ?? []) {
			routingChain.push({
				name: fb,
				tier: routingChain.length === 1 ? 'Escalation' : 'Fallback',
				provider: findProvider(fb),
				status: 'standby'
			});
		}
	}

	// Load and filter agent usage stats for this project
	let entries: AgentUsageEntry[] = [];
	try {
		entries = JSON.parse(agentUsageRaw);
	} catch {
		// invalid JSON
	}

	// Filter by project — match on projectId field or cwd containing project path
	const projectEntries = entries.filter(
		(e) => e.projectId === params.id
	);

	// Aggregate usage by model
	const modelMap = new Map<string, ModelUsageStat>();
	for (const e of projectEntries) {
		const model = e.model ?? 'unknown';
		const existing = modelMap.get(model) ?? { model, count: 0, totalTokens: 0, costUsd: 0, avgDurationMs: 0 };
		existing.count++;
		existing.totalTokens += e.totalTokens ?? 0;
		existing.costUsd += e.costUsd ?? 0;
		existing.avgDurationMs += e.durationMs ?? 0;
		modelMap.set(model, existing);
	}

	const usageByModel: ModelUsageStat[] = [];
	for (const stat of modelMap.values()) {
		if (stat.count > 0) {
			stat.avgDurationMs = Math.round(stat.avgDurationMs / stat.count);
		}
		usageByModel.push(stat);
	}
	usageByModel.sort((a, b) => b.count - a.count);

	const totalRequests = projectEntries.length;
	const totalTokens = projectEntries.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
	const totalCost = projectEntries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);

	// Routing accuracy from global stats
	const routingAccuracy = routingStats.successRate * 100;

	return {
		projectId: params.id,
		hasOverrides,
		overrides,
		globalConfig,
		routingChain,
		strategy,
		usageByModel,
		totalRequests,
		totalTokens,
		totalCost,
		routingAccuracy: Math.round(routingAccuracy * 10) / 10
>>>>>>> worktree-agent-a73da255
	};
};
