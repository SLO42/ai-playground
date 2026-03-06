import { json } from '@sveltejs/kit';
import { execCli } from '$lib/server/cli-executor.js';
import { PATHS } from '$lib/server/constants.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, basename, dirname } from 'path';

/** Patterns that look like secrets/keys/tokens in CLI output */
const SENSITIVE_PATTERNS = [
	// Key=value pairs where the key suggests a secret
	/(\b(?:api[_-]?key|secret|token|password|credential|auth|private[_-]?key|access[_-]?key)\s*[=:]\s*)(\S+)/gi,
	// Bare long hex/base64 strings (likely keys)
	/\b([A-Za-z0-9+/]{32,}={0,2})\b/g,
	// sk-ant-... or sk-... style API keys
	/\b(sk-(?:ant-)?[A-Za-z0-9-]{20,})\b/g,
];

/** Redact sensitive values from scan output, keeping the variable/key name visible */
function sanitizeOutput(raw: string): string {
	let sanitized = raw;
	// Named secrets: keep the name, hide the value
	sanitized = sanitized.replace(
		/(\b(?:api[_-]?key|secret|token|password|credential|auth|private[_-]?key|access[_-]?key|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|TWITCH_TOKEN)\s*[=:]\s*)(\S+)/gi,
		'$1[HIDDEN]'
	);
	// sk-ant / sk- style keys anywhere
	sanitized = sanitized.replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1...[HIDDEN]');
	return sanitized;
}

interface ScanFinding {
	severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
	issue: string;
	detail: string;
}

/** Fallback: run a basic local security check when the CLI isn't available */
function runLocalScan(): { findings: ScanFinding[]; summary: string } {
	const findings: ScanFinding[] = [];

	// Check .env exists and isn't tracked by git
	const envPath = PATHS.envFile;
	if (existsSync(envPath)) {
		findings.push({
			severity: 'INFO',
			issue: '.env file present',
			detail: 'Secrets file exists — ensure it is listed in .gitignore'
		});

		// Check for placeholder or empty keys
		try {
			const envContent = readFileSync(envPath, 'utf-8');
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
					// Key is set — report it exists but hide the value
					findings.push({
						severity: 'INFO',
						issue: `${name} is configured`,
						detail: `Value: [HIDDEN]`
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

	// Check .gitignore includes .env
	const gitignorePath = resolve(PATHS.root, '.gitignore');
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

	// Check gateway config binds to loopback
	const gwPath = PATHS.gatewayYaml;
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

	// Check network policy exists
	if (!existsSync(PATHS.networkPolicy)) {
		findings.push({
			severity: 'MEDIUM',
			issue: 'Missing network policy',
			detail: `Expected policy at ${basename(PATHS.networkPolicy)}`
		});
	}

	// Check audit log directory
	const auditLogDir = resolve(PATHS.root, '.claude-flow/logs');
	if (!existsSync(auditLogDir)) {
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

export async function POST() {
	try {
		// Try CLI scan first
		const raw = execCli(['security', 'scan'], 30000);
		const sanitized = sanitizeOutput(raw);
		return json({ success: true, output: sanitized });
	} catch {
		// CLI unavailable — run local fallback scan
		try {
			const result = runLocalScan();
			saveScanFindings(result.findings);
			return json({ success: true, output: formatFindings(result) });
		} catch (err) {
			return json(
				{ success: false, error: 'Security scan failed: ' + String(err) },
				{ status: 500 }
			);
		}
	}
}

function saveScanFindings(findings: ScanFinding[]): void {
	try {
		const dir = dirname(PATHS.scanFindings);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const payload = {
			scannedAt: new Date().toISOString(),
			findings: findings.map((f) => ({
				severity: f.severity,
				issue: f.issue,
				detail: f.detail
			}))
		};
		writeFileSync(PATHS.scanFindings, JSON.stringify(payload, null, 2));
	} catch {
		// Non-critical — page will fall back to additionalFixes parsing
	}
}

function formatFindings(result: { findings: ScanFinding[]; summary: string }): string {
	const lines = [`Security Scan Results`, `${'='.repeat(40)}`, ''];
	for (const f of result.findings) {
		lines.push(`[${f.severity}] ${f.issue}`);
		lines.push(`  ${f.detail}`);
		lines.push('');
	}
	lines.push(`${'='.repeat(40)}`);
	lines.push(`Summary: ${result.summary}`);
	return lines.join('\n');
}
