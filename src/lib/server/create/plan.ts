// server/create/plan.ts — the generative PLAN half of Create-with-AI (CREATE-SPEC §2.1-2.3, §3).
//
// NOTHING here touches disk or writes the DB. This module produces a CONFIRM-GATED, EPHEMERAL
// creation proposal: given a brief {name, description, hints?}, it runs a cheap-tier READ-ONLY
// agent (injected seam — mirrors how launchSession's backend is stubbed in tests) that returns a
// STRUCTURED proposal, validates it (anti-sycophancy §3 + D-026 no-secret-echo + D-039
// objective/purpose + defect_class enum), and mints a confirmToken (sha256 over the canonicalized
// proposal — the planEdit shape) the executor re-submits. The proposal is returned to the caller
// and re-submitted at execute; nothing is persisted (D-010: nothing touches disk before confirm).
//
// Honest (F-008): stack/layout derive from the brief+hints+reference, never fabricated. The agent
// MAY read a reference repo as PRIOR ART (read-only) for §2.1 greenfield-with-reference, but it
// generates a FRESH scaffold — NOT adoption (adopt is the scanner's job, fork 1 LOCKED greenfield).

import type { Db } from '../db/client';
import { listDefectClassVocabulary } from '../workforce/capability-match';
import { screen } from '../memory/screen';
import { stableStringify } from '../cc-config/index';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { assertNoSycophancy, SycophancyError } from './anti-sycophancy';
import type { AdapterKind } from '../adapters/types';
import type { ProjectTemplate } from './templates';

// ── Brief (input) ───────────────────────────────────────────────────────────────

/** Optional hints that steer the generator (CREATE-SPEC §2 step 1). All optional. */
export interface CreateHints {
	/** Ecosystem hint, e.g. 'node' | 'rust' | 'python' (free text — the agent specializes). */
	ecosystem?: string;
	/** A reference repo URL to mine as PRIOR ART (read-only). Greenfield only — not adoption. */
	refRepoUrl?: string;
	/** Target platform hint, e.g. 'web' | 'cli' | 'github-pages'. */
	targetPlatform?: string;
}

/** The brief the operator submits (CREATE-SPEC §2 step 1). */
export interface CreateBrief {
	name: string;
	description: string;
	hints?: CreateHints;
}

/** A language → ecosystem mapping for template-derived brief hints (CT-4 pre-fill). */
const ECOSYSTEM_BY_LANGUAGE: ReadonlyMap<string, string> = new Map([
	['typescript', 'node'],
	['javascript', 'node'],
	['python', 'python'],
	['go', 'go'],
	['rust', 'rust'],
	['ruby', 'ruby'],
	['java', 'jvm'],
	['c#', 'dotnet']
]);

/**
 * A tag → targetPlatform mapping for template-derived brief hints (CT-4 pre-fill). The FIRST tag
 * (in this priority order) that the template carries wins — more specific platform tags before the
 * generic 'web'. Returns undefined when no tag maps (honest absence, not a fabricated default).
 */
const TARGET_PLATFORM_BY_TAG: ReadonlyArray<readonly [string, string]> = [
	['minecraft', 'minecraft'],
	['bg3', 'bg3'],
	['unity', 'unity'],
	['game', 'game'],
	['mod', 'game'],
	['cli', 'cli'],
	['mcp', 'mcp'],
	['agent', 'agent'],
	['web', 'web']
];

/**
 * Pure helper (CT-4): derive optional brief HINTS from a template's declared language + tags so the
 * create UI can PRE-FILL the ecosystem / target-platform fields when the operator picks a template.
 * Best-effort and HONEST (F-008): only fields that genuinely map are returned — an unmapped language
 * or tag yields no key (never a fabricated guess). No I/O; depends only on its argument.
 *
 * Shadow paths: a template with an empty language → no `ecosystem`; with no mapping tag → no
 * `targetPlatform`; both empty → an empty object (the UI pre-fills nothing).
 */
export function briefHintsFromTemplate(template: ProjectTemplate): {
	ecosystem?: string;
	targetPlatform?: string;
} {
	const out: { ecosystem?: string; targetPlatform?: string } = {};
	const lang = template.language?.trim().toLowerCase() ?? '';
	const ecosystem = ECOSYSTEM_BY_LANGUAGE.get(lang);
	if (ecosystem) out.ecosystem = ecosystem;

	const tags = new Set((template.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
	for (const [tag, platform] of TARGET_PLATFORM_BY_TAG) {
		if (tags.has(tag)) {
			out.targetPlatform = platform;
			break;
		}
	}
	return out;
}

// ── Proposal (output) ─────────────────────────────────────────────────────────────

/** The plan macro draft — Project-Plan-v3 shape (purpose/vision/role/DoD), DATA-MODEL §4.1. */
export interface PlanMacroDraft {
	purpose: string;
	vision: string;
	role: string;
	/** The project's Definition of Done (D-038-shaped, project-specific). */
	definition_of_done: string;
}

/**
 * A founding task draft (D-039 Act-with-Purpose): objective + purpose are MANDATORY — a task
 * with no stated purpose is rejected at validation, never born. 3-7 of these (fork 4 milestone-
 * level, LOCKED). These are DRAFTS — they become real `task` rows ONLY at execute (CA-2), not here.
 */
export interface FoundingTaskDraft {
	objective: string;
	purpose: string;
}

/** A deploy/publish target draft (D-037) — {adapterId, config}. config is env-NAMES only (D-026). */
export interface TargetDraft {
	kind: AdapterKind;
	adapterId: string;
	config: Record<string, unknown>;
}

/**
 * An honest record of a proposal value that LOOKED secret-like and was REDACTED in place (kept, not
 * discarded) before the proposal was returned (D-026 redact-and-keep, mirrors the scaffold-write
 * ScaffoldRedaction). The RETURNED proposal carries the redacted text only — never the raw value
 * (D-026: no raw secret in a returned proposal object). The review UI surfaces these so the operator
 * sees "a config value looked secret-like; use ${ENV_NAME}".
 */
export interface ConfigRedaction {
	/** The dotted field path of the redacted value, e.g. `targetDrafts[0].config.password`. */
	field: string;
	/** Short machine reason: a screen rule id, 'secret-like-key', or 'credential-shaped-token'. */
	reason: string;
}

/**
 * Capability needs draft (workforce capability-match shape). `defect_classes` carries ONLY classes
 * that are in the operator-confirmed vocabulary (confirmed + matchable, §3 D4). A class the agent
 * proposes that is NOT yet in the vocabulary is CAPTURED separately in `proposed_defect_classes`
 * (an explicit HIRE-gap signal that feeds the future pm-hr-handoff hire) — it is NEVER promoted to
 * a confirmed/matchable class without an operator key (D4 LOCKED). This is the new-domain
 * (e.g. BepInEx) chicken-and-egg fix: a brand-new domain has no confirmed classes yet, so we record
 * the need instead of hard-failing the whole proposal.
 */
export interface CapabilityNeedsDraft {
	languages: string[];
	frameworks: string[];
	/** Classes IN the operator-confirmed vocabulary — confirmed + matchable. */
	defect_classes: string[];
	/** Classes the agent proposed that are NOT (yet) in the vocabulary — captured as a HIRE signal,
	 *  never confirmed/matchable until an operator key mints them (D4 LOCKED). */
	proposed_defect_classes: string[];
}

/**
 * A clarifier (CREATE-SPEC §2 step 1 + §3): a position-taking question the agent asks ONLY where
 * the brief genuinely forks. 2-4 ONLY (G4: number wins over the must-not-interrogate rail). Each
 * states a POSITION and pairs it with its FALSIFIER — and contains ZERO banned phrases (§3).
 */
export interface Clarifier {
	/** The forking question. */
	question: string;
	/** The position the agent takes on the evidence in the brief (not a strawman). */
	position: string;
	/** The evidence that would change the position (CREATE-SPEC §3 — every position has one). */
	falsifier: string;
}

/** The structured proposal the agent returns (CREATE-SPEC §2.2). Ephemeral — never persisted here. */
export interface CreationProposal {
	/** The directory layout the FRESH scaffold will create (paths, relative to the project root). */
	dirLayout: string[];
	/** The stack + tooling the scaffold uses (derived from brief+hints+reference — F-008). */
	stack: string[];
	planMacro: PlanMacroDraft;
	/** 3-7 founding tasks (fork 4 milestone-level). Each carries objective+purpose (D-039). */
	foundingTasks: FoundingTaskDraft[];
	targetDrafts: TargetDraft[];
	capabilityNeeds: CapabilityNeedsDraft;
	/** Present only when PM-hire was requested (fork 3 default ON) — the charter seed text. */
	pmCharterDraft?: string;
	/** 2-4 position-taking clarifiers (§2 step 1 + §3). May be empty when the brief does not fork. */
	clarifiers: Clarifier[];
	/**
	 * Config values that looked secret-like and were REDACTED in place (kept, not discarded) so the
	 * proposal SUCCEEDS instead of one off-happy-path field nuking a ~2-min real-spend generation
	 * (D-026 redact-and-keep). Empty when no value tripped the redact path. The corresponding values
	 * in `targetDrafts[].config` already carry the redacted text — NO raw secret is in this object.
	 */
	configRedactions: ConfigRedaction[];
}

/**
 * The full, confirm-gated result CA-1 returns to the caller: the validated proposal + the brief it
 * was generated for (so the executor can detect a changed brief at confirm) + the confirmToken the
 * executor MUST re-submit. EPHEMERAL — nothing is on disk or in the DB.
 */
export interface CreationProposalEnvelope {
	brief: CreateBrief;
	proposal: CreationProposal;
	/** sha256 over the canonicalized {brief, proposal} (planEdit shape) — bound at execute. */
	confirmToken: string;
}

// ── The agent seam (stubbed in unit tests — no real spend) ─────────────────────────

/**
 * The generator seam: produces a RAW proposal from a brief. The PRODUCTION implementation
 * (`launchProposalAgent` below) runs a cheap-tier read-only session via launchSession; UNIT TESTS
 * inject a stub (mirroring how launchSession tests script the CcBackend — no creds, no network, no
 * spend). Returns `unknown` because it crosses the agent boundary — validateProposal is the trust
 * boundary that proves the shape before anything downstream sees it.
 */
export type ProposalGenerator = (brief: CreateBrief) => Promise<unknown>;

// ── Errors (EVERY ERROR HAS A NAME) ────────────────────────────────────────────────

/** The proposal the agent returned violated the structured contract (§2.2). */
export class ProposalContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProposalContractError';
	}
}

/** A draft referenced a literal secret value where only an env NAME is allowed (D-026). */
export class SecretEchoError extends Error {
	readonly field: string;
	constructor(message: string, field: string) {
		super(message);
		this.name = 'SecretEchoError';
		this.field = field;
	}
}

/** The brief changed between proposal and confirm; the confirmToken is stale (D-010 shape). */
export class StaleProposalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StaleProposalError';
	}
}

/**
 * A dirLayout[] entry tried to escape the project root (absolute path or `..`) at the PLAN trust
 * boundary, BEFORE it could reach the scaffold (D-018, fail closed). The executor's resolveEntry
 * is the second line of defense; this one rejects the escape before confirm so a path-traversal
 * layout never even gets a confirmToken.
 */
export class ProposalPathError extends Error {
	readonly entry: string;
	constructor(message: string, entry: string) {
		super(message);
		this.name = 'ProposalPathError';
		this.entry = entry;
	}
}

// Re-export so callers catch §3 violations from this module's surface too.
export { SycophancyError };

// ── Validation helpers ──────────────────────────────────────────────────────────

const MIN_FOUNDING_TASKS = 3;
const MAX_FOUNDING_TASKS = 7;
const MIN_CLARIFIERS = 0; // a brief that does not fork asks zero.
const MAX_CLARIFIERS = 4; // G4: the number cap wins over interrogation.

function isObj(v: unknown): v is Record<string, unknown> {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Require a non-empty trimmed string at `field`; throw ProposalContractError naming the field. */
function reqStr(v: unknown, field: string): string {
	if (typeof v !== 'string' || v.trim() === '') {
		throw new ProposalContractError(`proposal field '${field}' must be a non-empty string`);
	}
	return v;
}

/** Require an array of non-empty strings; throw naming the field. Shadow path: non-array → throw. */
function reqStrArray(v: unknown, field: string): string[] {
	if (!Array.isArray(v)) {
		throw new ProposalContractError(`proposal field '${field}' must be an array of strings`);
	}
	return v.map((x, i) => reqStr(x, `${field}[${i}]`));
}

// ── D-026 ENV-NAME-POSITIVE credential detection (CREATE-SPEC §3) ────────────────────
//
// The isolation-screening screen() (memory/screen.ts) catches a literal secret only when it is
// HIGH-CONFIDENCE in isolation: a known provider prefix, a JWT/PEM block, or an inline `key=value`
// credential ASSIGNMENT that appears WITHIN one string. It MISSES the create-config case where the
// secret IS the whole value, screened alone with no key context:
//   • { password: 's3cr3tP@ssw0rd' }   → screen('s3cr3tP@ssw0rd')  is clean (no `key=` in the string)
//   • { token:    'glpat-<gitlab-pat>' } → a GitLab PAT prefix screen() does not enumerate
//   • { dbPass:   'no-prefix-but-secret' } → a bare password assigned to a secret-like KEY
// Per CREATE-SPEC §3 a scaffold config value may reference an ENV NAME only — `${ENV_NAME}` or a
// bare UPPER_SNAKE env-name token. So we enforce a POSITIVE rule keyed on the config KEY, plus a
// prefix/entropy detector that fires regardless of key. This does NOT replace screen() — screen()
// still runs first to catch the high-confidence cases; this closes the key=value gap it leaves.

/** Known credential token prefixes that are ALWAYS a literal secret echo, whatever the key. */
const LITERAL_CREDENTIAL_PREFIXES: readonly string[] = Object.freeze([
	'glpat-', // GitLab personal access token
	'ghp_',
	'gho_',
	'ghu_',
	'ghs_',
	'ghr_', // GitHub token family
	'github_pat_',
	'sk-ant-', // Anthropic
	'sk-', // OpenAI / generic
	'xoxb-',
	'xoxp-',
	'xoxa-',
	'xoxr-',
	'xoxs-', // Slack
	'AKIA', // AWS access key id
	'AIza', // Google API key
	'ya29.', // Google OAuth token
	'npm_', // npm token
	'dop_v1_', // DigitalOcean
	'shpat_', // Shopify
	'pk_live_',
	'sk_live_', // Stripe live keys
	'SG.' // SendGrid
]);

// A secret-like config KEY is detected on its HEAD NOUN, not by substring — substring matching
// over-rejected legitimate descriptive config (CA-H1 review): 'auth' is a substring of authMethod/
// authProvider/authStrategy/oauth, 'token' of tokenExpiry, 'pass' of passwordPolicy, 'credential'
// of credentialType — all plausible deploy/publish-adapter config keys that fail closed and destroy
// legitimate config, contradicting F-008. We tokenize the key (snake_case / kebab-case / camelCase)
// and require the SECRET WORD to be the head (last) token (or the whole key) — so dbPassword/dbPass/
// clientSecret/accessToken/credential are secret, but tokenExpiry/passwordPolicy/authMethod are not.

/** Standalone head tokens that make a key secret-like (the value must be an env-name reference). */
const SECRET_HEAD_TOKENS: ReadonlySet<string> = new Set([
	'password',
	'passwd',
	'passphrase',
	'pass',
	'secret',
	'token',
	'credential',
	'credentials',
	'apikey'
]);

/** Modifiers that, when followed by a `key`/`secret`/`token` head, make the key secret-like. */
const SECRET_KEY_MODIFIERS: ReadonlySet<string> = new Set([
	'api',
	'access',
	'private',
	'secret',
	'signing',
	'encryption',
	'client',
	'refresh',
	'auth',
	'bearer',
	'session',
	'oauth'
]);

/** Tokenize a config key on snake/kebab separators and camelCase boundaries, lowercased. */
function tokenizeKey(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMBoundary
		.split(/[\s_-]+/)
		.filter((t) => t.length > 0)
		.map((t) => t.toLowerCase());
}

/**
 * Is this a secret-like config KEY (its value must be an env-name reference, D-026)? Decided on the
 * HEAD (last) token — not a substring — so descriptive compounds like authMethod/tokenExpiry/
 * passwordPolicy/credentialType are NOT flagged, while dbPassword/dbPass/clientSecret/accessToken/
 * apiKey/access_key/private_key/credential ARE. A `key`/`secret`/`token` head only counts as secret
 * when preceded by a credential modifier (apiKey yes, sortKey/foreignKey no).
 */
function isSecretLikeKey(key: string): boolean {
	const tokens = tokenizeKey(key);
	if (tokens.length === 0) return false;
	const head = tokens[tokens.length - 1];
	if (SECRET_HEAD_TOKENS.has(head)) return true;
	// `key`/`secret`/`token` are only secret-like with a credential modifier in front (apiKey, but
	// not sortKey/partitionKey); 'apikey' collapsed to one token is already covered above.
	if ((head === 'key' || head === 'secret' || head === 'token') && tokens.length >= 2) {
		if (SECRET_KEY_MODIFIERS.has(tokens[tokens.length - 2])) return true;
	}
	return false;
}

/**
 * An ACCEPTED env-name reference for a config value: only an EXPLICIT interpolation form —
 * `${ENV_NAME}`, `$ENV_NAME`, `{{ENV_NAME}}`, or `process.env.X` / `import.meta.env.X` / `env.X`.
 * These are the ONLY value shapes permitted under a secret-like key (CREATE-SPEC §3). The whole
 * value must BE the reference; mixed text that merely CONTAINS a placeholder is not accepted, so a
 * literal smuggled alongside `${X}` cannot pass.
 *
 * CA-H1 review GAP-1 (root cause + closure): a BARE token (even UPPER_SNAKE) is NOT a reference — it
 * is a literal string value, and a short high-entropy all-caps literal ('X7K9QZ2MPLW4') is
 * byte-for-byte a valid bare token, so accepting bare tokens left a hole no length/entropy threshold
 * could close (the fixer narrowed it twice and a 12–16 char literal still passed). A reference now
 * REQUIRES explicit interpolation syntax; under a secret-like key the value must therefore BE an
 * explicit `${ENV_NAME}` (the standard a generated config should emit anyway), so NO literal — short
 * or long, any entropy — can be misread as a reference. No entropy guessing on this path.
 */
function isEnvNameReference(value: string): boolean {
	const v = value.trim();
	if (v === '') return false;
	if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v)) return true; // ${ENV_NAME}
	if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return true; // $ENV_NAME
	if (/^\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}$/.test(v)) return true; // {{ ENV_NAME }} template
	if (/^(?:process\.env|import\.meta\.env|env)\.[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return true; // process.env.X
	return false;
}

/** Shannon entropy (bits/char) of a string — a rough literal-token detector. */
function shannonBitsPerChar(s: string): number {
	if (s.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) {
		const p = n / s.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/**
 * Does this string LOOK like a literal credential token (regardless of key)? True when it starts
 * with a known credential prefix, OR it is a long high-entropy mixed-charset token (≥20 chars,
 * ≥3.4 bits/char, contains BOTH letters and digits) that is NOT an env-name reference. The entropy
 * gate is deliberately conservative so descriptive config strings ('us-east-1', 'thunderstore',
 * 'production') do not trip — F-008: do not destroy legitimate config.
 */
function looksLikeLiteralCredential(value: string): boolean {
	const v = value.trim();
	if (v === '') return false;
	// Known credential prefixes are ALWAYS a literal echo — checked UNCONDITIONALLY, even if the value
	// otherwise looks env-name shaped (CA-H1 review GAP-1: env-ref classification must NOT suppress the
	// prefix backstop; no real env name carries a glpat-/ghp_/sk- prefix anyway).
	for (const p of LITERAL_CREDENTIAL_PREFIXES) {
		if (v.startsWith(p)) return true;
	}
	// The entropy heuristic stays env-ref-aware so a legitimate UPPER_SNAKE env name is not over-flagged.
	if (isEnvNameReference(v)) return false;
	// High-entropy bare token: long, mixed charset, no whitespace — a key, not a sentence/name.
	if (v.length >= 20 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v)) {
		if (shannonBitsPerChar(v) >= 3.4) return true;
	}
	return false;
}

/**
 * D-026 secret-echo guard for a config blob. THREE gates, in order, recursively over every string:
 *   1. isolation screen() — the high-confidence cases (provider prefixes screen knows, JWT/PEM,
 *      inline `key=value`); a redact/quarantine ⇒ literal echo ⇒ reject (NAMED). This is the
 *      original behaviour, kept as the first line.
 *   2. KEY-POSITIVE — when the value sits under a secret-like KEY (password/token/secret/key/…),
 *      it MUST be an env-name reference (`${ENV}` / `$ENV` / UPPER_SNAKE). ANYTHING else is a
 *      literal echo and is rejected — this closes the gap where screen() missed a bare password
 *      ('s3cr3tP@ssw0rd') because it screened the value in isolation with no key context.
 *   3. PREFIX/ENTROPY — a value that LOOKS like a credential token (glpat-/ghp-/sk-/…, or a long
 *      high-entropy mixed token) is rejected under ANY key, since no env-name reference looks like
 *      that. Catches a secret smuggled under an innocuous key (`{ note: 'glpat-…' }`).
 *
 * `mode` tunes Gate 1's disposition of a NON-clean screen result, mirroring the scaffold-write gate:
 *   • 'config' (default) — a config blob references env NAMES only, so ANY non-clean screen (redacted
 *     OR quarantined) is a literal echo and HARD-rejects. Stricter than "redact and continue" on
 *     purpose: a scaffold config that names a value rather than an env var is a bug to surface.
 *   • 'freetext' — agent-authored descriptive prose (a plan-macro field, a charter, a task
 *     objective/purpose, a clarifier). A 'redacted' status means the span is a benign,
 *     SAFELY-redactable token (an email, a home path, a known-prefix mention) — the SAME class the
 *     scaffold-write gate redacts-in-place rather than aborts. We let it PASS this validation gate
 *     (the value is kept verbatim HERE) and HARD-reject ONLY 'quarantined' (an un-redactable
 *     private-key block). This fixes the live bug where a normal description containing an email
 *     failed the create with a 'literal secret' error: a redactable email in prose is not a secret
 *     echo, it is redactable PII. The redactable span is made SAFE at its WRITER boundary, not here:
 *     scaffold-bound fields via the scaffold-write screen (writeFileMap), and DB-bound fields
 *     (planMacro.* → updateProjectPlan, foundingTasks[].objective/purpose → createTask) via
 *     screenWriterText() in execute.ts postRegister. Letting a 'redacted' span PASS this gate is
 *     therefore safe ONLY because every persistence path screens it — never rely on this comment's
 *     premise without the matching writer-boundary screen.
 * Gates 2 (key-positive) and 3 (prefix/entropy) ALWAYS run and are NEVER relaxed by mode — a real
 * credential token in free text still HARD-rejects regardless.
 *
 * `key` is the immediate field name the value sits under (undefined at array elements / the root).
 */
function assertNoSecretEcho(
	value: unknown,
	path: string,
	key?: string,
	mode: 'config' | 'freetext' = 'config'
): void {
	if (typeof value === 'string') {
		// Gate 1 — isolation screen (high-confidence inline secrets).
		const res = screen(value);
		// 'config' rejects ANY non-clean; 'freetext' rejects only the un-redactable 'quarantined'
		// (a 'redacted' span is benign redactable PII, handled at the scaffold-write disk boundary).
		const gate1Rejects = mode === 'config' ? res.status !== 'clean' : res.status === 'quarantined';
		if (gate1Rejects) {
			const why =
				res.status === 'quarantined'
					? `carries an un-redactable secret (D-026, quarantined)`
					: `echoes a literal secret (D-026: config references env NAMES only)`;
			throw new SecretEchoError(`proposal '${path}' ${why} — screen reasons: [${res.reasons.join(', ')}]`, path);
		}
		// Gate 2 — KEY-POSITIVE: a non-empty value under a secret-like key must BE an EXPLICIT env-name
		// reference (${ENV_NAME}/$ENV_NAME/…). A bare token or any literal is rejected — this is what
		// closes GAP-1 for short high-entropy literals (an empty value echoes no secret, so it passes).
		if (key !== undefined && isSecretLikeKey(key) && value.trim() !== '' && !isEnvNameReference(value)) {
			throw new SecretEchoError(
				`proposal '${path}' assigns a literal value to a secret-like key '${key}' ` +
					`(D-026: config references env NAMES only — use an explicit \${ENV_NAME} reference)`,
				path
			);
		}
		// Gate 3 — PREFIX/ENTROPY: a credential-shaped token is rejected under any key.
		if (looksLikeLiteralCredential(value)) {
			throw new SecretEchoError(
				`proposal '${path}' contains a literal credential token ` +
					`(D-026: config references env NAMES only — never a literal secret value)`,
				path
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((v, i) => assertNoSecretEcho(v, `${path}[${i}]`, key, mode));
		return;
	}
	if (isObj(value)) {
		for (const [k, v] of Object.entries(value)) assertNoSecretEcho(v, `${path}.${k}`, k, mode);
	}
	// numbers/booleans/null pass through.
}

const REDACTED_KEY_POSITIVE = '[REDACTED:secret-like]';

/**
 * D-026 REDACT-AND-KEEP disposition for a targetDrafts CONFIG blob (the H1 disposition applied to
 * the PROPOSAL secret-echo gate). Recursively returns a SCREENED COPY of the config plus the list of
 * redactions performed. The disposition SPLITS by certainty so one off-happy-path field never
 * discards an entire real-spend generation, while an UNAMBIGUOUS secret still HARD-rejects:
 *
 *   (a) HARD-reject (throws SecretEchoError, NAMES the field) — ONLY for a value the operator MUST
 *       remove themselves:
 *         • a known LITERAL_CREDENTIAL_PREFIXES prefix (glpat-/ghp_/sk-ant-/AKIA/AIza/…) — Gate 3
 *           prefix branch; OR
 *         • a `quarantined` screen result (un-redactable, e.g. a private-key PEM block).
 *   (b) REDACT-IN-PLACE + KEEP (collect {field, reason}, proposal SUCCEEDS) — for ANY OTHER
 *       suspected secret:
 *         • screen() 'redacted' → keep screen().text (the span already replaced with a safe
 *           placeholder, e.g. [REDACTED:email]);
 *         • a value under a secret-like KEY that is NOT an env-name reference → replace the WHOLE
 *           value with [REDACTED:secret-like] (reason 'secret-like-key');
 *         • a high-entropy NON-prefixed credential-shaped token → replace with
 *           [REDACTED:secret-like] (reason 'credential-shaped-token').
 *
 * D-026 PRESERVED: the RETURNED config carries NO raw secret on ANY branch — a kept value is either
 * already-clean, the screen's redacted text, or the placeholder; a hard-rejected value never returns
 * at all. The benign asset PATH ('icon.png') stays clean and is kept verbatim. NEVER relaxed for the
 * two hard classes (prefix + quarantine), so a glpat-/sk-ant- value or a PEM block STILL hard-rejects.
 */
function redactConfigSecrets(
	value: unknown,
	path: string,
	into: ConfigRedaction[],
	key?: string
): unknown {
	if (typeof value === 'string') {
		// Gate 3 PREFIX (HARD) — a known credential prefix is an unambiguous secret the operator must
		// remove. Checked FIRST/unconditionally so an env-ref-shaped or screen-clean prefix still throws.
		for (const p of LITERAL_CREDENTIAL_PREFIXES) {
			if (value.trim().startsWith(p)) {
				throw new SecretEchoError(
					`proposal '${path}' contains a literal credential token ` +
						`(D-026: config references env NAMES only — never a literal secret value)`,
					path
				);
			}
		}
		// Gate 1 isolation screen.
		const res = screen(value);
		if (res.status === 'quarantined') {
			// Un-redactable (e.g. a private-key block) — HARD-reject, NAME the field. The operator removes it.
			throw new SecretEchoError(
				`proposal '${path}' carries an un-redactable secret (D-026, quarantined) — ` +
					`screen reasons: [${res.reasons.join(', ')}]`,
				path
			);
		}
		if (res.status === 'redacted') {
			// REDACT-AND-KEEP: the span is already replaced with a safe placeholder in res.text.
			for (const r of res.reasons) into.push({ field: path, reason: r });
			return res.text;
		}
		// Gate 2 KEY-POSITIVE: a non-empty value under a secret-like key that is NOT an explicit env-name
		// reference is a literal echo — REDACT-AND-KEEP (replace the whole value), do not hard-reject.
		if (key !== undefined && isSecretLikeKey(key) && value.trim() !== '' && !isEnvNameReference(value)) {
			into.push({ field: path, reason: 'secret-like-key' });
			return REDACTED_KEY_POSITIVE;
		}
		// Gate 3 ENTROPY: a credential-shaped (non-prefixed — prefixes already hard-rejected above)
		// high-entropy token under any key — REDACT-AND-KEEP.
		if (looksLikeLiteralCredential(value)) {
			into.push({ field: path, reason: 'credential-shaped-token' });
			return REDACTED_KEY_POSITIVE;
		}
		// Clean (e.g. a benign asset path 'icon.png') — kept verbatim.
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((v, i) => redactConfigSecrets(v, `${path}[${i}]`, into, key));
	}
	if (isObj(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = redactConfigSecrets(v, `${path}.${k}`, into, k);
		return out;
	}
	// numbers/booleans/null pass through unchanged.
	return value;
}

/**
 * D-018 path-confinement for a dirLayout[] entry, enforced at the PLAN trust boundary (before the
 * proposal can earn a confirmToken). REJECTS an absolute path or any `..` traversal segment — the
 * same escape classes the executor's resolveEntry fails closed on, but caught here so a traversal
 * layout never reaches scaffold. Throws ProposalPathError (NAMED). Reuses confineToRoot SEMANTICS
 * (reject `..`/absolute) syntactically — confineToRoot itself does filesystem realpath resolution
 * and cannot run here (the scaffold dirs do not exist yet and the project root is unknown at plan).
 */
function assertScaffoldPathSafe(entry: string, path: string): void {
	const trimmed = entry.trim();
	if (isAbsolute(trimmed)) {
		throw new ProposalPathError(
			`proposal '${path}' is an absolute path '${entry}' — scaffold entries must be relative ` +
				`and confined under the project root (D-018, fail closed)`,
			entry
		);
	}
	// A drive-letter / UNC root that isAbsolute misses on the non-native platform, plus any `..`
	// traversal segment (./ is fine, ../ is an escape). Normalize separators first.
	const segments = trimmed.split(/[\\/]/);
	if (segments.some((s) => s === '..')) {
		throw new ProposalPathError(
			`proposal '${path}' contains a '..' traversal segment ('${entry}') — scaffold entries must ` +
				`stay under the project root (D-018, fail closed)`,
			entry
		);
	}
	// Windows drive-absolute (C:\...) and UNC (\\host\share) that POSIX isAbsolute may not flag.
	if (/^[A-Za-z]:[\\/]/.test(trimmed) || /^[\\/]{2}/.test(trimmed)) {
		throw new ProposalPathError(
			`proposal '${path}' is a drive-absolute or UNC path ('${entry}') — scaffold entries must be ` +
				`relative (D-018, fail closed)`,
			entry
		);
	}
}

function validatePlanMacro(raw: unknown): PlanMacroDraft {
	if (!isObj(raw)) throw new ProposalContractError("proposal 'planMacro' must be an object");
	return {
		purpose: reqStr(raw.purpose, 'planMacro.purpose'),
		vision: reqStr(raw.vision, 'planMacro.vision'),
		role: reqStr(raw.role, 'planMacro.role'),
		definition_of_done: reqStr(raw.definition_of_done, 'planMacro.definition_of_done')
	};
}

function validateFoundingTasks(raw: unknown): FoundingTaskDraft[] {
	if (!Array.isArray(raw)) {
		throw new ProposalContractError("proposal 'foundingTasks' must be an array");
	}
	// fork 4 (LOCKED): milestone-level, 3-7.
	if (raw.length < MIN_FOUNDING_TASKS || raw.length > MAX_FOUNDING_TASKS) {
		throw new ProposalContractError(
			`proposal 'foundingTasks' must have ${MIN_FOUNDING_TASKS}-${MAX_FOUNDING_TASKS} tasks ` +
				`(milestone-level, fork 4) — got ${raw.length}`
		);
	}
	return raw.map((t, i) => {
		if (!isObj(t)) throw new ProposalContractError(`foundingTasks[${i}] must be an object`);
		// D-039: objective + purpose are MANDATORY — a purposeless task is never born.
		return {
			objective: reqStr(t.objective, `foundingTasks[${i}].objective`),
			purpose: reqStr(t.purpose, `foundingTasks[${i}].purpose`)
		};
	});
}

function validateTargetDrafts(raw: unknown, redactions: ConfigRedaction[]): TargetDraft[] {
	if (!Array.isArray(raw)) {
		throw new ProposalContractError("proposal 'targetDrafts' must be an array");
	}
	const KINDS: AdapterKind[] = ['publish', 'deploy', 'sync'];
	// targetDrafts are the LOWEST-stakes field: OPTIONAL (an empty array is valid, F-008) and
	// OPERATOR-CONFIRMED before any publish/deploy ever runs (D-037 + the operator gate). A single
	// stray/malformed entry must NOT nuke an entire real-spend proposal (the recurring "don't let
	// one bad field waste a ~2-min generation" lesson — cf. the over-constrained gauntlet keys) —
	// DROP a non-object / invalid-kind / id-less entry (honest warn) and keep the valid targets;
	// the operator reviews and adds any missing target post-create.
	//
	// D-026 disposition for a KEPT target's config (H1 REDACT-AND-KEEP, the operator-blessed
	// disposition that fixes the recurring over-rejection — the live trigger was a benign publish-
	// target asset PATH list flagged as a literal secret, discarding a whole ~2-min generation):
	//   • UNAMBIGUOUS secret (a known credential PREFIX, or an un-redactable QUARANTINED block) →
	//     STILL HARD-throws SecretEchoError naming the field — the operator must remove it.
	//   • ANY OTHER suspected secret (screen 'redacted', a secret-like-key non-env-name value, a
	//     high-entropy non-prefixed token) → REDACTED IN PLACE and KEPT; the proposal SUCCEEDS, the
	//     redaction is recorded for the review UI. NO raw secret survives in the returned config.
	const out: TargetDraft[] = [];
	raw.forEach((t, i) => {
		if (!isObj(t)) {
			console.warn(`[create] dropping targetDrafts[${i}] — not an object`);
			return;
		}
		const kind = typeof t.kind === 'string' ? (t.kind.trim() as AdapterKind) : undefined;
		if (!kind || !KINDS.includes(kind)) {
			console.warn(`[create] dropping targetDrafts[${i}] — kind '${String(t.kind)}' not ${KINDS.join('|')}`);
			return;
		}
		const adapterId = typeof t.adapterId === 'string' ? t.adapterId.trim() : '';
		if (!adapterId) {
			console.warn(`[create] dropping targetDrafts[${i}] — missing adapterId`);
			return;
		}
		const rawConfig = isObj(t.config) ? t.config : {};
		// REDACT-AND-KEEP: returns a screened COPY (no raw secret) + appends any redactions; a known
		// prefix or a quarantined block still HARD-throws SecretEchoError (named) from inside.
		const config = redactConfigSecrets(rawConfig, `targetDrafts[${i}].config`, redactions) as Record<
			string,
			unknown
		>;
		out.push({ kind, adapterId, config });
	});
	return out;
}

/**
 * Validate capabilityNeeds. The agent's raw `defect_classes` are PARTITIONED against the
 * operator-confirmed vocabulary (the SAME source-of-truth setCapabilityNeeds enforces, §3 D4):
 *   • in-vocab classes → `defect_classes` (CONFIRMED + matchable);
 *   • NOT-in-vocab classes → `proposed_defect_classes` (CAPTURED as a HIRE signal — never confirmed
 *     or matchable until an operator key mints them; D4 LOCKED).
 * An unknown class no longer HARD-FAILS the proposal (the new-domain chicken-and-egg fix: a brand-new
 * domain has no confirmed classes yet, so the need is recorded for the future hire instead of nuking
 * a ~2-min real-spend generation). Both partitions are de-duplicated; a class can never appear in
 * both (vocab membership decides). languages/frameworks are free text (screened at the execute
 * boundary, not here — this is a plan).
 *
 * Shadow path: empty arrays are honest (F-008) — a brief that declares no capability needs is valid.
 */
async function validateCapabilityNeeds(db: Db, raw: unknown): Promise<CapabilityNeedsDraft> {
	if (!isObj(raw)) {
		throw new ProposalContractError("proposal 'capabilityNeeds' must be an object");
	}
	const languages = reqStrArrayAllowEmpty(raw.languages, 'capabilityNeeds.languages');
	const frameworks = reqStrArrayAllowEmpty(raw.frameworks, 'capabilityNeeds.frameworks');
	const rawDefects = reqStrArrayAllowEmpty(raw.defect_classes, 'capabilityNeeds.defect_classes');

	// PARTITION against the live operator-confirmed vocabulary (§3 D4). No hard-fail on unknown:
	// in-vocab → confirmed/matchable; not-in-vocab → captured proposed need (future hire signal).
	let defect_classes: string[] = [];
	let proposed_defect_classes: string[] = [];
	if (rawDefects.length > 0) {
		const vocab = new Set(await listDefectClassVocabulary(db));
		const confirmed = new Set<string>();
		const proposed = new Set<string>();
		for (const c of rawDefects) {
			(vocab.has(c) ? confirmed : proposed).add(c);
		}
		defect_classes = [...confirmed].sort();
		proposed_defect_classes = [...proposed].sort();
	}
	return { languages, frameworks, defect_classes, proposed_defect_classes };
}

/** Like reqStrArray but tolerates an absent/empty array (honest empty — F-008). */
function reqStrArrayAllowEmpty(v: unknown, field: string): string[] {
	if (v === undefined || v === null) return [];
	return reqStrArray(v, field);
}

function validateClarifiers(raw: unknown): Clarifier[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new ProposalContractError("proposal 'clarifiers' must be an array");
	}
	// G4: 0-4 ONLY. The must-not-interrogate rail wins — more than 4 is interrogation.
	if (raw.length < MIN_CLARIFIERS || raw.length > MAX_CLARIFIERS) {
		throw new ProposalContractError(
			`proposal 'clarifiers' must have ${MIN_CLARIFIERS}-${MAX_CLARIFIERS} entries ` +
				`(G4: must-not-interrogate) — got ${raw.length}`
		);
	}
	return raw.map((c, i) => {
		if (!isObj(c)) throw new ProposalContractError(`clarifiers[${i}] must be an object`);
		return {
			question: reqStr(c.question, `clarifiers[${i}].question`),
			position: reqStr(c.position, `clarifiers[${i}].position`),
			// §3: every position carries its falsifier.
			falsifier: reqStr(c.falsifier, `clarifiers[${i}].falsifier`)
		};
	});
}

/**
 * Validate the raw agent output into a typed CreationProposal — the TRUST BOUNDARY. Every field
 * is shape-checked (ProposalContractError, named), then the cross-cutting rails run:
 *   • D-026 no-secret-echo across every target config (SecretEchoError, named);
 *   • §3 anti-sycophancy across EVERY agent-authored string (dirLayout + stack + plan macro +
 *     charter + task objectives/purposes + clarifiers) — assertNoSycophancy throws
 *     SycophancyError (named).
 *
 * Shadow paths: nil → throw (named); empty object → throw on the first missing required field.
 */
export async function validateProposal(db: Db, raw: unknown): Promise<CreationProposal> {
	if (!isObj(raw)) {
		throw new ProposalContractError(
			`proposal must be an object (the agent returned ${raw === null ? 'null' : typeof raw})`
		);
	}

	const dirLayout = reqStrArray(raw.dirLayout, 'dirLayout');
	if (dirLayout.length === 0) {
		throw new ProposalContractError("proposal 'dirLayout' must be non-empty (F-008: derive from the brief)");
	}
	// D-018: reject an absolute or `..`-traversal dirLayout entry HERE, at the trust boundary, so a
	// path escape never reaches scaffold (ProposalPathError, named). Second line of defense is the
	// executor's resolveEntry; this one fails closed before the proposal earns a confirmToken.
	dirLayout.forEach((e, i) => assertScaffoldPathSafe(e, `dirLayout[${i}]`));
	const stack = reqStrArray(raw.stack, 'stack');
	if (stack.length === 0) {
		throw new ProposalContractError("proposal 'stack' must be non-empty (F-008: derive from the brief)");
	}
	const planMacro = validatePlanMacro(raw.planMacro);
	const foundingTasks = validateFoundingTasks(raw.foundingTasks);
	// D-026 H1 redact-and-keep: targetDrafts config secret-echoes are redacted-in-place (kept) unless
	// they are an unambiguous secret (prefix/quarantine), which still hard-rejects inside.
	const configRedactions: ConfigRedaction[] = [];
	const targetDrafts = validateTargetDrafts(raw.targetDrafts, configRedactions);
	const capabilityNeeds = await validateCapabilityNeeds(db, raw.capabilityNeeds);
	const clarifiers = validateClarifiers(raw.clarifiers);

	// D-026: the agent-authored ARRAYS (dirLayout + stack) are screened for a literal secret echo
	// too — a secret previously could ride a stack/dirLayout entry to the operator/disk unflagged
	// (CA-1 red-team gap). targetDrafts[].config is screened inside validateTargetDrafts already.
	dirLayout.forEach((e, i) => assertNoSecretEcho(e, `dirLayout[${i}]`));
	stack.forEach((e, i) => assertNoSecretEcho(e, `stack[${i}]`));

	let pmCharterDraft: string | undefined;
	if (raw.pmCharterDraft !== undefined && raw.pmCharterDraft !== null) {
		pmCharterDraft = reqStr(raw.pmCharterDraft, 'pmCharterDraft');
	}

	// D-026 — secret-echo across EVERY agent-authored FREE-TEXT string, not just configs/arrays
	// (CA-H1 review Gap-2): a secret echoed in the plan macro, the PM charter (→ disk on hire), a
	// task objective/purpose, or a clarifier reaches the operator/disk unflagged otherwise. No key
	// context here, so this leans on the isolation screen() + prefix/entropy gates.
	const secretScreened: ReadonlyArray<readonly [string, string | undefined]> = [
		['planMacro.purpose', planMacro.purpose],
		['planMacro.vision', planMacro.vision],
		['planMacro.role', planMacro.role],
		['planMacro.definition_of_done', planMacro.definition_of_done],
		['pmCharterDraft', pmCharterDraft],
		...foundingTasks.flatMap(
			(t, i) =>
				[
					[`foundingTasks[${i}].objective`, t.objective],
					[`foundingTasks[${i}].purpose`, t.purpose]
				] as ReadonlyArray<readonly [string, string | undefined]>
		),
		...clarifiers.flatMap(
			(c, i) =>
				[
					[`clarifiers[${i}].question`, c.question],
					[`clarifiers[${i}].position`, c.position],
					[`clarifiers[${i}].falsifier`, c.falsifier]
				] as ReadonlyArray<readonly [string, string | undefined]>
		)
	];
	// 'freetext' mode: a benign redactable span (an email, a home path, a known-prefix provider key) in
	// agent-authored PROSE is redactable PII, NOT a literal secret echo — it PASSES this validation gate
	// (the live-bug fix: a normal description with an email no longer hard-fails the create). The raw
	// value is NOT made safe here — it is screened to its SAFE redacted text at the WRITER boundary that
	// persists it: scaffold files via writeFileMap/screen() (execute.ts), and the DB-bound fields
	// (planMacro.* → updateProjectPlan, foundingTasks[].objective/purpose → createTask) via
	// screenWriterText() in execute.ts postRegister — the canonical chokepoint that mirrors
	// setCapabilityNeeds, so no raw secret lands in a file OR a DB column. Only an un-redactable
	// 'quarantined' block hard-rejects here; Gates 2/3 (key-positive + prefix/entropy) still catch a real
	// credential token regardless of mode.
	for (const [p, s] of secretScreened) if (s !== undefined) assertNoSecretEcho(s, p, undefined, 'freetext');

	// §3 ANTI-SYCOPHANCY across EVERY agent-authored string. One pass, named SycophancyError.
	// dirLayout[] and stack[] are agent-authored descriptive free-text too, so they are screened
	// here alongside the macro/charter/tasks/clarifiers — "EVERY agent-authored string" is the
	// contract, and a hedge in a stack/dirLayout entry must not slip past to the operator.
	const authored: (string | undefined)[] = [
		...dirLayout,
		...stack,
		planMacro.purpose,
		planMacro.vision,
		planMacro.role,
		planMacro.definition_of_done,
		pmCharterDraft,
		...foundingTasks.flatMap((t) => [t.objective, t.purpose]),
		...clarifiers.flatMap((c) => [c.question, c.position, c.falsifier])
	];
	assertNoSycophancy(authored);

	return {
		dirLayout,
		stack,
		planMacro,
		foundingTasks,
		targetDrafts,
		capabilityNeeds,
		pmCharterDraft,
		clarifiers,
		configRedactions
	};
}

// ── confirmToken (planEdit sha-over-content shape) ─────────────────────────────────

/**
 * Canonicalize {brief, proposal} deterministically (recursively key-sorted JSON — the SAME
 * stableStringify cc-config's digest uses) and sha256 it. The token binds the confirm to BOTH the
 * brief and the exact proposed bytes, so a brief edited between propose and execute mismatches and
 * the executor re-validates (StaleProposalError) rather than scaffolding a stale plan (D-010 shape).
 */
export function computeConfirmToken(brief: CreateBrief, proposal: CreationProposal): string {
	const stable = stableStringify({ brief, proposal });
	return createHash('sha256').update(stable, 'utf8').digest('hex');
}

/**
 * Re-validate at the execute boundary that the brief+proposal the executor holds STILL hashes to
 * the token CA-1 issued. Throws StaleProposalError (NAMED) on a mismatch — the equivalent of
 * StaleConfirmError for the ephemeral (DB-less) create flow. Pure; no I/O.
 */
export function assertProposalFresh(
	brief: CreateBrief,
	proposal: CreationProposal,
	confirmToken: string
): void {
	const fresh = computeConfirmToken(brief, proposal);
	if (fresh !== confirmToken) {
		throw new StaleProposalError(
			'the brief or proposal changed since the proposal was generated — re-generate before confirming ' +
				'(D-010 shape): the confirm token no longer matches the canonicalized proposal.'
		);
	}
}

// ── The orchestration entry point (CA-1) ───────────────────────────────────────────

/**
 * Generate a confirm-gated creation proposal (CREATE-SPEC §2.1-2.3, §3). NOTHING touches disk or
 * the DB here (the only DB read is listDefectClassVocabulary for enum validation). The `generate`
 * seam runs the cheap-tier read-only agent (production: launchProposalAgent; tests: a stub).
 *
 * Sequence: run the agent → validateProposal (shape + D-026 + §3 + D-039 + enum) → mint the
 * confirmToken over the canonicalized {brief, proposal}. Returns the EPHEMERAL envelope.
 *
 * Shadow paths:
 *   • nil brief fields → reqStr inside validation throws ProposalContractError (named);
 *   • the agent returns empty/garbage → validateProposal throws (named), never a phantom proposal;
 *   • the agent leg errors (env/timeout) → the rejection propagates from `generate` with its own
 *     name (launchProposalAgent surfaces the runtime error) — never swallowed as success.
 */
export async function generateCreationProposal(
	db: Db,
	brief: CreateBrief,
	generate: ProposalGenerator
): Promise<CreationProposalEnvelope> {
	// Validate the brief itself at the boundary (SHADOW PATHS: nil/empty name or description).
	reqStr(brief.name, 'brief.name');
	reqStr(brief.description, 'brief.description');

	const raw = await generate(brief);
	const proposal = await validateProposal(db, raw);
	const confirmToken = computeConfirmToken(brief, proposal);
	return { brief, proposal, confirmToken };
}
