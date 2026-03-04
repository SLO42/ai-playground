import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		summary: { active: 4, idle: 2, completed: 17, failed: 1 },
		capacity: { current: 6, max: 15 },
		agents: [
			{ name: 'coder-01', type: 'coder', status: 'active', task: 'Implementing auth middleware', cpu: '12%', mem: '84MB', uptime: '24m' },
			{ name: 'researcher-01', type: 'researcher', status: 'active', task: 'Analyzing dependency graph', cpu: '8%', mem: '62MB', uptime: '18m' },
			{ name: 'tester-01', type: 'tester', status: 'active', task: 'Running integration tests', cpu: '23%', mem: '128MB', uptime: '12m' },
			{ name: 'reviewer-01', type: 'reviewer', status: 'idle', task: 'Waiting for PR #42', cpu: '1%', mem: '34MB', uptime: '31m' },
			{ name: 'planner-01', type: 'planner', status: 'active', task: 'Decomposing feature request', cpu: '5%', mem: '48MB', uptime: '8m' },
			{ name: 'security-01', type: 'security', status: 'idle', task: 'Queued: scan dependencies', cpu: '0%', mem: '22MB', uptime: '45m' }
		],
		recentCompletions: [
			{ name: 'coder-02', task: 'Refactored dashboard layout', duration: '14m', result: 'success' },
			{ name: 'tester-02', task: 'Unit tests for auth module', duration: '8m', result: 'success' }
		]
	};
};
