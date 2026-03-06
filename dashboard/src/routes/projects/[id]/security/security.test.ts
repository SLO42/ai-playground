import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';

// Mock file readers before importing the module under test
vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: vi.fn()
}));

vi.mock('$lib/server/yaml-parser.js', () => ({
	readYamlFile: vi.fn()
}));

import { load } from './+page.server.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import SecurityPage from './+page.svelte';

const mockReadJson = vi.mocked(readJsonFile);
const mockReadYaml = vi.mocked(readYamlFile);

function callLoad() {
	// PageServerLoad expects a complex event object; the load function doesn't use it
	return (load as unknown as () => Promise<Record<string, unknown>>)();
}

function makePageData(overrides: Record<string, unknown> = {}) {
	return {
		summary: { lastScan: 'Never', vulnerabilities: 0, critical: 0, score: 'N/A', status: 'PENDING' },
		vulnerabilities: [] as Array<{ package: string; severity: string; cve: string; current: string; fixed: string }>,
		policies: [] as Array<{ name: string; value: string; pass: boolean }>,
		permissions: [] as Array<{ path: string; perms: string; pass: boolean }>,
		auditLog: [] as Array<{ time: string; message: string; result: string }>,
		loadError: null as string | null,
		...overrides
	};
}

function renderPage(dataOverrides: Record<string, unknown> = {}) {
	return render(SecurityPage, { props: { data: makePageData(dataOverrides) as any } });
}

describe('/projects/[id]/security load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('typical scenarios', () => {
		it('returns full security data when all files exist', async () => {
			mockReadJson.mockImplementation(async (path: string) => {
				if (path.includes('audit-status')) {
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
						additionalFixes: ['/etc/app/config.yaml']
					};
				}
				if (path.includes('security-findings')) {
					return {
						scannedAt: '2026-03-01T12:00:00Z',
						findings: [
							{ severity: 'CRITICAL', issue: 'CVE-2026-9999', detail: 'RCE in parser', component: 'xml-parser' },
							{ severity: 'LOW', issue: 'CVE-2026-0001', detail: 'Info leak' }
						]
					};
				}
				return null;
			});

			mockReadYaml.mockResolvedValue({
				version: '1.2.0',
				firewall: { defaultAction: 'deny' },
				inputValidation: { enabled: true }
			});

			const result = await callLoad();

			// Summary
			expect(result.summary).toEqual({
				lastScan: '2026-03-01T12:00:00Z',
				vulnerabilities: 2,
				critical: 1,
				score: '4/5',
				status: 'PASS'
			});

			// Vulnerabilities
			expect(result.vulnerabilities).toHaveLength(2);
			expect(result.vulnerabilities[0]).toEqual({
				package: 'xml-parser',
				severity: 'critical',
				cve: 'CVE-2026-9999',
				current: 'RCE in parser',
				fixed: '2026-03-01T12:00:00Z'
			});

			// Policies
			expect(result.policies).toHaveLength(3);
			expect(result.policies[0]).toEqual({ name: 'Default Firewall Action', value: 'deny', pass: true });
			expect(result.policies[1]).toEqual({ name: 'Input Validation', value: 'Enabled', pass: true });

			// Permissions
			expect(result.permissions).toEqual([{ path: '/etc/app/config.yaml', perms: 'applied', pass: true }]);

			// Audit log
			expect(result.auditLog).toHaveLength(1);
			expect(result.auditLog[0]).toEqual({
				time: '2026-03-01T10:00:00Z',
				message: 'CVE-2026-1234: Updated lodash to 4.17.21',
				result: 'PASS'
			});

			expect(result.loadError).toBeNull();
		});

		it('counts HIGH severity as critical', async () => {
			mockReadJson.mockImplementation(async (path: string) => {
				if (path.includes('audit-status')) return { lastScan: 'now', status: 'WARN', cvesFixed: 0, totalCves: 0, fixes: {}, additionalFixes: [] };
				if (path.includes('security-findings')) {
					return {
						scannedAt: 'now',
						findings: [
							{ severity: 'HIGH', issue: 'CVE-H', detail: 'high sev' },
							{ severity: 'MEDIUM', issue: 'CVE-M', detail: 'medium sev' }
						]
					};
				}
				return null;
			});
			mockReadYaml.mockResolvedValue(null);

			const result = await callLoad();
			expect(result.summary.critical).toBe(1);
			expect(result.summary.vulnerabilities).toBe(2);
		});
	});

	describe('edge cases', () => {
		it('returns defaults when all files are null', async () => {
			mockReadJson.mockResolvedValue(null);
			mockReadYaml.mockResolvedValue(null);

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
			expect(result.loadError).toBeNull();
		});

		it('handles audit with no fixes or additionalFixes', async () => {
			mockReadJson.mockImplementation(async (path: string) => {
				if (path.includes('audit-status')) {
					return { lastScan: '2026-01-01', status: 'PASS', cvesFixed: 0, totalCves: 0 };
				}
				return null;
			});
			mockReadYaml.mockResolvedValue(null);

			const result = await callLoad();
			expect(result.permissions).toEqual([]);
			expect(result.auditLog).toEqual([]);
		});

		it('handles findings without component field', async () => {
			mockReadJson.mockImplementation(async (path: string) => {
				if (path.includes('audit-status')) return null;
				if (path.includes('security-findings')) {
					return {
						scannedAt: '2026-03-01',
						findings: [{ severity: 'MEDIUM', issue: 'CVE-2026-5555 overflow', detail: 'buffer overflow' }]
					};
				}
				return null;
			});
			mockReadYaml.mockResolvedValue(null);

			const result = await callLoad();
			expect(result.vulnerabilities[0].package).toBe('CVE-2026-5555');
		});

		it('handles policy with missing nested fields', async () => {
			mockReadJson.mockResolvedValue(null);
			mockReadYaml.mockResolvedValue({ version: '1.0' });

			const result = await callLoad();
			expect(result.policies).toEqual([
				{ name: 'Default Firewall Action', value: 'N/A', pass: false },
				{ name: 'Input Validation', value: 'Disabled', pass: false },
				{ name: 'Policy Version', value: '1.0', pass: true }
			]);
		});

		it('handles empty findings array', async () => {
			mockReadJson.mockImplementation(async (path: string) => {
				if (path.includes('security-findings')) return { scannedAt: 'now', findings: [] };
				return null;
			});
			mockReadYaml.mockResolvedValue(null);

			const result = await callLoad();
			expect(result.vulnerabilities).toEqual([]);
			expect(result.summary.vulnerabilities).toBe(0);
			expect(result.summary.critical).toBe(0);
		});
	});

	describe('failure scenarios', () => {
		it('returns error state when file reader throws', async () => {
			mockReadJson.mockRejectedValue(new Error('ENOENT: file not found'));
			mockReadYaml.mockResolvedValue(null);

			const result = await callLoad();

			expect(result.loadError).toBe('ENOENT: file not found');
			expect(result.summary).toEqual({
				lastScan: 'Error',
				vulnerabilities: 0,
				critical: 0,
				score: 'N/A',
				status: 'ERROR'
			});
			expect(result.vulnerabilities).toEqual([]);
			expect(result.policies).toEqual([]);
			expect(result.permissions).toEqual([]);
			expect(result.auditLog).toEqual([]);
		});

		it('returns generic message for non-Error throws', async () => {
			mockReadJson.mockRejectedValue('string error');
			mockReadYaml.mockResolvedValue(null);

			const result = await callLoad();
			expect(result.loadError).toBe('Failed to load security data');
		});

		it('returns error state when yaml parser throws', async () => {
			mockReadJson.mockResolvedValue(null);
			mockReadYaml.mockRejectedValue(new Error('Invalid YAML'));

			const result = await callLoad();
			expect(result.loadError).toBe('Invalid YAML');
			expect(result.summary.status).toBe('ERROR');
		});
	});
});

describe('/projects/[id]/security page rendering', () => {
	describe('empty state', () => {
		it('shows empty state when all data arrays are empty', () => {
			renderPage();
			expect(screen.getByText('No Security Data')).toBeInTheDocument();
			expect(screen.getByText('Run First Scan')).toBeInTheDocument();
			expect(screen.getByText(/Run a security scan to audit/)).toBeInTheDocument();
		});

		it('shows the header and Run Scan button', () => {
			renderPage();
			expect(screen.getByText('Project Security')).toBeInTheDocument();
			expect(screen.getByText('Run Scan')).toBeInTheDocument();
		});
	});

	describe('error state', () => {
		it('displays server load error banner', () => {
			renderPage({ loadError: 'ENOENT: file not found' });
			expect(screen.getByText('Failed to load security data')).toBeInTheDocument();
			expect(screen.getByText('ENOENT: file not found')).toBeInTheDocument();
			expect(screen.getByText('Retry')).toBeInTheDocument();
		});

		it('shows empty state alongside load error when data is empty', () => {
			renderPage({ loadError: 'Something broke' });
			expect(screen.getByText('Failed to load security data')).toBeInTheDocument();
			expect(screen.getByText('No Security Data')).toBeInTheDocument();
		});
	});

	describe('success state with data', () => {
		const fullData = {
			summary: { lastScan: '2026-03-01', vulnerabilities: 2, critical: 1, score: '4/5', status: 'PASS' },
			vulnerabilities: [
				{ package: 'xml-parser', severity: 'critical', cve: 'CVE-2026-9999', current: 'RCE in parser', fixed: '2026-03-01' },
				{ package: 'lodash', severity: 'low', cve: 'CVE-2026-0001', current: 'Info leak', fixed: '2026-03-01' }
			],
			policies: [
				{ name: 'Default Firewall Action', value: 'deny', pass: true },
				{ name: 'Input Validation', value: 'Enabled', pass: true },
				{ name: 'Policy Version', value: '1.2.0', pass: true }
			],
			permissions: [
				{ path: '/etc/app/config.yaml', perms: 'applied', pass: true }
			],
			auditLog: [
				{ time: '2026-03-01T10:00:00Z', message: 'CVE-2026-1234: Updated lodash', result: 'PASS' }
			]
		};

		it('renders summary metric cards', () => {
			renderPage(fullData);
			expect(screen.getByText('Last Scan')).toBeInTheDocument();
			expect(screen.getAllByText('2026-03-01').length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('Vulnerabilities')).toBeInTheDocument();
			expect(screen.getByText('Critical')).toBeInTheDocument();
			expect(screen.getByText('Score')).toBeInTheDocument();
			expect(screen.getByText('4/5')).toBeInTheDocument();
		});

		it('does not show empty state when data exists', () => {
			renderPage(fullData);
			expect(screen.queryByText('No Security Data')).not.toBeInTheDocument();
		});

		it('renders vulnerability rows', () => {
			renderPage(fullData);
			expect(screen.getByText('Dependency Vulnerabilities')).toBeInTheDocument();
			expect(screen.getByText('xml-parser')).toBeInTheDocument();
			expect(screen.getByText('CVE-2026-9999')).toBeInTheDocument();
			expect(screen.getByText('critical')).toBeInTheDocument();
			expect(screen.getByText('lodash')).toBeInTheDocument();
			expect(screen.getByText('CVE-2026-0001')).toBeInTheDocument();
		});

		it('renders severity badges with correct styles', () => {
			renderPage(fullData);
			const critical = screen.getByText('critical');
			expect(critical).toHaveClass('bg-accent-red/20', 'text-accent-red');
			const low = screen.getByText('low');
			expect(low).toHaveClass('bg-accent-green/20', 'text-accent-green');
		});

		it('renders security policies', () => {
			renderPage(fullData);
			expect(screen.getByText('Security Policies')).toBeInTheDocument();
			expect(screen.getByText('Default Firewall Action')).toBeInTheDocument();
			expect(screen.getByText('deny')).toBeInTheDocument();
			expect(screen.getByText('Input Validation')).toBeInTheDocument();
			expect(screen.getByText('Enabled')).toBeInTheDocument();
		});

		it('renders file permissions', () => {
			renderPage(fullData);
			expect(screen.getByText('File Permissions')).toBeInTheDocument();
			expect(screen.getByText('/etc/app/config.yaml')).toBeInTheDocument();
			expect(screen.getByText('applied')).toBeInTheDocument();
		});

		it('renders audit log entries', () => {
			renderPage(fullData);
			expect(screen.getByText('Recent Audit Log')).toBeInTheDocument();
			expect(screen.getByText('2026-03-01T10:00:00Z')).toBeInTheDocument();
			expect(screen.getByText('CVE-2026-1234: Updated lodash')).toBeInTheDocument();
			expect(screen.getByText('PASS')).toBeInTheDocument();
		});

		it('applies correct result color for PASS entries', () => {
			renderPage(fullData);
			const passEl = screen.getByText('PASS');
			expect(passEl).toHaveClass('text-accent-green');
		});
	});

	describe('partial data', () => {
		it('shows "All clear" when vulnerabilities array is empty but other data exists', () => {
			renderPage({
				policies: [{ name: 'Firewall', value: 'deny', pass: true }],
				vulnerabilities: []
			});
			expect(screen.getByText('All clear')).toBeInTheDocument();
			expect(screen.getByText('No dependency vulnerabilities detected')).toBeInTheDocument();
		});

		it('shows empty policy message when policies array is empty but other data exists', () => {
			renderPage({
				vulnerabilities: [{ package: 'foo', severity: 'low', cve: 'CVE-1', current: 'x', fixed: 'y' }],
				policies: []
			});
			expect(screen.getByText(/No security policies configured/)).toBeInTheDocument();
		});

		it('shows empty permissions message when permissions array is empty but other data exists', () => {
			renderPage({
				vulnerabilities: [{ package: 'foo', severity: 'low', cve: 'CVE-1', current: 'x', fixed: 'y' }],
				permissions: []
			});
			expect(screen.getByText(/No file permissions audited/)).toBeInTheDocument();
		});

		it('shows empty audit log message when auditLog is empty but other data exists', () => {
			renderPage({
				vulnerabilities: [{ package: 'foo', severity: 'low', cve: 'CVE-1', current: 'x', fixed: 'y' }],
				auditLog: []
			});
			expect(screen.getByText(/No audit log entries yet/)).toBeInTheDocument();
		});
	});
});
