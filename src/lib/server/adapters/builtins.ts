// TASK 12.1 — the BUILT-IN D-037 adapters (npm + Thunderstore publishers; a static-host deploy
// target). These prove the framework end-to-end against the contract harness + dry-run; this
// track performs NO real external publish/deploy — a real push needs operator-supplied creds
// (D-026) and lands later. 12.2/12.3 deepen Thunderstore + add more targets against this CORE.
//
// Each adapter is HONEST (F-008): probe() reports availability + the named secrets it needs
// (presence only, D-026); package()/publish()/deploy() compute a real plan from the project
// manifest; a real (non-dry-run) action is GATED by the caller (D-018) and, in this track,
// returns an honest "real publish deferred — supply <SECRET> and confirm" rather than calling
// out. The manifest read is the only filesystem touch; it is confined to the project cwd.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	AdapterProbe,
	AdapterRunOptions,
	AdapterRunResult,
	DeployStatus,
	DeployTarget,
	PackageResult,
	PublishValidation,
	PublisherAdapter,
	SecretRequirement,
	SecretResolver
} from './types';

/** Read + parse a JSON manifest under the project cwd; null when absent/unreadable (honest). */
async function readManifest(cwd: string, file: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await readFile(join(cwd, file), 'utf8');
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The honest "real action deferred to operator credentials" line every built-in shares. */
function deferReal(secretName: string): string {
	return `Real publish/deploy not performed in this track — supply ${secretName} in .env and confirm the gated action (D-026).`;
}

// ── npm publisher ───────────────────────────────────────────────────────────────────
//
// Publishes a Node package to the npm registry. Reads package.json for name/version + the
// `private` flag + `files`. Dry-run computes the `npm publish --dry-run`-equivalent plan from
// the manifest with no network. Credential: NPM_TOKEN (operator-supplied, never stored).

export class NpmPublisherAdapter implements PublisherAdapter {
	readonly id = 'npm';
	readonly label = 'npm registry';
	readonly kind = 'publish' as const;

	secrets(): SecretRequirement[] {
		return [
			{
				envVar: 'NPM_TOKEN',
				label: 'npm auth token',
				purpose: 'Authenticates `npm publish` to the registry. Required for a real publish.',
				required: true
			}
		];
	}

	async probe(opts: { cwd: string; secrets: SecretResolver }): Promise<AdapterProbe> {
		const pkg = await readManifest(opts.cwd, 'package.json');
		if (!pkg) {
			return { available: false, reason: 'No package.json found in the project root.' };
		}
		if (pkg.private === true) {
			return { available: false, reason: 'package.json is marked "private": true — npm refuses to publish it.' };
		}
		const name = typeof pkg.name === 'string' ? pkg.name : undefined;
		if (!name) return { available: false, reason: 'package.json has no "name".' };
		const hasToken = opts.secrets.has('NPM_TOKEN');
		return {
			available: true,
			target: `npm:${name}`,
			...(hasToken ? {} : { reason: 'NPM_TOKEN is not set — dry-run only until you supply it.' })
		};
	}

	async validate(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PublishValidation> {
		const pkg = await readManifest(opts.cwd, 'package.json');
		const blockers: string[] = [];
		const warnings: string[] = [];
		if (!pkg) blockers.push('No package.json found.');
		else {
			if (pkg.private === true) blockers.push('package.json is "private": true.');
			if (typeof pkg.name !== 'string' || !pkg.name) blockers.push('package.json has no "name".');
			if (typeof pkg.version !== 'string' || !pkg.version) blockers.push('package.json has no "version".');
			if (!opts.secrets.has('NPM_TOKEN')) warnings.push('NPM_TOKEN is not set — a real publish will fail.');
		}
		return { ok: blockers.length === 0, blockers, warnings };
	}

	async package(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PackageResult> {
		const pkg = await readManifest(opts.cwd, 'package.json');
		const name = typeof pkg?.name === 'string' ? pkg.name : '(unknown)';
		const version = typeof pkg?.version === 'string' ? pkg.version : '(unknown)';
		const files = Array.isArray(pkg?.files) ? (pkg!.files as unknown[]).map(String) : ['(npm default file set)'];
		return {
			target: `npm:${name}`,
			dryRun: true,
			ok: pkg != null,
			summary: pkg ? `Would package ${name}@${version}` : 'No package.json to package.',
			steps: [
				`Read package.json (${name}@${version})`,
				`Resolve file set: ${files.join(', ')}`,
				`Compute tarball name ${name}-${version}.tgz`
			],
			warnings: [],
			...(pkg ? { artifact: { name, version } } : {})
		};
	}

	async publish(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult> {
		const v = await this.validate(opts);
		const pkg = await readManifest(opts.cwd, 'package.json');
		const name = typeof pkg?.name === 'string' ? pkg.name : '(unknown)';
		const version = typeof pkg?.version === 'string' ? pkg.version : '(unknown)';
		const target = `npm:${name}`;
		const dryRun = opts.dryRun ?? true;

		if (!v.ok) {
			return { target, dryRun, ok: false, summary: `Not publishable: ${v.blockers.join('; ')}`, steps: [], warnings: v.warnings };
		}
		const plan = [
			`npm publish --access public (${name}@${version})`,
			'Authenticate via NPM_TOKEN',
			'Push tarball to registry.npmjs.org'
		];
		if (dryRun) {
			return { target, dryRun: true, ok: true, summary: `Dry-run: would publish ${name}@${version} to npm.`, steps: plan, warnings: v.warnings };
		}
		// Real publish is GATED + deferred in this track (no external call — D-026).
		return {
			target,
			dryRun: false,
			ok: false,
			summary: `Publish of ${name}@${version} prepared but not executed.`,
			steps: plan,
			warnings: [...v.warnings, deferReal('NPM_TOKEN')]
		};
	}
}

// ── Thunderstore publisher (SWIP/ROUNDS mods — the operator's live target) ──────────────
//
// DEEPENED in TASK 12.2: the real packager + preflight validator + dry-run-by-default upload-API
// request shape lives in ./thunderstore/. The class is re-exported here so the registry + the
// barrel keep their existing import surface (index.ts imports it from builtins.ts).
export { ThunderstorePublisherAdapter } from './thunderstore/adapter';

// ── Static-host deploy target (the reference DeployTarget) ──────────────────────────────
//
// Deploys a built site/artifact to a static host. config.{publishDir, host} describe where;
// a real deploy needs DEPLOY_TOKEN (operator-supplied). Dry-run computes the plan. status()
// honestly reports "unknown" until a real deploy lands (this track never performs one).

export class StaticHostDeployTarget implements DeployTarget {
	readonly id = 'static-host';
	readonly label = 'Static host';
	readonly kind = 'deploy' as const;

	secrets(): SecretRequirement[] {
		return [
			{
				envVar: 'DEPLOY_TOKEN',
				label: 'Static-host deploy token',
				purpose: 'Authenticates an upload to the static host. Required for a real deploy.',
				required: true
			}
		];
	}

	#host(config?: Record<string, unknown>): string {
		const h = config && typeof config.host === 'string' ? config.host : 'static-host';
		return h;
	}

	async probe(opts: { cwd: string; secrets: SecretResolver; config?: Record<string, unknown> }): Promise<AdapterProbe> {
		const host = this.#host(opts.config);
		const hasToken = opts.secrets.has('DEPLOY_TOKEN');
		return {
			available: true,
			target: host,
			...(hasToken ? {} : { reason: 'DEPLOY_TOKEN is not set — dry-run only until you supply it.' })
		};
	}

	async deploy(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult> {
		const host = this.#host(opts.config);
		const dir = opts.config && typeof opts.config.publishDir === 'string' ? opts.config.publishDir : 'build';
		const dryRun = opts.dryRun ?? true;
		const plan = [`Resolve publish dir "${dir}"`, `Authenticate to ${host} via DEPLOY_TOKEN`, `Upload ${dir}/ to ${host}`];
		if (dryRun) {
			return { target: host, dryRun: true, ok: true, summary: `Dry-run: would deploy ${dir}/ to ${host}.`, steps: plan, warnings: [] };
		}
		return {
			target: host,
			dryRun: false,
			ok: false,
			summary: `Deploy of ${dir}/ to ${host} prepared but not executed.`,
			steps: plan,
			warnings: [deferReal('DEPLOY_TOKEN')]
		};
	}

	async status(opts: { cwd: string; secrets: SecretResolver; config?: Record<string, unknown> }): Promise<DeployStatus> {
		// Honest: no real deploy is performed in this track, so the live state is unknown.
		return { state: 'unknown', detail: 'No deploy has been performed through this adapter yet.', url: this.#host(opts.config) };
	}
}
