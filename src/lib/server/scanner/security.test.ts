import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSecurity, type SecurityFinding } from './security';

// TASK 3.1 — pure security detector. Builds a REAL temp project tree on disk and asserts
// the detector flags the planted issues, ignores the safe/example ones, and skips
// vendored dirs. No DB, no mocks of the filesystem (we use a real temp dir).

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'sec-scan-'));

	// A file with multiple real issues.
	writeFileSync(
		join(root, 'config.ts'),
		[
			'export const region = "us-east-1";',
			'const apiKey = "sk_live_abcdef0123456789";', // generic secret assignment (high)
			'const awsId = "AKIAIOSFODNN7EXAMPLE";', // aws key id (critical)
			'export function run(cmd) { return execSync(cmd); }' // shell sink (high)
		].join('\n')
	);

	// eval sink (medium).
	writeFileSync(join(root, 'danger.js'), 'function f(s){ return eval(s); }');

	// A private key block (critical).
	writeFileSync(
		join(root, 'id_rsa'),
		'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB\n-----END RSA PRIVATE KEY-----\n'
	);
	// id_rsa has no scannable extension on its own; put a .pem instead for the rule.
	writeFileSync(
		join(root, 'key.sh'),
		'#!/bin/sh\n-----BEGIN RSA PRIVATE KEY-----\necho hi\n'
	);

	// Safe references — must NOT flag (no quoted literal, just a property access).
	writeFileSync(
		join(root, 'safe.ts'),
		[
			'const apiKey = config.apiKey;',
			'// const password = "thisisacommentonly12345"',
			'logger.evaluate(value);' // .evaluate must not match eval(
		].join('\n')
	);

	// Example env file — placeholders, must be skipped wholesale.
	writeFileSync(join(root, '.env.example'), 'API_KEY="replace_me_with_real_key_value"');

	// Vendored dir — must be skipped.
	const nm = join(root, 'node_modules', 'pkg');
	mkdirSync(nm, { recursive: true });
	writeFileSync(join(nm, 'leak.ts'), 'const token = "ghp_vendoredsecrettoken123456";');
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

const ruleOf = (fs: SecurityFinding[]) => fs.map((f) => f.rule);

describe('scanSecurity — pure detector', () => {
	it('flags an AWS access key id as critical with file + line', () => {
		const findings = scanSecurity(root);
		const aws = findings.find((f) => f.rule === 'hardcoded-secret.aws-access-key');
		expect(aws).toBeDefined();
		expect(aws!.severity).toBe('critical');
		expect(aws!.file).toBe('config.ts');
		expect(aws!.line).toBe(3);
	});

	it('flags a generic hardcoded secret assignment as high — without leaking the value', () => {
		const findings = scanSecurity(root);
		const f = findings.find((x) => x.rule === 'hardcoded-secret.generic-assignment');
		expect(f).toBeDefined();
		expect(f!.severity).toBe('high');
		// The redacted detail must NOT contain the secret value.
		expect(f!.detail).not.toContain('sk_live_abcdef0123456789');
		expect(f!.detail.toLowerCase()).toContain('redacted');
	});

	it('flags the shell-spawning child_process call as high', () => {
		const findings = scanSecurity(root);
		expect(ruleOf(findings)).toContain('dangerous-sink.child-process-shell');
	});

	it('flags eval() as medium but ignores a .evaluate() method call', () => {
		const findings = scanSecurity(root);
		const evals = findings.filter((f) => f.rule === 'dangerous-sink.eval');
		expect(evals.length).toBe(1);
		expect(evals[0].file).toBe('danger.js');
	});

	it('flags a private key block as critical', () => {
		const findings = scanSecurity(root);
		expect(ruleOf(findings)).toContain('hardcoded-secret.private-key');
	});

	it('does NOT flag a safe property reference or a comment-only line', () => {
		const findings = scanSecurity(root);
		const fromSafe = findings.filter((f) => f.file === 'safe.ts');
		expect(fromSafe).toEqual([]);
	});

	it('skips .env.example placeholders and vendored node_modules', () => {
		const findings = scanSecurity(root);
		expect(findings.some((f) => f.file.includes('.env.example'))).toBe(false);
		expect(findings.some((f) => f.file.includes('node_modules'))).toBe(false);
	});

	it('sorts findings critical→low', () => {
		const findings = scanSecurity(root);
		const order = { critical: 3, high: 2, medium: 1, low: 0 } as const;
		for (let i = 1; i < findings.length; i++) {
			expect(order[findings[i - 1].severity]).toBeGreaterThanOrEqual(order[findings[i].severity]);
		}
	});

	it('throws on a non-directory target', () => {
		expect(() => scanSecurity(join(root, 'config.ts'))).toThrow();
	});
});
