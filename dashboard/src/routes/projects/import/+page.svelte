<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let projectPath = $state(data.defaultPath);
	let scanned = $state(true);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">Import Existing Project</h1>
		<p class="text-sm text-text-secondary mt-1">
			Point to an existing project directory and OpenClaw will auto-detect its configuration
		</p>
	</div>

	<!-- Tab Nav -->
	<div class="flex gap-2">
		<a
			href="/projects/create"
			class="px-4 py-2 text-sm border border-border text-text-secondary rounded-lg hover:text-text-primary hover:bg-bg-tertiary transition-colors"
		>
			+ Create New Project
		</a>
		<a
			href="/projects/import"
			class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg"
		>
			Import Existing
		</a>
	</div>

	<!-- Step 1: Select Directory -->
	<div class="space-y-2">
		<div class="flex items-center gap-2">
			<span class="w-6 h-6 rounded-full bg-accent-blue text-white text-xs flex items-center justify-center font-bold">1</span>
			<h2 class="text-sm font-bold text-text-primary">Select Project Directory</h2>
		</div>
		<p class="text-xs text-text-secondary ml-8">Choose the root directory of an existing project</p>
		<div class="flex gap-2 ml-8">
			<input
				type="text"
				bind:value={projectPath}
				class="flex-1 bg-bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
			/>
			<button class="px-4 py-2 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors">
				Browse
			</button>
		</div>
	</div>

	{#if scanned}
		<!-- Step 2: Detected Configuration -->
		<div class="space-y-3">
			<div class="flex items-center gap-2">
				<span class="w-6 h-6 rounded-full bg-accent-blue text-white text-xs flex items-center justify-center font-bold">2</span>
				<h2 class="text-sm font-bold text-text-primary">Detected Configuration</h2>
			</div>
			<div class="ml-8">
				<p class="text-xs text-accent-green mb-3">
					{data.detectedConfigs.filter((c) => c.found).length} config files detected
				</p>
				<div class="grid grid-cols-2 gap-2">
					{#each data.detectedConfigs as config}
						<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
							<span class="w-2 h-2 rounded-full {config.found ? 'bg-accent-green' : 'bg-bg-tertiary'}"></span>
							<span class="text-xs font-mono text-accent-cyan">{config.file}</span>
							<span class="text-xs text-text-secondary ml-auto">{config.found ? config.type : 'not found'}</span>
						</div>
					{/each}
				</div>
			</div>

			<!-- Detected Services -->
			<div class="ml-8 mt-4">
				<p class="text-xs text-text-secondary uppercase tracking-wider mb-2">Detected Services</p>
				<div class="flex gap-3">
					{#each data.detectedServices as svc}
						<span class="text-xs px-3 py-1.5 bg-bg-secondary border border-border rounded-lg text-text-primary">
							{svc.name}
						</span>
					{/each}
				</div>
			</div>
		</div>

		<!-- Step 3: Review & Import -->
		<div class="space-y-3">
			<div class="flex items-center gap-2">
				<span class="w-6 h-6 rounded-full bg-accent-blue text-white text-xs flex items-center justify-center font-bold">3</span>
				<h2 class="text-sm font-bold text-text-primary">Review & Import</h2>
			</div>
			<p class="text-xs text-text-secondary ml-8">Confirm what OpenClaw will configure for this project</p>
			<div class="grid grid-cols-2 gap-2 ml-8">
				{#each data.importActions as action}
					<div class="flex items-center gap-2 text-xs">
						<span class="text-accent-green">&#10003;</span>
						<span class="text-text-primary">{action.label}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Actions -->
	<div class="flex items-center justify-end gap-3">
		<button class="px-4 py-2 text-sm border border-border text-text-secondary rounded-lg hover:text-text-primary hover:bg-bg-tertiary transition-colors">
			Re-Scan
		</button>
		<a href="/projects" class="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
			Cancel
		</a>
		<button class="px-6 py-2 text-sm bg-accent-green text-white rounded-lg hover:bg-accent-green/90 transition-colors">
			Import Project
		</button>
	</div>
</div>
