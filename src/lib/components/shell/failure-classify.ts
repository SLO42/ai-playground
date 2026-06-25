// MC-4 — human-readable classification of a session failure/advisory `note`.
//
// The session `note` stamped by launch.ts / merge-back.ts / the reaper is an HONEST,
// already-D-026-SCREENED string — but today it is rendered RAW (SessionFailureReason.svelte
// renders `note` verbatim), so the operator sees a wall of text: a streamed-JSON CLI exit
// tail, a long git merge-conflict hint, the D-036 capability-denied line, etc.
//
// This is a PURE, side-effect-free classifier: raw screened note → { category, shortLabel,
// detail }. The caller renders `shortLabel` + a category tag as the ONE clean overview line,
// and exposes the (unchanged, still-screened) `detail` in a collapsed disclosure.
//
// HONESTY RAILS (F-008):
//   • A category is assigned ONLY when the note carries a real, observed marker for it. There
//     is NO guessing and NO fabricated label — an unrecognized note maps to the honest
//     `unknown` category with `shortLabel: 'session failed'` and the raw note as `detail`.
//   • `detail` is ALWAYS the input note verbatim (already screened upstream — D-026 boundary
//     unchanged; this function neither widens nor narrows exposure, it only labels).
//   • The function NEVER throws: nil / empty / non-string input all return an honest result.
//
// Categories are grounded in REAL note shapes in the codebase (file:line cited per case below).

/** A machine-stable failure/advisory category. `unknown` is the honest fallback (never guessed). */
export type FailureCategory =
	| 'crashed-mid-run'
	| 'merge-needed'
	| 'auth-token'
	| 'capability-denied'
	| 'tests-failed'
	| 'agent-refusal'
	| 'spawn-timeout'
	| 'stream-exit'
	| 'worktree-failed'
	| 'no-output'
	| 'unknown';

/** The classified, render-ready view of a session note. */
export interface ClassifiedFailure {
	/** Machine-stable category (drives the tag/icon). `unknown` ⇒ honest fallback. */
	category: FailureCategory;
	/** A short, human one-liner for the overview row (≤ ~6 words). Never the raw wall of text. */
	shortLabel: string;
	/** The FULL, unchanged, already-screened note for the collapsible disclosure. '' when no note. */
	detail: string;
	/** A short glyph for the category tag (decorative; aria-hidden at the render site). */
	icon: string;
	/** True when there is no note at all (legacy/absent) — the caller renders "no reason recorded". */
	empty: boolean;
}

/**
 * One classification rule: a predicate over the lowercased note + a short label + icon. Rules
 * are evaluated in priority order (first match wins), so more-specific markers precede generic
 * ones (e.g. capability-denied before the generic stream-exit it may ride inside).
 */
interface Rule {
	category: Exclude<FailureCategory, 'unknown'>;
	icon: string;
	shortLabel: string;
	/** Match against the lowercased, trimmed note. Markers are taken verbatim from the codebase. */
	test: (lower: string) => boolean;
}

// ── FOREIGN-TEXT GUARD (fix: CC-1 review gap #1) ──────────────────────────────────────────────
// A stream-exit note WRAPS arbitrary foreign text that is NOT a marker for the cause:
//   • cli-backend.ts:705-709 — `claude CLI exited N: <detail>` where <detail> is up to 800 chars of
//     the agent's OWN stream-json result tail (`{"type":"result","result":"I cannot help…"}`, the
//     last 3 raw lines joined by ' ⏎ ') — the agent's natural-language output, NOT the exit cause.
//   • cli-backend.ts:699 — `claude CLI failed to start: <err>` (spawn err message).
//   • launch.ts:998 — `failed mid-stream: <err>`.
// The generic single-token content markers below (401/credential/timeout/refusal/\d+ failed) would
// fire from INSIDE that embedded payload → a confidently-WRONG overview tag (a CLI crash mislabeled
// 'agent declined the task'/'timed out'/'auth problem'), violating the honesty rail (§12-15: a
// category is assigned ONLY on a real OBSERVED marker FOR THE CAUSE). So generic content markers are
// matched ONLY against the WRAPPER (the text up to the first ': '), never the embedded tail. REAL
// causes our spawn/runtime layer emits as the error ITSELF (capability-denied, the F-029 stale-token
// signals) are in REAL_CAUSE_RULES below and match anywhere — they ARE the observed cause.
const STREAM_WRAPPER_PREFIXES = [
	'claude cli exited',
	'claude cli failed to start',
	'failed mid-stream'
] as const;

/** True when the lowercased note is a stream-exit wrapper (its tail is foreign, non-marker text). */
function isStreamWrapper(lower: string): boolean {
	return STREAM_WRAPPER_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * The portion of a wrapper note safe to scan for GENERIC content markers: the wrapper itself, up to
 * (and excluding) the embedded payload that begins after the first ': '. For a non-wrapper note the
 * whole note is returned unchanged (nothing is stripped). This is the ONLY text the generic rules
 * see — so a marker buried in the agent's own result tail can no longer mislabel the cause.
 */
function scannableScope(lower: string): string {
	if (!isStreamWrapper(lower)) return lower;
	const sep = lower.indexOf(': ');
	return sep === -1 ? lower : lower.slice(0, sep);
}

// REAL-CAUSE rules: each marker is text OUR code emits AS the error/advisory itself — a genuine
// OBSERVED cause. Matched against the WHOLE note (they legitimately ride inside a stream wrapper,
// e.g. capability-denied / the F-029 stale-token reason on `claude CLI failed to start: …`).
// Ordered most-specific → most-generic; first match wins.
const REAL_CAUSE_RULES: readonly Rule[] = [
	{
		// reaper.ts:25 — REAPED_NOTE = 'reaped: server restarted mid-run'
		category: 'crashed-mid-run',
		icon: '⟲',
		shortLabel: 'crashed — server restarted',
		test: (l) => l.includes('reaped') || l.includes('server restarted mid-run')
	},
	{
		// merge-back.ts:280/350 — 'work preserved on branch <b>; … merge needed' (+ 'fast-forward not possible')
		category: 'merge-needed',
		icon: '⑂',
		shortLabel: 'work preserved — merge needed',
		test: (l) => l.includes('merge needed') || l.includes('work preserved on') || l.includes('fast-forward not possible')
	},
	{
		// capabilities.ts:190 — 'unknown <kind> capability id "<id>" — not in the cc-config catalog (fail closed, D-036)'.
		// This is the REAL cause even when it rides inside `claude CLI exited N: …` (the legitimate nesting).
		category: 'capability-denied',
		icon: '⊘',
		shortLabel: 'capability denied',
		test: (l) => (l.includes('capability id') && l.includes('catalog')) || l.includes('d-036')
	},
	{
		// launch.ts:541 — 'worktree acquisition failed …' (WI-2 fail-closed path)
		category: 'worktree-failed',
		icon: '⑂',
		shortLabel: 'worktree setup failed',
		test: (l) => l.includes('worktree acquisition failed') || l.includes('worktree setup failed')
	},
	{
		// EXPLICIT spawn-layer auth/token cause — our code emits this AS the error (F-029 stale token;
		// the instant pre-init death with cc_session_id=null). These are real OBSERVED causes and
		// legitimately ride inside `claude CLI failed to start: OPENCLAW_TOKEN unset (stale token)`,
		// so they match the whole note. The GENERIC auth tokens (401/credential/…) are NOT here — they
		// must not fire from inside an embedded agent result payload (see generic-content rules).
		category: 'auth-token',
		icon: '🔑',
		shortLabel: 'auth / token problem',
		test: (l) =>
			l.includes('cc_session_id=null') ||
			l.includes('stale token') ||
			l.includes('token unset') ||
			l.includes('openclaw_token')
	}
];

// GENERIC-CONTENT rules: single-token / phrase markers that could appear in ARBITRARY foreign text
// (an agent's own result, a git stderr tail). Matched ONLY against `scannableScope` — the wrapper,
// never an embedded payload — so they classify the genuine cause and never a quote of it.
// Ordered most-specific → most-generic; first match wins.
const GENERIC_CONTENT_RULES: readonly Rule[] = [
	{
		// A spawn/start timeout (subprocess discipline; create-leg 'timeout'/'session ended timeout').
		category: 'spawn-timeout',
		icon: '⏱',
		shortLabel: 'timed out',
		test: (l) => l.includes('timed out') || /\btimeout\b/.test(l)
	},
	{
		// Generic auth/credential tokens — only meaningful OUTSIDE a wrapped agent payload.
		category: 'auth-token',
		icon: '🔑',
		shortLabel: 'auth / token problem',
		test: (l) => /\b(auth|oauth|unauthorized|401|invalid api key|credential)\b/.test(l)
	},
	{
		// The model DECLINED the task (an honest refusal, F-008). Distinct from a crash.
		category: 'agent-refusal',
		icon: '🛑',
		shortLabel: 'agent declined the task',
		test: (l) => /\b(refus|declined|i can('|no)?t (help|assist|comply)|will not)\b/.test(l)
	},
	{
		// A verification failure surfaced in the note (build/test gate). 'completed with a failure
		// result: …' often carries a test summary; match the explicit test/build markers.
		category: 'tests-failed',
		icon: '✗',
		shortLabel: 'tests / build failed',
		test: (l) =>
			/\b(tests? failed|test failures?|build failed|svelte-check|lint (errors?|failed)|\d+ failed)\b/.test(l) ||
			(l.includes('completed with a failure result') && /\btest|build|lint\b/.test(l))
	}
];

// The generic stream-exit fallback: a recognized wrapper whose embedded tail carried no REAL cause.
const STREAM_EXIT_RESULT: Pick<Rule, 'category' | 'icon' | 'shortLabel'> = {
	category: 'stream-exit',
	icon: '⚠',
	shortLabel: 'CLI exited with an error'
};

/**
 * Classify a raw (already-D-026-screened) session note into a render-ready category + short
 * label, keeping the full note verbatim as `detail`. Pure and total — never throws.
 *
 * Shadow paths (all four built + tested):
 *   • nil           → empty honest result (category 'unknown', shortLabel 'session failed', detail '').
 *   • empty/blank   → same as nil (a blank that screened to '' must NOT read like a real reason).
 *   • upstream/odd  → an unrecognized note → 'unknown' + the raw note as detail (NEVER fabricated).
 *   • happy         → a recognized marker → its category + a short human label.
 */
export function classifyFailureNote(note: string | null | undefined): ClassifiedFailure {
	// nil / non-string / empty → honest empty result (caller shows "no reason recorded").
	if (typeof note !== 'string') {
		return { category: 'unknown', shortLabel: 'session failed', detail: '', icon: '?', empty: true };
	}
	const detail = note;
	const trimmed = note.trim();
	if (trimmed.length === 0) {
		return { category: 'unknown', shortLabel: 'session failed', detail, icon: '?', empty: true };
	}

	const lower = trimmed.toLowerCase();

	// 'failed before producing any output …' (launch.ts:1005) is a distinct honest no-output case.
	if (lower.startsWith('failed before producing any output')) {
		return { category: 'no-output', shortLabel: 'failed before any output', detail, icon: '∅', empty: false };
	}

	// 1. REAL-CAUSE markers — text our code emits AS the error itself. Matched against the WHOLE
	//    note (they legitimately ride inside a stream wrapper; e.g. capability-denied / stale-token).
	for (const rule of REAL_CAUSE_RULES) {
		if (rule.test(lower)) {
			return { category: rule.category, shortLabel: rule.shortLabel, detail, icon: rule.icon, empty: false };
		}
	}

	// 2. GENERIC-CONTENT markers — only scanned over the WRAPPER (never an embedded agent/git
	//    payload), so a marker quoted inside the agent's own result tail can't mislabel the cause.
	const scope = scannableScope(lower);
	for (const rule of GENERIC_CONTENT_RULES) {
		if (rule.test(scope)) {
			return { category: rule.category, shortLabel: rule.shortLabel, detail, icon: rule.icon, empty: false };
		}
	}

	// 3. A recognized stream-exit wrapper with no real cause in its (foreign) tail → stream-exit.
	if (isStreamWrapper(lower)) {
		return { ...STREAM_EXIT_RESULT, detail, empty: false };
	}

	// Unrecognized note → HONEST fallback. Never a guessed category/label (F-008). The raw
	// (screened) note still rides in `detail` so nothing is hidden — only un-labeled.
	return { category: 'unknown', shortLabel: 'session failed', detail, icon: '?', empty: false };
}
