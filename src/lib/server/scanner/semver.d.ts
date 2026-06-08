// Minimal ambient types for the `semver` package (no @types/semver installed; we use only
// the four functions the dependency detector needs). The runtime package is real + tested;
// this just gives TypeScript the shapes of the calls in dependencies.ts. (TASK 3.2)
declare module 'semver' {
	interface SemVer {
		version: string;
	}
	interface Options {
		includePrerelease?: boolean;
		loose?: boolean;
	}
	/** Returns the normalized version string, or null if not a valid single version. */
	export function valid(version: string, options?: Options): string | null;
	/** Lowest version a range admits, or null if the range is invalid. */
	export function minVersion(range: string, options?: Options): SemVer | null;
	/** True if `version` falls within `range`. */
	export function satisfies(version: string, range: string, options?: Options): boolean;
	/** True if `a` is strictly less than `b`. */
	export function lt(a: string | SemVer, b: string | SemVer, options?: Options): boolean;
	const semver: {
		valid: typeof valid;
		minVersion: typeof minVersion;
		satisfies: typeof satisfies;
		lt: typeof lt;
	};
	export default semver;
}
