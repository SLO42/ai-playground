/**
 * Nexus Mods publisher.
 *
 * Uploads mod files to Nexus Mods via their v1 API. Commonly used for
 * Baldur's Gate 3, Skyrim, Fallout, and other moddable games.
 *
 * Note: Nexus Mods API for file uploads is limited. The v1 API supports
 * metadata updates but file uploads require the mod author tools or
 * the premium API. This publisher handles the available API surface.
 */
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { existsSync } from 'fs';
import type { ReleasePublisher, PublisherConfig, ReleaseInfo, PublishResult, PublisherValidation } from './types.js';

const NEXUS_API_BASE = 'https://api.nexusmods.com/v1';

export interface NexusPublisherConfig extends PublisherConfig {
	/** Nexus API key. Falls back to env NEXUS_API_KEY. */
	apiKey?: string;
	/** Game domain name (e.g., 'baldursgate3', 'skyrimspecialedition') */
	gameDomain?: string;
	/** Nexus mod ID */
	modId?: string;
	/** File name override for the uploaded file */
	fileName?: string;
	/** File category: main, update, optional, old_version, miscellaneous */
	fileCategory?: 'main' | 'update' | 'optional' | 'old_version' | 'miscellaneous';
	/** Brief description for this file version */
	fileDescription?: string;
}

export const nexusPublisher: ReleasePublisher = {
	id: 'nexus',
	name: 'Nexus Mods',
	platforms: ['nexus', 'nexusmods'],

	validate(config: PublisherConfig): PublisherValidation {
		const nxConfig = config as NexusPublisherConfig;
		const errors: string[] = [];

		const apiKey = nxConfig.apiKey ?? process.env.NEXUS_API_KEY;
		if (!apiKey) {
			errors.push('Missing API key: set apiKey in config or NEXUS_API_KEY env var');
		}

		if (!nxConfig.gameDomain) {
			errors.push('Missing gameDomain (e.g., "baldursgate3")');
		}

		if (!nxConfig.modId) {
			errors.push('Missing modId');
		}

		return { valid: errors.length === 0, errors };
	},

	async publish(release: ReleaseInfo, config: PublisherConfig, dryRun = false): Promise<PublishResult> {
		const nxConfig = config as NexusPublisherConfig;
		const apiKey = nxConfig.apiKey ?? process.env.NEXUS_API_KEY;

		if (dryRun) {
			const validation = this.validate(config);
			if (!validation.valid) {
				return { success: false, error: validation.errors.join('; '), platform: 'nexus', dryRun: true };
			}

			const artifactNames = release.artifacts
				.filter((f) => existsSync(f))
				.map((f) => basename(f));

			return {
				success: true,
				platform: 'nexus',
				dryRun: true,
				url: `(dry-run) would upload ${artifactNames.join(', ')} to ${nxConfig.gameDomain}/mods/${nxConfig.modId}`
			};
		}

		if (!apiKey) {
			return { success: false, error: 'No API key available', platform: 'nexus' };
		}

		if (!nxConfig.gameDomain || !nxConfig.modId) {
			return { success: false, error: 'Missing gameDomain or modId', platform: 'nexus' };
		}

		// Find an artifact to upload
		const artifact = release.artifacts.find((f) => existsSync(f));
		if (!artifact) {
			return { success: false, error: 'No artifacts found to upload', platform: 'nexus' };
		}

		try {
			// Step 1: Validate API key
			const validateResp = await fetch(`${NEXUS_API_BASE}/users/validate.json`, {
				headers: { apikey: apiKey, accept: 'application/json' }
			});

			if (!validateResp.ok) {
				return {
					success: false,
					error: `Nexus API key validation failed (${validateResp.status})`,
					platform: 'nexus'
				};
			}

			// Step 2: Upload file
			// Note: Nexus v1 file upload endpoint
			const fileData = await readFile(artifact);
			const fileName = nxConfig.fileName ?? basename(artifact);
			const uploadUrl = `${NEXUS_API_BASE}/games/${nxConfig.gameDomain}/mods/${nxConfig.modId}/files`;

			const formData = new FormData();
			formData.append('file', new Blob([fileData]), fileName);
			formData.append('name', `${release.projectName} v${release.version}`);
			formData.append('version', release.version);
			formData.append('category_name', nxConfig.fileCategory ?? 'main');
			formData.append('description', nxConfig.fileDescription ?? release.changelog);
			formData.append('new_existing', release.version === '1.0.0' ? '1' : '2');

			const uploadResp = await fetch(uploadUrl, {
				method: 'POST',
				headers: { apikey: apiKey },
				body: formData
			});

			if (!uploadResp.ok) {
				const body = await uploadResp.text();
				return {
					success: false,
					error: `Nexus upload failed (${uploadResp.status}): ${body}`,
					platform: 'nexus'
				};
			}

			const modUrl = `https://www.nexusmods.com/${nxConfig.gameDomain}/mods/${nxConfig.modId}`;
			return { success: true, url: modUrl, platform: 'nexus' };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, error: msg, platform: 'nexus' };
		}
	}
};
