// TASK 12.1 — credential confinement for the D-037 adapter framework (D-026).
//
// The named-secret indirection: an adapter's per-project config stores a SECRET NAME (an
// env-var name), NEVER a secret value. At call time the framework resolves each declared name
// from the runtime env (`$env/dynamic/private` → a string map) and hands the adapter a
// `SecretResolver` SCOPED to exactly the names it declared. The value never enters the DB, a
// log, a returned surface, or the adapter's reach beyond its own declared names.
//
// This generalizes config/env-presence.ts (10.3), which is a FIXED allow-list of provider
// keys; here the allow-list is DERIVED per-adapter from `adapter.secrets()`, so a novel
// per-project adapter can declare its own credential names without a core change (D-037).

import type {
	BaseAdapter,
	SecretPresence,
	SecretRequirement,
	SecretResolver
} from './types';
import { SecretConfinementError } from './types';

/** A loose env shape (what `$env/dynamic/private` exposes — a string→string|undefined map). */
export type EnvLike = Record<string, string | undefined>;

/** True iff an env var is set to a non-whitespace value (a blank placeholder is "unset"). */
function isPresent(env: EnvLike, name: string): boolean {
	const v = env[name];
	return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Build a `SecretResolver` SCOPED to an adapter's declared secret names. The resolver reads
 * ONLY those names from `env`; any other name throws `SecretConfinementError` (fail closed,
 * D-026). The value is exposed via `get` only for authentication at call time — the framework
 * never persists or logs it.
 */
export function makeSecretResolver(env: EnvLike, requirements: SecretRequirement[]): SecretResolver {
	const declared = new Set(requirements.map((r) => r.envVar));
	return {
		has(envVar: string): boolean {
			if (!declared.has(envVar)) throw new SecretConfinementError(envVar);
			return isPresent(env, envVar);
		},
		get(envVar: string): string | undefined {
			if (!declared.has(envVar)) throw new SecretConfinementError(envVar);
			const v = env[envVar];
			return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
		}
	};
}

/**
 * Describe each of an adapter's declared secrets as PRESENCE ONLY (D-026) — the surface uses
 * this to tell the operator which credentials to set in .env. NEVER returns a value or a
 * masked prefix; strictly the boolean + the non-secret label/purpose.
 */
export function describeSecrets(env: EnvLike, requirements: SecretRequirement[]): SecretPresence[] {
	return requirements.map((r) => ({
		envVar: r.envVar,
		label: r.label,
		purpose: r.purpose,
		required: r.required ?? false,
		present: isPresent(env, r.envVar)
	}));
}

/** Convenience: presence for a whole adapter (reads adapter.secrets()). */
export function describeAdapterSecrets(env: EnvLike, adapter: BaseAdapter): SecretPresence[] {
	return describeSecrets(env, adapter.secrets());
}

/** Convenience: a scoped resolver for a whole adapter (reads adapter.secrets()). */
export function resolverForAdapter(env: EnvLike, adapter: BaseAdapter): SecretResolver {
	return makeSecretResolver(env, adapter.secrets());
}

/**
 * True iff every REQUIRED secret an adapter declares is present in `env`. Adapters with no
 * required secrets (dry-run-only / unauthenticated probes) return true. Used by the surface to
 * decide whether a REAL (non-dry-run) action is even attemptable — honestly (F-008).
 */
export function requiredSecretsPresent(env: EnvLike, adapter: BaseAdapter): boolean {
	return adapter
		.secrets()
		.filter((r) => r.required)
		.every((r) => isPresent(env, r.envVar));
}
