<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const projectId = data.projectId ?? '';
	const projectName = data.project?.name ?? projectId ?? 'Project';
	const pageTitle = `Security — ${projectName}`;
	const pageDescription = `Security audit, vulnerability analysis, and policy compliance for ${projectName}. View dependency vulnerabilities, security policies, file permissions, and audit logs.`;

	let scanning = $state(false);
	let error = $state('');

	const severityColors: Record<string, string> = {
		critical: 'bg-accent-red/20 text-accent-red',
		high: 'bg-accent-red/20 text-accent-red',
		moderate: 'bg-accent-yellow/20 text-accent-yellow',
		low: 'bg-accent-green/20 text-accent-green'
	};

	const resultColors: Record<string, string> = {
		PASS: 'text-accent-green',
		WARN: 'text-accent-yellow',
		FAIL: 'text-accent-red'
	};

	async function runScan() {
		scanning = true;
		error = '';
		try {
			const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/security`, { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: 'Scan failed' }));
				error = body.error ?? 'Scan failed';
			} else {
				await invalidateAll();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Scan failed';
		} finally {
			scanning = false;
		}
	}
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={pageDescription} />
	<meta property="og:title" content={pageTitle} />
	<meta property="og:description" content={pageDescription} />
	<meta property="og:type" content="website" />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={pageTitle} />
	<meta name="twitter:description" content={pageDescription} />
</svelte:head>

<div class="space-y-6" role="main" aria-label="Project Security">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Security</h1>
			<p class="text-sm text-text-secondary mt-1">Security audit, dependencies, and policies</p>
		</div>
		<button
			onclick={runScan}
			disabled={scanning}
			aria-busy={scanning}
			class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors disabled:opacity-50"
		>
			{scanning ? 'Scanning...' : 'Run Scan'}
		</button>
	</div>

	<!-- Scan Error Banner -->
	{#if error}
		<div role="alert" class="bg-accent-red/10 border border-accent-red/30 rounded-lg px-4 py-3 flex items-center justify-between">
			<p class="text-sm text-accent-red">{error}</p>
			<button onclick={() => (error = '')} aria-label="Dismiss error" class="text-accent-red/60 hover:text-accent-red text-xs">Dismiss</button>
		</div>
	{/if}

	<!-- Scanning State -->
	{#if scanning}
		<div class="flex items-center justify-center py-12" role="status" aria-label="Running security scan">
			<div class="text-center space-y-3">
				<div class="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin mx-auto" aria-hidden="true"></div>
				<p class="text-sm text-text-secondary">Running security scan...</p>
			</div>
		</div>
	{/if}

	{#await data.security}
		<!-- Skeleton Loader -->
		<div class="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading security data">
			<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
				{#each Array(4) as _}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="h-3 w-16 bg-border rounded mb-2"></div>
						<div class="h-6 w-12 bg-border rounded"></div>
					</div>
				{/each}
			</div>

			<div>
				<div class="h-3 w-40 bg-border rounded mb-3"></div>
				<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
					{#each Array(3) as _}
						<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
							<div class="h-4 w-20 bg-border rounded"></div>
							<div class="h-4 w-14 bg-border rounded"></div>
							<div class="h-4 w-28 bg-border rounded"></div>
							<div class="h-4 w-16 bg-border rounded ml-auto"></div>
						</div>
					{/each}
				</div>
			</div>

			<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{#each Array(2) as _}
					<div>
						<div class="h-3 w-32 bg-border rounded mb-3"></div>
						<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
							{#each Array(3) as __}
								<div class="flex items-center justify-between">
									<div class="h-4 w-32 bg-border rounded"></div>
									<div class="h-4 w-16 bg-border rounded"></div>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>

			<div>
				<div class="h-3 w-28 bg-border rounded mb-3"></div>
				<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-2">
					{#each Array(4) as _}
						<div class="flex items-center gap-4">
							<div class="h-3 w-24 bg-border rounded"></div>
							<div class="h-3 flex-1 bg-border rounded"></div>
							<div class="h-3 w-10 bg-border rounded"></div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	{:then sec}
		{#if sec.loadError}
			<div role="alert" class="bg-accent-red/10 border border-accent-red/30 rounded-lg px-5 py-4">
				<div class="flex items-start gap-3">
					<span class="text-xl leading-none mt-0.5" aria-hidden="true">&#9888;</span>
					<div class="flex-1">
						<h3 class="text-accent-red font-semibold text-sm">Failed to load security data</h3>
						<p class="text-xs text-text-secondary mt-1">{sec.loadError}</p>
						<p class="text-xs text-text-secondary mt-0.5">This may be caused by missing configuration files or a server error. You can retry or run a new scan.</p>
						<div class="flex items-center gap-2 mt-3">
							<button
								onclick={() => invalidateAll()}
								class="text-xs px-3 py-1.5 bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 transition-colors"
							>
								Retry
							</button>
							<button
								onclick={runScan}
								disabled={scanning}
								class="text-xs px-3 py-1.5 bg-accent-red/20 text-accent-red rounded hover:bg-accent-red/30 transition-colors disabled:opacity-50"
							>
								Run Scan
							</button>
						</div>
					</div>
				</div>
			</div>
		{:else if sec.vulnerabilities.length === 0 && sec.policies.length === 0 && sec.permissions.length === 0 && sec.auditLog.length === 0}
			<!-- Empty State -->
			<div class="bg-bg-secondary border border-border rounded-lg px-6 py-12 text-center">
				<div class="text-4xl mb-3 opacity-40" aria-hidden="true">&#128274;</div>
				<h2 class="text-lg font-semibold text-text-primary mb-1">No Security Data</h2>
				<p class="text-sm text-text-secondary mb-4">
					Run a security scan to audit dependencies, policies, and file permissions.
				</p>
				<button
					onclick={runScan}
					class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
				>
					Run First Scan
				</button>
			</div>
		{:else}
			<!-- Summary -->
			<section aria-label="Security summary">
				<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
					<MetricCard label="Last Scan" value={sec.summary.lastScan} accent="blue" />
					<MetricCard label="Vulnerabilities" value={sec.summary.vulnerabilities} accent="yellow" />
					<MetricCard label="Critical" value={sec.summary.critical} accent="green" />
					<MetricCard label="Score" value={sec.summary.score} accent="cyan" />
				</div>
			</section>

			<!-- Lazy-loaded details: vulnerability table, policies, permissions, audit log -->
			{#await import('./SecurityDetails.svelte') then { default: SecurityDetails }}
				<SecurityDetails
					vulnerabilities={sec.vulnerabilities}
					policies={sec.policies}
					permissions={sec.permissions}
					auditLog={sec.auditLog}
					{severityColors}
					{resultColors}
				/>
			{/await}
		{/if}
	{:catch err}
		<div role="alert" class="bg-accent-red/10 border border-accent-red/30 rounded-lg px-4 py-3">
			<span class="text-accent-red font-semibold text-sm">Failed to load security data</span>
			<p class="text-xs text-accent-red/80 mt-1">{err?.message ?? 'Unknown error'}</p>
			<button
				onclick={() => invalidateAll()}
				class="mt-2 text-xs px-3 py-1 bg-accent-red/20 text-accent-red rounded hover:bg-accent-red/30 transition-colors"
			>
				Retry
			</button>
		</div>
	{/await}
</div>
