import { json, error } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';

async function getProjectPath(id: string): Promise<string> {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === id);
	if (!project) throw error(404, 'Project not found');
	return project.path;
}

export async function GET({ params }) {
	const projectPath = await getProjectPath(params.id);

	try {
		const { listReleases, determineBump } = await import('$lib/server/release-manager.js');

		const [releases, bump] = await Promise.all([
			listReleases(projectPath).catch(() => []),
			determineBump(projectPath).catch(() => ({
				current: '0.0.0',
				major: '1.0.0',
				minor: '0.1.0',
				patch: '0.0.1'
			}))
		]);

		return json({ releases, currentVersion: bump.current ?? '0.0.0' });
	} catch {
		return json({ releases: [], currentVersion: '0.0.0' });
	}
}

export async function POST({ params, request }) {
	const projectPath = await getProjectPath(params.id);
	const body = await request.json();

	// ── Action: prepare — spawn a release agent ──────────────────────
	if (body.action === 'prepare') {
		try {
			const { spawnReleaseAgent } = await import('$lib/server/heartbeat/release-agent.js');
			const spawned = await spawnReleaseAgent(projectPath, params.id, {
				dryRun: body.dryRun ?? false
			});

			return json({
				spawned,
				agentId: spawned ? `release-${params.id}` : null,
				message: spawned
					? `Release agent spawned for ${params.id}`
					: 'Release agent not spawned — check agent limits or existing agent'
			}, { status: spawned ? 202 : 409 });
		} catch (e) {
			const message = e instanceof Error ? e.message : 'Failed to spawn release agent';
			throw error(500, message);
		}
	}

	// ── Default: manual release creation ─────────────────────────────
	if (!body.version || typeof body.version !== 'string') {
		throw error(400, 'Version is required');
	}

	if (!body.changelog || typeof body.changelog !== 'string') {
		throw error(400, 'Changelog is required');
	}

	try {
		const { createGitHubRelease, bumpVersion } = await import('$lib/server/release-manager.js');

		// createGitHubRelease(path, version, changelog, options?) — separate args, not an object
		const releaseResult = await createGitHubRelease(
			projectPath,
			body.version,
			body.changelog,
			{ draft: body.draft ?? false, prerelease: body.prerelease ?? false }
		).catch(() => null);

		// Bump version in package.json (best-effort, may not have one)
		await bumpVersion(projectPath, body.version).catch(() => {});

		return json({
			success: true,
			version: body.version,
			release: releaseResult
		}, { status: 201 });
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Release creation failed';
		throw error(500, message);
	}
}
