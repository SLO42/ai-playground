<script lang="ts">
	let {
		vulnerabilities,
		policies,
		permissions,
		auditLog,
		severityColors,
		resultColors
	}: {
		vulnerabilities: Array<{ package: string; severity: string; cve: string; current: string; fixed: string }>;
		policies: Array<{ name: string; value: string; pass: boolean }>;
		permissions: Array<{ path: string; perms: string; pass: boolean }>;
		auditLog: Array<{ time: string; message: string; result: string }>;
		severityColors: Record<string, string>;
		resultColors: Record<string, string>;
	} = $props();
</script>

<!-- Dependency Vulnerabilities -->
<section aria-label="Dependency vulnerabilities">
	<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Dependency Vulnerabilities</h2>
	<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden" role="table" aria-label="Vulnerability list">
		<div class="sr-only" role="row">
			<span role="columnheader">Package</span>
			<span role="columnheader">Severity</span>
			<span role="columnheader">CVE</span>
			<span role="columnheader">Current Version</span>
			<span role="columnheader">Fixed Version</span>
			<span role="columnheader">Actions</span>
		</div>
		{#each vulnerabilities as vuln}
			<div role="row" class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
				<span role="cell" class="text-sm font-bold text-text-primary w-24">{vuln.package}</span>
				<span role="cell" class="text-[10px] px-2 py-0.5 rounded font-mono {severityColors[vuln.severity]}">{vuln.severity}</span>
				<span role="cell" class="text-xs font-mono text-accent-cyan">{vuln.cve}</span>
				<span role="cell" class="text-xs font-mono text-text-secondary">{vuln.current}</span>
				<span role="cell" class="text-xs font-mono text-accent-green">{vuln.fixed}</span>
				<span role="cell">
					<button aria-label="Update {vuln.package} to {vuln.fixed}" class="ml-auto text-[10px] px-3 py-1 bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 transition-colors">
						Update
					</button>
				</span>
			</div>
		{:else}
			<div class="px-4 py-6 text-center">
				<div class="text-2xl mb-2 opacity-30" aria-hidden="true">&#9989;</div>
				<p class="text-text-primary text-sm font-medium">All clear</p>
				<p class="text-text-secondary text-xs mt-0.5">No dependency vulnerabilities detected</p>
			</div>
		{/each}
	</div>
</section>

<!-- Security Policies + File Permissions -->
<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
	<section aria-label="Security policies">
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Security Policies</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3" role="list">
			{#each policies as policy}
				<div role="listitem" class="flex items-center justify-between">
					<span class="text-sm text-text-secondary">{policy.name}</span>
					<div class="flex items-center gap-2">
						<span class="text-sm font-mono text-text-primary">{policy.value}</span>
						<span class="text-xs {policy.pass ? 'text-accent-green' : 'text-accent-red'}" aria-label={policy.pass ? 'Passed' : 'Failed'}>
							{policy.pass ? '&#10003;' : '&#10007;'}
						</span>
					</div>
				</div>
			{:else}
				<p class="text-text-secondary text-sm text-center py-2">No security policies configured. Add a network policy file to enable checks.</p>
			{/each}
		</div>
	</section>

	<section aria-label="File permissions">
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">File Permissions</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3" role="list">
			{#each permissions as perm}
				<div role="listitem" class="flex items-center justify-between">
					<span class="text-sm font-mono text-accent-cyan">{perm.path}</span>
					<div class="flex items-center gap-2">
						<span class="text-xs font-mono text-text-secondary">{perm.perms}</span>
						<span class="text-xs {perm.pass ? 'text-accent-green' : 'text-accent-red'}" aria-label={perm.pass ? 'Passed' : 'Failed'}>
							{perm.pass ? '&#10003;' : '&#10007;'}
						</span>
					</div>
				</div>
			{:else}
				<p class="text-text-secondary text-sm text-center py-2">No file permissions audited yet. Run a scan to check sensitive files.</p>
			{/each}
		</div>
	</section>
</div>

<!-- Audit Log -->
<section aria-label="Audit log">
	<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Audit Log</h2>
	<div class="bg-bg-secondary border border-border rounded-lg p-4 font-mono text-xs space-y-2" role="log" aria-label="Security audit log">
		{#each auditLog as entry}
			<div class="flex items-center gap-4">
				<time class="text-text-secondary">{entry.time}</time>
				<span class="text-text-primary flex-1">{entry.message}</span>
				<span class="{resultColors[entry.result]} font-bold" aria-label="Result: {entry.result}">{entry.result}</span>
			</div>
		{:else}
			<p class="text-text-secondary text-center font-sans text-sm py-2">No audit log entries yet. Entries will appear after scans and fixes.</p>
		{/each}
	</div>
</section>
