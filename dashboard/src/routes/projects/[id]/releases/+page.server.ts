import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';

interface Release {
	tag: string;
	name: string;
	body: string;
	date: string;
	draft: boolean;
	prerelease: boolean;
	source: 'github' | 'git-tag';
	htmlUrl?: string;
}

interface ReleaseData {
	projectId: string;
	releases: Release[];
	currentVersion: string;
	suggestedBump: { major: string; minor: string; patch: string };
	hasGh: boolean;
	generatedNotes: string;
}

export const load: PageServerLoad = async ({ params }): Promise<ReleaseData> => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);

	const empty: ReleaseData = {
		projectId: params.id,
		releases: [],
		currentVersion: '0.0.0',
		suggestedBump: { major: '1.0.0', minor: '0.1.0', patch: '0.0.1' },
		hasGh: false,
		generatedNotes: ''
	};

	if (!project) return empty;

	try {
		const {
			listReleases,
			determineBump,
			generateChangelog,
			formatChangelog,
			isGhAvailable
		} = await import('$lib/server/release-manager.js');

		const [rawReleases, bump, changelogEntries] = await Promise.all([
			listReleases(project.path).catch(() => []),
			determineBump(project.path).catch(() => null),
			generateChangelog(project.path).catch(() => [])
		]);

		// Map release-manager's Release shape to the page's expected shape
		const releases: Release[] = rawReleases.map((r) => ({
			tag: r.tagName,
			name: r.version,
			body: r.body,
			date: r.date,
			draft: r.isDraft,
			prerelease: r.isPrerelease,
			source: r.isGitHub ? 'github' as const : 'git-tag' as const,
			htmlUrl: r.url ?? undefined
		}));

		// Build suggested versions for each bump type from the current version
		const current = bump?.current ?? '0.0.0';
		const [maj = 0, min = 0, pat = 0] = current.replace(/^v/, '').split('.').map(Number);
		const suggestedBump = {
			major: `${maj + 1}.0.0`,
			minor: `${maj}.${min + 1}.0`,
			patch: `${maj}.${min}.${pat + 1}`
		};

		// Detect gh CLI availability
		const hasGh = isGhAvailable(project.path);

		// Generate formatted changelog notes from commits since last tag
		const generatedNotes = formatChangelog(changelogEntries);

		return {
			projectId: params.id,
			releases,
			currentVersion: current,
			suggestedBump,
			hasGh,
			generatedNotes
		};
	} catch {
		// release-manager module not available yet — return empty data
		return empty;
	}
};
