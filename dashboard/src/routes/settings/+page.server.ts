import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';

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

export interface HeartbeatPhase {
	id: string;
	name: string;
	enabled: boolean;
	intervalSeconds: number;
}

export interface HeartbeatConfig {
	enabled: boolean;
	phases: HeartbeatPhase[];
}

const DEFAULT_HEARTBEAT: HeartbeatConfig = {
	enabled: true,
	phases: [
		{ id: 'health-checks', name: 'Health Checks', enabled: true, intervalSeconds: 30 },
		{ id: 'task-scanning', name: 'Task Scanning', enabled: true, intervalSeconds: 60 },
		{ id: 'agent-spawning', name: 'Agent Spawning', enabled: true, intervalSeconds: 120 },
		{ id: 'review-cycle', name: 'Review Cycle', enabled: false, intervalSeconds: 300 },
		{ id: 'memory-sync', name: 'Memory Sync', enabled: true, intervalSeconds: 180 }
	]
};

export const load: PageServerLoad = async () => {
	const categories: SettingsCategory[] = [
		{ id: 'general', icon: 'gear', name: 'General' },
		{ id: 'heartbeat', icon: 'pulse', name: 'Heartbeat' },
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

	const storedHeartbeat = await readJsonFile<HeartbeatConfig>(PATHS.heartbeatConfig);
	const heartbeat: HeartbeatConfig = storedHeartbeat ?? DEFAULT_HEARTBEAT;

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
		projectOverride: true,
		heartbeat
	};
};
