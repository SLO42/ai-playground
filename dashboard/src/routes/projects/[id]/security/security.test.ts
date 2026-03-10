// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/feature-flags.js', () => ({
	getFeatureFlags: vi.fn()
}));

import { load } from './+page.server.js';
import { getFeatureFlags } from '$lib/server/feature-flags.js';

const mockedFlags = vi.mocked(getFeatureFlags);
const mockFetch = vi.fn();

function callLoad(paramsOverride?: Record<string, string>) {
	return load({
		params: { id: 'test-proj', ...paramsOverride },
		fetch: mockFetch
	} as any);
}

const fullSecurityResponse = {
	summary: { lastScan: '2026-03-01T12:00:00Z', vulnerabilities: 2, critical: 1, score: '4/5', status: 'PASS' },
	vulnerabilities: [
		{ package: 'xml-parser', severity: 'critical', cve: 'CVE-2026-9999', current: 'RCE in parser', fixed: '2026-03-01T12:00:00Z' },
		{ package: 'lodash', severity: 'low', cve: 'CVE-2026-0001', current: 'Info leak', fixed: '2026-03-01T12:00:00Z' }
	],
	policies: [
		{ name: 'Default Firewall Action', value: 'deny', pass: true },
		{ name: 'Input Validation', value: 'Enabled', pass: true },
		{ name: 'Policy Version', value: '1.2.0', pass: true }
	],
	permissions: [{ path: '/etc/app/config.yaml', perms: 'applied', pass: true }],
	auditLog: [{ time: '2026-03-01T10:00:00Z', message: 'CVE-2026-1234: Updated lodash to 4.17.21', result: 'PASS' }]
};

describe('/projects/[id]/security load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedFlags.mockReturnValue({ previewNewPages: true } as any);
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(fullSecurityResponse)
		});
	});

	describe('feature flag gating', () => {
		it('throws 404 when previewNewPages is false', async () => {
			mockedFlags.mockReturnValue({ previewNewPages: false } as any);
			await expect(callLoad()).rejects.toThrow();
		});
	});

	describe('typical scenarios', () => {
		it('returns security data from API when previewNewPages is true', async () => {
			const result = await callLoad();
			const securityData = await result.security;

			expect(securityData.summary).toEqual(fullSecurityResponse.summary);
			expect(securityData.vulnerabilities).toEqual(fullSecurityResponse.vulnerabilities);
			expect(securityData.policies).toEqual(fullSecurityResponse.policies);
			expect(securityData.permissions).toEqual(fullSecurityResponse.permissions);
			expect(securityData.auditLog).toEqual(fullSecurityResponse.auditLog);
			expect(securityData.loadError).toBeNull();
		});
	});

	describe('failure scenarios', () => {
		it('returns error state when fetch fails', async () => {
			mockFetch.mockRejectedValue(new Error('Network failure'));
			const result = await callLoad();
			const securityData = await result.security;

			expect(securityData.loadError).toBe('Network failure');
			expect(securityData.summary.status).toBe('ERROR');
			expect(securityData.vulnerabilities).toEqual([]);
		});

		it('returns error state when API returns non-ok', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: 'Internal error' })
			});
			const result = await callLoad();
			const securityData = await result.security;

			expect(securityData.loadError).toBeTruthy();
			expect(securityData.summary.status).toBe('ERROR');
		});

		it('returns generic message for non-Error throws', async () => {
			mockFetch.mockRejectedValue('string error');
			const result = await callLoad();
			const securityData = await result.security;

			expect(securityData.loadError).toBe('Failed to load security data');
		});
	});
});
