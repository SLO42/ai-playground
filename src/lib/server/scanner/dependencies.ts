// TASK 3.2 — dependency health (pure detector; ARCHITECTURE §2.7 / PRODUCT job 4 / ROADMAP 3.2).
//
// Pure, filesystem-reading dependency-health scan: read a project's package.json, and for
// each declared dependency consult an injected AdvisorySource (an offline/local advisory
// DB, or a mocked registry response in tests — NEVER a live feed from inside the detector)
// to flag two classes of issue:
//   • dependency.vulnerable — the installed version falls inside a known advisory's
//     vulnerable range. Severity = the advisory's severity. detail carries the advisory.
//   • dependency.outdated   — the installed version is strictly behind `latest` with no
//     matching advisory. Severity = low (hygiene, not a security hole).
//
// NO database, NO process spawn, NO network — this is the deterministic core that
// dep-repo.ts feeds into `security_finding` upserts (the SAME §4.9 table the security
// scan uses; dependency findings ARE security findings on the Maintain surface). Mirrors
// the security.ts split (pure detector + db-backed registry). Each finding reuses the
// SecurityFinding shape so writeFindings/listFindings work unchanged.
//
// F-008: every finding is a real comparison of a real declared version against a real
// advisory record — nothing fabricated. Live advisory feeds are the caller's job (the
// AdvisorySource seam), so the detector stays pure + testable with a mock source.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import type { SecurityFinding, Severity } from './security';

/** One published advisory for a package (offline/local or mocked-registry record). */
export interface Advisory {
	/** Stable advisory id (e.g. a GHSA id). */
	id: string;
	severity: Severity;
	/** semver range the advisory applies to (e.g. "<4.17.21", ">=1.0.0 <1.2.3"). */
	vulnerableRange: string;
	/** Human title (no secret content — this is public advisory metadata). */
	title: string;
}

/** What an advisory source returns for a single package name. */
export interface AdvisoryRecord {
	/** Latest published version (for outdated detection); omit if unknown. */
	latest?: string;
	/** Known advisories affecting this package. */
	advisories: Advisory[];
}

/**
 * The advisory lookup seam. An implementation may read a bundled offline DB, a cached
 * `npm audit` JSON, or (outside the detector) a live registry — the detector itself never
 * does I/O beyond the lookup. Returns `undefined` for an unknown package (no false flags).
 */
export interface AdvisorySource {
	lookup(packageName: string): AdvisoryRecord | undefined;
}

/** A dependency-health finding — a SecurityFinding plus the dep-specific fields. */
export interface DependencyFinding extends SecurityFinding {
	/** The npm package name flagged. */
	package: string;
	/** The version (or range spec) declared in package.json. */
	declared: string;
	/** The advisory id, when rule = dependency.vulnerable. */
	advisoryId?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * Resolve a declared spec (e.g. "^4.18.2", "1.2.5", "~1.0.0") to a concrete version for
 * comparison. Uses semver.minVersion (the lowest version the range admits) so a caret/
 * tilde range is treated as its floor — conservative + deterministic. Returns null for a
 * spec we cannot resolve (a URL/git/workspace dep), which the caller skips.
 */
function resolveDeclared(spec: string): string | null {
	const direct = semver.valid(spec);
	if (direct) return direct;
	try {
		const min = semver.minVersion(spec);
		return min ? min.version : null;
	} catch {
		return null;
	}
}

/**
 * Scan a project directory for dependency-health findings (PURE — no DB/spawn/network).
 * Reads `<dir>/package.json`, walks dependencies + devDependencies, and consults
 * `source` for each. Returns findings sorted severity (critical→low) then package name.
 * Tolerant: a missing/malformed package.json yields `[]` (never throws). Callers MUST
 * path-confine `dir` under CODE_ROOT first (dep-repo.ts does this via confineToRoot).
 */
export function scanDependencies(dir: string, source: AdvisorySource): DependencyFinding[] {
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	} catch {
		return []; // no package.json or malformed — nothing to scan, don't fail the run
	}

	const deps: Record<string, string> = {
		...(pkg.dependencies ?? {}),
		...(pkg.devDependencies ?? {})
	};

	const findings: DependencyFinding[] = [];
	for (const [name, declared] of Object.entries(deps)) {
		const record = source.lookup(name);
		if (!record) continue; // unknown package — no false flags

		const installed = resolveDeclared(declared);
		if (!installed) continue; // unresolvable spec (git/url/workspace) — skip

		// (1) Vulnerabilities: the installed version inside any advisory's range.
		for (const adv of record.advisories) {
			let hit = false;
			try {
				hit = semver.satisfies(installed, adv.vulnerableRange, { includePrerelease: true });
			} catch {
				hit = false; // malformed range in the advisory data — skip, don't crash
			}
			if (!hit) continue;
			findings.push({
				rule: 'dependency.vulnerable',
				severity: adv.severity,
				file: 'package.json',
				line: 1,
				detail: `${name}@${declared} matches advisory ${adv.id} (${adv.severity}): ${adv.title} [vulnerable ${adv.vulnerableRange}].`,
				package: name,
				declared,
				advisoryId: adv.id
			});
		}

		// (2) Outdated: installed strictly behind latest. Hygiene-level (low).
		const latest = record.latest && semver.valid(record.latest) ? record.latest : null;
		if (latest && semver.lt(installed, latest)) {
			findings.push({
				rule: 'dependency.outdated',
				severity: 'low',
				file: 'package.json',
				line: 1,
				detail: `${name}@${declared} is outdated — latest is ${latest} (installed resolves to ${installed}).`,
				package: name,
				declared
			});
		}
	}

	findings.sort((a, b) => {
		const sv = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
		if (sv !== 0) return sv;
		const p = a.package.localeCompare(b.package);
		return p !== 0 ? p : a.rule.localeCompare(b.rule);
	});
	return findings;
}
