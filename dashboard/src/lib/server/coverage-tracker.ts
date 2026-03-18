/**
 * Test coverage trend tracking — parses coverage output files (lcov, cobertura),
 * stores historical data, and detects coverage regressions.
 * Persists to .playground/coverage-trends.json.
 */
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from './constants.js';
import { withLock } from './async-mutex.js';
import { createIncident } from './incidents.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface CoverageMetric {
	total: number;
	covered: number;
	percentage: number;
}

export interface CoverageReport {
	projectId: string;
	timestamp: string;
	lines: CoverageMetric;
	branches?: CoverageMetric;
	functions?: CoverageMetric;
	source: 'lcov' | 'cobertura' | 'jacoco' | 'cargo' | 'go';
}

// ── Storage ────────────────────────────────────────────────────────────

const TRENDS_FILE = resolve(PATHS.root, '.playground/coverage-trends.json');
const MAX_REPORTS_PER_PROJECT = 100;
const REGRESSION_THRESHOLD_PCT = 5;

async function readTrends(): Promise<CoverageReport[]> {
	try {
		const raw = await readFile(TRENDS_FILE, 'utf-8');
		return JSON.parse(raw) as CoverageReport[];
	} catch {
		return [];
	}
}

async function writeTrends(reports: CoverageReport[]): Promise<void> {
	await mkdir(dirname(TRENDS_FILE), { recursive: true });
	await writeFile(TRENDS_FILE, JSON.stringify(reports, null, '\t'), 'utf-8');
}

// ── Parsers ────────────────────────────────────────────────────────────

/**
 * Parse LCOV format coverage data.
 * Handles: LF (lines found), LH (lines hit), BRF (branches found), BRH (branches hit),
 * FNF (functions found), FNH (functions hit).
 */
export function parseLcov(content: string): Partial<CoverageReport> {
	let linesTotal = 0, linesCovered = 0;
	let branchesTotal = 0, branchesCovered = 0;
	let functionsTotal = 0, functionsCovered = 0;

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith('LF:')) linesTotal += parseInt(trimmed.slice(3), 10) || 0;
		else if (trimmed.startsWith('LH:')) linesCovered += parseInt(trimmed.slice(3), 10) || 0;
		else if (trimmed.startsWith('BRF:')) branchesTotal += parseInt(trimmed.slice(4), 10) || 0;
		else if (trimmed.startsWith('BRH:')) branchesCovered += parseInt(trimmed.slice(4), 10) || 0;
		else if (trimmed.startsWith('FNF:')) functionsTotal += parseInt(trimmed.slice(4), 10) || 0;
		else if (trimmed.startsWith('FNH:')) functionsCovered += parseInt(trimmed.slice(4), 10) || 0;
	}

	const result: Partial<CoverageReport> = {
		source: 'lcov',
		lines: {
			total: linesTotal,
			covered: linesCovered,
			percentage: linesTotal > 0 ? Math.round((linesCovered / linesTotal) * 10000) / 100 : 0
		}
	};

	if (branchesTotal > 0) {
		result.branches = {
			total: branchesTotal,
			covered: branchesCovered,
			percentage: Math.round((branchesCovered / branchesTotal) * 10000) / 100
		};
	}

	if (functionsTotal > 0) {
		result.functions = {
			total: functionsTotal,
			covered: functionsCovered,
			percentage: Math.round((functionsCovered / functionsTotal) * 10000) / 100
		};
	}

	return result;
}

/**
 * Parse Cobertura XML format coverage data.
 * Extracts line-rate and branch-rate from the top-level <coverage> element.
 */
export function parseCobertura(content: string): Partial<CoverageReport> {
	// Extract attributes from the <coverage> element
	const coverageMatch = content.match(/<coverage[^>]*>/);
	if (!coverageMatch) {
		return { source: 'cobertura', lines: { total: 0, covered: 0, percentage: 0 } };
	}

	const tag = coverageMatch[0];

	const lineRate = parseFloat(tag.match(/line-rate="([^"]+)"/)?.[1] ?? '0');
	const branchRate = parseFloat(tag.match(/branch-rate="([^"]+)"/)?.[1] ?? '0');
	const linesValid = parseInt(tag.match(/lines-valid="([^"]+)"/)?.[1] ?? '0', 10);
	const linesCovered = parseInt(tag.match(/lines-covered="([^"]+)"/)?.[1] ?? '0', 10);
	const branchesValid = parseInt(tag.match(/branches-valid="([^"]+)"/)?.[1] ?? '0', 10);
	const branchesCovered = parseInt(tag.match(/branches-covered="([^"]+)"/)?.[1] ?? '0', 10);

	const result: Partial<CoverageReport> = {
		source: 'cobertura',
		lines: {
			total: linesValid,
			covered: linesCovered,
			percentage: Math.round(lineRate * 10000) / 100
		}
	};

	if (branchesValid > 0) {
		result.branches = {
			total: branchesValid,
			covered: branchesCovered,
			percentage: Math.round(branchRate * 10000) / 100
		};
	}

	return result;
}

// ── Coverage file detection ────────────────────────────────────────────

interface CoverageFileInfo {
	path: string;
	format: 'lcov' | 'cobertura';
}

const COVERAGE_CANDIDATES: Array<{ relative: string; format: 'lcov' | 'cobertura' }> = [
	{ relative: 'coverage/lcov.info', format: 'lcov' },
	{ relative: 'lcov.info', format: 'lcov' },
	{ relative: 'coverage/coverage.xml', format: 'cobertura' },
	{ relative: 'coverage.xml', format: 'cobertura' },
	{ relative: 'coverage/cobertura-coverage.xml', format: 'cobertura' },
	{ relative: 'target/site/cobertura/coverage.xml', format: 'cobertura' },
	{ relative: 'build/reports/cobertura/coverage.xml', format: 'cobertura' }
];

/**
 * Detect a coverage output file in the given project path.
 * Returns the first matching file and its format, or null if none found.
 */
export async function detectCoverageFile(
	projectPath: string
): Promise<CoverageFileInfo | null> {
	for (const candidate of COVERAGE_CANDIDATES) {
		const fullPath = resolve(projectPath, candidate.relative);
		try {
			await access(fullPath);
			return { path: fullPath, format: candidate.format };
		} catch {
			// Not found — try next
		}
	}
	return null;
}

// ── Storage API ────────────────────────────────────────────────────────

/**
 * Store a coverage report. Automatically checks for regressions against
 * the previous report for the same project.
 */
export async function storeCoverageReport(report: CoverageReport): Promise<void> {
	await withLock(TRENDS_FILE, async () => {
		const allReports = await readTrends();

		// Check for regression before storing
		const projectReports = allReports
			.filter((r) => r.projectId === report.projectId)
			.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		const previous = projectReports[0];

		allReports.unshift(report);

		// Trim per-project to MAX_REPORTS_PER_PROJECT
		const counts = new Map<string, number>();
		const trimmed = allReports.filter((r) => {
			const count = (counts.get(r.projectId) ?? 0) + 1;
			counts.set(r.projectId, count);
			return count <= MAX_REPORTS_PER_PROJECT;
		});

		await writeTrends(trimmed);

		// Detect regression
		if (previous && previous.lines.percentage - report.lines.percentage >= REGRESSION_THRESHOLD_PCT) {
			const drop = Math.round((previous.lines.percentage - report.lines.percentage) * 100) / 100;
			await createIncident({
				projectId: report.projectId,
				type: 'test_regression',
				title: `Coverage dropped ${drop}% in ${report.projectId}`,
				description: [
					`Line coverage fell from ${previous.lines.percentage}% to ${report.lines.percentage}%.`,
					`This exceeds the ${REGRESSION_THRESHOLD_PCT}% regression threshold.`,
					`Previous report: ${previous.timestamp}`,
					`Current report: ${report.timestamp}`
				].join('\n'),
				severity: drop >= 10 ? 'high' : 'medium',
				status: 'open',
				context: {
					previousCoverage: previous.lines.percentage,
					currentCoverage: report.lines.percentage,
					drop,
					source: report.source
				}
			}).catch(() => {});
		}
	});
}

/**
 * Get coverage trend for a project, most recent first.
 */
export async function getCoverageTrend(
	projectId: string,
	limit?: number
): Promise<CoverageReport[]> {
	const allReports = await readTrends();
	const projectReports = allReports
		.filter((r) => r.projectId === projectId)
		.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	return limit ? projectReports.slice(0, limit) : projectReports;
}

/**
 * Collect and store coverage for a project after tests pass.
 * Returns the report if coverage was found, null otherwise.
 */
export async function collectCoverage(
	projectId: string,
	projectPath: string
): Promise<CoverageReport | null> {
	const coverageFile = await detectCoverageFile(projectPath);
	if (!coverageFile) return null;

	let content: string;
	try {
		content = await readFile(coverageFile.path, 'utf-8');
	} catch {
		return null;
	}

	const parsed =
		coverageFile.format === 'lcov' ? parseLcov(content) : parseCobertura(content);

	if (!parsed.lines || parsed.lines.total === 0) return null;

	const report: CoverageReport = {
		projectId,
		timestamp: new Date().toISOString(),
		lines: parsed.lines,
		branches: parsed.branches,
		functions: parsed.functions,
		source: parsed.source ?? coverageFile.format
	};

	await storeCoverageReport(report);
	return report;
}
