// TASK 12.3 — the EXACT `npm publish` invocation a real publish WOULD run (recorded by the
// dry-run; the secret is NEVER rendered — D-026). NO live `npm publish` happens in this track:
// the builder describes the command + the registry PUT it performs; the driver records it; the
// operator supplies NPM_TOKEN + confirms later. Encoding the real shape now means the eventual
// live publish is a credential swap, not a rewrite.
//
// `npm publish` authenticates via an auth token. The standard CI form is an `.npmrc` line
//   //registry.npmjs.org/:_authToken=${NPM_TOKEN}
// (the token interpolated from the env at call time), then `npm publish --access <public|restricted>`.
// The token value NEVER appears in the rendered plan — it is shown as a redacted placeholder.

/** The redacted stand-in for NPM_TOKEN in any rendered command/.npmrc (D-026 — never a value). */
export const REDACTED_TOKEN = '<NPM_TOKEN — supplied from .env at call time>';

export interface NpmPublishPlanInput {
	name: string;
	version: string;
	registry: string;
	access: 'public' | 'restricted';
	/** The tarball filename npm pack would produce. */
	tarball: string;
	/** Whether NPM_TOKEN is set (presence only — never the value, D-026). */
	tokenPresent: boolean;
	/** Optional dist-tag (defaults to "latest"). */
	tag?: string;
}

/** The described `npm publish` invocation + the registry write it performs. */
export interface NpmPublishPlan {
	/** The `.npmrc` auth line npm reads (token redacted). */
	npmrcLine: string;
	/** The argv `npm publish` is invoked with (no secret — auth is via .npmrc/env). */
	argv: string[];
	/** The registry endpoint the publish PUTs the package version to. */
	registryPut: string;
	registry: string;
	access: 'public' | 'restricted';
	tag: string;
	tokenPresent: boolean;
}

/** Strip the scheme + trailing slash off a registry url to build the `.npmrc` auth key. */
function authKeyHost(registry: string): string {
	return registry.replace(/^https?:/i, '').replace(/\/+$/, '') + '/';
}

/**
 * Build the exact `npm publish` invocation a real publish would run. Deterministic, pure, no
 * network/shell. The token is rendered as `REDACTED_TOKEN`; the real value is read from the
 * resolver only at the real-call site (which this track does not reach).
 */
export function buildNpmPublishPlan(input: NpmPublishPlanInput): NpmPublishPlan {
	const tag = input.tag && input.tag.trim() ? input.tag.trim() : 'latest';
	const registry = input.registry.replace(/\/?$/, '/');
	const argv = ['npm', 'publish', '--access', input.access, '--tag', tag];
	// A non-default registry is passed explicitly so the publish is reproducible.
	if (registry !== 'https://registry.npmjs.org/') {
		argv.push('--registry', registry);
	}
	return {
		npmrcLine: `//${authKeyHost(registry)}:_authToken=${REDACTED_TOKEN}`,
		argv,
		registryPut: `PUT ${registry}${encodeURIComponent(input.name)}`,
		registry,
		access: input.access,
		tag,
		tokenPresent: input.tokenPresent
	};
}

/** Render the plan as ordered human-readable step lines for the dry-run surface (no secret). */
export function npmPlanToSteps(plan: NpmPublishPlan): string[] {
	return [
		`Auth: write ${plan.npmrcLine} (token from .env at call time — redacted here)`,
		`Invoke: ${plan.argv.join(' ')}`,
		`Registry write: ${plan.registryPut} (dist-tag "${plan.tag}", access "${plan.access}")`
	];
}
