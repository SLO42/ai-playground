import type { PageServerLoad } from './$types.js';

interface SessionAgent {
	id: string;
	name: string;
	model: string;
	started: string;
	duration: string;
	filesModified: number;
	toolsUsed: string[];
	input: string;
	output: string;
}

interface WorkflowStage {
	name: string;
	status: 'completed' | 'running' | 'pending' | 'error';
	agent?: string;
}

export interface Session {
	id: string;
	name: string;
	status: 'running' | 'completed' | 'error';
	agentCount: number;
	duration: string;
	started: string;
	workflow: WorkflowStage[];
	agents: SessionAgent[];
	logs: LogEntry[];
}

export interface LogEntry {
	timestamp: string;
	agent: string;
	agentType: 'coder' | 'reviewer' | 'tester' | 'planner' | 'coordinator';
	message: string;
}

export const load: PageServerLoad = async () => {
	const sessions: Session[] = [
		{
			id: 'sess-a1b2',
			name: 'Feature: Auth Flow',
			status: 'running',
			agentCount: 4,
			duration: '3m 12s',
			started: '2026-03-04T14:22:00Z',
			workflow: [
				{ name: 'Session Start', status: 'completed' },
				{ name: 'planner', status: 'completed', agent: 'planner-01' },
				{ name: 'coder', status: 'running', agent: 'coder-03' },
				{ name: 'reviewer', status: 'pending' },
				{ name: 'tester', status: 'pending' }
			],
			agents: [
				{
					id: 'planner-01',
					name: 'planner-01',
					model: 'gpt-oss-20b',
					started: '14:22:05',
					duration: '45s',
					filesModified: 0,
					toolsUsed: ['memory_search', 'task_create'],
					input: 'Implement JWT authentication with refresh tokens',
					output: 'Created 3 tasks: auth middleware, token service, refresh endpoint'
				},
				{
					id: 'coder-03',
					name: 'coder-03',
					model: 'claude-sonnet-4.6',
					started: '14:22:52',
					duration: '2m 20s',
					filesModified: 3,
					toolsUsed: ['file_read', 'file_write', 'grep'],
					input: 'Implement auth middleware and token service',
					output: 'Writing middleware integration...'
				}
			],
			logs: [
				{ timestamp: '14:22:05', agent: 'planner-01', agentType: 'planner', message: 'Session started' },
				{ timestamp: '14:22:10', agent: 'planner-01', agentType: 'planner', message: 'Analyzed codebase: found existing auth stub' },
				{ timestamp: '14:22:50', agent: 'planner-01', agentType: 'planner', message: 'Deployment: JWT auth + refresh tokens' },
				{ timestamp: '14:22:52', agent: 'coder-03', agentType: 'coder', message: 'Started implementation of auth middleware' },
				{ timestamp: '14:24:10', agent: 'coder-03', agentType: 'coder', message: 'Created src/middleware/auth.ts' },
				{ timestamp: '14:25:02', agent: 'coder-03', agentType: 'coder', message: 'coder in progress — writing middleware integration...' }
			]
		},
		{
			id: 'sess-c3d4',
			name: 'Code Review #547',
			status: 'completed',
			agentCount: 3,
			duration: '4m 32s',
			started: '2026-03-04T14:10:00Z',
			workflow: [
				{ name: 'Session Start', status: 'completed' },
				{ name: 'reviewer', status: 'completed', agent: 'reviewer-02' },
				{ name: 'tester', status: 'completed', agent: 'tester-01' }
			],
			agents: [],
			logs: [
				{ timestamp: '14:10:01', agent: 'reviewer-02', agentType: 'reviewer', message: 'Started review of PR #547' },
				{ timestamp: '14:12:30', agent: 'reviewer-02', agentType: 'reviewer', message: 'Found 2 issues, requesting changes' },
				{ timestamp: '14:14:32', agent: 'tester-01', agentType: 'tester', message: 'All 14 tests passing' }
			]
		},
		{
			id: 'sess-e5f6',
			name: 'Security Scan',
			status: 'completed',
			agentCount: 2,
			duration: '1m 45s',
			started: '2026-03-04T13:55:00Z',
			workflow: [
				{ name: 'Session Start', status: 'completed' },
				{ name: 'security-auditor', status: 'completed', agent: 'sec-01' }
			],
			agents: [],
			logs: []
		},
		{
			id: 'sess-g7h8',
			name: 'Memory Optimize',
			status: 'running',
			agentCount: 2,
			duration: '5m 10s',
			started: '2026-03-04T14:20:00Z',
			workflow: [
				{ name: 'Session Start', status: 'completed' },
				{ name: 'performance-engineer', status: 'running', agent: 'perf-01' }
			],
			agents: [],
			logs: []
		},
		{
			id: 'sess-i9j0',
			name: 'Bug Fix: Routing',
			status: 'error',
			agentCount: 1,
			duration: '0m 38s',
			started: '2026-03-04T13:45:00Z',
			workflow: [
				{ name: 'Session Start', status: 'completed' },
				{ name: 'coder', status: 'error', agent: 'coder-05' }
			],
			agents: [],
			logs: [
				{ timestamp: '13:45:01', agent: 'coder-05', agentType: 'coder', message: 'Started bug fix for routing issue' },
				{ timestamp: '13:45:38', agent: 'coder-05', agentType: 'coder', message: 'Error: OOM — model context exceeded' }
			]
		}
	];

	const running = sessions.filter((s) => s.status === 'running').length;
	const completed = sessions.filter((s) => s.status === 'completed').length;
	const errored = sessions.filter((s) => s.status === 'error').length;

	return {
		sessions,
		summary: {
			total: sessions.length,
			running,
			completed,
			errored
		}
	};
};
