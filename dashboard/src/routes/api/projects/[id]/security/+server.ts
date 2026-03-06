import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { AuditStatus, SecurityFinding, SecurityPolicy } from '$lib/types/security.js';

interface ScanFindingsFile {
	scannedAt: string;
	findings: Array<{ severity: string; issue: string; detail: string; component?: string }>;
}

async function buildSecurityData() {
	const [audit, policy, scanFile] = await Promise.all([
		readJsonFile<AuditStatus>(PATHS.auditStatus),
		readYamlFile<SecurityPolicy>(PATHS.networkPolicy),
		readJsonFile<ScanFindingsFile>(PATHS.scanFindings)
	]);

	const scanFindings: SecurityFinding[] = (scanFile?.findings ?? []).map((f) => ({
		severity: f.severity as SecurityFinding['severity'],
		issue: f.issue,
		detail: f.detail,
		component: f.component,
		detected: scanFile?.scannedAt
	}));

	const criticalCount = scanFindings.filter(
		(f) => f.severity === 'CRITICAL' || f.severity === 'HIGH'
	).length;

	const summary = {
		lastScan: audit?.lastScan ?? 'Never',
		vulnerabilities: scanFindings.length,
		critical: criticalCount,
		score: audit ? `${audit.cvesFixed}/${audit.totalCves}` : 'N/A',
		status: audit?.status ?? 'PENDING'
	};

	const vulnerabilities = scanFindings.map((f) => ({
		package: f.component ?? f.issue.split(' ')[0] ?? 'unknown',
		severity: f.severity.toLowerCase(),
		cve: f.issue,
		current: f.detail,
		fixed: f.detected ?? ''
	}));

	const policies = policy
		? [
				{
					name: 'Default Firewall Action',
					value: policy.firewall?.defaultAction ?? 'N/A',
					pass: policy.firewall?.defaultAction === 'deny'
				},
				{
					name: 'Input Validation',
					value: policy.inputValidation?.enabled ? 'Enabled' : 'Disabled',
					pass: policy.inputValidation?.enabled === true
				},
				{
					name: 'Policy Version',
					value: policy.version ?? 'N/A',
					pass: true
				}
			]
		: [];

	const permissions =
		audit?.additionalFixes?.map((fix) => ({
			path: fix,
			perms: 'applied',
			pass: true
		})) ?? [];

	const auditLog = Object.entries(audit?.fixes ?? {}).map(([cve, fix]) => ({
		time: fix.fixedAt,
		message: `${cve}: ${fix.description}`,
		result: 'PASS' as const
	}));

	return { summary, vulnerabilities, policies, permissions, auditLog };
}

/** GET /api/projects/[id]/security — security audit data for a project */
export const GET: RequestHandler = async () => {
	return json(await buildSecurityData());
};

/** POST /api/projects/[id]/security — trigger a security scan, then return fresh data */
export const POST: RequestHandler = async ({ fetch }) => {
	const scanRes = await fetch('/api/security/scan', { method: 'POST' });
	if (!scanRes.ok) {
		const body = await scanRes.json().catch(() => ({ error: 'Scan failed' }));
		return json({ error: body.error ?? 'Scan failed' }, { status: scanRes.status });
	}

	return json(await buildSecurityData());
};
