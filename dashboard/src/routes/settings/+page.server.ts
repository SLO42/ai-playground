import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { loadGeneralSettings, GENERAL_DEFAULTS } from '$lib/server/general-settings.js';
import { loadAgentDefaults, AGENT_DEFAULTS } from '$lib/server/agent-defaults.js';
import { loadModelRoutingSettings, MODEL_ROUTING_DEFAULTS } from '$lib/server/model-routing-settings.js';
import { loadMemorySettings } from '$lib/server/memory-settings.js';
import { getFeatureFlags } from '$lib/server/feature-flags.js';
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

export interface NotifSettings {
	desktop: boolean;
	inAppToasts: boolean;
	sound: boolean;
	quietHoursStart: string;
	quietHoursEnd: string;
	categories: Record<string, { desktop: boolean; inApp: boolean }>;
	heartbeatEnabled?: boolean;
	heartbeatIntervalMs?: number;
}

const NOTIF_SETTINGS_FILE = resolve(PATHS.root, '.playground/notification-settings.json');

async function loadNotifSettings(): Promise<NotifSettings> {
	try {
		const raw = await readFile(NOTIF_SETTINGS_FILE, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return {
			desktop: true,
			inAppToasts: true,
			sound: false,
			quietHoursStart: '23:00',
			quietHoursEnd: '08:00',
			categories: {
				task: { desktop: true, inApp: true },
				service: { desktop: true, inApp: true },
				agent: { desktop: true, inApp: true },
				chat: { desktop: false, inApp: true },
				memory: { desktop: false, inApp: true },
				model: { desktop: true, inApp: true },
				system: { desktop: true, inApp: true }
			},
			heartbeatEnabled: true,
			heartbeatIntervalMs: 60000
		};
	}
}

export interface ApiKeyStatus {
	name: string;
	label: string;
	set: boolean;
}

const API_KEYS: { name: string; label: string }[] = [
	{ name: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)' },
	{ name: 'OPENAI_API_KEY', label: 'OpenAI' },
	{ name: 'GITHUB_TOKEN', label: 'GitHub' }
];

function detectApiKeyStatus(): ApiKeyStatus[] {
	return API_KEYS.map(({ name, label }) => ({
		name,
		label,
		set: !!process.env[name]
	}));
}

export const load: PageServerLoad = async () => {
	const [notifSettings, generalSettings, agentDefaults, modelRoutingSettings, memorySettings] = await Promise.all([
		loadNotifSettings(),
		loadGeneralSettings(),
		loadAgentDefaults(),
		loadModelRoutingSettings(),
		loadMemorySettings()
	]);
	const apiKeys = detectApiKeyStatus();
	const featureFlags = getFeatureFlags();

	/** Map category IDs to feature flag keys — categories not listed are always shown */
	const categoryFlagMap: Record<string, keyof typeof featureFlags> = {
		memory: 'memory',
		security: 'security',
		notifications: 'notifications'
	};

	const allCategories: SettingsCategory[] = [
		{ id: 'general', icon: 'gear', name: 'General' },
		{ id: 'agent-defaults', icon: 'cpu', name: 'Agent Defaults' },
		{ id: 'notifications', icon: 'bell', name: 'Notifications' },
		{ id: 'model-routing', icon: 'route', name: 'Model Routing' },
		{ id: 'memory', icon: 'database', name: 'Memory' },
		{ id: 'security', icon: 'shield', name: 'Security' },
		{ id: 'shortcuts', icon: 'keyboard', name: 'Shortcuts' },
		{ id: 'api-keys', icon: 'key', name: 'API Keys' },
		{ id: 'services', icon: 'server', name: 'Services' }
	];

	const categories = allCategories.filter(cat => {
		const flag = categoryFlagMap[cat.id];
		return !flag || featureFlags[flag];
	});

	const quickActions: QuickAction[] = [
		{ id: 'approve', icon: 'check', name: 'Approve', description: "Accept the agent's suggestion and continue", shortcut: 'Ctrl+Enter' },
		{ id: 'reject', icon: 'x', name: 'Reject', description: 'Reject and ask agent to try again', shortcut: 'Ctrl+Backspace' },
		{ id: 'skip', icon: 'minus', name: 'Skip', description: 'Skip this decision, agent proceeds with default', shortcut: 'Ctrl+S' },
		{ id: 'delegate', icon: 'arrow-right', name: 'Delegate', description: 'Hand off to another agent or escalate', shortcut: 'Ctrl+D' }
	];

	const notifDefaults: NotifSettings = {
		desktop: true,
		inAppToasts: true,
		sound: false,
		quietHoursStart: '23:00',
		quietHoursEnd: '08:00',
		categories: {
			task: { desktop: true, inApp: true },
			service: { desktop: true, inApp: true },
			agent: { desktop: true, inApp: true },
			chat: { desktop: false, inApp: true },
			memory: { desktop: false, inApp: true },
			model: { desktop: true, inApp: true },
			system: { desktop: true, inApp: true }
		},
		heartbeatEnabled: true,
		heartbeatIntervalMs: 60000
	};

	return {
		categories,
		featureFlags,
		quickActions,
		behavior: {
			requireConfirmation: generalSettings.requireConfirmation,
			autoApproveLowRisk: generalSettings.autoApproveLowRisk,
			showCommandsInInputBar: generalSettings.showCommandsInInputBar
		},
		defaultTimeout: generalSettings.defaultTimeout,
		scope: 'global' as 'global' | 'project',
		projectOverride: generalSettings.projectOverride,
		notifSettings,
		agentDefaults,
		modelRoutingSettings,
		memorySettings,
		apiKeys,
		defaults: {
			general: GENERAL_DEFAULTS,
			agentDefaults: AGENT_DEFAULTS,
			modelRouting: MODEL_ROUTING_DEFAULTS,
			notifications: notifDefaults
		}
	};
};
