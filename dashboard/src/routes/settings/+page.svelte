<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let activeCategory = $state('general');
	let scope = $state<'global' | 'project'>(data.scope as 'global' | 'project');
	let requireConfirmation = $state(data.behavior.requireConfirmation);
	let autoApproveLowRisk = $state(data.behavior.autoApproveLowRisk);
	let showCommands = $state(data.behavior.showCommandsInInputBar);
	let projectOverride = $state(data.projectOverride);

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
