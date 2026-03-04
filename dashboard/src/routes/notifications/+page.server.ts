import type { PageServerLoad } from './$types.js';

export interface Notification {
	id: string;
	timestamp: string;
	severity: 'critical' | 'warning' | 'info';
	category: 'jobs' | 'agents' | 'security' | 'system';
	title: string;
	message: string;
	read: boolean;
	link?: string;
	linkLabel?: string;
}

export interface NotificationPreference {
	type: string;
	desktop: boolean;
	sound: boolean;
}

export const load: PageServerLoad = async () => {
	const notifications: Notification[] = [
		{
			id: 'n1',
			timestamp: '15 min ago',
			severity: 'info',
			category: 'jobs',
			title: 'Job Running — npm test (3/5 steps)',
			message: 'Step 3: integration tests running... ETA 45s remaining.',
			read: false
		},
		{
			id: 'n2',
			timestamp: '18 min ago',
			severity: 'info',
			category: 'agents',
			title: 'Agent Spawned — reviewer-03',
			message: 'Spawned for PR #47 code review. Assigned to ai-playground project.',
			read: false
		},
		{
			id: 'n3',
			timestamp: '25 min ago',
			severity: 'info',
			category: 'jobs',
			title: 'Session Complete — task #141',
			message: 'Researcher -> Coder -> Tester pipeline finished. 3 agents used, 4m 32s total.',
			read: false,
			link: '/sessions',
			linkLabel: 'View Session'
		},
		{
			id: 'n4',
			timestamp: '1h ago',
			severity: 'info',
			category: 'system',
			title: 'Pattern Learned — auth-flow',
			message: 'Intelligence system distilled new JWT authentication pattern from 3 sessions.',
			read: true
		},
		{
			id: 'n5',
			timestamp: '2h ago',
			severity: 'critical',
			category: 'security',
			title: 'Security Alert — Suspicious API Key Access',
			message: 'Detected unauthorized attempt to read .env credentials from agent coder-12.',
			read: false
		},
		{
			id: 'n6',
			timestamp: '3h ago',
			severity: 'warning',
			category: 'system',
			title: 'VRAM Warning — 92% Utilization',
			message: 'GPU VRAM at 22.1GB / 24GB. Consider unloading unused models.',
			read: true
		},
		{
			id: 'n7',
			timestamp: '4h ago',
			severity: 'critical',
			category: 'system',
			title: 'Memory DB Connection Lost',
			message: 'SQLite lock file detected. Memory operations may fail until resolved.',
			read: true
		}
	];

	const preferences: NotificationPreference[] = [
		{ type: 'Desktop Notifications', desktop: true, sound: false },
		{ type: 'Sound Alerts', desktop: false, sound: true },
		{ type: 'Auto-dismiss Success', desktop: true, sound: false },
		{ type: 'Quiet Hours', desktop: false, sound: false },
		{ type: 'Slack Integration', desktop: false, sound: false }
	];

	const unread = notifications.filter((n) => !n.read).length;
	const critical = notifications.filter((n) => n.severity === 'critical').length;
	const today = notifications.length;
	const activeJobs = notifications.filter((n) => n.category === 'jobs' && !n.read).length;
	const alerts = critical;

	return {
		notifications,
		preferences,
		stats: { unread, critical, today, activeJobs, alerts }
	};
};
