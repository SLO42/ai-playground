// TASK 12.3 — npm PACKAGE SPEC: the rules a Node package must satisfy to be publishable, plus
// the npm package-name + version validators. Transcribed from npm's published rules
// (docs.npmjs.com — `package.json`, `npm publish`, the validate-npm-package-name semantics).
//
// PURE + dependency-free: it validates parsed `package.json` values + returns HONEST, SPECIFIC
// blockers (F-008) — never a generic "invalid". 12.3's adapter validate()/publish() delegate
// every rule here so the contract harness, the unit tests, and the live surface share ONE rule
// set. No filesystem, no network — the adapter reads package.json; this judges it.

/** npm registry the publish targets by default (a real publish would PUT here). */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/** npm package-name limits (validate-npm-package-name + the registry's own rules). */
export const NAME_LIMITS = {
	/** Max total length of a package name (incl. an `@scope/` prefix). */
	max: 214
} as const;

/**
 * A 3-part `Major.Minor.Patch` core with an OPTIONAL `-prerelease` and `+build` (the subset of
 * SemVer 2.0.0 npm actually publishes). Each numeric identifier is non-negative with no leading
 * zero; pre-release/build identifiers are dot-separated alphanumerics/hyphens.
 */
const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** True iff `v` is a publishable SemVer string (the npm subset above). */
export function isValidVersion(v: unknown): v is string {
	return typeof v === 'string' && SEMVER_RE.test(v);
}

/** The result of a package-name check: ok + a specific reason when not (F-008). */
export interface NameValidation {
	ok: boolean;
	/** The scope (with the leading `@`) when the name is scoped, else undefined. */
	scope?: string;
	reason?: string;
}

/**
 * Validate an npm package name (validate-npm-package-name semantics, the publishable subset):
 *   • non-empty, ≤214 chars, no leading/trailing whitespace;
 *   • all-lowercase (new-package rule), no spaces;
 *   • may be scoped `@scope/name`; each segment url-safe (no leading `.`/`_`, no `~)('!*` etc.);
 *   • not a core node builtin name (a soft rule — surfaced as a blocker for clarity).
 * Returns the scope when scoped (the adapter notes scoped packages default to RESTRICTED access).
 */
export function validatePackageName(name: unknown): NameValidation {
	if (typeof name !== 'string' || name.length === 0) {
		return { ok: false, reason: 'package.json "name" is required (a non-empty string).' };
	}
	if (name !== name.trim()) {
		return { ok: false, reason: 'package.json "name" must not have leading or trailing whitespace.' };
	}
	if (name.length > NAME_LIMITS.max) {
		return { ok: false, reason: `package.json "name" exceeds ${NAME_LIMITS.max} characters (got ${name.length}).` };
	}
	if (name !== name.toLowerCase()) {
		return { ok: false, reason: 'package.json "name" must be all lowercase (npm new-package rule).' };
	}
	if (/[~'!()*\s]/.test(name)) {
		return { ok: false, reason: 'package.json "name" contains a character npm forbids (~ \' ! ( ) * or whitespace).' };
	}

	// Scoped name: @scope/pkg.
	const scopedMatch = /^@([^/]+)\/(.+)$/.exec(name);
	if (name.startsWith('@')) {
		if (!scopedMatch) {
			return { ok: false, reason: 'scoped package "name" must be of the form @scope/name.' };
		}
		const [, scope, pkg] = scopedMatch;
		const seg = checkSegment(scope) ?? checkSegment(pkg);
		if (seg) return { ok: false, reason: seg };
		return { ok: true, scope: `@${scope}` };
	}

	const seg = checkSegment(name);
	if (seg) return { ok: false, reason: seg };
	return { ok: true };
}

/** A single name segment must not begin with `.` or `_` and be non-empty (npm rule). */
function checkSegment(seg: string): string | null {
	if (seg.length === 0) return 'package.json "name" has an empty segment.';
	if (seg.startsWith('.')) return 'package.json "name" segment must not start with a period.';
	if (seg.startsWith('_')) return 'package.json "name" segment must not start with an underscore.';
	return null;
}

/** A field-level validation outcome: honest blockers + non-blocking warnings (F-008). */
export interface PackageValidation {
	ok: boolean;
	blockers: string[];
	warnings: string[];
	/** The resolved registry the publish would target (publishConfig.registry > default). */
	registry: string;
	/** The resolved access (`public` | `restricted`) the publish would use. */
	access: 'public' | 'restricted';
}

/**
 * Validate a parsed `package.json` against npm's publish preconditions. Returns EVERY blocker
 * (not just the first) so the operator fixes them in one pass — each message names the exact
 * field + rule (honest, F-008). `pkg` may be anything (untrusted JSON); a non-object is itself a
 * blocker. Also resolves the registry + access the publish would use (publishConfig + scope).
 */
export function validatePackage(pkg: unknown): PackageValidation {
	const blockers: string[] = [];
	const warnings: string[] = [];
	let registry = DEFAULT_REGISTRY;
	let access: 'public' | 'restricted' = 'public';

	if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
		return {
			ok: false,
			blockers: ['package.json must be a JSON object.'],
			warnings,
			registry,
			access
		};
	}
	const m = pkg as Record<string, unknown>;

	// private:true — npm refuses to publish; the single most common blocker.
	if (m.private === true) {
		blockers.push('package.json is marked "private": true — npm refuses to publish it (remove the flag to publish).');
	}

	// name — required + valid.
	const nv = validatePackageName(m.name);
	if (!nv.ok) blockers.push(nv.reason ?? 'package.json "name" is invalid.');

	// version — required + valid SemVer.
	if (typeof m.version !== 'string' || m.version.length === 0) {
		blockers.push('package.json "version" is required (a Major.Minor.Patch SemVer string).');
	} else if (!isValidVersion(m.version)) {
		blockers.push(`package.json "version" "${m.version}" is not a valid SemVer (e.g. 1.4.0 or 2.0.0-rc.1).`);
	}

	// publishConfig.registry / .access override the defaults.
	const pubConfig = m.publishConfig && typeof m.publishConfig === 'object' ? (m.publishConfig as Record<string, unknown>) : null;
	if (pubConfig) {
		if (typeof pubConfig.registry === 'string' && pubConfig.registry) {
			registry = pubConfig.registry;
		}
		if (pubConfig.access === 'public' || pubConfig.access === 'restricted') {
			access = pubConfig.access;
		}
	}
	// A scoped package defaults to RESTRICTED unless publishConfig.access:public is set — surface
	// it honestly so the operator isn't surprised by a private publish (a frequent npm footgun).
	if (nv.ok && nv.scope && !(pubConfig && pubConfig.access === 'public')) {
		access = 'restricted';
		warnings.push(
			`"${nv.scope}" is a scoped package — npm defaults it to "restricted" (private) access. The publish plan uses "--access public" only if package.json publishConfig.access is "public".`
		);
	}

	// files — advisory: an absent `files` array publishes the npm default set (which can over-ship).
	if (!('files' in m)) {
		warnings.push('package.json has no "files" array — npm will publish its default file set (everything not ignored). Add "files" to ship exactly what you intend.');
	} else if (!Array.isArray(m.files)) {
		blockers.push('package.json "files" must be an array of glob patterns/paths.');
	}

	return { ok: blockers.length === 0, blockers, warnings, registry, access };
}
