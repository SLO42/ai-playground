/**
 * npm publisher.
 *
 * Wraps `npm publish` for Node.js packages. Reads package.json for
 * metadata and supports dry-run via `npm publish --dry-run`.
 */
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { ReleasePublisher, PublisherConfig, ReleaseInfo, PublishResult, PublisherValidation } from './types.js';

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 60_000, windowsHide: true, shell: true };

export interface NpmPublisherConfig extends PublisherConfig {
	/** npm auth token. Falls back to env NPM_TOKEN or .npmrc. */
	authToken?: string;
	/** Registry URL (default: https://registry.npmjs.org/) */
	registry?: string;
	/** npm tag (e.g., 'latest', 'next', 'beta') */
	tag?: string;
	/** Publish with public access (for scoped packages) */
	access?: 'public' | 'restricted';
	/** OTP for 2FA-enabled accounts */
	otp?: string;
}

interface PackageJson {
	name?: string;
	version?: string;
	private?: boolean;
}

async function readPackageJson(projectPath: string): Promise<PackageJson | null> {
	try {
		const raw = await readFile(resolve(projectPath, 'package.json'), 'utf-8');
		return JSON.parse(raw) as PackageJson;
	} catch {
		return null;
	}
}

export const npmPublisher: ReleasePublisher = {
	id: 'npm',
	name: 'npm Registry',
	platforms: ['npm', 'npmjs'],

	validate(config: PublisherConfig): PublisherValidation {
		const errors: string[] = [];

		// npm auth can come from many sources: token, .npmrc, npm login
		// We just verify npm is available
		try {
			execSync('npm --version', { ...EXEC_OPTS, timeout: 5_000 });
		} catch {
			errors.push('npm CLI is not installed or not on PATH');
		}

		return { valid: errors.length === 0, errors };
	},

	async publish(release: ReleaseInfo, config: PublisherConfig, dryRun = false): Promise<PublishResult> {
		const npmConfig = config as NpmPublisherConfig;

		// Check for package.json
		const pkg = await readPackageJson(release.projectPath);
		if (!pkg) {
			return {
				success: false,
				error: 'No package.json found in project root',
				platform: 'npm'
			};
		}

		if (pkg.private) {
			return {
				success: false,
				error: 'Package is marked as private in package.json',
				platform: 'npm'
			};
		}

		// Build the npm publish command
		const args: string[] = ['npm publish'];

		if (dryRun) args.push('--dry-run');
		if (npmConfig.tag) args.push(`--tag ${npmConfig.tag}`);
		if (npmConfig.access) args.push(`--access ${npmConfig.access}`);
		if (npmConfig.otp) args.push(`--otp ${npmConfig.otp}`);
		if (npmConfig.registry) args.push(`--registry ${npmConfig.registry}`);

		// Set token via environment if provided
		const env: Record<string, string> = { ...process.env } as Record<string, string>;
		const token = npmConfig.authToken ?? process.env.NPM_TOKEN;
		if (token) {
			const registry = npmConfig.registry ?? 'https://registry.npmjs.org/';
			const registryHost = new URL(registry).host;
			env[`npm_config_//${registryHost}/:_authToken`] = token;
		}

		try {
			const cmd = args.join(' ');
			const output = execSync(cmd, {
				...EXEC_OPTS,
				cwd: release.projectPath,
				env
			}).toString().trim();

			if (dryRun) {
				return {
					success: true,
					platform: 'npm',
					dryRun: true,
					url: `(dry-run) npm publish for ${pkg.name ?? release.projectName}@${release.version}\n${output}`
				};
			}

			const packageUrl = pkg.name
				? `https://www.npmjs.com/package/${pkg.name}/v/${release.version}`
				: undefined;

			return { success: true, url: packageUrl, platform: 'npm' };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, error: msg, platform: 'npm' };
		}
	}
};
