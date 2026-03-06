<script lang="ts">
	import { goto } from '$app/navigation';
	import { apiFetch } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let projectPath = $state(data.defaultPath);
	let scanned = $state(data.scanned);
	let detectedConfigs = $state(data.detectedConfigs);
	let detectedServices = $state(data.detectedServices);
	let hasPlaygroundConfig = $state(data.hasPlaygroundConfig);
	let meta = $state(data.meta);
	let configPreview = $state(data.configPreview);
	let showConfigPreview = $state(false);
	let scanning = $state(false);
	let importing = $state(false);
	let error = $state('');

	// Collapsible section state
	let collapsedSections = $state<Record<string, boolean>>({});
	function toggleSection(key: string) {
		collapsedSections = { ...collapsedSections, [key]: !collapsedSections[key] };
	}

	// Group detected configs by category
	const configGroups = $derived.by(() => {
		const groups: Record<string, typeof detectedConfigs> = {};
		const categoryMap: Record<string, string> = {
			'Playground Config': 'Playground',
			'Claude Config': 'Claude / AI',
			'Claude Flow Config': 'Claude / AI',
			'MCP Servers': 'Claude / AI',
			'AI Agents': 'Claude / AI',
			'Node.js Project': 'Build & Runtime',
			'TypeScript': 'Build & Runtime',
			'Python': 'Build & Runtime',
			'Rust': 'Build & Runtime',
			'C# Solution': 'Build & Runtime',
			'C# Project': 'Build & Runtime',
			'NuGet': 'Build & Runtime',
			'Build Script (bash)': 'Build & Runtime',
			'Build Script (PowerShell)': 'Build & Runtime',
			'CI/CD Workflows': 'GitHub & CI/CD',
			'Git Repository': 'GitHub & CI/CD',
			'Docker': 'Infrastructure',
			'OpenClaw Config': 'Infrastructure',
			'Security Policy': 'Infrastructure',
			'Environment': 'Infrastructure',
			'Memory DB': 'Data & Storage',
			'Thunderstore Mod': 'Platform',
			'Documentation': 'Documentation',
			'Scripts': 'Build & Runtime',
		};

		for (const config of detectedConfigs) {
			const cat = categoryMap[config.type] ?? 'Other';
			if (!groups[cat]) groups[cat] = [];
			groups[cat].push(config);
		}

		return groups;
	});

	async function rescan() {
		scanning = true;
		error = '';
		try {
			await apiFetch(`/projects/import?path=${encodeURIComponent(projectPath)}`, {
				headers: { accept: 'application/json' },
				silent: true
			});
			window.location.href = `/projects/import?path=${encodeURIComponent(projectPath)}`;
		} catch {
			error = 'Failed to scan directory';
		} finally {
			scanning = false;
		}
	}

	async function importProject() {
		importing = true;
		error = '';
		try {
			const res = await apiFetch('/api/projects', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: projectPath })
			});
			if (!res.ok) {
				const data = await res.json();
				error = data.error || 'Import failed';
				return;
			}
			await goto('/projects');
		} catch (e: unknown) {
			const err = e as { message?: string };
			error = err.message ?? 'Failed to import project';
		} finally {
			importing = false;
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">Import Existing Project</h1>
		<p class="text-sm text-text-secondary mt-1">
			Point to an existing project directory to auto-detect its configuration
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
				placeholder="F:\code\my-project"
				class="flex-1 bg-bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
			/>
			<button
				onclick={rescan}
				disabled={scanning}
				class="px-4 py-2 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50"
			>
				{scanning ? 'Scanning...' : 'Scan'}
			</button>
		</div>
		{#if error}
			<p class="text-xs text-accent-red ml-8">{error}</p>
		{/if}
	</div>

	{#if scanned && detectedConfigs.length > 0}
		<!-- Step 2: Detected Configuration -->
		<div class="space-y-3">
			<div class="flex items-center gap-2">
				<span class="w-6 h-6 rounded-full bg-accent-blue text-white text-xs flex items-center justify-center font-bold">2</span>
				<h2 class="text-sm font-bold text-text-primary">Detected Configuration</h2>
			</div>
			<div class="ml-8">
				<p class="text-xs text-accent-green mb-3">
					{detectedConfigs.filter((c) => c.found).length} config files detected
				</p>
				<div class="space-y-2">
					{#each Object.entries(configGroups) as [groupName, configs]}
						{@const foundCount = configs.filter((c) => c.found).length}
						{@const isCollapsed = collapsedSections[`cfg-${groupName}`] ?? (foundCount === 0)}
						<div class="border border-border rounded-lg overflow-hidden">
							<button
								onclick={() => toggleSection(`cfg-${groupName}`)}
								class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-tertiary transition-colors {foundCount > 0 ? 'bg-bg-secondary' : 'bg-bg-secondary/50'}"
							>
								<svg class="w-3 h-3 text-text-secondary transition-transform {isCollapsed ? '' : 'rotate-90'}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
								</svg>
								<span class="text-xs font-medium {foundCount > 0 ? 'text-text-primary' : 'text-text-secondary'}">{groupName}</span>
								<span class="text-xs ml-auto {foundCount > 0 ? 'text-accent-green' : 'text-text-secondary/50'}">{foundCount}/{configs.length}</span>
							</button>
							{#if !isCollapsed}
								<div class="grid grid-cols-2 gap-1.5 px-3 pb-2 pt-1">
									{#each configs as config}
										<div class="flex items-center gap-2 px-2 py-1.5 rounded {config.found ? '' : 'opacity-40'}">
											<span class="w-2 h-2 rounded-full shrink-0 {config.found ? 'bg-accent-green' : 'bg-bg-tertiary'}"></span>
											<span class="text-xs font-mono text-accent-cyan truncate">{config.file}</span>
											<span class="text-xs text-text-secondary ml-auto shrink-0">{config.found ? config.type : 'not found'}</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!-- Auto-detected Project Details -->
			{#if meta && (meta.language || meta.framework || meta.buildTool)}
				<div class="ml-8 mt-4">
					<p class="text-xs text-text-secondary uppercase tracking-wider mb-2">Project Details</p>
					<div class="grid grid-cols-2 gap-2">
						{#if meta.language}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Language</span>
								<span class="text-xs font-mono text-accent-cyan ml-auto">{meta.language}</span>
							</div>
						{/if}
						{#if meta.framework}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Framework</span>
								<span class="text-xs font-mono text-accent-cyan ml-auto">{meta.framework}</span>
							</div>
						{/if}
						{#if meta.buildTool}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Build Tool</span>
								<span class="text-xs font-mono text-accent-cyan ml-auto">{meta.buildTool}</span>
							</div>
						{/if}
						{#if meta.buildCommand}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Build</span>
								<span class="text-xs font-mono text-accent-green ml-auto">{meta.buildCommand}</span>
							</div>
						{/if}
						{#if meta.devCommand}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Dev</span>
								<span class="text-xs font-mono text-accent-green ml-auto">{meta.devCommand}</span>
							</div>
						{/if}
						{#if meta.testCommand}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Test</span>
								<span class="text-xs font-mono text-accent-green ml-auto">{meta.testCommand}</span>
							</div>
						{/if}
						{#if meta.lintCommand}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Lint</span>
								<span class="text-xs font-mono text-accent-green ml-auto">{meta.lintCommand}</span>
							</div>
						{/if}
						{#if meta.startCommand}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Start</span>
								<span class="text-xs font-mono text-accent-green ml-auto">{meta.startCommand}</span>
							</div>
						{/if}
						{#if meta.gitRemote}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Git Remote</span>
								<span class="text-xs font-mono text-accent-cyan ml-auto truncate max-w-[250px]" title={meta.gitRemote}>{meta.gitRemote}</span>
							</div>
						{/if}
						{#if meta.defaultBranch}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<span class="text-xs text-text-secondary">Default Branch</span>
								<span class="text-xs font-mono text-accent-cyan ml-auto">{meta.defaultBranch}</span>
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<!-- CI/CD Workflows -->
			{#if meta && meta.workflows && meta.workflows.length > 0}
				<div class="ml-8 mt-4">
					<button onclick={() => toggleSection('workflows')} class="flex items-center gap-2 w-full text-left mb-2 group">
						<svg class="w-3 h-3 text-text-secondary transition-transform {collapsedSections['workflows'] ? '' : 'rotate-90'}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
						<p class="text-xs text-text-secondary uppercase tracking-wider group-hover:text-text-primary transition-colors">CI/CD Workflows ({meta.workflows.length})</p>
					</button>
					{#if !collapsedSections['workflows']}
					<div class="space-y-2">
						{#each meta.workflows as wf}
							<div class="bg-bg-secondary border border-border rounded-lg px-3 py-2">
								<div class="flex items-center gap-2">
									<svg class="w-3.5 h-3.5 text-accent-green shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728" />
									</svg>
									<span class="text-xs font-medium text-text-primary">{wf.name}</span>
									<span class="text-xs font-mono text-text-secondary ml-auto">{wf.file}</span>
								</div>
								<div class="flex gap-4 mt-1.5 ml-6">
									{#if wf.triggers.length > 0}
										<div class="flex items-center gap-1 flex-wrap">
											<span class="text-xs text-text-secondary">Triggers:</span>
											{#each wf.triggers as trigger}
												<span class="text-xs px-1.5 py-0.5 bg-accent-blue/10 text-accent-blue rounded">{trigger}</span>
											{/each}
										</div>
									{/if}
									{#if wf.jobs.length > 0}
										<div class="flex items-center gap-1 flex-wrap">
											<span class="text-xs text-text-secondary">Jobs:</span>
											{#each wf.jobs as job}
												<span class="text-xs px-1.5 py-0.5 bg-accent-purple/10 text-accent-purple rounded">{job}</span>
											{/each}
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
					{/if}
				</div>
			{/if}

			<!-- AI Agents -->
			{#if meta && meta.agents && meta.agents.length > 0}
				<div class="ml-8 mt-4">
					<button onclick={() => toggleSection('agents')} class="flex items-center gap-2 w-full text-left mb-2 group">
						<svg class="w-3 h-3 text-text-secondary transition-transform {collapsedSections['agents'] ? '' : 'rotate-90'}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
						<p class="text-xs text-text-secondary uppercase tracking-wider group-hover:text-text-primary transition-colors">AI Agents ({meta.agents.length} types)</p>
					</button>
					{#if !collapsedSections['agents']}
					<div class="flex gap-2 flex-wrap">
						{#each meta.agents as agent}
							<span class="text-xs px-2.5 py-1.5 bg-bg-secondary border border-accent-cyan/30 rounded-lg text-accent-cyan" title="{agent.fileCount} files">
								{agent.name}
								<span class="text-text-secondary ml-1">({agent.fileCount})</span>
							</span>
						{/each}
					</div>
					{/if}
				</div>
			{/if}

			<!-- Dependencies -->
			{#if meta && meta.dependencies && meta.dependencies.length > 0}
				{@const modDeps = meta.dependencies.filter((d: any) => d.type === 'mod-framework' || d.type === 'platform')}
				{@const runtimeDeps = meta.dependencies.filter((d: any) => d.type === 'runtime')}
				{@const devDeps = meta.dependencies.filter((d: any) => d.type === 'dev')}
				<div class="ml-8 mt-4">
					<button onclick={() => toggleSection('deps')} class="flex items-center gap-2 w-full text-left mb-2 group">
						<svg class="w-3 h-3 text-text-secondary transition-transform {collapsedSections['deps'] ? '' : 'rotate-90'}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
						<p class="text-xs text-text-secondary uppercase tracking-wider group-hover:text-text-primary transition-colors">Dependencies ({meta.dependencies.length})</p>
					</button>
					{#if !collapsedSections['deps']}
					{#if modDeps.length > 0}
						<p class="text-xs text-text-secondary mt-2 mb-1">Mod Framework / Platform</p>
						<div class="flex gap-2 flex-wrap">
							{#each modDeps as dep}
								<span class="text-xs px-2 py-1 bg-bg-secondary border rounded border-accent-yellow/30 text-accent-yellow">
									{dep.name}{#if dep.version}<span class="text-text-secondary ml-1">@{dep.version}</span>{/if}
								</span>
							{/each}
						</div>
					{/if}
					{#if runtimeDeps.length > 0}
						<p class="text-xs text-text-secondary mt-2 mb-1">Runtime</p>
						<div class="flex gap-2 flex-wrap">
							{#each runtimeDeps as dep}
								<span class="text-xs px-2 py-1 bg-bg-secondary border rounded border-accent-green/30 text-accent-green">
									{dep.name}{#if dep.version}<span class="text-text-secondary ml-1">@{dep.version}</span>{/if}
								</span>
							{/each}
						</div>
					{/if}
					{#if devDeps.length > 0}
						<p class="text-xs text-text-secondary mt-2 mb-1">Dev</p>
						<div class="flex gap-2 flex-wrap">
							{#each devDeps.slice(0, 20) as dep}
								<span class="text-xs px-2 py-1 bg-bg-secondary border rounded border-border text-text-secondary">
									{dep.name}{#if dep.version}<span class="text-text-secondary/60 ml-1">@{dep.version}</span>{/if}
								</span>
							{/each}
							{#if devDeps.length > 20}
								<span class="text-xs px-2 py-1 text-text-secondary">+{devDeps.length - 20} more</span>
							{/if}
						</div>
					{/if}
					{/if}
				</div>
			{/if}

			<!-- Branches -->
			{#if meta && meta.branches && meta.branches.length > 1}
				<div class="ml-8 mt-4">
					<button onclick={() => toggleSection('branches')} class="flex items-center gap-2 w-full text-left mb-2 group">
						<svg class="w-3 h-3 text-text-secondary transition-transform {collapsedSections['branches'] ? '' : 'rotate-90'}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
						<p class="text-xs text-text-secondary uppercase tracking-wider group-hover:text-text-primary transition-colors">Git Branches ({meta.branches.length})</p>
					</button>
					{#if !collapsedSections['branches']}
					<div class="flex gap-2 flex-wrap">
						{#each meta.branches as branch}
							<span class="text-xs px-2.5 py-1 bg-bg-secondary border rounded-lg {branch === meta.defaultBranch ? 'text-accent-green border-accent-green/30' : 'text-text-primary border-border'}">
								{branch}{#if branch === meta.defaultBranch} <span class="text-accent-green">(default)</span>{/if}
							</span>
						{/each}
					</div>
					{/if}
				</div>
			{/if}

			<!-- Maintenance & Docs -->
			{#if meta && meta.maintenance}
				<div class="ml-8 mt-4">
					<button onclick={() => toggleSection('maintenance')} class="flex items-center gap-2 w-full text-left mb-2 group">
						<svg class="w-3 h-3 text-text-secondary transition-transform {collapsedSections['maintenance'] ? '' : 'rotate-90'}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
						<p class="text-xs text-text-secondary uppercase tracking-wider group-hover:text-text-primary transition-colors">Maintenance & Docs</p>
					</button>
					{#if !collapsedSections['maintenance']}
					<div class="grid grid-cols-3 gap-2">
						{#each [
							['README', meta.maintenance.hasReadme],
							['Changelog', meta.maintenance.hasChangelog],
							['Docs dir', meta.maintenance.hasDocsDir],
							['CLAUDE.md', meta.maintenance.hasClaude],
							['Claude Flow', meta.maintenance.hasClaudeFlow],
							['License', meta.maintenance.hasLicense]
						] as [label, found]}
							<div class="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-1.5">
								<span class="w-2 h-2 rounded-full {found ? 'bg-accent-green' : 'bg-accent-red/40'}"></span>
								<span class="text-xs text-text-primary">{label}</span>
							</div>
						{/each}
					</div>
					{/if}
				</div>
			{/if}

			<!-- Release Process -->
			{#if meta && meta.releaseProcess && meta.releaseProcess.length > 0}
				<div class="ml-8 mt-4">
					<p class="text-xs text-text-secondary uppercase tracking-wider mb-2">Release Process</p>
					<div class="flex gap-3 flex-wrap">
						{#each meta.releaseProcess as process}
							<span class="text-xs px-3 py-1.5 bg-bg-secondary border border-accent-purple/30 rounded-lg text-accent-purple">
								{process}
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Detected Services -->
			{#if detectedServices.length > 0}
				<div class="ml-8 mt-4">
					<p class="text-xs text-text-secondary uppercase tracking-wider mb-2">Detected Services</p>
					<div class="flex gap-3 flex-wrap">
						{#each detectedServices as svc}
							<span class="text-xs px-3 py-1.5 bg-bg-secondary border border-border rounded-lg text-text-primary">
								{svc.name}{#if svc.port} <span class="text-text-secondary">:{svc.port}</span>{/if}
							</span>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- Step 3: Review & Import -->
		<div class="space-y-3">
			<div class="flex items-center gap-2">
				<span class="w-6 h-6 rounded-full bg-accent-blue text-white text-xs flex items-center justify-center font-bold">3</span>
				<h2 class="text-sm font-bold text-text-primary">Review & Import</h2>
			</div>
			<div class="ml-8 space-y-2">
				{#if !hasPlaygroundConfig}
					<p class="text-xs text-accent-yellow">
						No .playground/config.json found — one will be auto-generated from detected data.
					</p>
				{/if}
				<div class="grid grid-cols-2 gap-2">
					<div class="flex items-center gap-2 text-xs">
						<span class="text-accent-green">&#10003;</span>
						<span class="text-text-primary">Add project to registry</span>
					</div>
					<div class="flex items-center gap-2 text-xs">
						<span class="text-accent-green">&#10003;</span>
						<span class="text-text-primary">{hasPlaygroundConfig ? 'Read' : 'Generate'} .playground/config.json</span>
					</div>
					<div class="flex items-center gap-2 text-xs">
						<span class="text-accent-green">&#10003;</span>
						<span class="text-text-primary">Scan project for live stats</span>
					</div>
					<div class="flex items-center gap-2 text-xs">
						<span class="text-accent-green">&#10003;</span>
						<span class="text-text-primary">Non-destructive — no existing files modified</span>
					</div>
				</div>

				<!-- Config Preview Toggle -->
				{#if configPreview}
					<button
						onclick={() => showConfigPreview = !showConfigPreview}
						class="text-xs text-accent-cyan hover:text-accent-blue transition-colors mt-2"
					>
						{showConfigPreview ? 'Hide' : 'Preview'} config.json {showConfigPreview ? '\u25B2' : '\u25BC'}
					</button>
					{#if showConfigPreview}
						<div class="mt-2 bg-bg-secondary border border-border rounded-lg overflow-hidden">
							<div class="flex items-center justify-between px-3 py-1.5 border-b border-border bg-bg-tertiary">
								<span class="text-xs font-mono text-text-secondary">.playground/config.json</span>
								<span class="text-xs text-text-secondary">{hasPlaygroundConfig ? 'existing' : 'will be generated'}</span>
							</div>
							<pre class="p-3 text-xs font-mono text-text-primary overflow-x-auto max-h-80 overflow-y-auto">{JSON.stringify(configPreview, null, 2)}</pre>
						</div>
					{/if}
				{/if}
			</div>
		</div>
	{/if}

	<!-- Actions -->
	<div class="flex items-center justify-end gap-3">
		<button
			onclick={rescan}
			disabled={scanning}
			class="px-4 py-2 text-sm border border-border text-text-secondary rounded-lg hover:text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50"
		>
			{scanning ? 'Scanning...' : 'Re-Scan'}
		</button>
		<a href="/projects" class="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
			Cancel
		</a>
		<button
			onclick={importProject}
			disabled={importing || !scanned}
			class="px-6 py-2 text-sm bg-accent-green text-white rounded-lg hover:bg-accent-green/90 transition-colors disabled:opacity-50"
		>
			{importing ? 'Importing...' : 'Import Project'}
		</button>
	</div>
</div>
