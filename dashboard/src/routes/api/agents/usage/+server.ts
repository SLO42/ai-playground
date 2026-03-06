import { json } from '@sveltejs/kit';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

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

export const GET: RequestHandler = async () => {
	try {
		const raw = await readFile(resolve(PATHS.root, '.playground/agent-usage.json'), 'utf-8');
		const entries: AgentUsageEntry[] = JSON.parse(raw);

		let totalInput = 0, totalOutput = 0, totalCost = 0, totalDuration = 0;
		const byModel: Record<string, { input: number; output: number; cost: number; count: number; avgDurationMs: number; avgInput: number; avgOutput: number; inputOutputRatio: number; costPerOutputToken: number }> = {};
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

			if (e.usedClaudeFlow) {
				cfUsing++;
				for (const tool of (e.claudeFlowTools ?? [])) {
					cfToolUsage[tool] = (cfToolUsage[tool] ?? 0) + 1;
				}
			}
		}

		for (const m of Object.values(byModel)) {
			if (m.count > 0) {
				m.avgDurationMs = m.avgDurationMs / m.count;
				m.avgInput = m.input / m.count;
				m.avgOutput = m.output / m.count;
				m.inputOutputRatio = m.output > 0 ? m.input / m.output : 0;
				m.costPerOutputToken = m.output > 0 ? m.cost / m.output : 0;
			}
		}

		const totalTokens = totalInput + totalOutput;
		return json({
			entries,
			totals: {
				inputTokens: totalInput,
				outputTokens: totalOutput,
				totalTokens,
				costUsd: totalCost,
				durationMs: totalDuration,
				taskCount: entries.length,
				inputOutputRatio: totalOutput > 0 ? totalInput / totalOutput : 0,
				costPerOutputToken: totalOutput > 0 ? totalCost / totalOutput : 0
			},
			byModel,
			recentAgents: entries.slice(-10).reverse(),
			claudeFlow: {
				agentsUsing: cfUsing,
				agentsTotal: entries.length,
				adoptionRate: entries.length > 0 ? cfUsing / entries.length : 0,
				toolUsage: cfToolUsage
			}
		});
	} catch {
		return json({
			entries: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, taskCount: 0, inputOutputRatio: 0, costPerOutputToken: 0 },
			byModel: {},
			recentAgents: [],
			claudeFlow: { agentsUsing: 0, agentsTotal: 0, adoptionRate: 0, toolUsage: {} }
		});
	}
};
