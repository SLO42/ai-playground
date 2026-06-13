// TASK 2.5 — secret/PII screen + DO-NOT-CAPTURE guard (MEMORY-SPEC §3.1, §3.1b; D-026).
//
// Two co-equal extraction gates, run BEFORE any embed or insert (§3.4 step 2.0):
//
//   1. DO-NOT-CAPTURE (§3.1) — never persist environment failures / negative tool
//      claims ("X is broken", "daemon is down", "API returns 500"). Left uncaught
//      they harden into self-cited refusals. The guard DROPS such candidates (or
//      rewrites a failure into a fix where the candidate already phrases one).
//
//   2. SECRET/PII SCREEN (§3.1b) — co-equal in prominence. Nothing reaches an
//      embedding or an insert before it is screened. On a hit: redact-in-place the
//      offending span, or quarantine the whole candidate if it cannot be safely
//      redacted. A raw secret-bearing string is NEVER sent to the embedding model
//      (this is the only point that closes the §7.1 embedding-cache side channel).
//      The outcome is stamped as `screen_status` (clean | redacted | quarantined).
//
// This module is pure + synchronous (no DB, no network) so it can be reused at every
// boundary: extraction (§3.4), learned-skill synthesis (§5.4a), and inbound channel/
// peer_message screening (§10 / D-035). It NEVER throws on input — a screen failure
// must fail CLOSED (quarantine), never let raw content through.

/** The stamped screen outcome (DATA-MODEL `memory.screen_status`). */
export type ScreenStatus = 'clean' | 'redacted' | 'quarantined';

/** Result of screening one candidate string. */
export interface ScreenResult {
	/** The text safe to embed/insert — redacted where a span was caught. */
	text: string;
	status: ScreenStatus;
	/** Short machine reasons for each hit (rule ids), for the audit/explain view. */
	reasons: string[];
}

/** Result of the DO-NOT-CAPTURE pass. */
export interface CaptureGateResult {
	/** false ⇒ the candidate must be DROPPED (never persisted). */
	capture: boolean;
	/** Why it was dropped (audit). */
	reason?: string;
}

// ── §3.1 DO-NOT-CAPTURE — transient negative / environment-failure detection ─────
//
// These patterns catch the class of transient negative claims that must not harden
// into beliefs. The hook context this very wave injected — "daemon is unreachable …
// hooks/memory/gates are inactive" — is the canonical example: it is transient
// environment state, not durable knowledge. DROP it.

const NEGATIVE_CLAIM_RES: { id: string; re: RegExp }[] = [
	{ id: 'unreachable', re: /\b(is|are|was|were|currently)?\s*(un(reachable|available)|offline|down|dead)\b/i },
	{ id: 'broken', re: /\b(is|are|seems?|looks?)\s+broken\b/i },
	{ id: 'not-working', re: /(\bnot|n't|\bnever)\s+(work(ing|s)?|respond(ing|s)?|connect(ing|s)?)\b/i },
	{ id: 'failed-transient', re: /\b(failed to (start|connect|reach|spawn|load)|connection refused|timed out|timeout)\b/i },
	{ id: 'http-error', re: /\b(returns?|returned|gives?|threw)\s+(an?\s+)?(http\s+)?(4\d\d|5\d\d)\b/i },
	{ id: 'cannot-x', re: /\b(can(no|')t|cannot|unable to)\s+\w+/i }
];

// A candidate already phrased as a FIX/instruction is durable knowledge, even if it
// mentions a failure ("to do X, use Y instead of Z"). These markers exempt it.
const FIX_MARKERS_RE = /\b(use|instead|prefer|fix|workaround|resolved by|to (do|fix|avoid)|the fix is)\b/i;

/**
 * §3.1 DO-NOT-CAPTURE guard. Returns capture:false for transient negative/
 * environment-failure claims that would harden into self-cited refusals — UNLESS
 * the candidate is already phrased as a fix ("to do X, use Y"), which is durable.
 */
export function captureGate(text: string): CaptureGateResult {
	if (typeof text !== 'string' || !text.trim()) {
		return { capture: false, reason: 'empty' };
	}
	if (FIX_MARKERS_RE.test(text)) {
		return { capture: true };
	}
	for (const { id, re } of NEGATIVE_CLAIM_RES) {
		if (re.test(text)) {
			return { capture: false, reason: `do-not-capture:${id}` };
		}
	}
	return { capture: true };
}

// ── §3.1b SECRET / PII screen ────────────────────────────────────────────────────
//
// Each rule has a placeholder used for redact-in-place. `quarantineOnHit:true` means
// the value cannot be safely redacted in isolation (e.g. a private-key block whose
// boundaries we can't reliably bound) — the WHOLE candidate is quarantined instead.

interface SecretRule {
	id: string;
	re: RegExp;
	placeholder: string;
	/** If true, a hit quarantines the whole candidate rather than redacting a span. */
	quarantineOnHit?: boolean;
	/**
	 * Optional per-match guard. A regex match is only treated as a real hit (and
	 * redacted) when this returns true; when it returns false the matched span is left
	 * verbatim. Used to add a semantic check a regex alone can't express (e.g. a Luhn
	 * gate on a digit run) so legitimate look-alikes (build IDs, version strings) are
	 * NOT destroyed — F-008. Absent ⇒ every regex match is a hit (the prior behaviour).
	 */
	validate?: (match: string) => boolean;
}

/** Luhn (mod-10) checksum — a real payment-card number passes; an arbitrary digit run
 *  (build artifact id, version string, phone, ordinal sequence) almost never does. Used
 *  to gate the card-number rule so legit numeric strings are not redacted (F-008). */
function luhnValid(raw: string): boolean {
	const digits = raw.replace(/\D/g, '');
	if (digits.length < 13 || digits.length > 19) return false;
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48; // '0' = 48
		if (d < 0 || d > 9) return false;
		if (alt) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		alt = !alt;
	}
	return sum % 10 === 0;
}

const SECRET_RULES: SecretRule[] = [
	// Provider API keys / tokens — high-confidence prefixes.
	{ id: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{8,}/g, placeholder: '[REDACTED:anthropic-key]' },
	{ id: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, placeholder: '[REDACTED:api-key]' },
	{ id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g, placeholder: '[REDACTED:github-token]' },
	{ id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, placeholder: '[REDACTED:aws-key]' },
	{ id: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, placeholder: '[REDACTED:slack-token]' },
	{ id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi, placeholder: 'Bearer [REDACTED:token]' },
	{ id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, placeholder: '[REDACTED:jwt]' },
	// A private-key PEM block — quarantine the candidate AND redact the WHOLE block
	// (header → footer, multiline) so no key material survives even though the row is
	// quarantined (a quarantined row is still written for audit; its body must be safe).
	// Marker matching is case-INSENSITIVE (/i): a lowercase PEM header
	// (`-----begin rsa private key-----`) or a lowercase OpenSSH header is still a
	// private key — case-sensitive markers let a lowercase paste evade the screen and
	// embed/store raw key material (the wave-v2.2b-a key-material leak). The literal
	// `-----`/whitespace/`[\s\S]` body is case-agnostic, so /i adds no false positives.
	{
		id: 'private-key',
		re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/gi,
		placeholder: '[REDACTED:private-key]',
		quarantineOnHit: true
	},
	// A bare BEGIN header with no matching END (truncated/malformed paste) — redact the
	// header AND everything after it to end-of-text. The full-block rule above already
	// consumed every well-formed BEGIN…END pair, so by the time this rule runs any
	// surviving BEGIN header is unterminated: the base64 key material is on the lines
	// FOLLOWING the header (a header-line-only redaction left it raw — the truncated-paste
	// leak). Once an unterminated private-key header appears, the remainder of the text is
	// presumed key material and is redacted wholesale so no partial key lands in the row body.
	{
		id: 'private-key-header',
		re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*$/gi,
		placeholder: '[REDACTED:private-key]',
		quarantineOnHit: true
	},
	// Generic high-entropy assignment: `password=...`, `secret: ...`, `api_key=...`.
	{
		id: 'credential-assignment',
		re: /\b(pass(word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{6,}/gi,
		placeholder: '[REDACTED:credential]'
	},
	// PII: email addresses + payment-card numbers.
	{ id: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, placeholder: '[REDACTED:email]' },
	// A 13–16 digit run is only redacted when it passes the Luhn checksum — a raw
	// `\b(?:\d[ -]?){13,16}\b` match mangled legit build artifact ids / version strings
	// (F-008 data destruction). Luhn keeps real cards (Visa/Stripe test numbers pass)
	// while letting arbitrary numeric strings through verbatim.
	{
		id: 'card-number',
		re: /\b(?:\d[ -]?){13,16}\b/g,
		placeholder: '[REDACTED:card]',
		validate: luhnValid
	}
];

// Private/home filesystem paths — operator-private, redacted not quarantined.
const PRIVATE_PATH_RULES: SecretRule[] = [
	{ id: 'home-path-unix', re: /\/(?:home|Users)\/[A-Za-z0-9._-]+/g, placeholder: '[REDACTED:home-path]' },
	{ id: 'home-path-win', re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, placeholder: '[REDACTED:home-path]' }
];

const ALL_RULES = [...SECRET_RULES, ...PRIVATE_PATH_RULES];

/**
 * §3.1b screen. Redacts every matched secret/PII span in place; quarantines the whole
 * candidate if any quarantine-on-hit rule fires. Fails CLOSED: any unexpected error in
 * the scan quarantines the candidate (a raw secret must never slip through on a bug).
 *
 * Returns the SCREENED text — this, and only this, is what may be embedded/inserted.
 */
export function screen(text: string): ScreenResult {
	if (typeof text !== 'string') {
		return { text: '', status: 'quarantined', reasons: ['non-string'] };
	}
	try {
		let out = text;
		const reasons: string[] = [];
		let quarantine = false;

		for (const rule of ALL_RULES) {
			rule.re.lastIndex = 0;
			let hit = false;
			if (rule.validate) {
				// Per-match guard: only matches that pass `validate` are redacted; a
				// failing match is left verbatim (so a legit look-alike is not destroyed,
				// F-008). `hit` becomes true only if at least one match was actually
				// redacted — a rule that matches but validates-false is NOT a hit.
				const validate = rule.validate;
				out = out.replace(rule.re, (m) => {
					if (validate(m)) {
						hit = true;
						return rule.placeholder;
					}
					return m;
				});
			} else if (rule.re.test(out)) {
				hit = true;
				rule.re.lastIndex = 0;
				out = out.replace(rule.re, rule.placeholder);
			}
			if (hit) {
				reasons.push(rule.id);
				if (rule.quarantineOnHit) quarantine = true;
			}
		}

		if (quarantine) {
			return { text: out, status: 'quarantined', reasons };
		}
		if (reasons.length) {
			return { text: out, status: 'redacted', reasons };
		}
		return { text, status: 'clean', reasons: [] };
	} catch (err) {
		// Fail closed — never emit raw on a scanner error (D-024 ethos).
		return { text: '', status: 'quarantined', reasons: [`screen-error:${(err as Error).message}`] };
	}
}

/**
 * The combined extraction gate used by §3.4 step 2.0: run DO-NOT-CAPTURE first, then
 * (if it survives) the secret/PII screen. A dropped candidate returns capture:false;
 * a screened candidate returns its ScreenResult. One call, both gates, in order.
 */
export interface GateOutcome {
	capture: boolean;
	dropReason?: string;
	screen?: ScreenResult;
}

export function gateCandidate(text: string): GateOutcome {
	const cap = captureGate(text);
	if (!cap.capture) return { capture: false, dropReason: cap.reason };
	return { capture: true, screen: screen(text) };
}
