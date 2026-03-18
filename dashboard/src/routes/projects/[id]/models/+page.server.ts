import { resolve } from 'path';
import { readFile } from 'fs/promises';
import type { PageServerLoad } from './$types.js';
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
	};
};
