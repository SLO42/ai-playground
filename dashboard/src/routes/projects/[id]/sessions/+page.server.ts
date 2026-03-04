import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		summary: { active: 2, paused: 1, completed: 12, totalTurns: 847 },
		sessions: [
			{ name: 'Feature: Auth Flow', id: 'sess-a7f2', type: 'sparc', status: 'active', agents: 4, turns: 142, duration: '1h 24m' },
			{ name: 'Bug: Memory Leak', id: 'sess-b3e1', type: 'debug', status: 'active', agents: 2, turns: 38, duration: '0h 22m' },
			{ name: 'Refactor: API Layer', id: 'sess-c9d4', type: 'swarm', status: 'paused', agents: 0, turns: 67, duration: '0h 48m' },
			{ name: 'Test: Integration', id: 'sess-d1a8', type: 'tdd', status: 'completed', agents: 0, turns: 94, duration: '1h 02m' },
			{ name: 'Design: Dashboard', id: 'sess-e5c2', type: 'sparc', status: 'completed', agents: 0, turns: 256, duration: '3h 18m' }
		],
		timeline: [
			{ time: '10:00', label: 'Auth Flow started', color: 'green' },
			{ time: '10:38', label: 'Memory Leak debug', color: 'green' },
			{ time: '11:02', label: 'API Refactor paused', color: 'yellow' },
			{ time: '11:48', label: 'Tests completed', color: 'blue' },
			{ time: '12:14', label: 'Design completed', color: 'blue' }
		],
		resources: {
			apiTokens: { value: 24832, cost: '$0.37 estimated' },
			localTokens: { value: 142560, cost: '$0.00 (Ollama)' },
			memoryNodes: { value: 89, label: 'HNSW indexed' }
		}
	};
};
