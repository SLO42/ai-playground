import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		summary: { activeHooks: 8, executions: 1247, patternsLearned: 14, successRate: '98.4%' },
		hooks: [
			{ name: 'pre-edit', type: 'pre', description: 'Before file edit', executions: 342, lastRun: '2m ago', status: 'active', enabled: true },
			{ name: 'post-edit', type: 'post', description: 'After file edit', executions: 348, lastRun: '2m ago', status: 'active', enabled: true },
			{ name: 'pre-task', type: 'pre', description: 'Before task start', executions: 89, lastRun: '8m ago', status: 'active', enabled: true },
			{ name: 'post-task', type: 'post', description: 'After task complete', executions: 87, lastRun: '12m ago', status: 'active', enabled: true },
			{ name: 'session-start', type: 'lifecycle', description: 'Session begins', executions: 24, lastRun: '1h ago', status: 'active', enabled: true },
			{ name: 'session-end', type: 'lifecycle', description: 'Session ends', executions: 22, lastRun: '3h ago', status: 'active', enabled: true },
			{ name: 'model-route', type: 'routing', description: 'LLM routing decision', executions: 284, lastRun: '1m ago', status: 'active', enabled: true },
			{ name: 'intelligence', type: 'learning', description: 'Pattern detection', executions: 59, lastRun: '14m ago', status: 'disabled', enabled: false }
		],
		learningConfig: {
			mode: 'active',
			patternThreshold: 0.85,
			maxPatterns: 100,
			autoApply: 'enabled'
		},
		workers: [
			{ name: 'pre-edit worker', status: 'idle', load: '0%' },
			{ name: 'post-edit worker', status: 'running', load: '12%' },
			{ name: 'model-route worker', status: 'running', load: '8%' },
			{ name: 'intelligence worker', status: 'disabled', load: '—' }
		],
		recentPatterns: [
			{ time: '14:12', pattern: 'TypeScript interface naming: prefix with I', score: 0.92, status: 'applied' },
			{ time: '13:48', pattern: 'Error handling: wrap async in try-catch', score: 0.88, status: 'applied' },
			{ time: '12:30', pattern: 'Import ordering: external→internal→types', score: 0.85, status: 'pending' }
		]
	};
};
