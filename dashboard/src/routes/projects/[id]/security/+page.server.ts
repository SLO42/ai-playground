import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		summary: { lastScan: '2h ago', vulnerabilities: 3, critical: 0, score: '94/100' },
		vulnerabilities: [
			{ package: 'postcss', severity: 'moderate', cve: 'CVE-2025-1234', current: '8.4.31', fixed: '8.4.35' },
			{ package: 'vite', severity: 'low', cve: 'CVE-2025-2345', current: '6.0.3', fixed: '6.0.5' },
			{ package: 'esbuild', severity: 'low', cve: 'CVE-2025-3456', current: '0.19.8', fixed: '0.19.12' }
		],
		policies: [
			{ name: 'Gateway Binding', value: 'loopback only', pass: true },
			{ name: 'TLS Minimum', value: '1.3', pass: true },
			{ name: 'DM Policy', value: 'pairing', pass: true },
			{ name: 'Secrets in Source', value: '0 found', pass: true },
			{ name: 'Audit Logging', value: 'enabled', pass: true },
			{ name: '.env Committed', value: 'no', pass: true }
		],
		permissions: [
			{ path: '.env', perms: 'rw-------', pass: true },
			{ path: '.mcp.json', perms: 'rw-r--r--', pass: true },
			{ path: 'config/', perms: 'rwxr-xr-x', pass: true },
			{ path: '.claude-flow/', perms: 'rwx------', pass: true },
			{ path: 'node_modules/', perms: 'rwxr-xr-x', pass: true }
		],
		auditLog: [
			{ time: '14:23:01', message: 'Security scan completed', result: 'PASS' },
			{ time: '14:22:58', message: 'Dependency audit: 3 moderate vulnerabilities', result: 'WARN' },
			{ time: '14:22:55', message: 'Secret scan: 0 leaked credentials', result: 'PASS' },
			{ time: '14:22:50', message: 'Network policy check: loopback enforced', result: 'PASS' }
		]
	};
};
