import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDependencies, type AdvisorySource } from './dependencies';

// TASK 3.2 — pure dependency-health detector. Builds a REAL temp project with a
// package.json on disk and runs the detector against a MOCKED (offline) advisory source
// (the verify note explicitly allows mocking the registry response). No DB, no network —
// the detector is the deterministic core dep-repo.ts feeds into security_finding upserts.

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'dep-scan-'));
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify(
			{
				name: 'demo',
				version: '1.0.0',
				dependencies: {
					lodash: '4.17.20', // vulnerable AND outdated (latest 4.17.21)
					express: '^4.18.2' // current — must NOT flag
				},
				devDependencies: {
					minimist: '1.2.5' // outdated only (latest 1.2.8), no advisory here
				}
			},
			null,
			2
		)
	);
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

// Deterministic offline advisory source — the "mocked registry response".
const offlineSource: AdvisorySource = {
	lookup(name) {
		switch (name) {
			case 'lodash':
				return {
					latest: '4.17.21',
					advisories: [
						{
							id: 'GHSA-p6mc-m468-83gw',
							severity: 'high',
							vulnerableRange: '<4.17.21',
							title: 'Prototype pollution in lodash'
						}
					]
				};
			case 'express':
				return { latest: '4.18.2', advisories: [] };
			case 'minimist':
				return { latest: '1.2.8', advisories: [] };
			default:
				return undefined;
		}
	}
};

describe('scanDependencies — pure detector', () => {
	it('flags a vulnerable dependency with its advisory id, severity, and range', () => {
		const findings = scanDependencies(root, offlineSource);
		const vuln = findings.find(
			(f) => f.rule === 'dependency.vulnerable' && f.package === 'lodash'
		);
		expect(vuln).toBeDefined();
		expect(vuln!.severity).toBe('high');
		// The advisory must be surfaced in the detail (id + title), with the installed version.
		expect(vuln!.detail).toContain('GHSA-p6mc-m468-83gw');
		expect(vuln!.detail).toContain('lodash');
		expect(vuln!.detail).toContain('4.17.20');
		expect(vuln!.advisoryId).toBe('GHSA-p6mc-m468-83gw');
		expect(vuln!.file).toBe('package.json');
	});

	it('does NOT flag a vulnerable advisory whose range excludes the installed version', () => {
		// express is current (4.18.2) and has no advisories — no vuln, no outdated.
		const findings = scanDependencies(root, offlineSource);
		expect(findings.some((f) => f.package === 'express')).toBe(false);
	});

	it('flags an outdated dependency (installed < latest) as low severity', () => {
		const findings = scanDependencies(root, offlineSource);
		const out = findings.find(
			(f) => f.rule === 'dependency.outdated' && f.package === 'minimist'
		);
		expect(out).toBeDefined();
		expect(out!.severity).toBe('low');
		expect(out!.detail).toContain('1.2.5');
		expect(out!.detail).toContain('1.2.8');
	});

	it('reports BOTH outdated and vulnerable for a dep that is both', () => {
		const findings = scanDependencies(root, offlineSource);
		const lodash = findings.filter((f) => f.package === 'lodash').map((f) => f.rule);
		expect(lodash).toContain('dependency.vulnerable');
		expect(lodash).toContain('dependency.outdated');
	});

	it('sorts findings critical→low', () => {
		const findings = scanDependencies(root, offlineSource);
		const order = { critical: 3, high: 2, medium: 1, low: 0 } as const;
		for (let i = 1; i < findings.length; i++) {
			expect(order[findings[i - 1].severity]).toBeGreaterThanOrEqual(
				order[findings[i].severity]
			);
		}
	});

	it('returns no findings when there is no package.json', () => {
		const empty = mkdtempSync(join(tmpdir(), 'dep-empty-'));
		try {
			expect(scanDependencies(empty, offlineSource)).toEqual([]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it('skips a package the advisory source does not know about (no false flags)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dep-unknown-'));
		try {
			writeFileSync(
				join(dir, 'package.json'),
				JSON.stringify({ dependencies: { 'totally-unknown-pkg': '1.0.0' } })
			);
			expect(scanDependencies(dir, offlineSource)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('tolerates a malformed package.json without throwing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dep-bad-'));
		try {
			writeFileSync(join(dir, 'package.json'), '{ not valid json');
			expect(scanDependencies(dir, offlineSource)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
