/**
 * Dependency Health — vulnerability auditing and outdated package detection.
 *
 * Detects project type (npm, pip, cargo, dotnet), runs the appropriate audit
 * and outdated commands, and returns unified results. Never throws — returns
 * empty/default results on failure.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

// ── Types ──────────────────────────────────────────────────────────────

export interface Vulnerability {
	package: string;
	severity: 'critical' | 'high' | 'moderate' | 'low' | 'info';
	title: string;
	url: string | null;
	fixAvailable: boolean;
}

export interface AuditResult {
	projectType: string;
	vulnerabilities: Vulnerability[];
	totalDependencies: number;
	lastChecked: string;
}

export interface OutdatedPackage {
	name: string;
	current: string;
	wanted: string;
	latest: string;
	type: 'dependencies' | 'devDependencies';
}

export interface DependencyHealth {
	projectType: string;
	audit: AuditResult;
	outdated: OutdatedPackage[];
	summary: {
		total: number;
		vulnerable: number;
		outdated: number;
		critical: number;
		high: number;
	};
	lastChecked: string;
}

// ── Constants ──────────────────────────────────────────────────────────

type ProjectType = 'npm' | 'pip' | 'cargo' | 'dotnet' | 'unknown';

const SEVERITY_SET = new Set(['critical', 'high', 'moderate', 'low', 'info']);

const EXEC_OPTS = { encoding: 'utf-8' as const, windowsHide: true, shell: true };

// ── Helpers ────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string, timeout = 15_000): string {
	return execSync(`${cmd} 2>&1`, { ...EXEC_OPTS, cwd, timeout });
}

function detectProjectType(projectPath: string): ProjectType {
	if (existsSync(resolve(projectPath, 'package.json'))) return 'npm';
	if (existsSync(resolve(projectPath, 'requirements.txt'))) return 'pip';
	if (existsSync(resolve(projectPath, 'Cargo.toml'))) return 'cargo';
	try {
		if (run('dir /b *.csproj 2>nul || ls *.csproj 2>/dev/null', projectPath, 5_000).trim()) {
			return 'dotnet';
		}
	} catch { /* no csproj */ }
	return 'unknown';
}

function json(raw: string): unknown {
	try { return JSON.parse(raw); } catch { return null; }
}

function severity(value: string | undefined): Vulnerability['severity'] {
	if (!value) return 'info';
	const lower = value.toLowerCase();
	if (SEVERITY_SET.has(lower)) return lower as Vulnerability['severity'];
	if (lower === 'warning') return 'low';
	return 'info';
}

function emptyAudit(projectType: string): AuditResult {
	return { projectType, vulnerabilities: [], totalDependencies: 0, lastChecked: new Date().toISOString() };
}

// ── npm ────────────────────────────────────────────────────────────────

function auditNpm(cwd: string): AuditResult {
	const result = emptyAudit('npm');
	try {
		const data = json(run('npm audit --json', cwd, 30_000)) as Record<string, unknown> | null;
		if (!data) return result;

		const vulns = data.vulnerabilities as Record<string, {
			name?: string; severity?: string; title?: string; url?: string;
			fixAvailable?: boolean | object;
			via?: Array<{ title?: string; url?: string }>;
		}> | undefined;

		if (vulns && typeof vulns === 'object') {
			for (const [pkgName, info] of Object.entries(vulns)) {
				let title = info.title ?? '';
				let url: string | null = info.url ?? null;
				if (!title && Array.isArray(info.via)) {
					const adv = info.via.find((v) => typeof v === 'object' && v.title);
					if (adv) { title = adv.title ?? ''; url = adv.url ?? null; }
				}
				result.vulnerabilities.push({
					package: info.name ?? pkgName, severity: severity(info.severity),
					title: title || `Vulnerability in ${pkgName}`, url,
					fixAvailable: typeof info.fixAvailable === 'boolean' ? info.fixAvailable : !!info.fixAvailable
				});
			}
		}
		const meta = data.metadata as { totalDependencies?: number } | undefined;
		result.totalDependencies = meta?.totalDependencies ?? 0;
	} catch { /* audit not available */ }
	result.lastChecked = new Date().toISOString();
	return result;
}

function outdatedNpm(cwd: string): OutdatedPackage[] {
	try {
		const data = json(run('npm outdated --json', cwd)) as Record<string, {
			current?: string; wanted?: string; latest?: string; type?: string;
		}> | null;
		if (!data || typeof data !== 'object') return [];
		return Object.entries(data).map(([name, info]) => ({
			name, current: info.current ?? 'unknown', wanted: info.wanted ?? 'unknown',
			latest: info.latest ?? 'unknown',
			type: info.type === 'devDependencies' ? 'devDependencies' as const : 'dependencies' as const
		}));
	} catch { return []; }
}

// ── pip ────────────────────────────────────────────────────────────────

function auditPip(cwd: string): AuditResult {
	const result = emptyAudit('pip');
	try {
		const data = json(run('pip audit --format json', cwd, 30_000)) as {
			dependencies?: unknown[]; vulnerabilities?: Array<{
				name?: string; id?: string; description?: string; fix_versions?: string[];
			}>;
		} | null;
		if (!data) return result;
		result.totalDependencies = data.dependencies?.length ?? 0;
		for (const v of data.vulnerabilities ?? []) {
			const id = v.id ?? '';
			result.vulnerabilities.push({
				package: v.name ?? 'unknown', severity: 'moderate',
				title: v.description ?? `Vulnerability ${id}`,
				url: id.startsWith('PYSEC-') ? `https://osv.dev/vulnerability/${id}`
					: id.startsWith('CVE-') ? `https://nvd.nist.gov/vuln/detail/${id}` : null,
				fixAvailable: Array.isArray(v.fix_versions) && v.fix_versions.length > 0
			});
		}
	} catch { /* pip audit not installed */ }
	result.lastChecked = new Date().toISOString();
	return result;
}

function outdatedPip(cwd: string): OutdatedPackage[] {
	try {
		const data = json(run('pip list --outdated --format json', cwd)) as Array<{
			name?: string; version?: string; latest_version?: string;
		}> | null;
		if (!Array.isArray(data)) return [];
		return data.map((p) => ({
			name: p.name ?? 'unknown', current: p.version ?? 'unknown',
			wanted: p.latest_version ?? 'unknown', latest: p.latest_version ?? 'unknown',
			type: 'dependencies' as const
		}));
	} catch { return []; }
}

// ── cargo ──────────────────────────────────────────────────────────────

function auditCargo(cwd: string): AuditResult {
	const result = emptyAudit('cargo');
	try {
		const data = json(run('cargo audit --json', cwd, 30_000)) as {
			vulnerabilities?: { list?: Array<{
				advisory?: { id?: string; title?: string; url?: string; severity?: string; package?: string };
				package?: { name?: string }; versions?: { patched?: string[] };
			}>; };
		} | null;
		for (const entry of data?.vulnerabilities?.list ?? []) {
			const adv = entry.advisory;
			result.vulnerabilities.push({
				package: entry.package?.name ?? adv?.package ?? 'unknown',
				severity: severity(adv?.severity),
				title: adv?.title ?? `Vulnerability ${adv?.id ?? ''}`,
				url: adv?.url ?? null,
				fixAvailable: (entry.versions?.patched?.length ?? 0) > 0
			});
		}
	} catch { /* cargo-audit not installed */ }
	result.lastChecked = new Date().toISOString();
	return result;
}

function outdatedCargo(cwd: string): OutdatedPackage[] {
	try {
		const raw = run('cargo outdated --root-deps-only', cwd);
		const lines = raw.split('\n').filter((l) => l.trim() && !l.startsWith('Name') && !l.startsWith('-'));
		return lines.map((line) => {
			const p = line.trim().split(/\s{2,}/);
			return p.length >= 4 ? {
				name: p[0], current: p[1], wanted: p[2] ?? p[1], latest: p[3],
				type: p[4]?.toLowerCase().includes('dev') ? 'devDependencies' as const : 'dependencies' as const
			} : null;
		}).filter((x): x is OutdatedPackage => x !== null);
	} catch { return []; }
}

// ── dotnet ─────────────────────────────────────────────────────────────

/** Extract packages from dotnet's nested project→framework→package JSON. */
function dotnetPackages(raw: string): Array<{ id: string; version: string; severity?: string; url?: string; latest?: string }> {
	const data = json(raw) as { projects?: Array<{ frameworks?: Array<{ topLevelPackages?: Array<Record<string, string>> }>; }>; } | null;
	const out: Array<{ id: string; version: string; severity?: string; url?: string; latest?: string }> = [];
	for (const proj of data?.projects ?? []) {
		for (const fw of proj.frameworks ?? []) {
			for (const pkg of fw.topLevelPackages ?? []) {
				out.push({
					id: pkg.id ?? 'unknown', version: pkg.resolvedVersion ?? 'unknown',
					severity: pkg.severity, url: pkg.advisoryurl, latest: pkg.latestVersion
				});
			}
		}
	}
	return out;
}

function auditDotnet(cwd: string): AuditResult {
	const result = emptyAudit('dotnet');
	try {
		const pkgs = dotnetPackages(run('dotnet list package --vulnerable --format json', cwd, 30_000));
		for (const pkg of pkgs) {
			result.vulnerabilities.push({
				package: pkg.id, severity: severity(pkg.severity),
				title: `Vulnerability in ${pkg.id} ${pkg.version}`.trim(),
				url: pkg.url ?? null, fixAvailable: false
			});
		}
	} catch { /* dotnet CLI not available */ }
	result.lastChecked = new Date().toISOString();
	return result;
}

function outdatedDotnet(cwd: string): OutdatedPackage[] {
	try {
		return dotnetPackages(run('dotnet list package --outdated --format json', cwd)).map((pkg) => ({
			name: pkg.id, current: pkg.version, wanted: pkg.latest ?? 'unknown',
			latest: pkg.latest ?? 'unknown', type: 'dependencies' as const
		}));
	} catch { return []; }
}

// ── Dispatch tables ────────────────────────────────────────────────────

const AUDIT: Record<string, (cwd: string) => AuditResult> = {
	npm: auditNpm, pip: auditPip, cargo: auditCargo, dotnet: auditDotnet
};

const OUTDATED: Record<string, (cwd: string) => OutdatedPackage[]> = {
	npm: outdatedNpm, pip: outdatedPip, cargo: outdatedCargo, dotnet: outdatedDotnet
};

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Run a vulnerability audit for the project at `projectPath`.
 *
 * Detects the project type from marker files (package.json, requirements.txt,
 * Cargo.toml, *.csproj) and runs the appropriate audit command.
 * Returns an empty result if the project type is unknown or the tool fails.
 */
export async function auditDependencies(projectPath: string): Promise<AuditResult> {
	const type = detectProjectType(projectPath);
	return AUDIT[type]?.(projectPath) ?? emptyAudit(type);
}

/**
 * Check for outdated packages in the project at `projectPath`.
 *
 * Returns a list of packages with current, wanted, and latest versions.
 * Returns an empty list if the project type is unknown or the tool fails.
 */
export async function checkOutdated(projectPath: string): Promise<OutdatedPackage[]> {
	const type = detectProjectType(projectPath);
	return OUTDATED[type]?.(projectPath) ?? [];
}

/**
 * Get a combined dependency health summary for the project at `projectPath`.
 *
 * Runs both audit and outdated checks, then produces a summary with counts
 * by severity level.
 */
export async function getDependencyHealth(projectPath: string): Promise<DependencyHealth> {
	const type = detectProjectType(projectPath);
	const now = new Date().toISOString();

	const audit = AUDIT[type]?.(projectPath) ?? emptyAudit(type);
	const outdated = OUTDATED[type]?.(projectPath) ?? [];

	return {
		projectType: type,
		audit,
		outdated,
		summary: {
			total: audit.totalDependencies,
			vulnerable: audit.vulnerabilities.length,
			outdated: outdated.length,
			critical: audit.vulnerabilities.filter((v) => v.severity === 'critical').length,
			high: audit.vulnerabilities.filter((v) => v.severity === 'high').length
		},
		lastChecked: now
	};
}
