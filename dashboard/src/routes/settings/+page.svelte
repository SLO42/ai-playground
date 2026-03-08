<script lang="ts">
	import { browser } from '$app/environment';
	import { get } from 'svelte/store';
	import { projectsStore } from '$lib/stores/projects.js';
	import { apiFetch } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let activeCategory = $state('general');
	let scope = $state<'global' | 'project'>(data.scope as 'global' | 'project');
	let scopeLoading = $state(false);

	function scopeQueryString(): string {
		if (scope !== 'project') return '';
		const proj = get(projectsStore.activeProject);
		if (!proj?.path) return '';
		return `?scope=project&projectPath=${encodeURIComponent(proj.path)}`;
	}

	function hasActiveProject(): boolean {
		return !!get(projectsStore.activeProject)?.path;
	}
	let requireConfirmation = $state(data.behavior.requireConfirmation);
	let autoApproveLowRisk = $state(data.behavior.autoApproveLowRisk);
	let showCommands = $state(data.behavior.showCommandsInInputBar);
	let defaultTimeout = $state(data.defaultTimeout);
	let projectOverride = $state(data.projectOverride);
	let generalSaving = $state(false);
	let generalSaved = $state(false);

	// Notification settings
	let notifDesktop = $state(data.notifSettings.desktop);
	let notifInApp = $state(data.notifSettings.inAppToasts);
	let notifSound = $state(data.notifSettings.sound);
	let notifQuietStart = $state(data.notifSettings.quietHoursStart);
	let notifQuietEnd = $state(data.notifSettings.quietHoursEnd);
	let notifCategories = $state({ ...data.notifSettings.categories });
	let heartbeatEnabled = $state(data.notifSettings.heartbeatEnabled !== false);
	let heartbeatIntervalSec = $state(Math.round((data.notifSettings.heartbeatIntervalMs ?? 60000) / 1000));
	let notifSaving = $state(false);
	let notifSaved = $state(false);
	let testSending = $state(false);
	let testSent = $state(false);

	// Agent defaults
	let agentModel = $state(data.agentDefaults.defaultModel);
	let agentMaxConcurrent = $state(data.agentDefaults.maxConcurrentAgents);
	let agentTopology = $state(data.agentDefaults.defaultTopology);
	let agentSaving = $state(false);
	let agentSaved = $state(false);

	// API keys
	let apiKeys = $state(data.apiKeys);
	let editingKey = $state('');
	let editingValue = $state('');
	let apiKeySaving = $state(false);
	let apiKeySaved = $state(false);
	let apiKeyError = $state('');

	// Memory settings
	let memBackend = $state(data.memorySettings.backend);
	let memEnableHNSW = $state(data.memorySettings.enableHNSW);
	let memCacheSize = $state(data.memorySettings.cacheSize);
	let memPersistPath = $state(data.memorySettings.persistPath);
	let memLearningBridge = $state(data.memorySettings.learningBridgeEnabled);
	let memGraph = $state(data.memorySettings.memoryGraphEnabled);
	let memorySaving = $state(false);
	let memorySaved = $state(false);

	// Model routing settings
	let routingStrategy = $state(data.modelRoutingSettings.strategy);
	let complexityThreshold = $state(data.modelRoutingSettings.complexityThreshold);
	let localModel = $state(data.modelRoutingSettings.localModel);
	let localProvider = $state(data.modelRoutingSettings.localProvider);
	let cloudModel = $state(data.modelRoutingSettings.cloudModel);
	let cloudProvider = $state(data.modelRoutingSettings.cloudProvider);
	let routingSaving = $state(false);
	let routingSaved = $state(false);

	const categoryLabels: Record<string, string> = {
		task: 'Task updates',
		service: 'Service status',
		agent: 'Agent events',
		chat: 'Chat messages',
		memory: 'Memory alerts',
		model: 'Model loading',
		system: 'System events'
	};

	async function sendTestNotification() {
		testSending = true;
		await apiFetch('/api/notifications', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Test Notification',
				message: 'This is a test notification from Settings. If you see this, notifications are working!',
				severity: 'info',
				category: 'system',
				source: 'settings',
				desktop: notifDesktop
			})
		});
		testSending = false;
		testSent = true;
		setTimeout(() => { testSent = false; }, 3000);
	}

	async function saveNotifSettings() {
		notifSaving = true;
		await apiFetch(`/api/settings/notifications${scopeQueryString()}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				desktop: notifDesktop,
				inAppToasts: notifInApp,
				sound: notifSound,
				quietHoursStart: notifQuietStart,
				quietHoursEnd: notifQuietEnd,
				categories: notifCategories,
				heartbeatEnabled,
				heartbeatIntervalMs: Math.max(10, heartbeatIntervalSec) * 1000
			})
		});
		notifSaving = false;
		notifSaved = true;
		setTimeout(() => { notifSaved = false; }, 2000);
	}

	async function saveGeneralSettings() {
		generalSaving = true;
		await apiFetch(`/api/settings/general${scopeQueryString()}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				requireConfirmation,
				autoApproveLowRisk,
				showCommandsInInputBar: showCommands,
				defaultTimeout,
				projectOverride
			})
		});
		generalSaving = false;
		generalSaved = true;
		setTimeout(() => { generalSaved = false; }, 2000);
	}

	async function saveAgentDefaults() {
		agentSaving = true;
		await apiFetch(`/api/settings/agent-defaults${scopeQueryString()}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				defaultModel: agentModel,
				maxConcurrentAgents: agentMaxConcurrent,
				defaultTopology: agentTopology
			})
		});
		agentSaving = false;
		agentSaved = true;
		setTimeout(() => { agentSaved = false; }, 2000);
	}

	async function saveModelRouting() {
		routingSaving = true;
		await apiFetch(`/api/settings/model-routing${scopeQueryString()}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				strategy: routingStrategy,
				complexityThreshold,
				localModel,
				localProvider,
				cloudModel,
				cloudProvider
			})
		});
		routingSaving = false;
		routingSaved = true;
		setTimeout(() => { routingSaved = false; }, 2000);
	}

	async function saveMemorySettings() {
		memorySaving = true;
		await apiFetch('/api/settings/memory', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				backend: memBackend,
				enableHNSW: memEnableHNSW,
				cacheSize: memCacheSize,
				persistPath: memPersistPath,
				learningBridgeEnabled: memLearningBridge,
				memoryGraphEnabled: memGraph
			})
		});
		memorySaving = false;
		memorySaved = true;
		setTimeout(() => { memorySaved = false; }, 2000);
	}

	// Services health
	interface ServiceHealth {
		id: string;
		name: string;
		url: string;
		status: 'checking' | 'connected' | 'disconnected' | 'error';
	}

	let servicesHealth = $state<ServiceHealth[]>([
		{ id: 'ollama', name: 'Ollama', url: '127.0.0.1:11434', status: 'checking' },
		{ id: 'openclaw', name: 'OpenClaw Gateway', url: '127.0.0.1:18789', status: 'checking' },
		{ id: 'claude-flow', name: 'Claude Flow Daemon', url: '127.0.0.1:3847', status: 'checking' }
	]);
	let servicesChecking = $state(false);

	async function checkServicesHealth() {
		servicesChecking = true;
		servicesHealth = servicesHealth.map(s => ({ ...s, status: 'checking' as const }));
		try {
			const res = await apiFetch('/api/health', { silent: true });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			servicesHealth = [
				{ id: 'ollama', name: 'Ollama', url: '127.0.0.1:11434', status: data.ollama ? 'connected' : 'disconnected' },
				{ id: 'openclaw', name: 'OpenClaw Gateway', url: '127.0.0.1:18789', status: data.gateway ? 'connected' : 'disconnected' },
				{ id: 'claude-flow', name: 'Claude Flow Daemon', url: '127.0.0.1:3847', status: data.daemon ? 'connected' : 'disconnected' }
			];
		} catch {
			servicesHealth = servicesHealth.map(s => ({ ...s, status: 'error' as const }));
		}
		servicesChecking = false;
	}

	// Auto-check when services tab is selected
	$effect(() => {
		if (activeCategory === 'services') {
			checkServicesHealth();
		}
	});

	// Graceful shutdown
	let shutdownState = $state<'idle' | 'confirming' | 'shutting_down' | 'done'>('idle');
	let shutdownSteps = $state<{ step: string; status: string; detail?: string }[]>([]);
	let shutdownError = $state('');

	async function initiateShutdown() {
		shutdownState = 'shutting_down';
		shutdownError = '';
		shutdownSteps = [
			{ step: 'heartbeat', status: 'pending', detail: 'Stopping heartbeat...' },
			{ step: 'agents', status: 'pending', detail: 'Killing agents...' },
			{ step: 'session-pool', status: 'pending', detail: 'Clearing sessions...' },
			{ step: 'claude-flow', status: 'pending', detail: 'Stopping daemon...' }
		];

		try {
			const res = await apiFetch('/api/settings/shutdown', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				silent: true  // suppress network error toast — connection drop is expected
			});

			if (res.ok) {
				const data = await res.json();
				shutdownSteps = data.steps;
				shutdownState = 'done';
			} else {
				shutdownError = `Shutdown failed: HTTP ${res.status}`;
				shutdownState = 'idle';
			}
		} catch {
			// Connection closed = server exited successfully
			shutdownState = 'done';
			shutdownSteps = shutdownSteps.map(s => s.status === 'pending' ? { ...s, status: 'ok' } : s);
		}
	}

	async function saveApiKey(name: string) {
		if (!editingValue.trim()) return;
		apiKeySaving = true;
		apiKeyError = '';
		try {
			const res = await apiFetch('/api/settings/api-keys', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, value: editingValue.trim() })
			});
			if (!res.ok) {
				apiKeyError = 'Failed to save key: ' + res.statusText;
			} else {
				const idx = apiKeys.findIndex((k) => k.name === name);
				if (idx >= 0) apiKeys[idx].set = true;
				editingKey = '';
				editingValue = '';
				apiKeySaved = true;
				setTimeout(() => { apiKeySaved = false; }, 3000);
			}
		} catch {
			apiKeyError = 'Failed to save key';
		}
		apiKeySaving = false;
	}

	// Track last-saved state for Reset
	let savedState = $state({
		general: {
			requireConfirmation, autoApproveLowRisk, showCommands,
			defaultTimeout, projectOverride
		},
		agent: { agentModel, agentMaxConcurrent, agentTopology },
		notif: {
			notifDesktop, notifInApp, notifSound, notifQuietStart, notifQuietEnd,
			notifCategories: { ...notifCategories }, heartbeatEnabled, heartbeatIntervalSec
		},
		routing: {
			routingStrategy, complexityThreshold, localModel, localProvider,
			cloudModel, cloudProvider
		}
	});

	function snapshotSaved() {
		savedState = {
			general: {
				requireConfirmation, autoApproveLowRisk, showCommands,
				defaultTimeout, projectOverride
			},
			agent: { agentModel, agentMaxConcurrent, agentTopology },
			notif: {
				notifDesktop, notifInApp, notifSound, notifQuietStart, notifQuietEnd,
				notifCategories: JSON.parse(JSON.stringify(notifCategories)),
				heartbeatEnabled, heartbeatIntervalSec
			},
			routing: {
				routingStrategy, complexityThreshold, localModel, localProvider,
				cloudModel, cloudProvider
			}
		};
	}

	async function reloadScopedSettings() {
		scopeLoading = true;
		const qs = scopeQueryString();
		try {
			const [genRes, agentRes, notifRes, routingRes] = await Promise.all([
				apiFetch(`/api/settings/general${qs}`, { silent: true }),
				apiFetch(`/api/settings/agent-defaults${qs}`, { silent: true }),
				apiFetch(`/api/settings/notifications${qs}`, { silent: true }),
				apiFetch(`/api/settings/model-routing${qs}`, { silent: true })
			]);
			if (genRes.ok) {
				const g = await genRes.json();
				requireConfirmation = g.requireConfirmation;
				autoApproveLowRisk = g.autoApproveLowRisk;
				showCommands = g.showCommandsInInputBar;
				defaultTimeout = g.defaultTimeout;
				projectOverride = g.projectOverride;
			}
			if (agentRes.ok) {
				const a = await agentRes.json();
				agentModel = a.defaultModel;
				agentMaxConcurrent = a.maxConcurrentAgents;
				agentTopology = a.defaultTopology;
			}
			if (notifRes.ok) {
				const n = await notifRes.json();
				notifDesktop = n.desktop;
				notifInApp = n.inAppToasts;
				notifSound = n.sound;
				notifQuietStart = n.quietHoursStart;
				notifQuietEnd = n.quietHoursEnd;
				notifCategories = { ...n.categories };
				heartbeatEnabled = n.heartbeatEnabled !== false;
				heartbeatIntervalSec = Math.round((n.heartbeatIntervalMs ?? 60000) / 1000);
			}
			if (routingRes.ok) {
				const r = await routingRes.json();
				routingStrategy = r.strategy;
				complexityThreshold = r.complexityThreshold;
				localModel = r.localModel;
				localProvider = r.localProvider;
				cloudModel = r.cloudModel;
				cloudProvider = r.cloudProvider;
			}
			snapshotSaved();
		} catch (err) {
			console.error('Failed to reload settings for scope:', err);
		}
		scopeLoading = false;
	}

	// Reload settings when scope changes
	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		scope; // track dependency
		if (!browser) return;
		if (scope === 'project' && !hasActiveProject()) return;
		reloadScopedSettings();
	});

	function resetToLastSaved() {
		if (activeCategory === 'general') {
			requireConfirmation = savedState.general.requireConfirmation;
			autoApproveLowRisk = savedState.general.autoApproveLowRisk;
			showCommands = savedState.general.showCommands;
			defaultTimeout = savedState.general.defaultTimeout;
			projectOverride = savedState.general.projectOverride;
		} else if (activeCategory === 'agent-defaults') {
			agentModel = savedState.agent.agentModel;
			agentMaxConcurrent = savedState.agent.agentMaxConcurrent;
			agentTopology = savedState.agent.agentTopology;
		} else if (activeCategory === 'notifications') {
			notifDesktop = savedState.notif.notifDesktop;
			notifInApp = savedState.notif.notifInApp;
			notifSound = savedState.notif.notifSound;
			notifQuietStart = savedState.notif.notifQuietStart;
			notifQuietEnd = savedState.notif.notifQuietEnd;
			notifCategories = JSON.parse(JSON.stringify(savedState.notif.notifCategories));
			heartbeatEnabled = savedState.notif.heartbeatEnabled;
			heartbeatIntervalSec = savedState.notif.heartbeatIntervalSec;
		} else if (activeCategory === 'model-routing') {
			routingStrategy = savedState.routing.routingStrategy;
			complexityThreshold = savedState.routing.complexityThreshold;
			localModel = savedState.routing.localModel;
			localProvider = savedState.routing.localProvider;
			cloudModel = savedState.routing.cloudModel;
			cloudProvider = savedState.routing.cloudProvider;
		}
	}

	function restoreDefaults() {
		const d = data.defaults;
		if (activeCategory === 'general') {
			requireConfirmation = d.general.requireConfirmation;
			autoApproveLowRisk = d.general.autoApproveLowRisk;
			showCommands = d.general.showCommandsInInputBar;
			defaultTimeout = d.general.defaultTimeout;
			projectOverride = d.general.projectOverride;
		} else if (activeCategory === 'agent-defaults') {
			agentModel = d.agentDefaults.defaultModel;
			agentMaxConcurrent = d.agentDefaults.maxConcurrentAgents;
			agentTopology = d.agentDefaults.defaultTopology;
		} else if (activeCategory === 'notifications') {
			notifDesktop = d.notifications.desktop;
			notifInApp = d.notifications.inAppToasts;
			notifSound = d.notifications.sound;
			notifQuietStart = d.notifications.quietHoursStart;
			notifQuietEnd = d.notifications.quietHoursEnd;
			notifCategories = JSON.parse(JSON.stringify(d.notifications.categories));
			heartbeatEnabled = d.notifications.heartbeatEnabled !== false;
			heartbeatIntervalSec = Math.round((d.notifications.heartbeatIntervalMs ?? 60000) / 1000);
		} else if (activeCategory === 'model-routing') {
			routingStrategy = d.modelRouting.strategy;
			complexityThreshold = d.modelRouting.complexityThreshold;
			localModel = d.modelRouting.localModel;
			localProvider = d.modelRouting.localProvider;
			cloudModel = d.modelRouting.cloudModel;
			cloudProvider = d.modelRouting.cloudProvider;
		}
	}

	async function saveCurrentTab() {
		if (activeCategory === 'general') await saveGeneralSettings();
		else if (activeCategory === 'agent-defaults') await saveAgentDefaults();
		else if (activeCategory === 'notifications') await saveNotifSettings();
		else if (activeCategory === 'model-routing') await saveModelRouting();
		else if (activeCategory === 'memory') await saveMemorySettings();
		snapshotSaved();
	}

	const savableCategories = new Set(['general', 'agent-defaults', 'notifications', 'model-routing', 'memory']);
	let isSavable = $derived(savableCategories.has(activeCategory));
	let isSaving = $derived(generalSaving || agentSaving || notifSaving || routingSaving || memorySaving);

	const iconMap: Record<string, string> = {
		gear: '\u2699',
		cpu: '\u2328',
		bell: '\uD83D\uDD14',
		route: '\u2194',
		database: '\uD83D\uDDC3',
		shield: '\uD83D\uDEE1',
		palette: '\uD83C\uDFA8',
		keyboard: '\u2328',
		key: '\uD83D\uDD11',
		server: '\uD83D\uDDA5'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-2xl font-bold text-text-primary">Settings</h1>
		<p class="text-sm text-text-secondary mt-1">Manage application preferences, agent behavior, and system configuration</p>
	</div>

	<!-- Main layout -->
	<div class="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
		<!-- Left sidebar: Categories -->
		<div class="bg-bg-secondary border border-border rounded-lg p-3 space-y-1 h-fit">
			{#each data.categories as cat}
				<button
					class="w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors {activeCategory === cat.id ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}"
					onclick={() => (activeCategory = cat.id)}
				>
					<span class="text-base">{iconMap[cat.icon] ?? ''}</span>
					<span>{cat.name}</span>
				</button>
			{/each}
		</div>

		<!-- Right content -->
		<div class="space-y-6">
			{#if activeCategory === 'general'}
				<h2 class="text-lg font-semibold text-text-primary">General</h2>
				<div class="space-y-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Require confirmation before executing actions</p>
							<p class="text-xs text-text-secondary">Show dialog for Approve/Reject</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={requireConfirmation} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>

					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Auto-approve low-risk decisions</p>
							<p class="text-xs text-text-secondary">Skip confirmation for formatting, naming, trivial changes</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={autoApproveLowRisk} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>

					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Show /commands in input bar</p>
							<p class="text-xs text-text-secondary">Display slash command suggestions while typing</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={showCommands} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>

					<div class="flex items-center justify-between">
						<p class="text-sm text-text-primary">Default agent wait timeout</p>
						<select bind:value={defaultTimeout} aria-label="Default agent wait timeout" class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
							<option value="15 minutes">15 minutes</option>
							<option value="30 minutes">30 minutes</option>
							<option value="60 minutes">60 minutes</option>
							<option value="No timeout">No timeout</option>
						</select>
					</div>

					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Project override</p>
							<p class="text-xs text-text-secondary">Allow per-project settings to override global defaults</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={projectOverride} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
					<div class="flex items-center gap-3 mt-2">
						<button
							onclick={saveGeneralSettings}
							disabled={generalSaving}
							class="px-4 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
						>
							{generalSaving ? 'Saving...' : 'Save General Settings'}
						</button>
						{#if generalSaved}
							<span class="text-xs text-green-400">Saved</span>
						{/if}
					</div>
				</div>

			{:else if activeCategory === 'agent-defaults'}
				<h2 class="text-lg font-semibold text-text-primary">Agent Defaults</h2>
				<p class="text-sm text-text-secondary">Default configuration for newly spawned agents. <span class="text-text-secondary/60">Persisted to <code class="text-xs font-mono">.playground/agent-defaults.json</code></span></p>
				<div class="space-y-4 mt-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Default model</p>
							<p class="text-xs text-text-secondary">Model used when spawning new agents</p>
						</div>
						<select bind:value={agentModel} aria-label="Default model" class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
							<option value="gpt-oss-20b">GPT-OSS 20B (local)</option>
							<option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
							<option value="claude-haiku-4-5">Claude Haiku 4.5</option>
						</select>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Max concurrent agents</p>
							<p class="text-xs text-text-secondary">Maximum agents running simultaneously (1–15)</p>
						</div>
						<input
							type="number"
							bind:value={agentMaxConcurrent}
							min="1"
							max="15"
							aria-label="Max concurrent agents"
							class="w-20 bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary"
						/>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Default topology</p>
							<p class="text-xs text-text-secondary">Agent coordination topology for swarms</p>
						</div>
						<select bind:value={agentTopology} aria-label="Default topology" class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
							<option value="hierarchical">Hierarchical</option>
							<option value="mesh">Mesh</option>
							<option value="hierarchical-mesh">Hierarchical Mesh</option>
							<option value="star">Star</option>
							<option value="ring">Ring</option>
						</select>
					</div>
					<div class="flex items-center gap-3 mt-2">
						<button
							onclick={saveAgentDefaults}
							disabled={agentSaving}
							class="px-4 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
						>
							{agentSaving ? 'Saving...' : 'Save Agent Defaults'}
						</button>
						{#if agentSaved}
							<span class="text-xs text-green-400">Saved</span>
						{/if}
					</div>
				</div>

			{:else if activeCategory === 'notifications'}
				<h2 class="text-lg font-semibold text-text-primary">Notifications</h2>

				<div class="text-xs text-text-secondary uppercase tracking-wider mb-4">Delivery</div>
				<div class="space-y-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Desktop notifications</p>
							<p class="text-xs text-text-secondary">Windows toast notifications for important events</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={notifDesktop} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">In-app toasts</p>
							<p class="text-xs text-text-secondary">Show toast popups in the dashboard when events occur</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={notifInApp} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Sound alerts</p>
							<p class="text-xs text-text-secondary">Play a sound for critical notifications</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={notifSound} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
				</div>

				<div class="text-xs text-text-secondary uppercase tracking-wider mb-4 mt-8">Quiet Hours</div>
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2">
						<span class="text-sm text-text-secondary">From</span>
						<input
							type="time"
							bind:value={notifQuietStart}
							class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary"
						/>
					</div>
					<div class="flex items-center gap-2">
						<span class="text-sm text-text-secondary">to</span>
						<input
							type="time"
							bind:value={notifQuietEnd}
							class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary"
						/>
					</div>
					<span class="text-xs text-text-secondary">(desktop only — in-app still fires)</span>
				</div>

				<div class="text-xs text-text-secondary uppercase tracking-wider mb-4 mt-8">Claw Heartbeat</div>
				<div class="space-y-3">
					<div class="flex items-center justify-between bg-bg-secondary border border-border rounded-lg px-4 py-3">
						<div>
							<span class="text-sm text-text-primary">Enable heartbeat notifications</span>
							<p class="text-xs text-text-secondary mt-0.5">Periodic service health check pushed to inbox</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={heartbeatEnabled} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
					{#if heartbeatEnabled}
						<div class="flex items-center gap-3 bg-bg-secondary border border-border rounded-lg px-4 py-3">
							<span class="text-sm text-text-secondary">Interval</span>
							<input
								type="number"
								bind:value={heartbeatIntervalSec}
								min="10"
								max="3600"
								step="10"
								class="w-24 bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary"
							/>
							<span class="text-sm text-text-secondary">seconds</span>
							<span class="text-xs text-text-secondary ml-auto">
								{#if heartbeatIntervalSec < 60}
									({heartbeatIntervalSec}s)
								{:else}
									({Math.floor(heartbeatIntervalSec / 60)}m {heartbeatIntervalSec % 60 > 0 ? `${heartbeatIntervalSec % 60}s` : ''})
								{/if}
							</span>
						</div>
					{/if}
				</div>

				<div class="text-xs text-text-secondary uppercase tracking-wider mb-4 mt-8">Per-Category Settings</div>
				<div class="space-y-3">
					{#each Object.entries(notifCategories) as [cat, prefs]}
						<div class="flex items-center justify-between bg-bg-secondary border border-border rounded-lg px-4 py-3">
							<span class="text-sm text-text-primary">{categoryLabels[cat] ?? cat}</span>
							<div class="flex items-center gap-4">
								<label class="flex items-center gap-1.5 cursor-pointer">
									<input type="checkbox" bind:checked={prefs.desktop} class="accent-accent-blue w-3.5 h-3.5" />
									<span class="text-xs text-text-secondary">Desktop</span>
								</label>
								<label class="flex items-center gap-1.5 cursor-pointer">
									<input type="checkbox" bind:checked={prefs.inApp} class="accent-accent-blue w-3.5 h-3.5" />
									<span class="text-xs text-text-secondary">In-app</span>
								</label>
							</div>
						</div>
					{/each}
				</div>

				<div class="flex items-center gap-3 mt-6">
					<button
						onclick={saveNotifSettings}
						disabled={notifSaving}
						class="px-4 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
					>
						{notifSaving ? 'Saving...' : 'Save Notification Settings'}
					</button>
					{#if notifSaved}
						<span class="text-xs text-green-400">Saved</span>
					{/if}
					<button
						onclick={sendTestNotification}
						disabled={testSending}
						class="px-4 py-1.5 text-xs font-medium text-text-primary border border-border rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-50"
					>
						{testSending ? 'Sending...' : 'Send Test Notification'}
					</button>
					{#if testSent}
						<span class="text-xs text-accent-blue">Sent! Check your toasts.</span>
					{/if}
				</div>

			{:else if activeCategory === 'model-routing'}
				<h2 class="text-lg font-semibold text-text-primary">Model Routing</h2>
				<p class="text-sm text-text-secondary">Controls which model handles chat requests. <span class="text-text-secondary/60">Persisted to <code class="text-xs font-mono">.playground/model-routing.json</code></span></p>
				<div class="space-y-4 mt-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Routing strategy</p>
							<p class="text-xs text-text-secondary">How requests are assigned to models</p>
						</div>
						<select bind:value={routingStrategy} aria-label="Routing strategy" class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
							<option value="local-first">Local-first (escalate on complexity)</option>
							<option value="cloud-first">Cloud-first (downgrade on simplicity)</option>
							<option value="round-robin">Round-robin</option>
							<option value="manual">Manual (use chat provider picker)</option>
						</select>
					</div>
					{#if routingStrategy !== 'manual'}
						<div class="flex items-center justify-between">
							<div>
								<p class="text-sm text-text-primary">Complexity threshold</p>
								<p class="text-xs text-text-secondary">
									{#if routingStrategy === 'local-first'}
										Tasks above this escalate to cloud
									{:else if routingStrategy === 'cloud-first'}
										Tasks below this downgrade to local
									{:else}
										Not used in round-robin mode
									{/if}
								</p>
							</div>
							<div class="flex items-center gap-2">
								<input
									type="range"
									min="0"
									max="1"
									step="0.05"
									bind:value={complexityThreshold}
									aria-label="Complexity threshold"
									class="w-32 accent-accent-blue"
								/>
								<span class="text-sm font-mono text-text-primary w-12 text-right">{Math.round(complexityThreshold * 100)}%</span>
							</div>
						</div>
					{/if}

					<div class="text-xs text-text-secondary uppercase tracking-wider mt-6 mb-2">Local Model</div>
					<div class="flex items-center justify-between">
						<p class="text-sm text-text-primary">Provider</p>
						<select bind:value={localProvider} aria-label="Local provider" class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
							<option value="ollama">Ollama</option>
							<option value="openclaw">OpenClaw</option>
						</select>
					</div>
					<div class="flex items-center justify-between">
						<p class="text-sm text-text-primary">Model</p>
						<input
							type="text"
							bind:value={localModel}
							aria-label="Local model"
							class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary w-48 font-mono"
							placeholder="gpt-oss:20b"
						/>
					</div>

					<div class="text-xs text-text-secondary uppercase tracking-wider mt-6 mb-2">Cloud Model</div>
					<div class="flex items-center justify-between">
						<p class="text-sm text-text-primary">Provider</p>
						<select bind:value={cloudProvider} aria-label="Cloud provider" class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
							<option value="claude">Claude (Anthropic)</option>
							<option value="openclaw">OpenClaw</option>
						</select>
					</div>
					<div class="flex items-center justify-between">
						<p class="text-sm text-text-primary">Model</p>
						<input
							type="text"
							bind:value={cloudModel}
							aria-label="Cloud model"
							class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary w-48 font-mono"
							placeholder="claude-sonnet-4-6"
						/>
					</div>

					<div class="flex items-center gap-3 mt-4">
						<button
							onclick={saveModelRouting}
							disabled={routingSaving}
							class="px-4 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
						>
							{routingSaving ? 'Saving...' : 'Save Routing Settings'}
						</button>
						{#if routingSaved}
							<span class="text-xs text-green-400">Saved</span>
						{/if}
					</div>
				</div>

			{:else if activeCategory === 'memory'}
				<h2 class="text-lg font-semibold text-text-primary">Memory</h2>
				<p class="text-sm text-text-secondary">AgentDB and HNSW memory configuration. <span class="text-text-secondary/60">Persisted to <code class="text-xs font-mono">.playground/memory-settings.json</code></span></p>
				<div class="space-y-4 mt-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Memory backend</p>
							<p class="text-xs text-text-secondary">Storage engine for agent memory</p>
						</div>
						<select bind:value={memBackend} aria-label="Memory backend" class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
							<option value="hybrid">Hybrid (SQLite + HNSW)</option>
							<option value="sqlite">SQLite only</option>
							<option value="hnsw">HNSW only</option>
						</select>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">HNSW indexing</p>
							<p class="text-xs text-text-secondary">Vector similarity search for memory retrieval</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={memEnableHNSW} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Cache size</p>
							<p class="text-xs text-text-secondary">Number of entries to keep in memory cache (10–10,000)</p>
						</div>
						<input
							type="number"
							bind:value={memCacheSize}
							min="10"
							max="10000"
							class="w-24 bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary"
						/>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Persist path</p>
							<p class="text-xs text-text-secondary">Directory for memory data files</p>
						</div>
						<input
							type="text"
							bind:value={memPersistPath}
							class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary w-48 font-mono"
						/>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Learning bridge</p>
							<p class="text-xs text-text-secondary">Self-learning memory with confidence decay</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={memLearningBridge} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Memory graph</p>
							<p class="text-xs text-text-secondary">PageRank-based relationship graph between memories</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={memGraph} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
					<div class="flex items-center gap-3 mt-2">
						<button
							onclick={saveMemorySettings}
							disabled={memorySaving}
							class="px-4 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
						>
							{memorySaving ? 'Saving...' : 'Save Memory Settings'}
						</button>
						{#if memorySaved}
							<span class="text-xs text-green-400">Saved</span>
						{/if}
					</div>
				</div>

			{:else if activeCategory === 'security'}
				<h2 class="text-lg font-semibold text-text-primary">Security</h2>
				<p class="text-sm text-text-secondary">Gateway binding, TLS, and access control settings.</p>
				<div class="space-y-4 mt-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">Gateway bind address</p>
							<p class="text-xs text-text-secondary">Loopback only recommended for local use</p>
						</div>
						<span class="text-sm font-mono text-text-primary bg-bg-primary border border-border rounded px-2 py-1">127.0.0.1</span>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">TLS minimum version</p>
							<p class="text-xs text-text-secondary">Enforced for all transport</p>
						</div>
						<span class="text-sm font-mono text-text-primary bg-bg-primary border border-border rounded px-2 py-1">TLS 1.3</span>
					</div>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">DM pairing policy</p>
							<p class="text-xs text-text-secondary">Require short-code approval for DM access</p>
						</div>
						<span class="text-xs font-medium px-2 py-0.5 rounded bg-accent-green/10 text-accent-green border border-accent-green/30">Pairing</span>
					</div>
				</div>

			{:else if activeCategory === 'shortcuts'}
				<h2 class="text-lg font-semibold text-text-primary">Keyboard Shortcuts</h2>
				<p class="text-sm text-text-secondary">Customize keyboard shortcuts for common actions.</p>
				<div class="space-y-3 mt-4">
					{#each [
						{ action: 'Send message', shortcut: 'Enter' },
						{ action: 'New line', shortcut: 'Shift+Enter' },
						{ action: 'Focus chat', shortcut: 'Ctrl+/' },
						{ action: 'Toggle sidebar', shortcut: 'Ctrl+B' }
					] as binding}
						<div class="flex items-center justify-between bg-bg-secondary border border-border rounded-lg px-4 py-3">
							<span class="text-sm text-text-primary">{binding.action}</span>
							<span class="text-xs font-mono text-text-secondary bg-bg-primary border border-border rounded px-2 py-1">{binding.shortcut}</span>
						</div>
					{/each}
				</div>

			{:else if activeCategory === 'api-keys'}
				<h2 class="text-lg font-semibold text-text-primary">API Keys</h2>
				<p class="text-sm text-text-secondary">Manage API keys for external services. Stored in .env (never committed).</p>
				<div class="space-y-3 mt-4">
					{#each apiKeys as key}
						<div class="flex items-center justify-between bg-bg-secondary border border-border rounded-lg px-4 py-3">
							<div>
								<span class="text-sm text-text-primary">{key.label}</span>
								<span class="text-xs font-mono text-text-secondary ml-2">{key.name}</span>
							</div>
							<div class="flex items-center gap-2">
								{#if editingKey === key.name}
									<input
										type="password"
										bind:value={editingValue}
										placeholder="Paste new value..."
										class="bg-bg-primary border border-border rounded-lg px-3 py-1 text-sm text-text-primary w-64 font-mono"
									/>
									<button
										onclick={() => saveApiKey(key.name)}
										disabled={apiKeySaving}
										class="px-3 py-1 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
									>
										{apiKeySaving ? '...' : 'Save'}
									</button>
									<button
										onclick={() => { editingKey = ''; editingValue = ''; }}
										class="px-3 py-1 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-tertiary transition-colors"
									>
										Cancel
									</button>
								{:else}
									<button
										onclick={() => { editingKey = key.name; editingValue = ''; }}
										class="px-3 py-1 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-tertiary transition-colors"
									>
										{key.set ? 'Update' : 'Set'}
									</button>
									<span class="text-xs font-medium px-2 py-0.5 rounded
										{key.set ? 'bg-accent-green/10 text-accent-green border border-accent-green/30' : 'bg-bg-primary text-text-secondary border border-border'}">
										{key.set ? 'Set' : 'Not set'}
									</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
				{#if apiKeySaved}
					<span class="text-xs text-green-400 mt-2 block">Key saved. Restart the server for changes to take effect.</span>
				{/if}
				{#if apiKeyError}
					<span class="text-xs text-red-400 mt-2 block">{apiKeyError}</span>
				{/if}

			{:else if activeCategory === 'services'}
				<div class="flex items-center justify-between">
					<div>
						<h2 class="text-lg font-semibold text-text-primary">Services</h2>
						<p class="text-sm text-text-secondary">External service connections and health.</p>
					</div>
					<button
						onclick={checkServicesHealth}
						disabled={servicesChecking}
						class="px-3 py-1.5 text-xs font-medium text-text-primary border border-border rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-50"
					>
						{servicesChecking ? 'Checking...' : 'Refresh'}
					</button>
				</div>
				<div class="space-y-3 mt-4">
					{#each servicesHealth as svc}
						<div class="flex items-center justify-between bg-bg-secondary border border-border rounded-lg px-4 py-3">
							<div>
								<span class="text-sm text-text-primary">{svc.name}</span>
								<span class="text-xs font-mono text-text-secondary ml-2">{svc.url}</span>
							</div>
							{#if svc.status === 'checking'}
								<span class="text-xs font-medium px-2 py-0.5 rounded bg-accent-blue/10 text-accent-blue border border-accent-blue/30">
									checking...
								</span>
							{:else if svc.status === 'connected'}
								<span class="text-xs font-medium px-2 py-0.5 rounded bg-accent-green/10 text-accent-green border border-accent-green/30">
									connected
								</span>
							{:else if svc.status === 'disconnected'}
								<span class="text-xs font-medium px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/30">
									disconnected
								</span>
							{:else}
								<span class="text-xs font-medium px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30">
									error
								</span>
							{/if}
						</div>
					{/each}
				</div>

				<!-- Graceful Shutdown -->
				<div class="mt-8 pt-6 border-t border-border">
					<h3 class="text-sm font-semibold text-accent-red mb-2">Graceful Shutdown</h3>
					<p class="text-xs text-text-secondary mb-4">
						Stops all running agents, clears the session pool, stops the Claude Flow daemon, then shuts down the dashboard server. This cannot be undone.
					</p>

					{#if shutdownState === 'idle'}
						<button
							onclick={() => (shutdownState = 'confirming')}
							class="w-full py-3 rounded-lg text-sm font-semibold text-white bg-accent-red hover:bg-accent-red/80 transition-colors"
						>
							Shutdown Everything
						</button>

					{:else if shutdownState === 'confirming'}
						<div class="bg-accent-red/10 border border-accent-red/30 rounded-lg p-4 space-y-3">
							<p class="text-sm text-accent-red font-medium">Are you sure? This will:</p>
							<ol class="text-xs text-text-secondary space-y-1 list-decimal list-inside">
								<li>Stop the heartbeat (no new agents)</li>
								<li>Kill all running agents (SIGTERM &rarr; SIGKILL)</li>
								<li>Clear the session pool</li>
								<li>Stop the Claude Flow daemon</li>
								<li>Exit the dashboard process</li>
							</ol>
							<div class="flex gap-3">
								<button
									onclick={initiateShutdown}
									class="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white bg-accent-red hover:bg-accent-red/80 transition-colors"
								>
									Yes, Shut Down
								</button>
								<button
									onclick={() => (shutdownState = 'idle')}
									class="flex-1 py-2.5 rounded-lg text-sm font-medium text-text-secondary border border-border hover:bg-bg-secondary transition-colors"
								>
									Cancel
								</button>
							</div>
						</div>

					{:else if shutdownState === 'shutting_down'}
						<div class="bg-accent-red/5 border border-accent-red/20 rounded-lg p-4">
							<div class="flex items-center gap-2 mb-3">
								<svg class="w-4 h-4 animate-spin text-accent-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
								<span class="text-sm font-medium text-accent-red">Shutting down...</span>
							</div>
							<div class="space-y-2">
								{#each shutdownSteps as step}
									<div class="flex items-center gap-2 text-xs">
										{#if step.status === 'pending'}
											<span class="w-2 h-2 rounded-full bg-accent-yellow animate-pulse"></span>
										{:else if step.status === 'ok'}
											<span class="w-2 h-2 rounded-full bg-accent-green"></span>
										{:else if step.status === 'skipped'}
											<span class="w-2 h-2 rounded-full bg-text-secondary"></span>
										{:else}
											<span class="w-2 h-2 rounded-full bg-accent-red"></span>
										{/if}
										<span class="font-mono text-text-primary">{step.step}</span>
										{#if step.detail}
											<span class="text-text-secondary">&mdash; {step.detail}</span>
										{/if}
									</div>
								{/each}
							</div>
						</div>

					{:else if shutdownState === 'done'}
						<div class="bg-accent-green/10 border border-accent-green/30 rounded-lg p-4">
							<p class="text-sm font-medium text-accent-green mb-3">Shutdown complete</p>
							<div class="space-y-2">
								{#each shutdownSteps as step}
									<div class="flex items-center gap-2 text-xs">
										{#if step.status === 'ok'}
											<span class="w-2 h-2 rounded-full bg-accent-green"></span>
										{:else if step.status === 'skipped'}
											<span class="w-2 h-2 rounded-full bg-text-secondary"></span>
										{:else}
											<span class="w-2 h-2 rounded-full bg-accent-red"></span>
										{/if}
										<span class="font-mono text-text-primary">{step.step}</span>
										{#if step.detail}
											<span class="text-text-secondary">&mdash; {step.detail}</span>
										{/if}
									</div>
								{/each}
							</div>
							<p class="text-xs text-text-secondary mt-3">The server has exited. You can close this tab.</p>
						</div>
					{/if}

					{#if shutdownError}
						<p class="text-xs text-accent-red mt-2">{shutdownError}</p>
					{/if}
				</div>

			{:else}
				<p class="text-sm text-text-secondary">Select a category from the sidebar.</p>
			{/if}

			<!-- Footer -->
			<div class="flex items-center justify-between pt-4 border-t border-border mt-6">
				<div class="flex items-center gap-4">
					<div class="text-xs text-text-secondary uppercase tracking-wider">Scope</div>
					<div class="flex items-center gap-1 bg-bg-primary rounded-lg p-0.5">
						<button
							class="px-3 py-1 text-xs rounded-md transition-colors {scope === 'global' ? 'bg-accent-blue text-white' : 'text-text-secondary'} {scopeLoading ? 'opacity-50 cursor-wait' : ''}"
							onclick={() => (scope = 'global')}
							disabled={scopeLoading}
						>Global</button>
						<button
							class="px-3 py-1 text-xs rounded-md transition-colors {scope === 'project' ? 'bg-accent-blue text-white' : 'text-text-secondary'} {scopeLoading ? 'opacity-50 cursor-wait' : ''}"
							onclick={() => (scope = 'project')}
							disabled={scopeLoading || !hasActiveProject()}
							title={hasActiveProject() ? 'Load project-specific settings' : 'No active project selected'}
						>Project</button>
					</div>
					{#if scopeLoading}
						<span class="text-xs text-accent-blue animate-pulse">Loading...</span>
					{:else if scope === 'project' && !hasActiveProject()}
						<span class="text-xs text-yellow-400">No active project</span>
					{/if}
				</div>
				<div class="flex items-center gap-2">
					{#if isSavable}
						<button
							onclick={restoreDefaults}
							disabled={isSaving || scopeLoading}
							class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-50"
						>Restore Defaults</button>
						<button
							onclick={resetToLastSaved}
							disabled={isSaving || scopeLoading}
							class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-50"
						>Reset</button>
						<button
							onclick={saveCurrentTab}
							disabled={isSaving || scopeLoading}
							class="px-4 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
						>{isSaving ? 'Saving...' : 'Save'}</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
