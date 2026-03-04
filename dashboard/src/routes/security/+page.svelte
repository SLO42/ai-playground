<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const audit = $derived(data.audit);
	const policy = $derived(data.policy);

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

	const cveRemediations = [
		{ id: 'CVE-1', desc: 'Prompt injection defense', percent: 100, color: 'bg-accent-green' },
		{ id: 'CVE-2', desc: 'PII detection pipeline', percent: 85, color: 'bg-accent-blue' },
		{ id: 'CVE-3', desc: 'Claims-based auth', percent: 60, color: 'bg-accent-yellow' }
	];

	const findings = [
		{ severity: 'HIGH', severityColor: 'text-accent-red', finding: 'Unvalidated input in webhook handler', component: 'openclaw/gateway', status: 'Fixed', statusColor: 'text-accent-green', detected: '2 days ago' },
		{ severity: 'MED', severityColor: 'text-accent-yellow', finding: 'Missing rate limit on pairing endpoint', component: 'openclaw/auth', status: 'In Progress', statusColor: 'text-accent-yellow', detected: '1 day ago' },
		{ severity: 'LOW', severityColor: 'text-accent-green', finding: 'Debug logging in production config', component: 'claude-flow/hooks', status: 'Fixed', statusColor: 'text-accent-green', detected: '3 days ago' },
		{ severity: 'INFO', severityColor: 'text-text-secondary', finding: 'TLS cert renewal in 45 days', component: 'openclaw/tls', status: 'Monitoring', statusColor: 'text-accent-blue', detected: 'Today' }
	];

	const networkPolicy = [
		{ label: 'Inbound', value: '127.0.0.1 only', color: 'text-accent-green' },
		{ label: 'Outbound API', value: 'api.anthropic.com:443', color: 'text-accent-blue' },
		{ label: 'Outbound Ollama', value: '127.0.0.1:11434', color: 'text-accent-blue' },
		{ label: 'External DNS', value: 'Blocked', color: 'text-accent-red' }
	];
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Security & Compliance</h1>

	<!-- Audit Status + CVE Remediation -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Audit Status -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">Audit Status</p>
			<div class="flex items-center gap-2 mb-3">
				<span class="w-2.5 h-2.5 rounded-full bg-accent-green"></span>
				<span class="text-sm font-medium text-accent-green">All Clear</span>
			</div>
			<div class="space-y-1 text-sm text-text-secondary">
				<p>Last scan: 15 min ago</p>
				<p>Total scans today: 24</p>
				<p class="text-accent-green">Findings resolved: 3/3</p>
				<p>Log: <span class="font-mono">security-audit.log</span></p>
			</div>
		</div>

		<!-- CVE Remediation -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">CVE Remediation</p>
			<div class="space-y-4">
				{#each cveRemediations as cve}
					<div>
						<div class="flex justify-between text-sm mb-1">
							<span class="text-text-primary">
								<span class="font-mono font-medium">{cve.id}</span>
								<span class="text-text-secondary ml-2">{cve.desc}</span>
							</span>
							<span class="font-mono text-accent-green">{cve.percent}%</span>
						</div>
						<div class="h-2 bg-bg-primary rounded-full overflow-hidden">
							<div class="h-full {cve.color} rounded-full transition-all" style="width: {cve.percent}%"></div>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Security Findings -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Security Findings</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border">
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Severity</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Finding</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Component</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Status</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Detected</th>
					</tr>
				</thead>
				<tbody>
					{#each findings as f}
						<tr class="border-b border-border last:border-0">
							<td class="px-4 py-3 font-mono font-bold {f.severityColor}">{f.severity}</td>
							<td class="px-4 py-3 text-text-primary">{f.finding}</td>
							<td class="px-4 py-3 font-mono text-text-secondary">{f.component}</td>
							<td class="px-4 py-3 {f.statusColor}">{f.status}</td>
							<td class="px-4 py-3 text-text-secondary">{f.detected}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<!-- Network Policy + Scan Button -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="type-section-title text-text-primary mb-4">Network Policy</h2>
			<div class="space-y-2">
				{#each networkPolicy as rule}
					<div class="flex justify-between text-sm">
						<span class="text-text-secondary">{rule.label}</span>
						<span class="font-mono {rule.color}">{rule.value}</span>
					</div>
				{/each}
			</div>
		</div>

		<div class="flex items-center justify-center">
			<button
				onclick={runScan}
				disabled={scanLoading}
				class="px-6 py-3 rounded-lg text-sm font-medium transition-colors
					{scanLoading
						? 'bg-bg-tertiary text-text-secondary cursor-not-allowed'
						: 'bg-accent-blue text-white hover:bg-accent-blue/80'}"
			>
				{scanLoading ? 'Scanning...' : 'Run Security Scan'}
			</button>

			{#if scanResult}
				<div class="mt-4 text-sm {scanResult.success ? 'text-accent-green' : 'text-accent-red'}">
					{scanResult.success ? 'Scan Complete' : scanResult.error}
				</div>
			{/if}
		</div>
	</div>
</div>
