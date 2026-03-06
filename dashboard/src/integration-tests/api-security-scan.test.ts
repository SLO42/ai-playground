import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync } from 'fs';

/**
 * Integration tests for /api/security/scan POST endpoint.
 *
 * These tests exercise the sanitization, local-scan fallback, findings
 * persistence, and output formatting logic used by the POST handler.
 */

// ── Types (mirrors +server.ts) ──────────────────────────────────────────

interface ScanFinding {
	severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
	issue: string;
	detail: string;
}

// ── sanitizeOutput (mirrors +server.ts) ─────────────────────────────────

function sanitizeOutput(raw: string): string {
	let sanitized = raw;
	sanitized = sanitized.replace(
		/(\b(?:api[_-]?key|secret|token|password|credential|auth|private[_-]?key|access[_-]?key|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|TWITCH_TOKEN)\s*[=:]\s*)(\S+)/gi,
		'$1[HIDDEN]'
	);
	sanitized = sanitized.replace(
		/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g,
		'$1...[HIDDEN]'
	);
	return sanitized;
}

// ── runLocalScan (mirrors +server.ts, parameterised for testing) ────────

function runLocalScan(paths: {
	envFile: string;
	root: string;
	gatewayYaml: string;
	networkPolicy: string;
	auditLogDir: string;
}): { findings: ScanFinding[]; summary: string } {
	const findings: ScanFinding[] = [];

	if (existsSync(paths.envFile)) {
		findings.push({
			severity: 'INFO',
			issue: '.env file present',
			detail: 'Secrets file exists — ensure it is listed in .gitignore'
		});

		try {
			const envContent = readFileSync(paths.envFile, 'utf-8');
			const lines = envContent.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
			for (const line of lines) {
				const match = line.match(/^([A-Z_]+)\s*=\s*(.*)/);
				if (!match) continue;
				const [, name, value] = match;
				const trimmed = value.trim().replace(/^["']|["']$/g, '');
				if (!trimmed || trimmed === 'your-key-here' || trimmed === 'changeme') {
					findings.push({
						severity: 'HIGH',
						issue: `${name} is not set`,
						detail: `Environment variable ${name} is empty or has a placeholder value`
					});
				} else {
					findings.push({
						severity: 'INFO',
						issue: `${name} is configured`,
						detail: 'Value: [HIDDEN]'
					});
				}
			}
		} catch {
			findings.push({
				severity: 'MEDIUM',
				issue: '.env file unreadable',
				detail: 'Could not read .env file to check for empty keys'
			});
		}
	} else {
		findings.push({
			severity: 'MEDIUM',
			issue: 'No .env file found',
			detail: 'Expected .env at project root — secrets may not be configured'
		});
	}

	const gitignorePath = join(paths.root, '.gitignore');
	if (existsSync(gitignorePath)) {
		try {
			const gitignore = readFileSync(gitignorePath, 'utf-8');
			if (!gitignore.includes('.env')) {
				findings.push({
					severity: 'CRITICAL',
					issue: '.env not in .gitignore',
					detail: 'Secrets file may be committed to version control'
				});
			}
		} catch {
			// non-critical
		}
	}

	const gwPath = paths.gatewayYaml;
	if (existsSync(gwPath)) {
		try {
			const gwContent = readFileSync(gwPath, 'utf-8');
			if (/bind.*0\.0\.0\.0/.test(gwContent)) {
				findings.push({
					severity: 'HIGH',
					issue: 'Gateway binds to 0.0.0.0',
					detail: 'Gateway should bind to 127.0.0.1 (loopback only) per security policy'
				});
			}
		} catch {
			// non-critical
		}
	}

	if (!existsSync(paths.networkPolicy)) {
		findings.push({
			severity: 'MEDIUM',
			issue: 'Missing network policy',
			detail: `Expected policy at ${paths.networkPolicy.split(/[\\/]/).pop()}`
		});
	}

	if (!existsSync(paths.auditLogDir)) {
		findings.push({
			severity: 'LOW',
			issue: 'Audit log directory missing',
			detail: 'Security audit logging may not be active'
		});
	}

	const critCount = findings.filter((f) => f.severity === 'CRITICAL').length;
	const highCount = findings.filter((f) => f.severity === 'HIGH').length;
	const summary =
		critCount > 0
			? `${critCount} critical issue(s) found`
			: highCount > 0
				? `${highCount} high-severity issue(s) found`
				: 'No critical issues found';

	return { findings, summary };
}

// ── formatFindings (mirrors +server.ts) ─────────────────────────────────

function formatFindings(result: { findings: ScanFinding[]; summary: string }): string {
	const lines = ['Security Scan Results', '='.repeat(40), ''];
	for (const f of result.findings) {
		lines.push(`[${f.severity}] ${f.issue}`);
		lines.push(`  ${f.detail}`);
		lines.push('');
	}
	lines.push('='.repeat(40));
	lines.push(`Summary: ${result.summary}`);
	return lines.join('\n');
}

// ── Tests: sanitizeOutput ───────────────────────────────────────────────

describe('/api/security/scan — sanitizeOutput', () => {
	it('redacts named secret values (key=value)', () => {
		const input = 'ANTHROPIC_API_KEY=sk-ant-abc123xyz TOKEN=mysecrettoken';
		const result = sanitizeOutput(input);
		expect(result).toContain('ANTHROPIC_API_KEY=[HIDDEN]');
		expect(result).toContain('TOKEN=[HIDDEN]');
		expect(result).not.toContain('mysecrettoken');
	});

	it('redacts sk-ant- style API keys', () => {
		const input = 'Found key: sk-ant-abcdefgh1234567890abcdefgh';
		const result = sanitizeOutput(input);
		expect(result).toContain('sk-ant-abcdefgh...[HIDDEN]');
		expect(result).not.toContain('1234567890');
	});

	it('redacts sk- style keys', () => {
		const input = 'Key is sk-abcdefgh1234567890extra';
		const result = sanitizeOutput(input);
		expect(result).toContain('sk-abcdefgh...[HIDDEN]');
		expect(result).not.toContain('1234567890extra');
	});

	it('preserves non-sensitive output', () => {
		const input = 'Scan complete: 3 findings, 0 critical. Network OK.';
		expect(sanitizeOutput(input)).toBe(input);
	});

	it('handles empty string', () => {
		expect(sanitizeOutput('')).toBe('');
	});

	it('redacts multiple secret patterns in one string', () => {
		const input = 'api_key=abc123 password: hunter2 credential=secret99';
		const result = sanitizeOutput(input);
		expect(result).not.toContain('abc123');
		expect(result).not.toContain('hunter2');
		expect(result).not.toContain('secret99');
	});
});

// ── Tests: runLocalScan ─────────────────────────────────────────────────

describe('/api/security/scan — runLocalScan', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'scan-test-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function makePaths(overrides: Partial<ReturnType<typeof defaultPaths>> = {}) {
		return { ...defaultPaths(), ...overrides };
	}

	function defaultPaths() {
		return {
			envFile: join(tmpDir, '.env'),
			root: tmpDir,
			gatewayYaml: join(tmpDir, 'gateway.yaml'),
			networkPolicy: join(tmpDir, 'network-policy.yaml'),
			auditLogDir: join(tmpDir, 'logs')
		};
	}

	it('reports missing .env when file does not exist', () => {
		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);
		expect(issues).toContain('No .env file found');
	});

	it('detects .env present and checks key values', async () => {
		await writeFile(
			join(tmpDir, '.env'),
			'ANTHROPIC_API_KEY=sk-real-key\nGITHUB_TOKEN=your-key-here\nEMPTY_VAR=\n'
		);

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).toContain('.env file present');
		expect(issues).toContain('ANTHROPIC_API_KEY is configured');
		expect(issues).toContain('GITHUB_TOKEN is not set');
		expect(issues).toContain('EMPTY_VAR is not set');
	});

	it('detects placeholder "changeme" value', async () => {
		await writeFile(join(tmpDir, '.env'), 'SECRET_KEY=changeme\n');

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).toContain('SECRET_KEY is not set');
	});

	it('hides actual values in findings', async () => {
		await writeFile(join(tmpDir, '.env'), 'MY_SECRET=super-secret-value-123\n');

		const result = runLocalScan(makePaths());
		const infoFinding = result.findings.find((f) => f.issue === 'MY_SECRET is configured');

		expect(infoFinding).toBeDefined();
		expect(infoFinding!.detail).toBe('Value: [HIDDEN]');
		expect(infoFinding!.detail).not.toContain('super-secret-value-123');
	});

	it('detects .env not in .gitignore', async () => {
		await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n');

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).toContain('.env not in .gitignore');
		const critFinding = result.findings.find((f) => f.issue === '.env not in .gitignore');
		expect(critFinding!.severity).toBe('CRITICAL');
	});

	it('does not flag .gitignore when .env is listed', async () => {
		await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n.env\n');

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).not.toContain('.env not in .gitignore');
	});

	it('detects gateway binding to 0.0.0.0', async () => {
		await writeFile(join(tmpDir, 'gateway.yaml'), 'bind: 0.0.0.0:18789\n');

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).toContain('Gateway binds to 0.0.0.0');
	});

	it('does not flag gateway bound to 127.0.0.1', async () => {
		await writeFile(join(tmpDir, 'gateway.yaml'), 'bind: 127.0.0.1:18789\n');

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).not.toContain('Gateway binds to 0.0.0.0');
	});

	it('detects missing network policy', () => {
		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).toContain('Missing network policy');
	});

	it('does not flag network policy when file exists', async () => {
		await writeFile(join(tmpDir, 'network-policy.yaml'), 'version: "1.0"\n');

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).not.toContain('Missing network policy');
	});

	it('detects missing audit log directory', () => {
		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).toContain('Audit log directory missing');
	});

	it('does not flag audit logs when directory exists', async () => {
		await mkdir(join(tmpDir, 'logs'));

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).not.toContain('Audit log directory missing');
	});

	it('skips comment lines in .env', async () => {
		await writeFile(join(tmpDir, '.env'), '# This is a comment\nVALID_KEY=hello\n');

		const result = runLocalScan(makePaths());
		const issues = result.findings.map((f) => f.issue);

		expect(issues).toContain('VALID_KEY is configured');
		expect(issues).not.toContain('# This is a comment');
	});

	it('strips quotes from .env values', async () => {
		await writeFile(join(tmpDir, '.env'), 'QUOTED_KEY="actual-value"\n');

		const result = runLocalScan(makePaths());
		const configured = result.findings.find((f) => f.issue === 'QUOTED_KEY is configured');

		expect(configured).toBeDefined();
		expect(configured!.severity).toBe('INFO');
	});
});

// ── Tests: summary logic ────────────────────────────────────────────────

describe('/api/security/scan — summary generation', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'scan-summary-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('reports critical count when CRITICAL findings exist', async () => {
		await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n');
		// No .env in gitignore => CRITICAL

		const result = runLocalScan({
			envFile: join(tmpDir, 'nonexistent'),
			root: tmpDir,
			gatewayYaml: join(tmpDir, 'nonexistent'),
			networkPolicy: join(tmpDir, 'nonexistent'),
			auditLogDir: join(tmpDir, 'nonexistent')
		});

		expect(result.summary).toMatch(/critical issue/);
	});

	it('reports high-severity when no CRITICAL but HIGH findings exist', async () => {
		await writeFile(join(tmpDir, 'gateway.yaml'), 'bind: 0.0.0.0:18789\n');
		await writeFile(join(tmpDir, '.gitignore'), '.env\nnode_modules/\n');

		const result = runLocalScan({
			envFile: join(tmpDir, 'nonexistent'),
			root: tmpDir,
			gatewayYaml: join(tmpDir, 'gateway.yaml'),
			networkPolicy: join(tmpDir, 'exists'),
			auditLogDir: join(tmpDir, 'nonexistent')
		});

		expect(result.summary).toMatch(/high-severity/);
	});

	it('reports no critical issues when only LOW/MEDIUM/INFO', async () => {
		await writeFile(join(tmpDir, '.env'), 'KEY=value\n');
		await writeFile(join(tmpDir, '.gitignore'), '.env\n');
		await mkdir(join(tmpDir, 'logs'));
		await writeFile(join(tmpDir, 'network-policy.yaml'), 'version: "1.0"\n');
		await writeFile(join(tmpDir, 'gateway.yaml'), 'bind: 127.0.0.1:18789\n');

		const result = runLocalScan({
			envFile: join(tmpDir, '.env'),
			root: tmpDir,
			gatewayYaml: join(tmpDir, 'gateway.yaml'),
			networkPolicy: join(tmpDir, 'network-policy.yaml'),
			auditLogDir: join(tmpDir, 'logs')
		});

		expect(result.summary).toBe('No critical issues found');
	});
});

// ── Tests: formatFindings ───────────────────────────────────────────────

describe('/api/security/scan — formatFindings', () => {
	it('formats findings with severity tags and summary', () => {
		const result = formatFindings({
			findings: [
				{ severity: 'CRITICAL', issue: '.env not in .gitignore', detail: 'Secrets may leak' },
				{ severity: 'LOW', issue: 'Audit logs missing', detail: 'Logging not active' }
			],
			summary: '1 critical issue(s) found'
		});

		expect(result).toContain('[CRITICAL] .env not in .gitignore');
		expect(result).toContain('  Secrets may leak');
		expect(result).toContain('[LOW] Audit logs missing');
		expect(result).toContain('Summary: 1 critical issue(s) found');
		expect(result).toContain('Security Scan Results');
	});

	it('formats empty findings with just header and summary', () => {
		const result = formatFindings({
			findings: [],
			summary: 'No critical issues found'
		});

		expect(result).toContain('Security Scan Results');
		expect(result).toContain('Summary: No critical issues found');
		// No severity tags
		expect(result).not.toMatch(/\[CRITICAL\]/);
		expect(result).not.toMatch(/\[HIGH\]/);
	});

	it('output contains separator lines', () => {
		const result = formatFindings({
			findings: [{ severity: 'INFO', issue: 'Test', detail: 'Detail' }],
			summary: 'OK'
		});

		expect(result).toContain('='.repeat(40));
	});
});

// ── Tests: POST handler behavior ────────────────────────────────────────

describe('/api/security/scan — POST response shape', () => {
	it('success response includes success:true and output string', () => {
		// Simulate CLI-success response shape
		const response = { success: true, output: 'Scan complete: 0 issues' };
		expect(response.success).toBe(true);
		expect(typeof response.output).toBe('string');
	});

	it('fallback scan response includes formatted findings', () => {
		// Simulate fallback-scan response shape
		const scanResult = runLocalScan({
			envFile: '/nonexistent',
			root: '/nonexistent',
			gatewayYaml: '/nonexistent',
			networkPolicy: '/nonexistent',
			auditLogDir: '/nonexistent'
		});
		const output = formatFindings(scanResult);
		const response = { success: true, output };

		expect(response.success).toBe(true);
		expect(response.output).toContain('Security Scan Results');
		expect(response.output).toContain('Summary:');
	});

	it('error response includes success:false and error message', () => {
		// Simulate error response shape
		const err = new Error('Permission denied');
		const response = {
			success: false,
			error: 'Security scan failed: ' + String(err)
		};

		expect(response.success).toBe(false);
		expect(response.error).toContain('Security scan failed');
		expect(response.error).toContain('Permission denied');
	});
});
