import type { PageServerLoad } from './$types.js';

export interface InboxMessage {
	id: string;
	sender: string;
	senderType: 'coder' | 'reviewer' | 'tester' | 'planner' | 'security';
	isAgent: boolean;
	content: string;
	timestamp: string;
}

export interface InboxConversation {
	id: string;
	title: string;
	agent: string;
	agentType: 'coder' | 'reviewer' | 'tester' | 'planner' | 'security';
	status: 'pending' | 'resolved' | 'escalated';
	project: string;
	lastActivity: string;
	messages: InboxMessage[];
}

export const load: PageServerLoad = async () => {
	const conversations: InboxConversation[] = [
		{
			id: 'conv-1',
			title: 'security-auditor: Decision',
			agent: 'security-auditor',
			agentType: 'security',
			status: 'pending',
			project: 'ai-playground',
			lastActivity: '2 min ago',
			messages: [
				{
					id: 'm1',
					sender: 'security-auditor',
					senderType: 'security',
					isAgent: true,
					content: 'Found 3 CVEs in dependencies. Auto-patch or manual review?',
					timestamp: '14:30'
				},
				{
					id: 'm2',
					sender: 'You',
					senderType: 'security',
					isAgent: false,
					content: 'Show me the CVE details first.',
					timestamp: '14:31'
				},
				{
					id: 'm3',
					sender: 'security-auditor',
					senderType: 'security',
					isAgent: true,
					content: 'CVE-2026-1234: path traversal in middleware/auth.ts — HIGH\nCVE-2026-5678: XSS in sanitize util — MEDIUM\nCVE-2026-9012: ReDoS in regex validator — LOW',
					timestamp: '14:31'
				}
			]
		},
		{
			id: 'conv-2',
			title: 'reviewer-02: Disposition',
			agent: 'reviewer-02',
			agentType: 'reviewer',
			status: 'pending',
			project: 'ai-playground',
			lastActivity: '5 min ago',
			messages: [
				{
					id: 'm4',
					sender: 'reviewer-02',
					senderType: 'reviewer',
					isAgent: true,
					content: 'PR #47 has conflicting changes in middleware/auth.ts. Should I merge or rebase?',
					timestamp: '14:25'
				}
			]
		},
		{
			id: 'conv-3',
			title: 'coder-03: Token Expiry Question',
			agent: 'coder-03',
			agentType: 'coder',
			status: 'pending',
			project: 'ai-playground',
			lastActivity: '8 min ago',
			messages: [
				{
					id: 'm5',
					sender: 'coder-03',
					senderType: 'coder',
					isAgent: true,
					content: 'Token expiry: how long should access tokens last?',
					timestamp: '14:22'
				},
				{
					id: 'm6',
					sender: 'You',
					senderType: 'coder',
					isAgent: false,
					content: '15 minutes for access, 7 days for refresh.',
					timestamp: '14:23'
				},
				{
					id: 'm7',
					sender: 'coder-03',
					senderType: 'coder',
					isAgent: true,
					content: 'Got it. Implementing with those values now. Created src/config/token.ts and src/middleware/auth/refresh.ts.',
					timestamp: '14:24'
				}
			]
		},
		{
			id: 'conv-4',
			title: 'tester-01: Test Coverage',
			agent: 'tester-01',
			agentType: 'tester',
			status: 'resolved',
			project: 'ai-playground',
			lastActivity: '15 min ago',
			messages: [
				{
					id: 'm8',
					sender: 'tester-01',
					senderType: 'tester',
					isAgent: true,
					content: 'Coverage dropped to 72%. Want me to add tests for the new auth module?',
					timestamp: '14:10'
				},
				{
					id: 'm9',
					sender: 'You',
					senderType: 'tester',
					isAgent: false,
					content: 'Yes, prioritize the token refresh flow.',
					timestamp: '14:12'
				}
			]
		},
		{
			id: 'conv-5',
			title: 'planner-01: Scope Question',
			agent: 'planner-01',
			agentType: 'planner',
			status: 'escalated',
			project: 'ai-playground',
			lastActivity: '20 min ago',
			messages: [
				{
					id: 'm10',
					sender: 'planner-01',
					senderType: 'planner',
					isAgent: true,
					content: 'User story #44 is too large. Should I split into 3 subtasks or delegate to a coordinator?',
					timestamp: '14:05'
				}
			]
		}
	];

	const pending = conversations.filter((c) => c.status === 'pending').length;
	const resolved = conversations.filter((c) => c.status === 'resolved').length;

	return {
		conversations,
		stats: {
			awaitingInput: pending,
			inProgress: 2,
			avgWaitTime: '3 min',
			resolvedToday: resolved
		}
	};
};
