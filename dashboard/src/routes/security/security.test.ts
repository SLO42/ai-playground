import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';

vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: vi.fn()
}));

vi.mock('$lib/server/yaml-parser.js', () => ({
	readYamlFile: vi.fn()
}));

vi.mock('$lib/api-client.js', () => ({
	apiFetch: vi.fn()
}));

import { load } from './+page.server.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import SecurityPage from './+page.svelte';

const mockReadJson = vi.mocked(readJsonFile);
const mockReadYaml = vi.mocked(readYamlFile);

function callLoad() {
	return (load as unknown as () => Promise<Record<string, unknown>>)();
}

function makePageData(overrides: Record<string, unknown> = {}) {
	return {
		audit: null as Record<string, unknown> | null,
		policy: null as Record<string, unknown> | null,
		scanFindings: [] as Array<{
			severity: string;
			issue: string;
			detail?: string;
			component?: string;
			detected?: string;
		}>,
		...overrides
	};
}

function renderPage(dataOverrides: Record<string, unknown> = {}) {
	return render(SecurityPage, { props: { data: makePageData(dataOverrides) as any } });
}

// ─── Server load tests ───

describe('/security load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns audit, policy, and scanFindings when files exist', async () => {
		mockReadJson.mockImplementation(async (path: string) => {
			if (path.includes('audit-status')) {
				return {
					lastScan: '2026-03-01T12:00:00Z',
					status: 'CLEAN',
					cvesFixed: 3,
					totalCves: 3,
					fixes: {
						'CVE-1': { fixedAt: '2026-03-01', description: 'Patched dep' }
					},
					additionalFixes: []
				};
			}
			if (path.includes('security-findings') || path.includes('scan')) {
				return {
					scannedAt: '2026-03-01T12:00:00Z',
					findings: [
						{ severity: 'CRITICAL', issue: 'CVE-2026-9999', detail: 'RCE in parser' }
					]
				};
			}
			return null;
		});

		mockReadYaml.mockResolvedValue({
			firewall: { defaultAction: 'deny', inbound: [], outbound: [] }
		});

		const result = await callLoad();
		expect(result.audit).toBeDefined();
		expect(result.policy).toBeDefined();
		expect(result.scanFindings).toHaveLength(1);
		expect(result.scanFindings[0]).toMatchObject({
			severity: 'CRITICAL',
			issue: 'CVE-2026-9999'
		});
	});

	it('returns nulls/empty when all files are missing', async () => {
		mockReadJson.mockResolvedValue(null);
		mockReadYaml.mockResolvedValue(null);

		const result = await callLoad();
		expect(result.audit).toBeNull();
		expect(result.policy).toBeNull();
		expect(result.scanFindings).toEqual([]);
	});

	it('returns empty scanFindings when findings file has no findings array', async () => {
		mockReadJson.mockImplementation(async (path: string) => {
			if (path.includes('scan') || path.includes('findings')) {
				return { scannedAt: '2026-03-01' };
			}
			return null;
		});
		mockReadYaml.mockResolvedValue(null);

		const result = await callLoad();
		expect(result.scanFindings).toEqual([]);
	});
});

// ─── Component rendering tests ───

describe('/security page rendering', () => {
	describe('default empty state', () => {
		it('renders page title', () => {
			renderPage();
			expect(screen.getByText('Security & Compliance')).toBeInTheDocument();
		});

		it('shows "Never" for last scan when audit is null', () => {
			renderPage();
			expect(screen.getByText(/Never/)).toBeInTheDocument();
		});

		it('shows 0/0 CVEs when audit is null', () => {
			renderPage();
			expect(screen.getByText('0/0')).toBeInTheDocument();
		});

		it('shows "No CVE data available" when no fixes exist', () => {
			renderPage();
			expect(screen.getByText('No CVE data available.')).toBeInTheDocument();
		});

		it('shows "No additional findings" when no findings exist', () => {
			renderPage();
			expect(screen.getByText('No additional findings.')).toBeInTheDocument();
		});

		it('shows "No firewall rules loaded" when policy is null', () => {
			renderPage();
			expect(screen.getByText('No firewall rules loaded.')).toBeInTheDocument();
		});

		it('renders the Run Security Scan button', () => {
			renderPage();
			expect(screen.getByText('Run Security Scan')).toBeInTheDocument();
		});
	});

	describe('audit status rendering', () => {
		it('shows "All Clear" for CLEAN status', () => {
			renderPage({
				audit: { status: 'CLEAN', lastScan: '2026-03-01', cvesFixed: 3, totalCves: 3, fixes: {}, additionalFixes: [] }
			});
			expect(screen.getByText('All Clear')).toBeInTheDocument();
		});

		it('shows "Vulnerable" for VULNERABLE status', () => {
			renderPage({
				audit: { status: 'VULNERABLE', lastScan: '2026-03-01', cvesFixed: 0, totalCves: 5, fixes: {}, additionalFixes: [] }
			});
			expect(screen.getByText('Vulnerable')).toBeInTheDocument();
		});

		it('shows "Pending Review" for PENDING status', () => {
			renderPage({
				audit: { status: 'PENDING', lastScan: '2026-03-01', cvesFixed: 1, totalCves: 3, fixes: {}, additionalFixes: [] }
			});
			expect(screen.getByText('Pending Review')).toBeInTheDocument();
		});

		it('shows last scan date from audit', () => {
			renderPage({
				audit: { status: 'CLEAN', lastScan: '2026-03-01T12:00:00Z', cvesFixed: 0, totalCves: 0, fixes: {}, additionalFixes: [] }
			});
			expect(screen.getByText(/2026-03-01T12:00:00Z/)).toBeInTheDocument();
		});

		it('shows CVE counts from audit', () => {
			renderPage({
				audit: { status: 'CLEAN', lastScan: 'now', cvesFixed: 4, totalCves: 5, fixes: {}, additionalFixes: [] }
			});
			expect(screen.getByText('4/5')).toBeInTheDocument();
		});
	});

	describe('CVE remediation rendering', () => {
		it('renders CVE IDs and descriptions', () => {
			renderPage({
				audit: {
					status: 'CLEAN',
					lastScan: 'now',
					cvesFixed: 1,
					totalCves: 1,
					fixes: {
						'CVE-2026-1234': { fixedAt: '2026-03-01', description: 'Updated lodash' }
					},
					additionalFixes: []
				}
			});
			expect(screen.getByText('CVE-2026-1234')).toBeInTheDocument();
			expect(screen.getByText('Updated lodash')).toBeInTheDocument();
			expect(screen.getByText('100%')).toBeInTheDocument();
		});

		it('shows partial remediation percentage when not fixed', () => {
			renderPage({
				audit: {
					status: 'PENDING',
					lastScan: 'now',
					cvesFixed: 3,
					totalCves: 5,
					fixes: {
						'CVE-2026-5555': { description: 'Pending patch' }
					},
					additionalFixes: []
				}
			});
			expect(screen.getByText('CVE-2026-5555')).toBeInTheDocument();
			expect(screen.getByText('60%')).toBeInTheDocument();
		});
	});

	describe('security findings table', () => {
		it('renders findings from scanFindings data', () => {
			renderPage({
				scanFindings: [
					{ severity: 'CRITICAL', issue: 'CVE-2026-9999', detail: 'RCE in parser', component: 'xml-parser', detected: '2026-03-01T12:00:00Z' },
					{ severity: 'LOW', issue: 'CVE-2026-0001', detail: 'Info leak' }
				]
			});
			expect(screen.getByText('Security Findings')).toBeInTheDocument();
			expect(screen.getByText('CRITICAL')).toBeInTheDocument();
			expect(screen.getByText(/RCE in parser/)).toBeInTheDocument();
			expect(screen.getByText('LOW')).toBeInTheDocument();
		});

		it('renders findings from additionalFixes with inferred severity', () => {
			renderPage({
				audit: {
					status: 'CLEAN',
					lastScan: '2026-03-01',
					cvesFixed: 0,
					totalCves: 0,
					fixes: {},
					additionalFixes: ['gateway.yaml: injection vulnerability in route config']
				}
			});
			// "injection" should infer HIGH severity
			expect(screen.getByText('HIGH')).toBeInTheDocument();
			expect(screen.getByText('gateway.yaml')).toBeInTheDocument();
			expect(screen.getByText(/injection vulnerability/)).toBeInTheDocument();
		});

		it('shows severity table headers', () => {
			renderPage({
				scanFindings: [
					{ severity: 'MEDIUM', issue: 'test', detail: 'detail' }
				]
			});
			expect(screen.getByText('Severity')).toBeInTheDocument();
			expect(screen.getByText('Finding')).toBeInTheDocument();
			expect(screen.getByText('Component')).toBeInTheDocument();
			expect(screen.getByText('Status')).toBeInTheDocument();
			expect(screen.getByText('Detected')).toBeInTheDocument();
		});

		it('maps severity to correct status labels', () => {
			renderPage({
				scanFindings: [
					{ severity: 'CRITICAL', issue: 'critical-issue', detail: 'x' },
					{ severity: 'MEDIUM', issue: 'medium-issue', detail: 'y' },
					{ severity: 'LOW', issue: 'low-issue', detail: 'z' }
				]
			});
			expect(screen.getAllByText('Action Required')).toHaveLength(1);
			expect(screen.getByText('Review')).toBeInTheDocument();
			expect(screen.getByText('Monitor')).toBeInTheDocument();
		});
	});

	describe('network policy rendering', () => {
		it('renders inbound firewall rules', () => {
			renderPage({
				policy: {
					firewall: {
						inbound: [
							{ name: 'Allow SSH', source: '10.0.0.0/8', port: 22, action: 'allow' }
						],
						outbound: []
					}
				}
			});
			expect(screen.getByText('Network Policy')).toBeInTheDocument();
			expect(screen.getByText('Inbound: Allow SSH')).toBeInTheDocument();
			expect(screen.getByText('10.0.0.0/8:22')).toBeInTheDocument();
		});

		it('renders outbound firewall rules', () => {
			renderPage({
				policy: {
					firewall: {
						inbound: [],
						outbound: [
							{ name: 'Block External', destination: '0.0.0.0/0', action: 'deny' }
						]
					}
				}
			});
			expect(screen.getByText('Outbound: Block External')).toBeInTheDocument();
			expect(screen.getByText('0.0.0.0/0')).toBeInTheDocument();
		});

		it('renders default firewall action', () => {
			renderPage({
				policy: {
					firewall: {
						defaultAction: 'deny',
						inbound: [],
						outbound: []
					}
				}
			});
			expect(screen.getByText('Default')).toBeInTheDocument();
			expect(screen.getByText('deny')).toBeInTheDocument();
		});

		it('shows port-only rule when no source/destination', () => {
			renderPage({
				policy: {
					firewall: {
						inbound: [{ name: 'Port rule', port: 443, action: 'allow' }],
						outbound: []
					}
				}
			});
			expect(screen.getByText('port 443')).toBeInTheDocument();
		});

		it('shows protocol when no source/port', () => {
			renderPage({
				policy: {
					firewall: {
						inbound: [{ name: 'Proto rule', protocol: 'icmp', action: 'allow' }],
						outbound: []
					}
				}
			});
			expect(screen.getByText('icmp')).toBeInTheDocument();
		});
	});

	describe('scan button state', () => {
		it('button is not disabled initially', () => {
			renderPage();
			const button = screen.getByText('Run Security Scan');
			expect(button).not.toBeDisabled();
		});
	});
});
