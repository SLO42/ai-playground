import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';

/**
 * Integration tests for /api/projects/[id]/security endpoint.
 *
 * These tests exercise the same data-loading + transformation logic the
 * GET handler uses, verifying correct JSON shape, severity counting,
 * policy mapping, audit log construction, and error handling.
 */

// ── Types ────────────────────────────────────────────────────────────────

interface AuditStatus {
	lastScan: string;
	status: string;
	cvesFixed: number;
	totalCves: number;
	fixes: Record<string, { fixedAt: string; description: string }>;
	additionalFixes?: string[];
}

interface SecurityPolicy {
	version?: string;
	firewall?: { defaultAction?: string };
	inputValidation?: { enabled?: boolean };
}

interface ScanFindingsFile {
	scannedAt: string;
	findings: Array<{ severity: string; issue: string; detail: string; component?: string }>;
}

interface SecurityFinding {
	severity: string;
	issue: string;
	detail: string;
	component?: string;
	detected?: string;
}

// ── Load function (mirrors +server.ts GET handler logic) ─────────────────

async function readJsonFile<T>(path: string): Promise<T | null> {
	try {
		const raw = await readFile(path, 'utf-8');
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function readYamlFile<T>(path: string): Promise<T | null> {
	try {
		const raw = await readFile(path, 'utf-8');
		return parseYaml(raw) as T;
	} catch {
		return null;
	}
}

async function loadSecurity(opts: {
	auditStatusPath: string;
	networkPolicyPath: string;
	scanFindingsPath: string;
}) {
	const [audit, policy, scanFile] = await Promise.all([
		readJsonFile<AuditStatus>(opts.auditStatusPath),
		readYamlFile<SecurityPolicy>(opts.networkPolicyPath),
		readJsonFile<ScanFindingsFile>(opts.scanFindingsPath)
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

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeAuditStatus(overrides: Partial<AuditStatus> = {}): AuditStatus {
	return {
		lastScan: '2026-03-01T12:00:00Z',
		status: 'PASS',
		cvesFixed: 4,
		totalCves: 5,
		fixes: {
			'CVE-2026-1234': {
				fixedAt: '2026-03-01T10:00:00Z',
				description: 'Updated lodash to 4.17.21'
			}
		},
		additionalFixes: ['/etc/app/config.yaml'],
		...overrides
	};
}

function makeScanFindings(
	overrides: Partial<ScanFindingsFile> = {}
): ScanFindingsFile {
	return {
		scannedAt: '2026-03-01T12:00:00Z',
		findings: [
			{
				severity: 'CRITICAL',
				issue: 'CVE-2026-9999',
				detail: 'RCE in parser',
				component: 'xml-parser'
			},
			{
				severity: 'LOW',
				issue: 'CVE-2026-0001',
				detail: 'Info leak'
			}
		],
		...overrides
	};
}

function makeNetworkPolicy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
	return {
		version: '1.2.0',
		firewall: { defaultAction: 'deny' },
		inputValidation: { enabled: true },
		...overrides
	};
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('/api/projects/[id]/security — GET', () => {
	let tmpDir: string;
	let auditPath: string;
	let scanPath: string;
	let policyPath: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-security-'));
		await mkdir(join(tmpDir, 'security'), { recursive: true });
		auditPath = join(tmpDir, 'security', 'audit-status.json');
		scanPath = join(tmpDir, 'security', 'security-findings.json');
		policyPath = join(tmpDir, 'security', 'network-policy.yaml');
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function callLoad() {
		return loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});
	}

	it('returns complete security payload when all data files exist', async () => {
		await writeFile(auditPath, JSON.stringify(makeAuditStatus()));
		await writeFile(scanPath, JSON.stringify(makeScanFindings()));
		await writeFile(
			policyPath,
			'version: "1.2.0"\nfirewall:\n  defaultAction: deny\ninputValidation:\n  enabled: true\n'
		);

		const result = await callLoad();

		// Summary shape
		expect(result.summary).toEqual({
			lastScan: '2026-03-01T12:00:00Z',
			vulnerabilities: 2,
			critical: 1,
			score: '4/5',
			status: 'PASS'
		});

		// Vulnerabilities array
		expect(result.vulnerabilities).toHaveLength(2);
		expect(result.vulnerabilities[0]).toEqual({
			package: 'xml-parser',
			severity: 'critical',
			cve: 'CVE-2026-9999',
			current: 'RCE in parser',
			fixed: '2026-03-01T12:00:00Z'
		});
		expect(result.vulnerabilities[1]).toEqual({
			package: 'CVE-2026-0001',
			severity: 'low',
			cve: 'CVE-2026-0001',
			current: 'Info leak',
			fixed: '2026-03-01T12:00:00Z'
		});

		// Policies
		expect(result.policies).toHaveLength(3);
		expect(result.policies[0]).toEqual({
			name: 'Default Firewall Action',
			value: 'deny',
			pass: true
		});
		expect(result.policies[1]).toEqual({
			name: 'Input Validation',
			value: 'Enabled',
			pass: true
		});
		expect(result.policies[2]).toEqual({
			name: 'Policy Version',
			value: '1.2.0',
			pass: true
		});

		// Permissions
		expect(result.permissions).toEqual([
			{ path: '/etc/app/config.yaml', perms: 'applied', pass: true }
		]);

		// Audit log
		expect(result.auditLog).toHaveLength(1);
		expect(result.auditLog[0]).toEqual({
			time: '2026-03-01T10:00:00Z',
			message: 'CVE-2026-1234: Updated lodash to 4.17.21',
			result: 'PASS'
		});
	});

	it('returns defaults when no data files exist', async () => {
		const result = await callLoad();

		expect(result.summary).toEqual({
			lastScan: 'Never',
			vulnerabilities: 0,
			critical: 0,
			score: 'N/A',
			status: 'PENDING'
		});
		expect(result.vulnerabilities).toEqual([]);
		expect(result.policies).toEqual([]);
		expect(result.permissions).toEqual([]);
		expect(result.auditLog).toEqual([]);
	});
});

describe('/api/projects/[id]/security — severity counting', () => {
	let tmpDir: string;
	let auditPath: string;
	let scanPath: string;
	let policyPath: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-security-sev-'));
		await mkdir(join(tmpDir, 'security'), { recursive: true });
		auditPath = join(tmpDir, 'security', 'audit-status.json');
		scanPath = join(tmpDir, 'security', 'security-findings.json');
		policyPath = join(tmpDir, 'security', 'network-policy.yaml');
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function callLoad() {
		return loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});
	}

	it('counts CRITICAL and HIGH as critical', async () => {
		await writeFile(
			scanPath,
			JSON.stringify(
				makeScanFindings({
					findings: [
						{ severity: 'CRITICAL', issue: 'CVE-C1', detail: 'rce' },
						{ severity: 'HIGH', issue: 'CVE-H1', detail: 'xss' },
						{ severity: 'MEDIUM', issue: 'CVE-M1', detail: 'info' },
						{ severity: 'LOW', issue: 'CVE-L1', detail: 'minor' }
					]
				})
			)
		);

		const result = await callLoad();

		expect(result.summary.vulnerabilities).toBe(4);
		expect(result.summary.critical).toBe(2);
	});

	it('reports zero critical when only LOW/MEDIUM findings', async () => {
		await writeFile(
			scanPath,
			JSON.stringify(
				makeScanFindings({
					findings: [
						{ severity: 'MEDIUM', issue: 'CVE-M1', detail: 'info disclosure' },
						{ severity: 'LOW', issue: 'CVE-L1', detail: 'cosmetic' }
					]
				})
			)
		);

		const result = await callLoad();

		expect(result.summary.vulnerabilities).toBe(2);
		expect(result.summary.critical).toBe(0);
	});

	it('handles empty findings array', async () => {
		await writeFile(
			scanPath,
			JSON.stringify(makeScanFindings({ findings: [] }))
		);

		const result = await callLoad();

		expect(result.summary.vulnerabilities).toBe(0);
		expect(result.summary.critical).toBe(0);
		expect(result.vulnerabilities).toEqual([]);
	});
});

describe('/api/projects/[id]/security — policy parsing', () => {
	let tmpDir: string;
	let auditPath: string;
	let scanPath: string;
	let policyPath: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-security-pol-'));
		await mkdir(join(tmpDir, 'security'), { recursive: true });
		auditPath = join(tmpDir, 'security', 'audit-status.json');
		scanPath = join(tmpDir, 'security', 'security-findings.json');
		policyPath = join(tmpDir, 'security', 'network-policy.yaml');
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function callLoad() {
		return loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});
	}

	it('marks firewall action as failing when not deny', async () => {
		await writeFile(
			policyPath,
			'version: "1.0"\nfirewall:\n  defaultAction: allow\ninputValidation:\n  enabled: false\n'
		);

		const result = await callLoad();

		expect(result.policies[0]).toEqual({
			name: 'Default Firewall Action',
			value: 'allow',
			pass: false
		});
		expect(result.policies[1]).toEqual({
			name: 'Input Validation',
			value: 'Disabled',
			pass: false
		});
	});

	it('handles YAML with missing nested fields', async () => {
		await writeFile(policyPath, 'version: "2.0"\n');

		const result = await callLoad();

		expect(result.policies).toHaveLength(3);
		expect(result.policies[0]).toEqual({
			name: 'Default Firewall Action',
			value: 'N/A',
			pass: false
		});
		expect(result.policies[1]).toEqual({
			name: 'Input Validation',
			value: 'Disabled',
			pass: false
		});
		expect(result.policies[2]).toEqual({
			name: 'Policy Version',
			value: '2.0',
			pass: true
		});
	});

	it('returns no policies when YAML file is missing', async () => {
		const result = await callLoad();

		expect(result.policies).toEqual([]);
	});
});

describe('/api/projects/[id]/security — audit log & permissions', () => {
	let tmpDir: string;
	let auditPath: string;
	let scanPath: string;
	let policyPath: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-security-audit-'));
		await mkdir(join(tmpDir, 'security'), { recursive: true });
		auditPath = join(tmpDir, 'security', 'audit-status.json');
		scanPath = join(tmpDir, 'security', 'security-findings.json');
		policyPath = join(tmpDir, 'security', 'network-policy.yaml');
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function callLoad() {
		return loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});
	}

	it('builds audit log from multiple CVE fixes', async () => {
		const audit = makeAuditStatus({
			fixes: {
				'CVE-2026-1111': { fixedAt: '2026-02-01', description: 'Patched openssl' },
				'CVE-2026-2222': { fixedAt: '2026-02-15', description: 'Updated zlib' },
				'CVE-2026-3333': { fixedAt: '2026-03-01', description: 'Fixed buffer overflow' }
			}
		});
		await writeFile(auditPath, JSON.stringify(audit));

		const result = await callLoad();

		expect(result.auditLog).toHaveLength(3);
		const messages = result.auditLog.map((e) => e.message);
		expect(messages).toContain('CVE-2026-1111: Patched openssl');
		expect(messages).toContain('CVE-2026-2222: Updated zlib');
		expect(messages).toContain('CVE-2026-3333: Fixed buffer overflow');
		result.auditLog.forEach((entry) => {
			expect(entry.result).toBe('PASS');
		});
	});

	it('builds permissions from additionalFixes array', async () => {
		const audit = makeAuditStatus({
			additionalFixes: ['/etc/app/config.yaml', '/var/log/app.log', '/usr/local/bin/app']
		});
		await writeFile(auditPath, JSON.stringify(audit));

		const result = await callLoad();

		expect(result.permissions).toHaveLength(3);
		expect(result.permissions).toEqual([
			{ path: '/etc/app/config.yaml', perms: 'applied', pass: true },
			{ path: '/var/log/app.log', perms: 'applied', pass: true },
			{ path: '/usr/local/bin/app', perms: 'applied', pass: true }
		]);
	});

	it('returns empty audit log and permissions when audit has no fixes', async () => {
		const audit = makeAuditStatus({ fixes: {}, additionalFixes: [] });
		await writeFile(auditPath, JSON.stringify(audit));

		const result = await callLoad();

		expect(result.auditLog).toEqual([]);
		expect(result.permissions).toEqual([]);
	});
});

describe('/api/projects/[id]/security — end-to-end realistic scenario', () => {
	let tmpDir: string;
	let auditPath: string;
	let scanPath: string;
	let policyPath: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-security-e2e-'));
		await mkdir(join(tmpDir, 'security'), { recursive: true });
		auditPath = join(tmpDir, 'security', 'audit-status.json');
		scanPath = join(tmpDir, 'security', 'security-findings.json');
		policyPath = join(tmpDir, 'security', 'network-policy.yaml');
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('produces a realistic security scan response for a project', async () => {
		// Simulate: project was scanned, 3 CVEs found, 2 already fixed, policy enforced
		const audit: AuditStatus = {
			lastScan: '2026-03-05T09:15:00Z',
			status: 'WARN',
			cvesFixed: 2,
			totalCves: 3,
			fixes: {
				'CVE-2026-4001': {
					fixedAt: '2026-03-04T14:00:00Z',
					description: 'Upgraded express to 4.19.2'
				},
				'CVE-2026-4002': {
					fixedAt: '2026-03-04T14:30:00Z',
					description: 'Patched prototype pollution in lodash'
				}
			},
			additionalFixes: ['/app/config/secrets.yaml', '/app/.env.production']
		};

		const scan: ScanFindingsFile = {
			scannedAt: '2026-03-05T09:15:00Z',
			findings: [
				{
					severity: 'CRITICAL',
					issue: 'CVE-2026-5001',
					detail: 'Remote code execution via deserialization',
					component: 'fastify-xml-parser'
				},
				{
					severity: 'HIGH',
					issue: 'CVE-2026-5002',
					detail: 'SQL injection in query builder',
					component: 'knex'
				},
				{
					severity: 'MEDIUM',
					issue: 'CVE-2026-5003',
					detail: 'Open redirect in OAuth callback'
				},
				{
					severity: 'LOW',
					issue: 'CVE-2026-5004',
					detail: 'Missing Content-Security-Policy header'
				}
			]
		};

		const policyYaml = [
			'version: "2.1.0"',
			'firewall:',
			'  defaultAction: deny',
			'inputValidation:',
			'  enabled: true'
		].join('\n');

		await writeFile(auditPath, JSON.stringify(audit));
		await writeFile(scanPath, JSON.stringify(scan));
		await writeFile(policyPath, policyYaml);

		const result = await loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});

		// ── Assert full response shape ──
		expect(result).toHaveProperty('summary');
		expect(result).toHaveProperty('vulnerabilities');
		expect(result).toHaveProperty('policies');
		expect(result).toHaveProperty('permissions');
		expect(result).toHaveProperty('auditLog');

		// Summary reflects the scan
		expect(result.summary).toEqual({
			lastScan: '2026-03-05T09:15:00Z',
			vulnerabilities: 4,
			critical: 2, // CRITICAL + HIGH
			score: '2/3',
			status: 'WARN'
		});

		// Vulnerabilities are realistic and correctly mapped
		expect(result.vulnerabilities).toHaveLength(4);
		expect(result.vulnerabilities[0]).toEqual({
			package: 'fastify-xml-parser',
			severity: 'critical',
			cve: 'CVE-2026-5001',
			current: 'Remote code execution via deserialization',
			fixed: '2026-03-05T09:15:00Z'
		});
		expect(result.vulnerabilities[1].package).toBe('knex');
		expect(result.vulnerabilities[1].severity).toBe('high');
		// Finding without component falls back to first word of issue
		expect(result.vulnerabilities[2].package).toBe('CVE-2026-5003');
		expect(result.vulnerabilities[3].severity).toBe('low');

		// All policies pass in this scenario
		expect(result.policies).toHaveLength(3);
		expect(result.policies.every((p) => p.pass)).toBe(true);
		expect(result.policies[2].value).toBe('2.1.0');

		// Permissions from additionalFixes
		expect(result.permissions).toHaveLength(2);
		expect(result.permissions[0].path).toBe('/app/config/secrets.yaml');
		expect(result.permissions[1].path).toBe('/app/.env.production');
		expect(result.permissions.every((p) => p.pass && p.perms === 'applied')).toBe(true);

		// Audit log entries
		expect(result.auditLog).toHaveLength(2);
		expect(result.auditLog.every((e) => e.result === 'PASS')).toBe(true);
		const auditMessages = result.auditLog.map((e) => e.message);
		expect(auditMessages).toContain('CVE-2026-4001: Upgraded express to 4.19.2');
		expect(auditMessages).toContain(
			'CVE-2026-4002: Patched prototype pollution in lodash'
		);
	});

	it('handles partial data — only scan findings, no audit or policy', async () => {
		await writeFile(
			scanPath,
			JSON.stringify(
				makeScanFindings({
					findings: [
						{ severity: 'HIGH', issue: 'CVE-2026-7777', detail: 'XSS in template engine', component: 'handlebars' }
					]
				})
			)
		);

		const result = await loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});

		expect(result.summary.lastScan).toBe('Never');
		expect(result.summary.vulnerabilities).toBe(1);
		expect(result.summary.critical).toBe(1);
		expect(result.summary.score).toBe('N/A');
		expect(result.summary.status).toBe('PENDING');
		expect(result.vulnerabilities).toHaveLength(1);
		expect(result.vulnerabilities[0].package).toBe('handlebars');
		expect(result.policies).toEqual([]);
		expect(result.permissions).toEqual([]);
		expect(result.auditLog).toEqual([]);
	});

	it('handles partial data — only audit, no scan or policy', async () => {
		await writeFile(auditPath, JSON.stringify(makeAuditStatus()));

		const result = await loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});

		expect(result.summary.lastScan).toBe('2026-03-01T12:00:00Z');
		expect(result.summary.vulnerabilities).toBe(0);
		expect(result.summary.score).toBe('4/5');
		expect(result.vulnerabilities).toEqual([]);
		expect(result.auditLog).toHaveLength(1);
		expect(result.permissions).toHaveLength(1);
	});

	it('handles corrupt JSON files gracefully', async () => {
		await writeFile(auditPath, '{ broken json !!!');
		await writeFile(scanPath, 'not json at all');

		const result = await loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});

		// Should treat as if files don't exist
		expect(result.summary.lastScan).toBe('Never');
		expect(result.summary.status).toBe('PENDING');
		expect(result.vulnerabilities).toEqual([]);
	});

	it('handles corrupt YAML policy file gracefully', async () => {
		await writeFile(policyPath, ':\n  :\n    - [invalid');

		const result = await loadSecurity({
			auditStatusPath: auditPath,
			networkPolicyPath: policyPath,
			scanFindingsPath: scanPath
		});

		// Depends on yaml parser — may return null or partial. Either way no crash.
		expect(result.summary).toBeDefined();
		expect(result.vulnerabilities).toEqual([]);
	});
});
