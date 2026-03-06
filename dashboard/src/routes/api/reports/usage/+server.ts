import { json } from '@sveltejs/kit';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

const USAGE_LOG_PATH = resolve(PATHS.root, '.playground/agent-usage.json');

export const GET: RequestHandler = async () => {
	try {
		const raw = await readFile(USAGE_LOG_PATH, 'utf-8');
		const entries = JSON.parse(raw);

		// Compute aggregates
		let totalInput = 0;
		let totalOutput = 0;
		let totalCost = 0;
		let totalDuration = 0;
		const byModel: Record<string, { input: number; output: number; cost: number; count: number }> = {};

		for (const e of entries) {
			totalInput += e.inputTokens ?? 0;
			totalOutput += e.outputTokens ?? 0;
			totalCost += e.costUsd ?? 0;
			totalDuration += e.durationMs ?? 0;

			const model = e.model ?? 'unknown';
			if (!byModel[model]) byModel[model] = { input: 0, output: 0, cost: 0, count: 0 };
			byModel[model].input += e.inputTokens ?? 0;
			byModel[model].output += e.outputTokens ?? 0;
			byModel[model].cost += e.costUsd ?? 0;
			byModel[model].count++;
		}

		return json({
			entries,
			totals: {
				inputTokens: totalInput,
				outputTokens: totalOutput,
				totalTokens: totalInput + totalOutput,
				costUsd: totalCost,
				durationMs: totalDuration,
				taskCount: entries.length
			},
			byModel
		});
	} catch {
		return json({ entries: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, taskCount: 0 }, byModel: {} });
	}
};
