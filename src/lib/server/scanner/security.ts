// TASK 3.1 — security scan (pure detector; ARCHITECTURE §2.7 / PRODUCT job 4 / ROADMAP 3.1).
//
// Pure, filesystem-reading security scan: given a directory, walk its source files
// (bounded depth, skip vendored/build dirs) and flag security issues against a small
// rule set — hardcoded secrets (API keys / tokens / private keys), known dangerous
// sinks (eval / child_process with shell). NO database, NO process spawn, NO network —
// this is the deterministic core that findings-repo.ts feeds into `security_finding`
// upserts. Mirrors the detect.ts split (pure detector + db-backed registry).
//
// Each match becomes a {rule, severity, file, line, detail} candidate. severity ∈
// the DATA-MODEL §4.9 enum ["low","medium","high","critical"]. `file` is a path
// RELATIVE to the scanned dir (stable across machines; the absolute root lives on the
// project row). NO secret VALUE is ever stored in `detail` — only the rule + a
// redacted location, so a finding row never leaks the very secret it reports.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';

/** DATA-MODEL §4.9 severity enum. */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** One security issue found in a file (pre-persist; no DB id yet). */
export interface SecurityFinding {
	/** Stable rule id (e.g. "hardcoded-secret.aws-key"). */
	rule: string;
	severity: Severity;
	/** Path relative to the scanned dir, POSIX separators (stable across machines). */
	file: string;
	/** 1-based line number of the match. */
	line: number;
	/** Human detail — NEVER contains the secret value itself (redacted). */
	detail: string;
}

/** A single source-pattern rule evaluated line-by-line. */
interface PatternRule {
	rule: string;
	severity: Severity;
	/** RegExp tested against each line (use a non-global clone per test). */
	pattern: RegExp;
	/** Human description of what was matched (no captured secret leaks in). */
	describe: (match: RegExpMatchArray) => string;
}

/**
 * The rule set. Deliberately small + high-signal — this is a heuristic scanner, not a
 * full SAST engine; it surfaces the classic "committed a secret / shell-injection sink"
 * issues a project lead wants on the Maintain surface. Each `detail` is constructed to
 * REDACT the matched secret (we report the kind, never the value — F-008 + no-secrets).
 */
const RULES: PatternRule[] = [
	{
		rule: 'hardcoded-secret.aws-access-key',
		severity: 'critical',
		// AWS access key ids are a fixed AKIA/ASIA prefix + 16 base32 chars.
		pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
		describe: () => 'Possible AWS access key id committed in source.'
	},
	{
		rule: 'hardcoded-secret.private-key',
		severity: 'critical',
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
		describe: () => 'Private key block committed in source.'
	},
	{
		rule: 'hardcoded-secret.generic-assignment',
		severity: 'high',
		// `apiKey = "…"`, `secret: '…'`, `password="…"`, `token = `…`` — a quoted literal
		// of ≥12 chars assigned to a secret-named identifier. Quote required so we don't
		// flag `const apiKey = config.apiKey` (a reference, not a literal).
		pattern:
			/\b(?:api[_-]?key|secret|passwd|password|token|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"`][^'"`\s]{12,}['"`]/i,
		describe: (m) => {
			const id = /\b([a-z_]*(?:key|secret|passwd|password|token)[a-z_]*)\b/i.exec(m[0]);
			return `Hardcoded credential assigned to "${id?.[1] ?? 'secret'}" (value redacted).`;
		}
	},
	{
		rule: 'dangerous-sink.eval',
		severity: 'medium',
		// eval( … ) on its own (not `.eval`-suffixed method names, not a comment-only line
		// handled by the comment skip below).
		pattern: /(?<![.\w])eval\s*\(/,
		describe: () => 'Use of eval() — code-injection sink.'
	},
	{
		rule: 'dangerous-sink.child-process-shell',
		severity: 'high',
		// exec(...) / execSync(...) (the shell-spawning child_process APIs). spawn with an
		// array is safe and intentionally NOT matched (F-001/F-002 prefer execFile arrays).
		pattern: /\b(?:exec|execSync)\s*\(/,
		describe: () => 'Shell-spawning child_process call — command-injection risk if input is interpolated.'
	}
];

/** Source extensions worth scanning. Binary/asset files are skipped wholesale. */
const SCAN_EXT = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.py', '.rb', '.go', '.rs', '.java', '.cs',
	'.json', '.json5', '.yaml', '.yml', '.toml', '.env', '.sh', '.ps1'
]);

/** Directories never worth scanning (vendored / build / vcs). */
const SKIP_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'target', 'bin', 'obj',
	'.svelte-kit', 'coverage', '.next', 'vendor', '__pycache__'
]);

/** Files whose contents are example placeholders, not live secrets (never flag). */
const SKIP_FILES = new Set(['.env.example', '.env.sample', '.env.template']);

export interface SecurityScanOptions {
	/** Max directory recursion depth (default 8). */
	maxDepth?: number;
	/** Max file size to read, in bytes (default 1 MiB — skip large/generated files). */
	maxFileBytes?: number;
}

/** True for a line that is purely a single-line comment (skip — reduces false positives). */
function isCommentOnly(line: string): boolean {
	const t = line.trim();
	return t.startsWith('//') || t.startsWith('#') || t.startsWith('*');
}

/**
 * Scan a directory tree for security findings (PURE — no DB/spawn/network). Returns
 * findings sorted by severity (critical→low) then file/line. Throws if `dir` is not a
 * readable directory. Callers MUST path-confine `dir` under CODE_ROOT first (the
 * findings-repo entry does this via the reused scanner/registry confineToRoot).
 */
export function scanSecurity(dir: string, opts: SecurityScanOptions = {}): SecurityFinding[] {
	const stat = statSync(dir); // throws ENOENT/ENOTDIR — caller validates path first
	if (!stat.isDirectory()) throw new Error(`Not a directory: ${dir}`);

	const maxDepth = opts.maxDepth ?? 8;
	const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
	const findings: SecurityFinding[] = [];

	const walk = (d: string, depth: number): void => {
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return; // unreadable dir — skip, don't fail the whole scan
		}
		for (const name of entries) {
			const lower = name.toLowerCase();
			const child = join(d, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(child);
			} catch {
				continue; // broken symlink / race — skip
			}
			if (st.isDirectory()) {
				if (depth < maxDepth && !SKIP_DIRS.has(lower)) walk(child, depth + 1);
				continue;
			}
			if (!st.isFile()) continue;
			if (SKIP_FILES.has(lower)) continue;
			// Scan .env (no ext) and any known source extension; skip everything else.
			if (lower !== '.env' && !SCAN_EXT.has(extname(lower))) continue;
			if (st.size > maxFileBytes) continue;
			scanFile(child, dir, findings);
		}
	};
	walk(dir, 0);

	findings.sort((a, b) => {
		const sv = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
		if (sv !== 0) return sv;
		const f = a.file.localeCompare(b.file);
		return f !== 0 ? f : a.line - b.line;
	});
	return findings;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** Read one file and append any findings (relative path, POSIX-normalized). */
function scanFile(absFile: string, root: string, out: SecurityFinding[]): void {
	let text: string;
	try {
		text = readFileSync(absFile, 'utf8');
	} catch {
		return; // unreadable — skip
	}
	// Cheap binary guard: a NUL byte means it's not text we should scan.
	if (text.indexOf(String.fromCharCode(0)) !== -1) return;

	const rel = relative(root, absFile).split(sep).join('/');
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isCommentOnly(line)) continue;
		for (const r of RULES) {
			// Fresh test each time (patterns are non-global, so lastIndex is irrelevant,
			// but match() returns the array we hand to describe()).
			const m = line.match(r.pattern);
			if (m) {
				out.push({
					rule: r.rule,
					severity: r.severity,
					file: rel,
					line: i + 1,
					detail: r.describe(m)
				});
			}
		}
	}
}
