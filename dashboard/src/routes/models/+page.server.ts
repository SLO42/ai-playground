import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { PageServerLoad } from './$types.js';
import { getModels, getRunningModels } from '$lib/server/ollama-client.js';
import { readTextFile, readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { ModelsConfig } from '$lib/types/models.js';
import { getRoutingStats, getWorkflowStats } from '$lib/server/routing-telemetry.js';

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
	usedClaudeFlow?: boolean;
	claudeFlowTools?: string[];
}

interface ModelStats {
	input: number;
	output: number;
	cost: number;
	count: number;
	avgDurationMs: number;
	avgInput: number;
	avgOutput: number;
	inputOutputRatio: number;
	costPerOutputToken: number;
}

interface ClaudeFlowStats {
	agentsUsing: number;
	agentsTotal: number;
	adoptionRate: number;
	toolUsage: Record<string, number>;
}

interface AgentUsageStats {
	entries: AgentUsageEntry[];
	totals: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; durationMs: number; taskCount: number; inputOutputRatio: number; costPerOutputToken: number };
	byModel: Record<string, ModelStats>;
	recentAgents: AgentUsageEntry[];
	claudeFlow: ClaudeFlowStats;
}

async function loadAgentUsageStats(): Promise<AgentUsageStats> {
	const empty: AgentUsageStats = {
		entries: [],
		totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, taskCount: 0, inputOutputRatio: 0, costPerOutputToken: 0 },
		byModel: {},
		recentAgents: [],
		claudeFlow: { agentsUsing: 0, agentsTotal: 0, adoptionRate: 0, toolUsage: {} }
	};

	try {
		const raw = await readFile(resolve(PATHS.root, '.playground/agent-usage.json'), 'utf-8');
		const entries: AgentUsageEntry[] = JSON.parse(raw);

		let totalInput = 0, totalOutput = 0, totalCost = 0, totalDuration = 0;
		const byModel: Record<string, ModelStats> = {};
		let cfUsing = 0;
		const cfToolUsage: Record<string, number> = {};

		for (const e of entries) {
			totalInput += e.inputTokens ?? 0;
			totalOutput += e.outputTokens ?? 0;
			totalCost += e.costUsd ?? 0;
			totalDuration += e.durationMs ?? 0;

			const model = e.model ?? 'unknown';
			if (!byModel[model]) byModel[model] = { input: 0, output: 0, cost: 0, count: 0, avgDurationMs: 0, avgInput: 0, avgOutput: 0, inputOutputRatio: 0, costPerOutputToken: 0 };
			byModel[model].input += e.inputTokens ?? 0;
			byModel[model].output += e.outputTokens ?? 0;
			byModel[model].cost += e.costUsd ?? 0;
			byModel[model].count++;
			byModel[model].avgDurationMs += e.durationMs ?? 0;

			// Claude Flow adoption tracking
			if (e.usedClaudeFlow) {
				cfUsing++;
				for (const tool of (e.claudeFlowTools ?? [])) {
					cfToolUsage[tool] = (cfToolUsage[tool] ?? 0) + 1;
				}
			}
		}

		// Compute per-model averages and efficiency metrics
		for (const m of Object.values(byModel)) {
			if (m.count > 0) {
				m.avgDurationMs = m.avgDurationMs / m.count;
				m.avgInput = m.input / m.count;
				m.avgOutput = m.output / m.count;
			}
			m.inputOutputRatio = m.output > 0 ? m.input / m.output : 0;
			m.costPerOutputToken = m.output > 0 ? m.cost / m.output : 0;
		}

		return {
			entries,
			totals: {
				inputTokens: totalInput,
				outputTokens: totalOutput,
				totalTokens: totalInput + totalOutput,
				costUsd: totalCost,
				durationMs: totalDuration,
				taskCount: entries.length,
				inputOutputRatio: totalOutput > 0 ? totalInput / totalOutput : 0,
				costPerOutputToken: totalOutput > 0 ? totalCost / totalOutput : 0
			},
			byModel,
			recentAgents: entries.slice(-20).reverse(),
			claudeFlow: {
				agentsUsing: cfUsing,
				agentsTotal: entries.length,
				adoptionRate: entries.length > 0 ? cfUsing / entries.length : 0,
				toolUsage: cfToolUsage
			}
		};
	} catch {
		return empty;
	}
}

export const load: PageServerLoad = async () => {
	const [ollamaModels, runningModels, modelsRaw, learning, routingStats, workflowStats, agentUsage] = await Promise.all([
		getModels(),
		getRunningModels(),
		readTextFile(PATHS.modelsJson5),
		readJsonFile<Record<string, unknown>>(PATHS.learning),
		getRoutingStats(),
		getWorkflowStats(),
		loadAgentUsageStats()
	]);

	const modelsConfig = modelsRaw ? parseJson5(modelsRaw) : null;

	// Top 5 most expensive tasks
	const topExpensiveTasks = agentUsage.entries
		.filter((e) => e.costUsd > 0)
		.sort((a, b) => b.costUsd - a.costUsd)
		.slice(0, 5)
		.map((e) => ({
			taskId: e.taskId,
			taskTitle: e.taskTitle,
			model: e.model,
			costUsd: e.costUsd,
			durationMs: e.durationMs,
			inputTokens: e.inputTokens,
			outputTokens: e.outputTokens
		}));

	// Daily cost trend (last 7 days)
	const now = new Date();
	const dailyCostTrend: { date: string; cost: number; tasks: number }[] = [];
	for (let i = 6; i >= 0; i--) {
		const d = new Date(now);
		d.setDate(d.getDate() - i);
		const dateStr = d.toISOString().slice(0, 10);
		const dayEntries = agentUsage.entries.filter(
			(e) => e.timestamp && e.timestamp.slice(0, 10) === dateStr
		);
		dailyCostTrend.push({
			date: dateStr,
			cost: dayEntries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
			tasks: dayEntries.length
		});
	}

	// Efficiency ratios per model (output/input)
	const efficiencyByModel = Object.entries(agentUsage.byModel).map(([name, stats]) => ({
		name,
		inputTokens: stats.input,
		outputTokens: stats.output,
		efficiencyRatio: stats.input > 0 ? stats.output / stats.input : 0,
		count: stats.count,
		totalCost: stats.cost,
		avgCostPerTask: stats.count > 0 ? stats.cost / stats.count : 0
	}));

	return {
		ollamaModels,
		runningModels,
		modelsConfig,
		learning,
		routingStats,
		workflowStats,
		agentUsage,
		topExpensiveTasks,
		dailyCostTrend,
		efficiencyByModel
	};
};
