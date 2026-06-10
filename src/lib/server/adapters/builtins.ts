// TASK 12.1 — the BUILT-IN D-037 adapters barrel. Publishers (npm, Thunderstore, GitHub releases)
// + a static-host deploy target. These prove the framework end-to-end against the contract harness
// + dry-run; this track performs NO real external publish/deploy — a real push needs
// operator-supplied creds (D-026) and lands later.
//
// Each adapter is HONEST (F-008): probe() reports availability + the named secrets it needs
// (presence only, D-026); package()/publish()/deploy() compute a real plan from the project
// manifest; a real (non-dry-run) action is GATED by the caller (D-018) and, in this track,
// returns an honest "real publish deferred — supply <SECRET> and confirm" rather than calling out.
//
// The publishers are DEEPENED into their own modules (./npm, ./thunderstore, ./github-releases):
//   • npm (TASK 12.3)           — real `npm pack` selection + name/version/private/registry rules
//                                 + the exact `npm publish` invocation (./npm/adapter.ts).
//   • Thunderstore (TASK 12.2)  — real packager + preflight + the 4-step upload shape (./thunderstore).
//   • GitHub releases (TASK 12.3) — assemble release (REUSE the 11.2 changelog source) + attach
//                                 artifacts + the exact gh release-create request (./github-releases).
// They are re-exported here so the registry + the barrel keep their existing import surface.

import type {
	AdapterProbe,
	AdapterRunOptions,
	AdapterRunResult,
	DeployStatus,
	DeployTarget,
	SecretRequirement,
	SecretResolver
} from './types';

export { NpmPublisherAdapter } from './npm/adapter';
export { ThunderstorePublisherAdapter } from './thunderstore/adapter';
export { GitHubReleasesPublisherAdapter } from './github-releases/adapter';

/** The honest "real action deferred to operator credentials" line the deploy target shares. */
function deferReal(secretName: string): string {
	return `Real publish/deploy not performed in this track — supply ${secretName} in .env and confirm the gated action (D-026).`;
}

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
