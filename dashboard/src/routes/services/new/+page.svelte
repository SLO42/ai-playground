<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let mode = $state<'config' | 'manual'>('config');
	let configFile = $state('C:\\Users\\11sos\\tools\\my-project\\.mcp.json');
	let configDir = $state(data.defaultConfigDir);
	let autoStart = $state(true);
	let healthMonitoring = $state(true);
	let services = $state(data.detectedServices.map((s) => ({ ...s })));
</script>

<div class="max-w-2xl mx-auto space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-text-primary">Create New Service</h1>
		<a href="/services" class="text-text-secondary hover:text-text-primary transition-colors text-xl">&times;</a>
	</div>

	<!-- Mode Tabs -->
	<div class="flex gap-2">
		<button
			class="px-4 py-2 text-sm font-medium rounded-lg transition-colors {mode === 'config' ? 'bg-accent-blue text-white' : 'text-text-secondary hover:bg-bg-secondary'}"
			onclick={() => (mode = 'config')}
		>From Config File</button>
		<button
			class="px-4 py-2 text-sm font-medium rounded-lg transition-colors {mode === 'manual' ? 'bg-accent-blue text-white' : 'text-text-secondary hover:bg-bg-secondary'}"
			onclick={() => (mode = 'manual')}
		>Manual Setup</button>
	</div>

	{#if mode === 'config'}
		<!-- Config File Input -->
		<div>
			<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Configuration File</label>
			<div class="flex gap-2">
				<input
					type="text"
					bind:value={configFile}
					class="flex-1 bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-secondary"
					placeholder="Path to .mcp.json, package.json, etc."
				/>
				<button class="px-4 py-2 text-sm text-text-primary border border-border rounded-lg hover:bg-bg-secondary transition-colors">Browse</button>
			</div>
			<p class="mt-2 text-xs text-accent-yellow">
				Auto-detect: Scans project root for .mcp.json, package.json (scripts), docker-compose.yml, or .claude-flow/config.yaml
			</p>
		</div>

		<!-- Detected Services -->
		<div>
			<label class="text-xs text-text-secondary uppercase tracking-wider block mb-3">Detected Services</label>
			<div class="space-y-2">
				{#each services as service, i}
					<div class="bg-bg-secondary border border-border rounded-lg p-3 flex items-center gap-3">
						<input type="checkbox" bind:checked={services[i].selected} class="w-4 h-4 rounded border-border bg-bg-primary text-accent-blue" />
						<div class="flex-1">
							<div class="text-sm font-medium text-text-primary">{service.name}</div>
							<div class="text-xs text-text-secondary font-mono">{service.type} &middot; {service.command} &middot; :{service.port}</div>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Service Config Directory -->
		<div>
			<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Service Config Directory</label>
			<input
				type="text"
				bind:value={configDir}
				class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary font-mono"
			/>
			<p class="mt-1 text-xs text-text-secondary">Services config stored here. Override in Settings &rarr; Services.</p>
		</div>

		<!-- Options -->
		<div class="space-y-3">
			<label class="flex items-center gap-3 cursor-pointer">
				<input type="checkbox" bind:checked={autoStart} class="w-4 h-4 rounded border-border bg-bg-primary text-accent-blue" />
				<span class="text-sm text-text-primary">Auto-start selected services when project opens</span>
			</label>
			<label class="flex items-center gap-3 cursor-pointer">
				<input type="checkbox" bind:checked={healthMonitoring} class="w-4 h-4 rounded border-border bg-bg-primary text-accent-blue" />
				<span class="text-sm text-text-primary">Enable health monitoring &amp; auto-restart on crash</span>
			</label>
		</div>
	{:else}
		<!-- Manual Setup -->
		<div class="space-y-4">
			<div>
				<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Service Name</label>
				<input type="text" class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary" placeholder="my-service" />
			</div>
			<div>
				<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Type</label>
				<select class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary">
					<option>MCP Server</option>
					<option>Background Service</option>
					<option>Web App</option>
					<option>Database</option>
					<option>API Gateway</option>
				</select>
			</div>
			<div>
				<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Start Command</label>
				<input type="text" class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary font-mono" placeholder="npm run start" />
			</div>
			<div class="grid grid-cols-2 gap-4">
				<div>
					<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Port</label>
					<input type="number" class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary font-mono" placeholder="3000" />
				</div>
				<div>
					<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Working Directory</label>
					<input type="text" class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary font-mono" placeholder="./" />
				</div>
			</div>
		</div>
	{/if}

	<!-- Footer Buttons -->
	<div class="flex justify-end gap-2 pt-4 border-t border-border">
		<a href="/services" class="px-4 py-2 text-sm text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">Cancel</a>
		<button class="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors">Create</button>
	</div>
</div>
