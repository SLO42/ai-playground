<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let activeCategory = $state('general');
	let scope = $state<'global' | 'project'>(data.scope as 'global' | 'project');
	let requireConfirmation = $state(data.behavior.requireConfirmation);
	let autoApproveLowRisk = $state(data.behavior.autoApproveLowRisk);
	let showCommands = $state(data.behavior.showCommandsInInputBar);
	let projectOverride = $state(data.projectOverride);

	// Heartbeat state
	let hbEnabled = $state(data.heartbeat.enabled);
	let hbPhases = $state(data.heartbeat.phases.map((p) => ({ ...p })));
	let hbSaving = $state(false);
	let hbSaveMessage = $state('');

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
		server: '\uD83D\uDDA5',
		pulse: '\u2764'
	};

	const actionColors: Record<string, string> = {
		approve: 'text-accent-green',
		reject: 'text-accent-red',
		skip: 'text-text-secondary',
		delegate: 'text-accent-purple'
	};

	const actionIcons: Record<string, string> = {
		approve: '\u2713',
		reject: '\u2717',
		skip: '\u2014',
		delegate: '\u2192'
	};

	async function saveHeartbeat() {
		hbSaving = true;
		hbSaveMessage = '';
		try {
			// Convert array phases to object format expected by the API
			const phasesObj: Record<string, boolean> = {};
			const intervalsObj: Record<string, number> = {};
			for (const p of hbPhases) {
				// Convert kebab-case id back to camelCase key
				const key = p.id.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
				phasesObj[key] = p.enabled;
				intervalsObj[key] = p.intervalSeconds * 1000;
			}
			const res = await fetch('/api/settings/heartbeat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: hbEnabled, phases: phasesObj, intervals: intervalsObj })
			});
			const result = await res.json();
			if (res.ok) {
				hbSaveMessage = 'Saved';
				setTimeout(() => (hbSaveMessage = ''), 2000);
			} else {
				hbSaveMessage = result.error ?? 'Save failed';
			}
		} catch {
			hbSaveMessage = 'Network error';
		} finally {
			hbSaving = false;
		}
	}
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
				<!-- Project Override Toggle -->
				<div class="flex items-center justify-between">
					<h2 class="text-lg font-semibold text-text-primary">Quick Actions</h2>
					<div class="flex items-center gap-2">
						<span class="text-xs text-text-secondary">Project Override</span>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={projectOverride} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
				</div>

				<p class="text-xs text-text-secondary">Configure the quick action buttons shown in the Agent Inbox input bar.</p>

				<div class="text-xs text-text-secondary uppercase tracking-wider mb-2">Active Quick Actions</div>
				<p class="text-[11px] text-text-secondary mb-3">Drag to reorder. First 4 shown in input bar.</p>

				<!-- Quick Actions List -->
				<div class="space-y-2">
					{#each data.quickActions as action}
						<div class="bg-bg-secondary border border-border rounded-lg p-3 flex items-center gap-3">
							<span class="text-lg {actionColors[action.id] ?? 'text-text-primary'}">{actionIcons[action.id] ?? ''}</span>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-text-primary">{action.name}</div>
								<div class="text-xs text-text-secondary">{action.description}</div>
							</div>
							<span class="text-xs font-mono text-text-secondary shrink-0">{action.shortcut}</span>
							<button class="text-xs text-text-secondary hover:text-text-primary transition-colors">Edit</button>
							<button class="text-xs text-text-secondary hover:text-accent-red transition-colors">Delete</button>
						</div>
					{/each}
				</div>

				<button class="text-xs text-accent-blue hover:underline mt-2">+ Add Quick Action</button>

				<!-- Behavior Section -->
				<div class="mt-8">
					<div class="text-xs text-text-secondary uppercase tracking-wider mb-4">Behavior</div>
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
							<select class="bg-bg-primary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
								<option>15 minutes</option>
								<option selected>30 minutes</option>
								<option>60 minutes</option>
								<option>No timeout</option>
							</select>
						</div>
					</div>
				</div>
			{:else if activeCategory === 'heartbeat'}
				<!-- Heartbeat Settings -->
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Heartbeat Configuration</h2>
					<p class="text-sm text-text-secondary mt-1">Control the automated lifecycle phases that keep your agents healthy and tasks flowing.</p>
				</div>

				<!-- Master Toggle -->
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm font-medium text-text-primary">Heartbeat Engine</p>
							<p class="text-xs text-text-secondary">Master switch for all heartbeat phases</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" bind:checked={hbEnabled} class="sr-only peer" />
							<div class="w-11 h-6 bg-bg-primary peer-checked:bg-accent-green rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
				</div>

				<!-- Per-Phase Controls -->
				<div>
					<div class="text-xs text-text-secondary uppercase tracking-wider mb-3">Phase Controls</div>
					<div class="space-y-2">
						{#each hbPhases as phase, i}
							<div class="bg-bg-secondary border border-border rounded-lg p-4 flex items-center gap-4 {!hbEnabled ? 'opacity-50 pointer-events-none' : ''}">
								<label class="relative inline-flex items-center cursor-pointer shrink-0">
									<input type="checkbox" bind:checked={hbPhases[i].enabled} class="sr-only peer" />
									<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
								</label>
								<div class="flex-1 min-w-0">
									<p class="text-sm font-medium text-text-primary">{phase.name}</p>
									<p class="text-xs text-text-secondary">
										{#if phase.id === 'health-checks'}
											Ping agents and services to verify liveness
										{:else if phase.id === 'task-scanning'}
											Scan for new, stalled, or orphaned tasks
										{:else if phase.id === 'agent-spawning'}
											Auto-spawn agents when task queue grows
										{:else if phase.id === 'review-cycle'}
											Periodic code review and quality checks
										{:else if phase.id === 'memory-sync'}
											Synchronize agent memory across the swarm
										{/if}
									</p>
								</div>
								<div class="flex items-center gap-2 shrink-0">
									<input
										type="number"
										min="5"
										max="3600"
										bind:value={hbPhases[i].intervalSeconds}
										class="w-20 bg-bg-tertiary border border-border rounded px-2 py-1 text-sm text-text-primary font-mono text-right focus:outline-none focus:border-accent-blue"
									/>
									<span class="text-xs text-text-secondary w-6">sec</span>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Save -->
				<div class="flex items-center justify-end gap-3 pt-2">
					{#if hbSaveMessage}
						<span class="text-xs {hbSaveMessage === 'Saved' ? 'text-accent-green' : 'text-accent-red'}">{hbSaveMessage}</span>
					{/if}
					<button
						onclick={saveHeartbeat}
						disabled={hbSaving}
						class="px-5 py-2 text-sm font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
					>
						{hbSaving ? 'Saving...' : 'Save Heartbeat Config'}
					</button>
				</div>
			{:else if activeCategory === 'notifications'}
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Notifications</h2>
					<p class="text-sm text-text-secondary mt-1">Control how you receive alerts from Claw agents.</p>
				</div>
				<div class="space-y-4 mt-4">
					{#each data.preferences ?? [] as pref}
						<div class="flex items-center justify-between py-2">
							<p class="text-sm text-text-primary">{pref.type}</p>
							<label class="relative inline-flex items-center cursor-pointer">
								<input type="checkbox" checked={pref.desktop || pref.sound} class="sr-only peer" />
								<div class="w-9 h-5 bg-bg-tertiary rounded-full peer peer-checked:bg-accent-blue transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
							</label>
						</div>
					{/each}
				</div>

			{:else if activeCategory === 'model-routing'}
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Model Routing</h2>
					<p class="text-sm text-text-secondary mt-1">Configure how tasks are routed to AI providers.</p>
				</div>
				<div class="mt-4 space-y-3">
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<p class="text-xs text-text-secondary uppercase tracking-wider mb-2">Routing Strategy</p>
						<select class="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary">
							<option>Tiered (Haiku → Sonnet → Opus)</option>
							<option>Cost-optimized</option>
							<option>Quality-first</option>
							<option>Local-first (Ollama → Cloud fallback)</option>
						</select>
					</div>
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<p class="text-xs text-text-secondary uppercase tracking-wider mb-2">Provider Priority</p>
						<div class="space-y-2 text-sm text-text-primary">
							<div class="flex items-center justify-between py-1"><span>1. Ollama (local)</span><span class="text-xs text-accent-green">Free</span></div>
							<div class="flex items-center justify-between py-1"><span>2. Claude Sonnet</span><span class="text-xs text-text-secondary">$3/MTok</span></div>
							<div class="flex items-center justify-between py-1"><span>3. Claude Opus</span><span class="text-xs text-text-secondary">$15/MTok</span></div>
						</div>
					</div>
				</div>

			{:else if activeCategory === 'agent-defaults'}
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Agent Defaults</h2>
					<p class="text-sm text-text-secondary mt-1">Default configuration for new agent sessions.</p>
				</div>
				<div class="mt-4 space-y-4">
					<div class="flex items-center justify-between">
						<div><p class="text-sm text-text-primary">Default Topology</p><p class="text-xs text-text-secondary">How agents coordinate</p></div>
						<select class="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary">
							<option>hierarchical-mesh</option>
							<option>mesh</option>
							<option>hierarchical</option>
							<option>adaptive</option>
						</select>
					</div>
					<div class="flex items-center justify-between">
						<div><p class="text-sm text-text-primary">Max Concurrent Agents</p><p class="text-xs text-text-secondary">Global limit across all projects</p></div>
						<input type="number" value="15" min="1" max="50" class="w-20 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary font-mono" />
					</div>
					<div class="flex items-center justify-between">
						<div><p class="text-sm text-text-primary">Default Model</p><p class="text-xs text-text-secondary">Model used when no routing rule matches</p></div>
						<select class="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary">
							<option>claude-sonnet-4-6</option>
							<option>claude-opus-4-6</option>
							<option>claude-haiku-4-5</option>
							<option>gpt-oss:20b (local)</option>
						</select>
					</div>
				</div>

			{:else if activeCategory === 'memory'}
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Memory</h2>
					<p class="text-sm text-text-secondary mt-1">Configure HNSW vector memory and knowledge graph.</p>
				</div>
				<div class="mt-4 space-y-4">
					<div class="flex items-center justify-between">
						<div><p class="text-sm text-text-primary">Memory Graph</p><p class="text-xs text-text-secondary">Enable BubbleGraph visualization on memory pages</p></div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" checked class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-tertiary rounded-full peer peer-checked:bg-accent-blue transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
					<div class="flex items-center justify-between">
						<div><p class="text-sm text-text-primary">Auto-sync Interval</p><p class="text-xs text-text-secondary">How often memory bridge syncs with claude-flow</p></div>
						<select class="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary">
							<option>30 seconds</option>
							<option selected>60 seconds</option>
							<option>5 minutes</option>
							<option>Manual only</option>
						</select>
					</div>
					<div class="flex items-center justify-between">
						<div><p class="text-sm text-text-primary">Pattern Decay</p><p class="text-xs text-text-secondary">Half-life for learned patterns</p></div>
						<select class="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary">
							<option>7 days</option>
							<option selected>30 days</option>
							<option>90 days</option>
							<option>Never</option>
						</select>
					</div>
				</div>

			{:else if activeCategory === 'security'}
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Security</h2>
					<p class="text-sm text-text-secondary mt-1">Network policy, input validation, and audit settings.</p>
				</div>
				<div class="mt-4 space-y-3">
					<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
						<div class="flex items-center justify-between"><p class="text-sm text-text-primary">Prompt Injection Guard</p><span class="text-xs text-accent-green">Active</span></div>
						<div class="flex items-center justify-between"><p class="text-sm text-text-primary">Path Traversal Guard</p><span class="text-xs text-accent-green">Active</span></div>
						<div class="flex items-center justify-between"><p class="text-sm text-text-primary">Command Injection Guard</p><span class="text-xs text-accent-green">Active</span></div>
						<div class="flex items-center justify-between"><p class="text-sm text-text-primary">XSS Sanitization</p><span class="text-xs text-accent-green">Active</span></div>
					</div>
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<p class="text-xs text-text-secondary uppercase tracking-wider mb-2">Secret Rotation</p>
						<p class="text-sm text-text-primary">Policy: 90-day rotation</p>
						<p class="text-xs text-text-secondary mt-1">Scanning: Enabled (blocks commits with secrets)</p>
					</div>
				</div>

			{:else if activeCategory === 'api-keys'}
				<div>
					<h2 class="text-lg font-semibold text-text-primary">API Keys</h2>
					<p class="text-sm text-text-secondary mt-1">Manage provider API keys. Values are never displayed.</p>
				</div>
				<div class="mt-4 space-y-3">
					{#each [
						{ name: 'ANTHROPIC_API_KEY', status: 'configured' },
						{ name: 'OPENCLAW_TOKEN', status: 'configured' },
						{ name: 'GITHUB_TOKEN', status: 'from gh CLI' },
						{ name: 'THUNDERSTORE_TOKEN', status: 'not set' },
						{ name: 'CURSEFORGE_TOKEN', status: 'not set' },
						{ name: 'NEXUS_API_KEY', status: 'not set' }
					] as key}
						<div class="bg-bg-secondary border border-border rounded-lg p-3 flex items-center justify-between">
							<span class="text-sm font-mono text-text-primary">{key.name}</span>
							<span class="text-xs {key.status === 'not set' ? 'text-text-secondary' : 'text-accent-green'}">{key.status}</span>
						</div>
					{/each}
				</div>

			{:else if activeCategory === 'services'}
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Services</h2>
					<p class="text-sm text-text-secondary mt-1">Configure managed services and daemon workers.</p>
				</div>
				<div class="mt-4">
					<a href="/services" class="text-sm text-accent-blue hover:underline">Open Services Dashboard →</a>
				</div>

			{:else}
				<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
					<p class="text-sm text-text-secondary">Settings for <span class="font-medium text-text-primary capitalize">{activeCategory.replace('-', ' ')}</span> coming soon.</p>
				</div>
			{/if}

			<!-- Footer -->
			<div class="flex items-center justify-between pt-4 border-t border-border mt-6">
				<div class="flex items-center gap-4">
					<div class="text-xs text-text-secondary uppercase tracking-wider">Scope</div>
					<div class="flex items-center gap-1 bg-bg-primary rounded-lg p-0.5">
						<button
							class="px-3 py-1 text-xs rounded-md transition-colors {scope === 'global' ? 'bg-accent-blue text-white' : 'text-text-secondary'}"
							onclick={() => (scope = 'global')}
						>Global</button>
						<button
							class="px-3 py-1 text-xs rounded-md transition-colors {scope === 'project' ? 'bg-accent-blue text-white' : 'text-text-secondary'}"
							onclick={() => (scope = 'project')}
						>Project</button>
					</div>
					<button class="text-xs text-accent-red hover:underline">Restore Defaults</button>
				</div>
				<div class="flex items-center gap-2">
					<button class="px-4 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">Reset</button>
					<button class="px-4 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors">Save</button>
				</div>
			</div>
		</div>
	</div>
</div>
