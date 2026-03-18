/**
 * CurseForge / Modrinth publisher.
 *
 * Uploads JAR artifacts for Minecraft mods to CurseForge and/or Modrinth.
 * Supports both platforms through a single publisher with auto-detection
 * based on which tokens are available.
 */
import { readFile } from 'fs/promises';
import { basename, resolve } from 'path';
import { existsSync } from 'fs';
import type { ReleasePublisher, PublisherConfig, ReleaseInfo, PublishResult, PublisherValidation } from './types.js';

const CURSEFORGE_UPLOAD_URL = 'https://minecraft.curseforge.com/api/projects';
const MODRINTH_VERSION_URL = 'https://api.modrinth.com/v2/version';

export interface CurseForgePublisherConfig extends PublisherConfig {
	/** CurseForge API token. Falls back to env CURSEFORGE_TOKEN. */
	curseforgeToken?: string;
	/** Modrinth API token. Falls back to env MODRINTH_TOKEN. */
	modrinthToken?: string;
	/** CurseForge project ID */
	curseforgeProjectId?: string;
	/** Modrinth project ID (slug or ID) */
	modrinthProjectId?: string;
	/** Minecraft game versions (e.g., ['1.20.1', '1.20.2']) */
	gameVersions?: string[];
	/** Mod loaders (e.g., ['fabric', 'forge', 'neoforge']) */
	loaders?: string[];
	/** Release channel */
	releaseType?: 'release' | 'beta' | 'alpha';
}

async function publishToCurseForge(
	release: ReleaseInfo,
	config: CurseForgePublisherConfig
): Promise<PublishResult> {
	const token = config.curseforgeToken ?? process.env.CURSEFORGE_TOKEN;
	if (!token) {
		return { success: false, error: 'No CurseForge token available', platform: 'curseforge' };
	}

	const projectId = config.curseforgeProjectId;
	if (!projectId) {
		return { success: false, error: 'No CurseForge project ID configured', platform: 'curseforge' };
	}

	// Find the first JAR artifact
	const jarArtifact = release.artifacts.find((f) => f.endsWith('.jar') && existsSync(f));
	if (!jarArtifact) {
		return { success: false, error: 'No .jar artifact found', platform: 'curseforge' };
	}

	try {
		const fileData = await readFile(jarArtifact);

		const metadata = {
			changelog: release.changelog,
			changelogType: 'markdown',
			displayName: `${release.projectName} ${release.version}`,
			gameVersions: config.gameVersions ?? [],
			releaseType: config.releaseType ?? 'release'
		};

		const formData = new FormData();
		formData.append('metadata', JSON.stringify(metadata));
		formData.append('file', new Blob([fileData], { type: 'application/java-archive' }), basename(jarArtifact));

		const response = await fetch(`${CURSEFORGE_UPLOAD_URL}/${projectId}/upload-file`, {
			method: 'POST',
			headers: { 'X-Api-Token': token },
			body: formData
		});

		if (!response.ok) {
			const body = await response.text();
			return {
				success: false,
				error: `CurseForge API error ${response.status}: ${body}`,
				platform: 'curseforge'
			};
		}

		const result = await response.json() as { id?: number };
		return {
			success: true,
			url: result.id
				? `https://www.curseforge.com/minecraft/mc-mods/${projectId}/files/${result.id}`
				: undefined,
			platform: 'curseforge'
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, error: msg, platform: 'curseforge' };
	}
}

async function publishToModrinth(
	release: ReleaseInfo,
	config: CurseForgePublisherConfig
): Promise<PublishResult> {
	const token = config.modrinthToken ?? process.env.MODRINTH_TOKEN;
	if (!token) {
		return { success: false, error: 'No Modrinth token available', platform: 'modrinth' };
	}

	const projectId = config.modrinthProjectId;
	if (!projectId) {
		return { success: false, error: 'No Modrinth project ID configured', platform: 'modrinth' };
	}

	// Find the first JAR artifact
	const jarArtifact = release.artifacts.find((f) => f.endsWith('.jar') && existsSync(f));
	if (!jarArtifact) {
		return { success: false, error: 'No .jar artifact found', platform: 'modrinth' };
	}

	try {
		const fileData = await readFile(jarArtifact);
		const fileName = basename(jarArtifact);

		const versionData = {
			name: `${release.projectName} ${release.version}`,
			version_number: release.version,
			changelog: release.changelog,
			dependencies: [],
			game_versions: config.gameVersions ?? [],
			version_type: config.releaseType ?? 'release',
			loaders: config.loaders ?? [],
			featured: true,
			project_id: projectId,
			file_parts: [fileName]
		};

		const formData = new FormData();
		formData.append('data', JSON.stringify(versionData));
		formData.append(fileName, new Blob([fileData], { type: 'application/java-archive' }), fileName);

		const response = await fetch(MODRINTH_VERSION_URL, {
			method: 'POST',
			headers: { Authorization: token },
			body: formData
		});

		if (!response.ok) {
			const body = await response.text();
			return {
				success: false,
				error: `Modrinth API error ${response.status}: ${body}`,
				platform: 'modrinth'
			};
		}

		const result = await response.json() as { id?: string };
		return {
			success: true,
			url: result.id ? `https://modrinth.com/mod/${projectId}/version/${result.id}` : undefined,
			platform: 'modrinth'
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, error: msg, platform: 'modrinth' };
	}
}

export const curseforgePublisher: ReleasePublisher = {
	id: 'curseforge',
	name: 'CurseForge / Modrinth',
	platforms: ['curseforge', 'modrinth'],

	validate(config: PublisherConfig): PublisherValidation {
		const cfConfig = config as CurseForgePublisherConfig;
		const errors: string[] = [];

		const hasCurseforge = !!(cfConfig.curseforgeToken ?? process.env.CURSEFORGE_TOKEN);
		const hasModrinth = !!(cfConfig.modrinthToken ?? process.env.MODRINTH_TOKEN);

		if (!hasCurseforge && !hasModrinth) {
			errors.push(
				'No platform token found: set CURSEFORGE_TOKEN and/or MODRINTH_TOKEN'
			);
		}

		if (hasCurseforge && !cfConfig.curseforgeProjectId) {
			errors.push('CurseForge token present but no curseforgeProjectId configured');
		}

		if (hasModrinth && !cfConfig.modrinthProjectId) {
			errors.push('Modrinth token present but no modrinthProjectId configured');
		}

		return { valid: errors.length === 0, errors };
	},

	async publish(release: ReleaseInfo, config: PublisherConfig, dryRun = false): Promise<PublishResult> {
		const cfConfig = config as CurseForgePublisherConfig;

		if (dryRun) {
			const validation = this.validate(config);
			const platforms: string[] = [];
			if (cfConfig.curseforgeToken ?? process.env.CURSEFORGE_TOKEN) platforms.push('curseforge');
			if (cfConfig.modrinthToken ?? process.env.MODRINTH_TOKEN) platforms.push('modrinth');

			return {
				success: validation.valid,
				error: validation.valid ? undefined : validation.errors.join('; '),
				platform: platforms.join('+') || 'curseforge/modrinth',
				dryRun: true,
				url: validation.valid
					? `(dry-run) would upload ${release.projectName} v${release.version} to ${platforms.join(', ')}`
					: undefined
			};
		}

		// Publish to all configured platforms
		const results: PublishResult[] = [];

		if (cfConfig.curseforgeToken ?? process.env.CURSEFORGE_TOKEN) {
			results.push(await publishToCurseForge(release, cfConfig));
		}

		if (cfConfig.modrinthToken ?? process.env.MODRINTH_TOKEN) {
			results.push(await publishToModrinth(release, cfConfig));
		}

		if (results.length === 0) {
			return { success: false, error: 'No platform tokens configured', platform: 'curseforge/modrinth' };
		}

		const failures = results.filter((r) => !r.success);
		if (failures.length === results.length) {
			return {
				success: false,
				error: failures.map((f) => `${f.platform}: ${f.error}`).join('; '),
				platform: results.map((r) => r.platform).join('+')
			};
		}

		const urls = results.filter((r) => r.url).map((r) => r.url);
		return {
			success: true,
			url: urls.join(' | ') || undefined,
			platform: results.map((r) => r.platform).join('+'),
			error: failures.length > 0
				? `Partial failure: ${failures.map((f) => `${f.platform}: ${f.error}`).join('; ')}`
				: undefined
		};
	}
};
