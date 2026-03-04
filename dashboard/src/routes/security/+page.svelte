<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const audit = $derived(data.audit);
	const policy = $derived(data.policy);

	// Map audit status to StatusBadge status
	const badgeStatus = $derived(
		audit?.status === 'CLEAN' ? 'clean' as const
		: audit?.status === 'PENDING' ? 'pending' as const
		: audit?.status === 'VULNERABLE' ? 'error' as const
		: 'warning' as const
	);

	// CVE progress
	const cvePercent = $derived(
		audit && audit.totalCves > 0
			? Math.round((audit.cvesFixed / audit.totalCves) * 100)
			: 0
	);

	// CVE fix rows for DataTable
	const cveColumns = [
		{ key: 'cveId', label: 'CVE ID', mono: true },
		{ key: 'description', label: 'Description' },
		{ key: 'fixedBy', label: 'Fixed By', mono: true },
		{ key: 'fixedAt', label: 'Fixed At', mono: true }
	];

	const cveRows = $derived(
		audit?.fixes
			? Object.entries(audit.fixes).map(([cveId, fix]) => ({
					cveId,
					description: fix.description,
					fixedBy: fix.fixedBy,
					fixedAt: fix.fixedAt
				}))
			: []
	);

	// Firewall inbound columns/rows
	const inboundColumns = [
		{ key: 'name', label: 'Name' },
		{ key: 'port', label: 'Port', mono: true },
		{ key: 'protocol', label: 'Protocol', mono: true },
		{ key: 'source', label: 'Source', mono: true },
		{ key: 'action', label: 'Action' }
	];

	const inboundRows = $derived(
		policy?.firewall?.inbound?.map((r) => ({
			name: r.name,
			port: r.port ?? '*',
			protocol: r.protocol,
			source: r.source ?? '*',
			action: r.action
		})) ?? []
	);

	// Firewall outbound columns/rows
	const outboundColumns = [
		{ key: 'name', label: 'Name' },
		{ key: 'destination', label: 'Destination', mono: true },
		{ key: 'port', label: 'Port', mono: true },
		{ key: 'protocol', label: 'Protocol', mono: true },
		{ key: 'action', label: 'Action' }
	];

	const outboundRows = $derived(
		policy?.firewall?.outbound?.map((r) => ({
			name: r.name,
			destination: r.destination ?? '*',
			port: r.port ?? '*',
			protocol: r.protocol,
			action: r.action
		})) ?? []
	);

	// Validation rules
	const validationRules = $derived(policy?.inputValidation?.rules ?? []);

	// Severity badge color
	function severityColor(severity: string): 'red' | 'yellow' | 'blue' | 'green' {
		switch (severity.toLowerCase()) {
			case 'critical': return 'red';
			case 'high': return 'red';
			case 'medium': return 'yellow';
			case 'low': return 'blue';
			default: return 'green';
		}
	}

	// Security scan state
	let scanLoading = $state(false);
	let scanResult = $state<{ success: boolean; output?: string; error?: string } | null>(null);

	async function runScan() {
		scanLoading = true;
		scanResult = null;
		try {
			const res = await fetch('/api/security/scan', { method: 'POST' });
			scanResult = await res.json();
		} catch (err) {
			scanResult = { success: false, error: String(err) };
		} finally {
			scanLoading = false;
		}
	}
</script>

<div class="space-y-6">
	<h1 class="text-2xl font-bold text-text-primary">Security</h1>

	<!-- Audit Status -->
	<section class="bg-bg-secondary border border-border rounded-lg p-6">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-semibold text-text-primary">Audit Status</h2>
			<StatusBadge status={badgeStatus} label={audit?.status ?? 'UNKNOWN'} size="md" />
		</div>

		{#if audit}
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
				<MetricCard
					label="CVEs Fixed"
					value="{audit.cvesFixed}/{audit.totalCves}"
					accent={audit.cvesFixed === audit.totalCves ? 'green' : 'yellow'}
				/>
				<MetricCard
					label="Status"
					value={audit.status}
					accent={audit.status === 'CLEAN' ? 'green' : 'red'}
				/>
				<MetricCard
					label="Last Scan"
					value={new Date(audit.lastScan).toLocaleString()}
					accent="blue"
				/>
			</div>

			<!-- CVE Progress Bar -->
			<div class="mb-2">
				<div class="flex items-center justify-between text-xs text-text-secondary mb-1">
					<span>CVE Remediation Progress</span>
					<span class="font-mono">{cvePercent}%</span>
				</div>
				<div class="w-full h-2 bg-bg-tertiary rounded-full overflow-hidden">
					<div
						class="h-full rounded-full transition-all duration-500 {cvePercent === 100 ? 'bg-accent-green' : 'bg-accent-yellow'}"
						style="width: {cvePercent}%"
					></div>
				</div>
			</div>
		{:else}
			<p class="text-text-secondary text-sm">No audit data available.</p>
		{/if}
	</section>

	<!-- CVE Details -->
	{#if audit && cveRows.length > 0}
		<section class="bg-bg-secondary border border-border rounded-lg p-6">
			<h2 class="text-lg font-semibold text-text-primary mb-4">CVE Details</h2>
			<DataTable columns={cveColumns} rows={cveRows} />

			{#if audit.additionalFixes && audit.additionalFixes.length > 0}
				<div class="mt-4">
					<h3 class="text-sm font-medium text-text-secondary mb-2">Additional Fixes</h3>
					<ul class="list-disc list-inside text-sm text-text-primary space-y-1">
						{#each audit.additionalFixes as fix}
							<li>{fix}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Firewall Rules -->
	{#if policy?.firewall}
		<section class="bg-bg-secondary border border-border rounded-lg p-6">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold text-text-primary">Firewall Rules</h2>
				<span class="text-xs text-text-secondary font-mono">
					Default: {policy.firewall.defaultAction}
				</span>
			</div>

			<div class="space-y-6">
				<div>
					<h3 class="text-sm font-medium text-text-secondary mb-2">Inbound Rules</h3>
					<DataTable columns={inboundColumns} rows={inboundRows} />
				</div>

				<div>
					<h3 class="text-sm font-medium text-text-secondary mb-2">Outbound Rules</h3>
					<DataTable columns={outboundColumns} rows={outboundRows} />
				</div>
			</div>
		</section>
	{/if}

	<!-- Input Validation -->
	{#if validationRules.length > 0}
		<section class="bg-bg-secondary border border-border rounded-lg p-6">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold text-text-primary">Input Validation</h2>
				<span class="text-xs px-2 py-0.5 rounded {policy?.inputValidation?.enabled ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red'}">
					{policy?.inputValidation?.enabled ? 'Enabled' : 'Disabled'}
				</span>
			</div>

			<div class="space-y-3">
				{#each validationRules as rule}
					<div class="flex items-center justify-between bg-bg-tertiary/50 rounded-lg px-4 py-3">
						<div>
							<p class="text-sm font-medium text-text-primary">{rule.name}</p>
							<p class="text-xs text-text-secondary mt-0.5">{rule.description}</p>
						</div>
						<div class="flex items-center gap-3">
							<span class="text-xs px-2 py-0.5 rounded font-medium
								{severityColor(rule.severity) === 'red' ? 'bg-accent-red/20 text-accent-red' : ''}
								{severityColor(rule.severity) === 'yellow' ? 'bg-accent-yellow/20 text-accent-yellow' : ''}
								{severityColor(rule.severity) === 'blue' ? 'bg-accent-blue/20 text-accent-blue' : ''}
								{severityColor(rule.severity) === 'green' ? 'bg-accent-green/20 text-accent-green' : ''}
							">
								{rule.severity}
							</span>
							<span class="text-xs font-mono text-text-secondary">{rule.action}</span>
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Security Scan -->
	<section class="bg-bg-secondary border border-border rounded-lg p-6">
		<h2 class="text-lg font-semibold text-text-primary mb-4">Security Scan</h2>
		<p class="text-sm text-text-secondary mb-4">
			Run a security scan using Claude Flow CLI to check for vulnerabilities.
		</p>

		<button
			onclick={runScan}
			disabled={scanLoading}
			class="px-4 py-2 rounded-lg text-sm font-medium transition-colors
				{scanLoading
					? 'bg-bg-tertiary text-text-secondary cursor-not-allowed'
					: 'bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30'}"
		>
			{scanLoading ? 'Scanning...' : 'Run Security Scan'}
		</button>

		{#if scanResult}
			<div class="mt-4 rounded-lg p-4 {scanResult.success ? 'bg-accent-green/10 border border-accent-green/30' : 'bg-accent-red/10 border border-accent-red/30'}">
				<p class="text-sm font-medium {scanResult.success ? 'text-accent-green' : 'text-accent-red'} mb-1">
					{scanResult.success ? 'Scan Complete' : 'Scan Failed'}
				</p>
				<pre class="text-xs text-text-secondary font-mono whitespace-pre-wrap overflow-x-auto">{scanResult.success ? scanResult.output : scanResult.error}</pre>
			</div>
		{/if}
	</section>
</div>
