// TASK 10.3 — provider / API-key PRESENCE + set (D-026: secrets via .env, NEVER rendered/committed).
//
// The /settings "API keys" panel manages the credentials driven sessions + direct chat use.
// D-026 is absolute: the server NEVER renders, logs, returns, or commits a secret VALUE — only
// its PRESENCE (set | unset). This module is the single boundary for that:
//
//   • describeKeyPresence(env) — given the runtime env (from $env/dynamic/private), report each
//        managed key's presence (set/unset) and a non-secret human label. NEVER the value, never
//        a masked prefix (even 4 chars of a token is a leak surface) — strictly the boolean.
//   • setEnvKey(filePath, key, value) — upsert ONE managed key in the .env file. The value is
//        written to .env (gitignored — never committed) and is NEVER echoed back in the result.
//        Refuses an unmanaged key (allow-list) and a value containing a newline (env-injection /
//        multi-line poisoning). Returns only { key, present } — no value, ever.
//
// .env is gitignored (see .gitignore + .env.example header). This module writes to it but never
// reads a value back out into any returned/logged surface — the round-trip a test asserts is
// "presence flips unset→set", proven by re-reading the file HERE and reporting only the boolean.

import { readFileSync, writeFileSync } from 'node:fs';

/** A managed credential key: the env var + a non-secret label + what it powers. */
export interface ManagedKey {
	/** The .env variable name. */
	key: string;
	/** Human label for the UI (non-secret). */
	label: string;
	/** What the credential powers (non-secret help text). */
	purpose: string;
}

/**
 * The credential keys /settings manages. Strictly an ALLOW-LIST — setEnvKey refuses anything
 * not here, so the UI can never be coerced into writing an arbitrary env var. Mirrors the
 * provider credentials in .env.example (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) — the
 * harness runtime reads CLAUDE_CODE_OAUTH_TOKEN for driven sessions (harness/wiring.ts) and the
 * Claude direct-chat adapter reads ANTHROPIC_API_KEY (providers/index.ts).
 */
export const MANAGED_KEYS: readonly ManagedKey[] = [
	{
		key: 'CLAUDE_CODE_OAUTH_TOKEN',
		label: 'Claude Code OAuth token',
		purpose: 'Credential for DRIVEN Claude Code sessions (the orchestrator + workflow runner). Required for a live spawn.'
	},
	{
		key: 'ANTHROPIC_API_KEY',
		label: 'Anthropic API key',
		purpose: 'Key for the Claude direct-chat provider (/chat) and Anthropic health probe.'
	}
] as const;

const MANAGED_SET = new Set<string>(MANAGED_KEYS.map((k) => k.key));

/** One managed key's PRESENCE — the ONLY thing the server reveals about a secret (D-026). */
export interface KeyPresence {
	key: string;
	label: string;
	purpose: string;
	/** True iff the env var is set to a non-empty value. The value itself is NEVER exposed. */
	present: boolean;
}

/** A loose env shape (what `$env/dynamic/private` exposes — a string→string|undefined map). */
export type EnvLike = Record<string, string | undefined>;

/**
 * Report each managed key's presence from the runtime env. NEVER returns a value or a masked
 * prefix — strictly the boolean (D-026). A whitespace-only value counts as UNSET (an empty
 * placeholder in .env is honestly "not set").
 */
export function describeKeyPresence(env: EnvLike): KeyPresence[] {
	return MANAGED_KEYS.map((m) => ({
		key: m.key,
		label: m.label,
		purpose: m.purpose,
		present: typeof env[m.key] === 'string' && (env[m.key] as string).trim().length > 0
	}));
}

/** Thrown when setEnvKey is given an unmanaged key or an unsafe value (boundary, D-016/D-026). */
export class EnvWriteError extends Error {
	override readonly name = 'EnvWriteError';
	constructor(message: string) {
		super(message);
	}
}

/** Result of a set — presence ONLY, never the value (D-026). */
export interface SetKeyResult {
	key: string;
	present: boolean;
}

/**
 * Upsert ONE managed key in the .env file. The value is written but NEVER returned/logged
 * (D-026). Refuses an unmanaged key (allow-list) and a value with a newline or NUL (env-file
 * injection / multi-line poisoning). An EMPTY value CLEARS the key (writes `KEY=`), an honest
 * "unset" — never an error. Preserves every other line in the file (a surgical line upsert, not
 * a re-serialize, so unrelated env vars + comments survive untouched).
 */
export function setEnvKey(filePath: string, key: string, value: string): SetKeyResult {
	if (!MANAGED_SET.has(key)) {
		throw new EnvWriteError(`refusing to write unmanaged env key "${key}"`);
	}
	if (/[\r\n\0]/.test(value)) {
		throw new EnvWriteError('value must not contain a newline or NUL character');
	}

	let text = '';
	try {
		text = readFileSync(filePath, 'utf8');
	} catch {
		text = ''; // .env doesn't exist yet → create it with just this line
	}

	const newline = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.length ? text.split(/\r?\n/) : [];
	const line = `${key}=${value}`;
	// A KEY= line is `key` followed by `=` (ignore commented `# KEY=` and indented lines).
	const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`);
	let replaced = false;
	for (let i = 0; i < lines.length; i++) {
		if (keyRe.test(lines[i])) {
			lines[i] = line;
			replaced = true;
			break;
		}
	}
	if (!replaced) lines.push(line);

	// Preserve a trailing newline if the original had one (or for a fresh file).
	let out = lines.join(newline);
	if (text === '' || text.endsWith('\n')) out += newline;

	writeFileSync(filePath, out, 'utf8');

	return { key, present: value.trim().length > 0 };
}
