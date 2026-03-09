<script lang="ts">
	import { goto } from '$app/navigation';
	import { apiFetch } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let mode = $state<'config' | 'manual'>('config');
	let configFile = $state('');
	let configDir = $state(data.defaultConfigDir);
	let autoStart = $state(true);
	let healthMonitoring = $state(true);
	let services = $state(data.detectedServices.map((s) => ({ ...s })));

	// Manual mode fields
	let manualName = $state('');
	let manualType = $state('MCP Server');
	let manualCommand = $state('');
	let manualPort = $state<number | null>(null);
	let manualWorkingDir = $state('./');

	let submitting = $state(false);
	let error = $state('');
	let touched = $state<Record<string, boolean>>({});
	let fileInput: HTMLInputElement;

	// Field-level validation for manual mode
	let fieldErrors = $derived.by(() => {
		const errors: Record<string, string> = {};
		if (mode !== 'manual') return errors;

		if (touched.name && !manualName.trim()) {
			errors.name = 'Service name is required.';
		} else if (touched.name && !/^[a-zA-Z][\w.-]*$/.test(manualName.trim())) {
			errors.name = 'Name must start with a letter and contain only letters, digits, hyphens, dots, or underscores.';
		}

		if (touched.command && !manualCommand.trim()) {
			errors.command = 'Start command is required.';
		}

		if (touched.port && manualPort !== null) {
			if (!Number.isInteger(manualPort) || manualPort < 1 || manualPort > 65535) {
				errors.port = 'Port must be an integer between 1 and 65535.';
			}
		}

		if (touched.workingDir && !manualWorkingDir.trim()) {
			errors.workingDir = 'Working directory is required.';
		}

		return errors;
	});

	// Config mode validation
	let configErrors = $derived.by(() => {
		const errors: Record<string, string> = {};
		if (mode !== 'config') return errors;

		if (touched.configFile && !configFile.trim()) {
			errors.configFile = 'Configuration file path is required.';
		}

		if (touched.configDir && !configDir.trim()) {
			errors.configDir = 'Service config directory is required.';
		}

		return errors;
	});

	let hasFieldErrors = $derived(
		mode === 'manual'
			? Object.keys(fieldErrors).length > 0
			: Object.keys(configErrors).length > 0
	);

	function markTouched(field: string) {
		touched = { ...touched, [field]: true };
	}

	function touchAllFields() {
		if (mode === 'manual') {
			touched = { ...touched, name: true, command: true, port: true, workingDir: true };
		} else {
			touched = { ...touched, configFile: true, configDir: true };
		}
	}

	function fieldClass(field: string, errors: Record<string, string>): string {
		if (errors[field]) return 'border-accent-red/60 focus:border-accent-red';
		return 'border-border';
	}

	function handleBrowse() {
		fileInput.click();
	}

	function handleFileSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			configFile = input.files[0].name;
			markTouched('configFile');
		}
	}

	async function handleCreate() {
		error = '';
		touchAllFields();

		let payload: { services: Array<{ name: string; type: string; command: string; port: number | null; workingDir: string }>; configDir: string; autoStart: boolean; healthMonitoring: boolean };

		if (mode === 'config') {
			if (Object.keys(configErrors).length > 0) return;
			const selected = services.filter((s) => s.selected);
			if (selected.length === 0) {
				error = 'Select at least one service';
				return;
			}
			payload = {
				services: selected.map((s) => ({
					name: s.name,
					type: s.type,
					command: s.command,
					port: s.port,
					workingDir: './'
				})),
				configDir,
				autoStart,
				healthMonitoring
			};
		} else {
			if (Object.keys(fieldErrors).length > 0) return;
			if (!manualName.trim()) return;
			if (!manualCommand.trim()) return;
			payload = {
				services: [{
					name: manualName,
					type: manualType,
					command: manualCommand,
					port: manualPort,
					workingDir: manualWorkingDir
				}],
				configDir,
				autoStart,
				healthMonitoring
			};
		}

		submitting = true;
		try {
			const res = await apiFetch('/api/services', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const data = await res.json();
				error = data.error || 'Failed to create service';
				return;
			}
			const result = await res.json();
			const firstId = result.created?.[0];
			if (firstId) {
				goto(`/services/${firstId}`);
			} else {
				goto('/services');
			}
		} catch {
			error = 'Network error';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="max-w-2xl mx-auto space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-text-primary">Create New Service</h1>
		<a href="/services" class="text-text-secondary hover:text-text-primary transition-colors text-xl" aria-label="Cancel and return to services">&times;</a>
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
					onblur={() => markTouched('configFile')}
					class="flex-1 bg-bg-secondary border {fieldClass('configFile', configErrors)} rounded-lg px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-secondary"
					placeholder="Path to .mcp.json, package.json, etc."
				/>
				<button onclick={handleBrowse} class="px-4 py-2 text-sm text-text-primary border border-border rounded-lg hover:bg-bg-secondary transition-colors">Browse</button>
			<input bind:this={fileInput} type="file" accept=".json,.yaml,.yml,.toml" class="hidden" onchange={handleFileSelected} />
			</div>
			{#if configErrors.configFile}
				<p class="mt-1 text-xs text-accent-red">{configErrors.configFile}</p>
			{:else}
				<p class="mt-2 text-xs text-accent-yellow">
					Auto-detect: Scans project root for .mcp.json, package.json (scripts), docker-compose.yml, or .claude-flow/config.yaml
				</p>
			{/if}
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
							<div class="text-xs text-text-secondary font-mono">{service.type} &middot; {service.command}{service.port != null ? ` · :${service.port}` : ''}</div>
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
				onblur={() => markTouched('configDir')}
				class="w-full bg-bg-secondary border {fieldClass('configDir', configErrors)} rounded-lg px-3 py-2 text-sm text-text-primary font-mono"
			/>
			{#if configErrors.configDir}
				<p class="mt-1 text-xs text-accent-red">{configErrors.configDir}</p>
			{:else}
				<p class="mt-1 text-xs text-text-secondary">Services config stored here. Override in Settings &rarr; Services.</p>
			{/if}
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
				<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Service Name <span class="text-accent-red">*</span></label>
				<input type="text" bind:value={manualName} onblur={() => markTouched('name')} class="w-full bg-bg-secondary border {fieldClass('name', fieldErrors)} rounded-lg px-3 py-2 text-sm text-text-primary" placeholder="my-service" />
				{#if fieldErrors.name}
					<p class="mt-1 text-xs text-accent-red">{fieldErrors.name}</p>
				{/if}
			</div>
			<div>
				<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Type</label>
				<select bind:value={manualType} class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary">
					<option>MCP Server</option>
					<option>Background Service</option>
					<option>Web App</option>
					<option>Database</option>
					<option>API Gateway</option>
				</select>
			</div>
			<div>
				<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Start Command <span class="text-accent-red">*</span></label>
				<input type="text" bind:value={manualCommand} onblur={() => markTouched('command')} class="w-full bg-bg-secondary border {fieldClass('command', fieldErrors)} rounded-lg px-3 py-2 text-sm text-text-primary font-mono" placeholder="npm run start" />
				{#if fieldErrors.command}
					<p class="mt-1 text-xs text-accent-red">{fieldErrors.command}</p>
				{/if}
			</div>
			<div class="grid grid-cols-2 gap-4">
				<div>
					<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Port</label>
					<input type="number" bind:value={manualPort} onblur={() => markTouched('port')} min="1" max="65535" class="w-full bg-bg-secondary border {fieldClass('port', fieldErrors)} rounded-lg px-3 py-2 text-sm text-text-primary font-mono" placeholder="3000" />
					{#if fieldErrors.port}
						<p class="mt-1 text-xs text-accent-red">{fieldErrors.port}</p>
					{/if}
				</div>
				<div>
					<label class="text-xs text-text-secondary uppercase tracking-wider block mb-2">Working Directory <span class="text-accent-red">*</span></label>
					<input type="text" bind:value={manualWorkingDir} onblur={() => markTouched('workingDir')} class="w-full bg-bg-secondary border {fieldClass('workingDir', fieldErrors)} rounded-lg px-3 py-2 text-sm text-text-primary font-mono" placeholder="./" />
					{#if fieldErrors.workingDir}
						<p class="mt-1 text-xs text-accent-red">{fieldErrors.workingDir}</p>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if error}
		<p class="text-sm text-accent-red">{error}</p>
	{/if}

	<!-- Footer Buttons -->
	<div class="flex justify-end gap-2 pt-4 border-t border-border">
		<a href="/services" class="px-4 py-2 text-sm text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">Cancel</a>
		<button
			onclick={handleCreate}
			disabled={submitting || hasFieldErrors}
			class="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
		>{submitting ? 'Creating...' : 'Create'}</button>
	</div>
</div>
