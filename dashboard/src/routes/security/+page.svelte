<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { apiFetch } from '$lib/api-client.js';
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
			const res = await apiFetch('/api/security/scan', { method: 'POST' });
			scanResult = await res.json();
		} catch {
			scanResult = { success: false, error: 'Request failed' };
		} finally {
			scanLoading = false;
		}
	}

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

		// Structured scan findings (from saved scan results)
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

		// Parse additionalFixes strings with inferred severity
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
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Security & Compliance</h1>

	<!-- Audit Status + CVE Remediation -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Audit Status -->
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
				<p class="px-4 py-6 text-sm text-text-secondary text-center">No additional findings.</p>
			{/if}
		</div>
	</section>

	<!-- Network Policy + Scan Button -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="type-section-title text-text-primary mb-4">Network Policy</h2>
			<div class="space-y-2">
				{#each networkRules as rule}
					<div class="flex justify-between text-sm">
						<span class="text-text-secondary">{rule.label}</span>
						<span class="font-mono {rule.color}">{rule.value}</span>
					</div>
				{:else}
					<p class="text-sm text-text-secondary">No firewall rules loaded.</p>
				{/each}
			</div>
		</div>

		<div class="flex flex-col items-center justify-center">
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
