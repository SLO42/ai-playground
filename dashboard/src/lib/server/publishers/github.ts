/**
 * GitHub Releases publisher.
 *
 * Wraps the `gh` CLI to create GitHub releases with optional draft/prerelease
 * flags and file attachments.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { ReleasePublisher, PublisherConfig, ReleaseInfo, PublishResult, PublisherValidation } from './types.js';

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 30_000, windowsHide: true, shell: true };

function isGhAvailable(): boolean {
	try {
		execSync('gh --version', { ...EXEC_OPTS, timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

export interface GitHubPublisherConfig extends PublisherConfig {
	draft?: boolean;
	prerelease?: boolean;
	/** GitHub repo in owner/repo format; auto-detected from git remote if omitted */
	repo?: string;
}

export const githubPublisher: ReleasePublisher = {
	id: 'github',
	name: 'GitHub Releases',
	platforms: ['github'],

	validate(config: PublisherConfig): PublisherValidation {
		const errors: string[] = [];

		if (!isGhAvailable()) {
			errors.push('The `gh` CLI is not installed or not on PATH');
		}

		// gh handles auth via its own login; no token required in config
		return { valid: errors.length === 0, errors };
	},

	async publish(release: ReleaseInfo, config: PublisherConfig, dryRun = false): Promise<PublishResult> {
		const ghConfig = config as GitHubPublisherConfig;
		const tagName = release.version.startsWith('v') ? release.version : `v${release.version}`;

		if (dryRun) {
			const validation = this.validate(config);
			if (!validation.valid) {
				return { success: false, error: validation.errors.join('; '), platform: 'github', dryRun: true };
			}
			return {
				success: true,
				platform: 'github',
				dryRun: true,
				url: `(dry-run) would create release ${tagName} for ${release.projectName}`
			};
		}

		try {
			const flags: string[] = [];
			if (ghConfig.draft) flags.push('--draft');
			if (ghConfig.prerelease) flags.push('--prerelease');
			if (ghConfig.repo) flags.push(`--repo "${ghConfig.repo}"`);

			// Attach artifacts
			const attachments = release.artifacts
				.filter((f) => existsSync(f))
				.map((f) => `"${f}"`)
				.join(' ');

			const safeNotes = release.changelog.replace(/"/g, '\\"');
			const cmd = [
				`gh release create "${tagName}"`,
				`--title "${tagName}"`,
				`--notes "${safeNotes}"`,
				...flags,
				attachments
			]
				.filter(Boolean)
				.join(' ');

			const output = execSync(cmd, { ...EXEC_OPTS, cwd: release.projectPath }).toString().trim();
			const url = output || undefined;

			return { success: true, url, platform: 'github' };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, error: msg, platform: 'github' };
		}
	}
};
