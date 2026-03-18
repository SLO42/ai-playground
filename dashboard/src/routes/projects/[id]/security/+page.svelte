<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const audit = $derived(data.audit);
	const policy = $derived(data.policy);
	const projectName = $derived(data.project?.name ?? data.projectId ?? 'Project');

	const statusBgColor = $derived.by(() => {
		const s = audit?.status ?? 'CLEAN';
		if (s === 'VULNERABLE') return 'bg-accent-red';
		if (s === 'PENDING') return 'bg-accent-yellow';
		return 'bg-accent-green';
	});

	const statusTextColor = $derived.by(() => {
		const s = audit?.status ?? 'CLEAN';
		if (s === 'VULNERABLE') return 'text-accent-red';
		if (s === 'PENDING') return 'text-accent-yellow';
		return 'text-accent-green';
	});

	const statusLabel = $derived.by(() => {
		const s = audit?.status ?? 'CLEAN';
		if (s === 'VULNERABLE') return 'Vulnerable';
		if (s === 'PENDING') return 'Pending Review';
		return 'All Clear';
	});

	const cveRemediations = $derived.by(() => {
		const fixes = audit?.fixes ?? {};
		const total = audit?.totalCves ?? 1;
		return Object.entries(fixes).map(([id, fix]) => {
			const hasFixedAt = Boolean(fix.fixedAt);
			const percent = hasFixedAt ? 100 : Math.round((audit?.cvesFixed ?? 0) / total * 100);
			const color = percent === 100
				? 'bg-accent-green'
				: percent >= 60
					? 'bg-accent-yellow'
					: 'bg-accent-blue';
			return { id, desc: fix.description, percent, color };
		});
	});

	const severityColors: Record<string, string> = {
		CRITICAL: 'text-accent-red',
		HIGH: 'text-accent-red',
		MEDIUM: 'text-accent-yellow',
		LOW: 'text-accent-blue',
		INFO: 'text-text-secondary'
	};

	const severityStatusMap: Record<string, { status: string; color: string }> = {
		CRITICAL: { status: 'Action Required', color: 'text-accent-red' },
		HIGH: { status: 'Action Required', color: 'text-accent-red' },
		MEDIUM: { status: 'Review', color: 'text-accent-yellow' },
		LOW: { status: 'Monitor', color: 'text-accent-blue' },
		INFO: { status: 'Noted', color: 'text-accent-blue' }
	};

	function inferSeverity(text: string): string {
		const lower = text.toLowerCase();
		if (lower.includes('injection') || lower.includes('traversal') || lower.includes('rce'))
			return 'HIGH';
		if (lower.includes('blocklist') || lower.includes('validation') || lower.includes('sanitiz'))
			return 'MEDIUM';
		if (lower.includes('deprecated') || lower.includes('warning'))
			return 'LOW';
		return 'INFO';
	}

	function parseComponent(text: string): string {
		const match = text.match(/^([^\s:]+\.[a-z]{1,4}):/i);
		return match ? match[1] : '-';
	}

	function formatDate(iso?: string): string {
		if (!iso) return '-';
		try {
			return new Date(iso).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			});
		} catch {
			return '-';
		}
	}

	const findings = $derived.by(() => {
		const result: Array<{
			severity: string;
			severityColor: string;
			finding: string;
			component: string;
			status: string;
			statusColor: string;
			detected: string;
		}> = [];

		for (const f of data.scanFindings ?? []) {
			const sev = f.severity ?? 'INFO';
			const statusInfo = severityStatusMap[sev] ?? severityStatusMap.INFO;
			result.push({
				severity: sev,
				severityColor: severityColors[sev] ?? 'text-text-secondary',
				finding: f.issue + (f.detail ? ` — ${f.detail}` : ''),
				component: f.component ?? '-',
				status: statusInfo.status,
				statusColor: statusInfo.color,
				detected: formatDate(f.detected)
			});
		}

		const extras = audit?.additionalFixes ?? [];
		for (const desc of extras) {
			const sev = inferSeverity(desc);
			const statusInfo = severityStatusMap[sev] ?? severityStatusMap.INFO;
			const component = parseComponent(desc);
			result.push({
				severity: sev,
				severityColor: severityColors[sev] ?? 'text-text-secondary',
				finding: component !== '-' ? desc.slice(desc.indexOf(':') + 1).trim() : desc,
				component,
				status: statusInfo.status,
				statusColor: statusInfo.color,
				detected: formatDate(audit?.lastScan)
			});
		}

		return result;
	});

	const networkRules = $derived.by(() => {
		const fw = policy?.firewall;
		if (!fw) return [];
		const rules: Array<{ label: string; value: string; color: string }> = [];

		for (const r of fw.inbound ?? []) {
			const value = r.source
				? `${r.source}${r.port ? ':' + r.port : ''}`
				: r.port
					? `port ${r.port}`
					: r.protocol;
			const color = r.action === 'deny' ? 'text-accent-red' : 'text-accent-green';
			rules.push({ label: `Inbound: ${r.name}`, value, color });
		}

		for (const r of fw.outbound ?? []) {
			const value = r.destination
				? `${r.destination}${r.port ? ':' + r.port : ''}`
				: r.port
					? `port ${r.port}`
					: r.protocol;
			const color = r.action === 'deny' ? 'text-accent-red' : 'text-accent-blue';
			rules.push({ label: `Outbound: ${r.name}`, value, color });
		}

		if (fw.defaultAction) {
			rules.push({
				label: 'Default',
				value: fw.defaultAction,
				color: fw.defaultAction === 'deny' ? 'text-accent-red' : 'text-accent-yellow'
			});
		}

		return rules;
	});

	let scanLoading = $state(false);
	let scanResult = $state<{ success: boolean; output?: string; error?: string } | null>(null);

	async function runScan() {
		scanLoading = true;
		scanResult = null;
		try {
			const res = await fetch('/api/security/scan', { method: 'POST' });
			scanResult = await res.json();
		} catch {
			scanResult = { success: false, error: 'Request failed' };
		} finally {
			scanLoading = false;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="type-page-title text-text-primary">Security</h1>
			<p class="text-xs text-text-secondary mt-0.5">
				Audit status and findings for <span class="font-mono text-accent-cyan">{projectName}</span>
			</p>
		</div>
		<button
			onclick={runScan}
			disabled={scanLoading}
			class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors disabled:opacity-50"
		>
			<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
			</svg>
			{scanLoading ? 'Scanning...' : 'Run Scan'}
		</button>
	</div>

	{#if scanResult}
		<div class="px-4 py-3 rounded-lg text-sm {scanResult.success ? 'bg-accent-green/10 border border-accent-green/20 text-accent-green' : 'bg-accent-red/10 border border-accent-red/20 text-accent-red'}">
			{scanResult.success ? 'Scan completed successfully' : scanResult.error ?? 'Scan failed'}
		</div>
	{/if}

	<!-- Audit Status + CVE Remediation -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">Audit Status</p>
			<div class="flex items-center gap-2 mb-3">
				<span class="w-2.5 h-2.5 rounded-full {statusBgColor}"></span>
				<span class="text-sm font-medium {statusTextColor}">{statusLabel}</span>
			</div>
			<div class="space-y-1 text-sm text-text-secondary">
				<p>Last scan: {audit?.lastScan ?? 'Never'}</p>
				<p>CVEs fixed: <span class="{statusTextColor}">{audit?.cvesFixed ?? 0}/{audit?.totalCves ?? 0}</span></p>
				<p>Initialized: {audit?.initialized ?? 'Unknown'}</p>
			</div>
		</div>

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
				{:else}
					<p class="text-sm text-text-secondary">No CVE data available.</p>
				{/each}
			</div>
		</div>
	</div>

	<!-- Security Findings -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Security Findings</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#if findings.length > 0}
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
			{:else}
				<div class="px-4 py-12 flex flex-col items-center justify-center text-center">
					<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
					</svg>
					<h2 class="text-text-primary text-sm font-medium mb-1">No findings</h2>
					<p class="text-text-secondary text-xs">Run a security scan to check for vulnerabilities</p>
				</div>
			{/if}
		</div>
	</section>

	<!-- Network Policy -->
	{#if networkRules.length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Network Policy</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="space-y-2">
					{#each networkRules as rule}
						<div class="flex justify-between text-sm">
							<span class="text-text-secondary">{rule.label}</span>
							<span class="font-mono {rule.color}">{rule.value}</span>
						</div>
					{/each}
				</div>
			</div>
		</section>
	{/if}
</div>
