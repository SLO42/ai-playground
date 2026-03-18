/**
 * Release Manager — changelog generation, semver bumping, and GitHub release creation.
 *
 * Parses conventional commits, determines version bumps, and orchestrates
 * releases via git tags and the `gh` CLI.  Also provides `publishRelease()`
 * for multi-platform publishing via the pluggable publisher registry.
 */
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { execSync } from 'child_process';
import type { DetectedProjectMeta } from '$lib/types/projects.js';
import type { PublisherConfig, ReleaseInfo, PublishResult } from './publishers/types.js';
import { getPublisher, getPublishersForProject } from './publishers/registry.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface ChangelogEntry {
	type: string;
	scope: string | null;
	message: string;
	hash: string;
	date: string;
	breaking: boolean;
}

export interface Release {
	version: string;
	tagName: string;
	date: string;
	body: string;
	isGitHub: boolean;
	url: string | null;
	isDraft: boolean;
	isPrerelease: boolean;
}

export interface BumpResult {
	current: string;
	next: string;
	bumpType: 'major' | 'minor' | 'patch';
}

// ── Constants ──────────────────────────────────────────────────────────

const COMMIT_PATTERN = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

const TYPE_LABELS: Record<string, string> = {
	feat: 'Features',
	fix: 'Bug Fixes',
	refactor: 'Refactoring',
	docs: 'Documentation',
	test: 'Tests',
	ci: 'CI',
	style: 'Style',
	chore: 'Chores',
	perf: 'Performance'
};

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 15_000, windowsHide: true, shell: true };

// ── Helpers ────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
	return execSync(`git ${args}`, { ...EXEC_OPTS, cwd }).trim();
}

function ghCli(args: string, cwd: string): string {
	return execSync(`gh ${args}`, { ...EXEC_OPTS, cwd }).trim();
}

function isGhAvailable(cwd: string): boolean {
	try {
		execSync('gh --version', { ...EXEC_OPTS, cwd, timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/** Get the latest semver tag reachable from HEAD. */
function latestTag(cwd: string): string | null {
	try {
		return git('describe --tags --abbrev=0 --match "v*"', cwd);
	} catch {
		try {
			// Fallback: any tag matching semver
			const tags = git('tag --sort=-v:refname', cwd);
			const first = tags.split('\n').find((t) => /^v?\d+\.\d+\.\d+/.test(t));
			return first ?? null;
		} catch {
			return null;
		}
	}
}

/** Read version from package.json, falling back to latest git tag. */
async function currentVersion(projectPath: string): Promise<string> {
	try {
		const raw = await readFile(resolve(projectPath, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		if (pkg.version) return pkg.version;
	} catch { /* fallback to git tag */ }

	const tag = latestTag(projectPath);
	if (tag) return tag.replace(/^v/, '');

	return '0.0.0';
}

/** Increment a semver string by the given bump type. */
function incrementVersion(version: string, bump: 'major' | 'minor' | 'patch'): string {
	const parts = version.replace(/^v/, '').split('.').map(Number);
	const [major = 0, minor = 0, patch = 0] = parts;

	switch (bump) {
		case 'major': return `${major + 1}.0.0`;
		case 'minor': return `${major}.${minor + 1}.0`;
		case 'patch': return `${major}.${minor}.${patch + 1}`;
	}
}

/** Parse a single conventional-commit subject line + body into a ChangelogEntry. */
function parseCommit(subject: string, body: string, hash: string, date: string): ChangelogEntry | null {
	const match = subject.match(COMMIT_PATTERN);
	if (!match) return null;

	const [, type, scope, bang, message] = match;
	const breaking = !!bang || /BREAKING[ -]CHANGE/i.test(body);

	return {
		type: type.toLowerCase(),
		scope: scope?.trim() || null,
		message: message.trim(),
		hash,
		date,
		breaking
	};
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Generate a changelog from git commits using conventional-commit parsing.
 *
 * @param projectPath  Absolute path to the project root (must be a git repo)
 * @param options.since  Git ref or date to start from (default: latest tag)
 * @param options.until  Git ref or date to end at (default: HEAD)
 */
export async function generateChangelog(
	projectPath: string,
	options?: { since?: string; until?: string }
): Promise<ChangelogEntry[]> {
	try {
		const since = options?.since ?? latestTag(projectPath) ?? '';
		const until = options?.until ?? 'HEAD';

		// Build range: "tag..HEAD" or just HEAD if no since
		const range = since ? `${since}..${until}` : until;

		// Use %x00 as record separator, %x1f as field separator
		const format = '%H%x1f%ai%x1f%s%x1f%b%x00';
		const raw = git(`log ${range} --pretty=format:"${format}"`, projectPath);

		if (!raw) return [];

		const entries: ChangelogEntry[] = [];

		for (const record of raw.split('\0')) {
			const trimmed = record.trim();
			if (!trimmed) continue;

			const [hash, date, subject, body] = trimmed.split('\x1f');
			if (!hash || !subject) continue;

			const entry = parseCommit(subject, body ?? '', hash.slice(0, 8), date);
			if (entry) entries.push(entry);
		}

		return entries;
	} catch {
		return [];
	}
}

/**
 * Determine the appropriate semver bump from commits since the last tag.
 *
 * - Any `BREAKING CHANGE` or `!` suffix → major
 * - Any `feat` → minor
 * - `fix`, `refactor`, `perf`, etc. → patch
 */
export async function determineBump(
	projectPath: string,
	since?: string
): Promise<BumpResult | null> {
	try {
		const current = await currentVersion(projectPath);
		const entries = await generateChangelog(projectPath, { since });

		if (entries.length === 0) return null;

		let bumpType: 'major' | 'minor' | 'patch' = 'patch';

		for (const entry of entries) {
			if (entry.breaking) {
				bumpType = 'major';
				break; // Can't go higher
			}
			if (entry.type === 'feat' && bumpType !== 'major') {
				bumpType = 'minor';
			}
		}

		return {
			current,
			next: incrementVersion(current, bumpType),
			bumpType
		};
	} catch {
		return null;
	}
}

/**
 * Write a new version to the project's package.json.
 */
export async function bumpVersion(projectPath: string, newVersion: string): Promise<void> {
	const pkgPath = resolve(projectPath, 'package.json');
	const raw = await readFile(pkgPath, 'utf-8');
	const pkg = JSON.parse(raw);
	pkg.version = newVersion;
	await writeFile(pkgPath, JSON.stringify(pkg, null, '\t') + '\n', 'utf-8');
}

/**
 * Create a GitHub release via the `gh` CLI.
 * Creates the git tag and GitHub release in a single command.
 */
export async function createGitHubRelease(
	projectPath: string,
	version: string,
	changelog: string,
	options?: { draft?: boolean; prerelease?: boolean }
): Promise<{ url: string; tagName: string } | null> {
	try {
		if (!isGhAvailable(projectPath)) return null;

		const tagName = version.startsWith('v') ? version : `v${version}`;
		const flags: string[] = [];

		if (options?.draft) flags.push('--draft');
		if (options?.prerelease) flags.push('--prerelease');

		// Write changelog to a temp approach via --notes
		// Escape double quotes in the changelog for shell safety
		const safeNotes = changelog.replace(/"/g, '\\"');
		const flagStr = flags.join(' ');

		const output = ghCli(
			`release create "${tagName}" --title "${tagName}" --notes "${safeNotes}" ${flagStr}`,
			projectPath
		);

		// gh release create prints the release URL on success
		const url = output.trim() || null;

		return { url: url ?? '', tagName };
	} catch {
		return null;
	}
}

/**
 * List releases for a project: combines git tags with GitHub releases.
 */
export async function listReleases(projectPath: string): Promise<Release[]> {
	const releases: Release[] = [];
	const seen = new Set<string>();

	// ── GitHub releases (if gh is available) ────────────────────────
	if (isGhAvailable(projectPath)) {
		try {
			const raw = ghCli(
				'release list --json tagName,name,body,publishedAt,isDraft,isPrerelease,url --limit 50',
				projectPath
			);

			if (raw) {
				const ghReleases = JSON.parse(raw) as Array<{
					tagName: string;
					name: string;
					body: string;
					publishedAt: string;
					isDraft: boolean;
					isPrerelease: boolean;
					url: string;
				}>;

				for (const r of ghReleases) {
					const version = r.tagName.replace(/^v/, '');
					seen.add(r.tagName);
					releases.push({
						version,
						tagName: r.tagName,
						date: r.publishedAt,
						body: r.body ?? '',
						isGitHub: true,
						url: r.url ?? null,
						isDraft: r.isDraft,
						isPrerelease: r.isPrerelease
					});
				}
			}
		} catch { /* gh not authenticated or no repo */ }
	}

	// ── Git tags (for tags without a GitHub release) ────────────────
	try {
		const tagOutput = git(
			'tag --sort=-v:refname --format="%(refname:short)%x1f%(creatordate:iso-strict)"',
			projectPath
		);

		if (tagOutput) {
			for (const line of tagOutput.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				const [tagName, date] = trimmed.split('\x1f');
				if (!tagName || seen.has(tagName)) continue;

				// Only include semver-like tags
				if (!/^v?\d+\.\d+\.\d+/.test(tagName)) continue;

				const version = tagName.replace(/^v/, '');
				// Try to get tag annotation as body
				let body = '';
				try {
					body = git(`tag -l --format="%(contents)" "${tagName}"`, projectPath);
				} catch { /* not annotated */ }

				releases.push({
					version,
					tagName,
					date: date ?? '',
					body,
					isGitHub: false,
					url: null,
					isDraft: false,
					isPrerelease: false
				});
			}
		}
	} catch { /* no tags */ }

	return releases;
}

/**
 * Format changelog entries into a Markdown string grouped by type.
 */
export function formatChangelog(entries: ChangelogEntry[]): string {
	if (entries.length === 0) return 'No changes.';

	const groups = new Map<string, ChangelogEntry[]>();

	for (const entry of entries) {
		const label = TYPE_LABELS[entry.type] ?? entry.type;
		const list = groups.get(label) ?? [];
		list.push(entry);
		groups.set(label, list);
	}

	const sections: string[] = [];

	// Sort groups: Features first, Bug Fixes second, then alphabetical
	const order = ['Features', 'Bug Fixes'];
	const sortedKeys = [...groups.keys()].sort((a, b) => {
		const ai = order.indexOf(a);
		const bi = order.indexOf(b);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});

	for (const label of sortedKeys) {
		const items = groups.get(label)!;
		sections.push(`### ${label}\n`);
		for (const item of items) {
			const scope = item.scope ? `**${item.scope}**: ` : '';
			const breaking = item.breaking ? ' **BREAKING**' : '';
			sections.push(`- ${scope}${item.message}${breaking} (${item.hash})`);
		}
		sections.push('');
	}

	return sections.join('\n').trim();
}

// ── Multi-platform publishing ─────────────────────────────────────────

export interface PublishReleaseOptions {
	/** Explicit platform IDs to publish to. When omitted, auto-detect from project metadata. */
	platforms?: string[];
	/** Per-platform config overrides keyed by platform ID. */
	configs?: Record<string, PublisherConfig>;
	/** When true, validate and package but do not upload. */
	dryRun?: boolean;
}

/**
 * Publish a release to one or more platforms.
 *
 * When `platforms` is omitted, uses the publisher registry to auto-detect
 * applicable publishers from `projectMeta`. Each publisher runs independently;
 * partial failures do not block other platforms.
 *
 * @returns An array of results, one per publisher that was invoked.
 */
export async function publishRelease(
	release: ReleaseInfo,
	projectMeta: DetectedProjectMeta | null,
	options?: PublishReleaseOptions
): Promise<PublishResult[]> {
	const dryRun = options?.dryRun ?? false;
	const configs = options?.configs ?? {};

	// Resolve publishers
	let publishers;
	if (options?.platforms && options.platforms.length > 0) {
		publishers = options.platforms
			.map((p) => getPublisher(p))
			.filter((p): p is NonNullable<typeof p> => p !== null);
	} else if (projectMeta) {
		publishers = getPublishersForProject(projectMeta);
	} else {
		return [{ success: false, error: 'No platforms specified and no project metadata for auto-detection', platform: 'unknown' }];
	}

	if (publishers.length === 0) {
		return [{ success: false, error: 'No matching publishers found for this project', platform: 'unknown' }];
	}

	// Run all publishers concurrently
	const results = await Promise.allSettled(
		publishers.map(async (publisher) => {
			const config = configs[publisher.id] ?? {};
			return publisher.publish(release, config, dryRun);
		})
	);

	return results.map((result, i) => {
		if (result.status === 'fulfilled') return result.value;
		return {
			success: false,
			error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			platform: publishers[i].id
		};
	});
}
