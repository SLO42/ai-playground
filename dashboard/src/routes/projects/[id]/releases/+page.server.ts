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
}

export const load: PageServerLoad = async ({ params }): Promise<ReleaseData> => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);

	const empty: ReleaseData = {
		projectId: params.id,
		releases: [],
		currentVersion: '0.0.0',
		suggestedBump: { major: '1.0.0', minor: '0.1.0', patch: '0.0.1' },
		hasGh: false
	};

	if (!project) return empty;

	try {
		const { listReleases, determineBump } = await import('$lib/server/release-manager.js');

		const [releases, bump] = await Promise.all([
			listReleases(project.path).catch((): Release[] => []),
			determineBump(project.path).catch(() => ({
				current: '0.0.0',
				major: '1.0.0',
				minor: '0.1.0',
				patch: '0.0.1'
			}))
		]);

		// Detect gh CLI availability
		let hasGh = false;
		try {
			const { execSync } = await import('child_process');
			execSync('gh --version', { stdio: 'ignore' });
			hasGh = true;
		} catch {
			// gh not installed
		}

		return {
			projectId: params.id,
			releases: releases as Release[],
			currentVersion: bump.current ?? '0.0.0',
			suggestedBump: { major: bump.major, minor: bump.minor, patch: bump.patch },
			hasGh
		};
	} catch {
		// release-manager module not available yet — return empty data
		return empty;
	}
};
