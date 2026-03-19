// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: vi.fn()
}));

vi.mock('$lib/server/yaml-parser.js', () => ({
	readYamlFile: vi.fn()
}));

vi.mock('$lib/server/project-scanner.js', () => ({
	scanAllProjects: vi.fn()
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		playgroundRegistry: '/mock/registry.json',
		root: '/mock/root',
		auditStatus: '/mock/audit-status.json',
		scanFindings: '/mock/scan-findings.json',
		networkPolicy: '/mock/network-policy.yaml'
	}
}));

import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { load } from './+page.server.js';

const mockedReadJson = vi.mocked(readJsonFile);
const mockedReadYaml = vi.mocked(readYamlFile);
const mockedScan = vi.mocked(scanAllProjects);

function callLoad(paramsOverride?: Record<string, string>) {
	return load({
		params: { id: 'test-proj', ...paramsOverride }
	} as any);
}

const sampleAudit = {
	lastScan: '2026-03-01T12:00:00Z',
	vulnerabilities: 2,
	critical: 1,
	score: '4/5',
	status: 'PASS'
};

const sampleScanFile = {
	scannedAt: '2026-03-01T12:00:00Z',
	findings: [
		{ severity: 'critical', issue: 'RCE', detail: 'Remote code execution', component: 'xml-parser' },
		{ severity: 'low', issue: 'Info leak', detail: 'Information disclosure' }
	]
};

const samplePolicy = {
	name: 'Default Policy',
	rules: [{ action: 'deny', source: '*' }]
};

describe('/projects/[id]/security load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedScan.mockResolvedValue([
			{ id: 'test-proj', name: 'Test Project', path: '/tmp/test-proj' }
		] as any);
		// Default: project-specific files not found, use global
		mockedReadJson.mockImplementation(async (path: any) => {
			const p = String(path);
			if (p.includes('test-proj')) return null; // project-specific not found
			if (p.includes('audit')) return sampleAudit;
			if (p.includes('scan') || p.includes('findings')) return sampleScanFile;
			return null;
		});
		mockedReadYaml.mockImplementation(async (path: any) => {
			const p = String(path);
			if (p.includes('test-proj')) return null;
			return samplePolicy;
		});
	});

	describe('typical scenarios', () => {
		it('returns security data from files', async () => {
			const result = await callLoad();

			expect(result.audit).toEqual(sampleAudit);
			expect(result.policy).toEqual(samplePolicy);
			expect(result.scanFindings).toHaveLength(2);
			expect(result.scanFindings[0].severity).toBe('critical');
			expect(result.scanFindings[0].issue).toBe('RCE');
			expect(result.scanFindings[0].detected).toBe('2026-03-01T12:00:00Z');
		});

		it('returns projectPath', async () => {
			const result = await callLoad();

			expect(result.projectPath).toBeDefined();
		});

		it('prefers project-specific audit over global', async () => {
			const projectAudit = { ...sampleAudit, score: '5/5' };
			mockedReadJson.mockImplementation(async (path: any) => {
				const p = String(path);
				if (p.includes('test-proj') && p.includes('audit')) return projectAudit;
				if (p.includes('audit')) return sampleAudit;
				if (p.includes('scan') || p.includes('findings')) return sampleScanFile;
				return null;
			});

			const result = await callLoad();
			expect(result.audit).toEqual(projectAudit);
		});
	});

	describe('failure scenarios', () => {
		it('returns null audit when no audit files exist', async () => {
			mockedReadJson.mockResolvedValue(null);
			mockedReadYaml.mockResolvedValue(null);

			const result = await callLoad();

			expect(result.audit).toBeNull();
			expect(result.scanFindings).toEqual([]);
			expect(result.policy).toBeNull();
		});

		it('handles missing findings gracefully', async () => {
			mockedReadJson.mockResolvedValue(null);
			mockedReadYaml.mockResolvedValue(null);

			const result = await callLoad();

			expect(result.scanFindings).toEqual([]);
		});

		it('falls back to root path when project not found', async () => {
			mockedScan.mockResolvedValue([] as any);

			const result = await callLoad();
			expect(result.projectPath).toBeDefined();
		});
	});
});
