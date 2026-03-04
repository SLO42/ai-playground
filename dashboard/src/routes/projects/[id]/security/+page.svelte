<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

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
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Security</h1>
			<p class="text-sm text-text-secondary mt-1">Security audit, dependencies, and policies for ai-playground</p>
		</div>
		<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
			Run Scan
		</button>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Last Scan" value={data.summary.lastScan} accent="blue" />
		<MetricCard label="Vulnerabilities" value={data.summary.vulnerabilities} accent="yellow" />
		<MetricCard label="Critical" value={data.summary.critical} accent="green" />
		<MetricCard label="Score" value={data.summary.score} accent="cyan" />
	</div>

	<!-- Dependency Vulnerabilities -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Dependency Vulnerabilities</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.vulnerabilities as vuln}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<span class="text-sm font-bold text-text-primary w-24">{vuln.package}</span>
					<span class="text-[10px] px-2 py-0.5 rounded font-mono {severityColors[vuln.severity]}">{vuln.severity}</span>
					<span class="text-xs font-mono text-accent-cyan">{vuln.cve}</span>
					<span class="text-xs font-mono text-text-secondary">{vuln.current}</span>
					<span class="text-xs font-mono text-accent-green">{vuln.fixed}</span>
					<button class="ml-auto text-[10px] px-3 py-1 bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 transition-colors">
						Update
					</button>
				</div>
			{/each}
		</div>
	</div>

	<!-- Security Policies + File Permissions -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Security Policies</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
				{#each data.policies as policy}
					<div class="flex items-center justify-between">
						<span class="text-sm text-text-secondary">{policy.name}</span>
						<div class="flex items-center gap-2">
							<span class="text-sm font-mono text-text-primary">{policy.value}</span>
							<span class="text-xs {policy.pass ? 'text-accent-green' : 'text-accent-red'}">
								{policy.pass ? '&#10003;' : '&#10007;'}
							</span>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">File Permissions</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
				{#each data.permissions as perm}
					<div class="flex items-center justify-between">
						<span class="text-sm font-mono text-accent-cyan">{perm.path}</span>
						<div class="flex items-center gap-2">
							<span class="text-xs font-mono text-text-secondary">{perm.perms}</span>
							<span class="text-xs {perm.pass ? 'text-accent-green' : 'text-accent-red'}">
								{perm.pass ? '&#10003;' : '&#10007;'}
							</span>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Audit Log -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Audit Log</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 font-mono text-xs space-y-2">
			{#each data.auditLog as entry}
				<div class="flex items-center gap-4">
					<span class="text-text-secondary">{entry.time}</span>
					<span class="text-text-primary flex-1">{entry.message}</span>
					<span class="{resultColors[entry.result]} font-bold">{entry.result}</span>
				</div>
			{/each}
		</div>
	</div>
</div>
