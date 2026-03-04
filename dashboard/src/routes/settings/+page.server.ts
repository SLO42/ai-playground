import type { PageServerLoad } from './$types.js';

export interface QuickAction {
	id: string;
	icon: string;
	name: string;
	description: string;
	shortcut: string;
}

export interface SettingsCategory {
	id: string;
	icon: string;
	name: string;
}

export const load: PageServerLoad = async () => {
	const categories: SettingsCategory[] = [
		{ id: 'general', icon: 'gear', name: 'General' },
		{ id: 'agent-defaults', icon: 'cpu', name: 'Agent Defaults' },
		{ id: 'notifications', icon: 'bell', name: 'Notifications' },
		{ id: 'model-routing', icon: 'route', name: 'Model Routing' },
		{ id: 'memory', icon: 'database', name: 'Memory' },
		{ id: 'security', icon: 'shield', name: 'Security' },
		{ id: 'appearance', icon: 'palette', name: 'Appearance' },
		{ id: 'shortcuts', icon: 'keyboard', name: 'Shortcuts' },
		{ id: 'api-keys', icon: 'key', name: 'API Keys' },
		{ id: 'services', icon: 'server', name: 'Services' }
	];

	const quickActions: QuickAction[] = [
		{ id: 'approve', icon: 'check', name: 'Approve', description: "Accept the agent's suggestion and continue", shortcut: 'Ctrl+Enter' },
		{ id: 'reject', icon: 'x', name: 'Reject', description: 'Reject and ask agent to try again', shortcut: 'Ctrl+Backspace' },
		{ id: 'skip', icon: 'minus', name: 'Skip', description: 'Skip this decision, agent proceeds with default', shortcut: 'Ctrl+S' },
		{ id: 'delegate', icon: 'arrow-right', name: 'Delegate', description: 'Hand off to another agent or escalate', shortcut: 'Ctrl+D' }
	];

	return {
		categories,
		quickActions,
		behavior: {
			requireConfirmation: true,
			autoApproveLowRisk: false,
			showCommandsInInputBar: true
		},
		defaultTimeout: '30 minutes',
		scope: 'global' as 'global' | 'project',
		projectOverride: true
	};
};
