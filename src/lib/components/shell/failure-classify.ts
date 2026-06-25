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
// The scoped/generic content markers below (401/credential/timeout/refusal/\d+ failed, and the broad
// real-cause prose markers merge-needed/reaped/worktree-failed/'stale token') would fire from INSIDE
// that embedded payload → a confidently-WRONG overview tag (a CLI crash mislabeled 'agent declined the
// task'/'timed out'/'work preserved — merge needed'), violating the honesty rail (§12-15: a category
// is assigned ONLY on a real OBSERVED marker FOR THE CAUSE). So those markers are matched ONLY against
// `scannableScope` (the wrapper PREFIX + our own ' · '-appended advisories), never the embedded foreign
// tail. The narrow, structurally-distinctive causes our spawn/runtime layer emits as the error ITSELF
// (capability-denied two-token, the STRUCTURED F-029 token signals) are in REAL_CAUSE_RULES and match
// the whole note — they ARE the observed cause and legitimately ride inside a wrapper.
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
 * The advisory-append separator merge-back.ts uses (stampNote: `string::concat($cur, " · ", $advisory)`)
 * — an existing failure note + ' · ' + OUR screened advisory. Anything in a ' · '-delimited segment
 * AFTER the first is appended by our own layer (a merge-needed preserve advisory), NOT foreign text.
 */
const ADVISORY_SEP = ' · ';

/**
 * The portion of a wrapper note safe to scan for SCOPED/GENERIC content markers: the wrapper prefix
 * itself PLUS any of our own ' · '-appended advisory segments — but NOT the embedded FOREIGN payload
 * (the agent's stream-json result tail / git stderr) that begins after the first ': '. For a
 * non-wrapper note the whole note is returned unchanged (nothing is stripped).
 *
 * Structure of a wrapped+appended note (merge-back.ts:281/352 stampNote appends to launch.ts's note):
 *   `<wrapper>: <FOREIGN PAYLOAD> · <our advisory> · <our advisory>`
 * We drop ONLY the FOREIGN PAYLOAD (first ': ' → first ' · '), keeping the wrapper prefix and every
 * appended advisory. So a marker BURIED in the agent's own result tail can no longer mislabel the
 * cause, while a legitimate appended 'merge needed' preserve advisory IS still seen (no regression).
 */
function scannableScope(lower: string): string {
	if (!isStreamWrapper(lower)) return lower;
	const sep = lower.indexOf(': ');
	if (sep === -1) return lower;
	const prefix = lower.slice(0, sep); // the wrapper, e.g. 'claude cli exited 1'
	// The embedded foreign payload runs from just after ': ' to the first appended-advisory boundary
	// (' · ') if any; everything from that boundary on is OUR appended, screened advisory text.
	const rest = lower.slice(sep + 2);
	const advIdx = rest.indexOf(ADVISORY_SEP);
	const appended = advIdx === -1 ? '' : rest.slice(advIdx); // includes the leading ' · '
	return prefix + appended;
}

// REAL-CAUSE rules (WHOLE-NOTE): each marker is text OUR spawn/runtime layer emits AS the error
// itself AND legitimately rides INSIDE a stream wrapper (e.g. `claude CLI failed to start: …`), so
// it must be matched against the whole note. To avoid the embedded-tail false positive (CC-1 review
// gap #1), ONLY narrow, structurally-distinctive markers live here:
//   • capability-denied — the two-token `capability id`+`catalog` (or the `d-036` flag) thrown by
//     capabilities.ts:190 and surfaced via `claude CLI failed to start: …`; near-zero prose-collision.
//   • the STRUCTURED F-029 spawn-layer signals (`cc_session_id=null`, `token unset`, `openclaw_token`)
//     — non-prose tokens our code emits, e.g. `claude CLI failed to start: OPENCLAW_TOKEN unset`.
// BROAD real-cause markers whose producers are STANDALONE (never wrapped) — reaper.ts:25
// 'reaped: server restarted mid-run', merge-back.ts:280 'work preserved on branch <b>; … merge needed',
// launch.ts:533/541 'worktree acquisition failed …', and the PROSE phrase 'stale token' — are NOT here:
// matching them whole-note buys nothing (their notes are stamped directly on the row, separate path)
// and only lets an agent's own result-tail prose ("a merge needed manual resolution", "had a stale
// token earlier") mislabel a wrapped CLI crash. They live in SCOPED_CAUSE_RULES below, scanned ONLY
// over the wrapper — exactly like the generic-content rules. Ordered most-specific → most-generic.
const REAL_CAUSE_RULES: readonly Rule[] = [
	{
		// capabilities.ts:190 — 'unknown <kind> capability id "<id>" — not in the cc-config catalog (fail closed, D-036)'.
		// This is the REAL cause even when it rides inside `claude CLI exited N: …` (the legitimate nesting).
		category: 'capability-denied',
		icon: '⊘',
		shortLabel: 'capability denied',
		test: (l) => (l.includes('capability id') && l.includes('catalog')) || l.includes('d-036')
	},
	{
		// EXPLICIT spawn-layer auth/token cause — our code emits these STRUCTURED tokens AS the error
		// (F-029 stale token; the instant pre-init death with cc_session_id=null). They legitimately
		// ride inside `claude CLI failed to start: OPENCLAW_TOKEN unset`, so they match the whole note.
		// The prose phrase 'stale token' is NOT here (it is plausible agent-tail prose → SCOPED_CAUSE_RULES);
		// the GENERIC auth tokens (401/credential/…) are in the generic-content rules.
		category: 'auth-token',
		icon: '🔑',
		shortLabel: 'auth / token problem',
		test: (l) =>
			l.includes('cc_session_id=null') ||
			l.includes('token unset') ||
			l.includes('openclaw_token')
	}
];

// SCOPED-CAUSE rules: REAL causes whose producers stamp the note STANDALONE (never inside a stream
// wrapper) AND whose markers are plausible foreign prose (an agent's own result tail, a git stderr).
// Matched ONLY against `scannableScope` — the wrapper, never an embedded payload — exactly like the
// generic-content rules. For a standalone note (not a wrapper) `scannableScope` returns it unchanged,
// so the genuine producer note still classifies correctly; a quote of these phrases inside a wrapped
// CLI crash no longer mislabels the cause (CC-1 review gap #1). Ordered most-specific → most-generic.
const SCOPED_CAUSE_RULES: readonly Rule[] = [
	{
		// reaper.ts:25 — REAPED_NOTE = 'reaped: server restarted mid-run' (standalone row stamp).
		category: 'crashed-mid-run',
		icon: '⟲',
		shortLabel: 'crashed — server restarted',
		test: (l) => l.includes('reaped') || l.includes('server restarted mid-run')
	},
	{
		// merge-back.ts:280 — 'work preserved on branch <b>; … merge needed' (+ 'fast-forward not possible') (standalone).
		category: 'merge-needed',
		icon: '⑂',
		shortLabel: 'work preserved — merge needed',
		test: (l) => l.includes('merge needed') || l.includes('work preserved on') || l.includes('fast-forward not possible')
	},
	{
		// launch.ts:533/541 — 'worktree acquisition failed …' (WI-2 fail-closed path, standalone row stamp).
		category: 'worktree-failed',
		icon: '⑂',
		shortLabel: 'worktree setup failed',
		test: (l) => l.includes('worktree acquisition failed') || l.includes('worktree setup failed')
	},
	{
		// The PROSE 'stale token' phrase (F-029) — a real cause when our layer emits it standalone, but
		// plausible agent-tail prose, so scoped to the wrapper. (The STRUCTURED token signals stay whole-note.)
		category: 'auth-token',
		icon: '🔑',
		shortLabel: 'auth / token problem',
		test: (l) => l.includes('stale token')
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

	// 1. NARROW REAL-CAUSE markers — structurally-distinctive text our code emits AS the error itself,
	//    which legitimately rides inside a stream wrapper (capability-denied / structured F-029 tokens).
	//    Matched against the WHOLE note (low prose-collision risk by construction).
	for (const rule of REAL_CAUSE_RULES) {
		if (rule.test(lower)) {
			return { category: rule.category, shortLabel: rule.shortLabel, detail, icon: rule.icon, empty: false };
		}
	}

	// 2. SCOPED-CAUSE + GENERIC-CONTENT markers — plausible foreign prose (an agent result tail, a git
	//    stderr, or a standalone row note). Scanned ONLY over the WRAPPER (for a standalone note that is
	//    the whole note), so a marker quoted inside an embedded agent/git payload can't mislabel the
	//    cause. Scoped-cause rules precede generic ones (more-specific markers win).
	const scope = scannableScope(lower);
	for (const rule of [...SCOPED_CAUSE_RULES, ...GENERIC_CONTENT_RULES]) {
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
