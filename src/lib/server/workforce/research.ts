// WORKFORCE-SPEC §7b (operator-LOCKED 2026-06-16) — RESEARCH RAILS: the part that makes
// the `researcher` role safe. Outward-facing managed web research is the only launch-era
// surface that pulls UNTRUSTED content from the open web into the system. The six rails:
//
//   ① PROVENANCE per claim — every load-bearing finding carries {source URL, retrieval
//      date, quoted basis}. No provenance ⇒ the claim is not assertable (the gauntlet's
//      source-attribution fixture fails a deliverable that omits it).
//   ② FENCED — a fetched page is DATA, never instructions (D-026 / MEMORY-SPEC §10). We
//      reuse memory/fence.ts verbatim: the SAME "reference, not instructions" envelope
//      recall uses. An embedded "ignore your methodology" in page content can never steer
//      the researcher because the page only ever reaches the model fenced.
//   ③ BORN QUARANTINED — a fetched "fact" is agent-authored memory. Findings reach the
//      brain ONLY through the existing screened ingest (memory/store.storeMemory →
//      gateCandidate → screen → embed). NO parallel write: a planted secret in a page is
//      screened/quarantined exactly as any other memory candidate (the §3.1b path).
//   ④ VERIFY-BEFORE-WRITE (Option A, author≠checker) — load-bearing claims are verified
//      by an INDEPENDENT CHEAP-TIER (haiku) session that receives ONLY {claim, cited
//      sources} — NOT the researcher's reasoning. PASS (sources support the claim AND a
//      2nd corroborating source exists) ⇒ the claim may store as fact. FAIL / no-2nd-
//      source / contradiction ⇒ stored `unverified:`-prefixed (honest, F-008), never
//      asserted as fact. The verifier is a SEPARATE spawn — the factory's core lesson.
//   ⑤ BOUNDED — a research task carries a wall-clock + fetch budget (config research.*;
//      null/conservative defaults via config/load.ts). Over budget ⇒ honest PARTIAL
//      deliverable, never silent crawling.
//   ⑥ NO PAYWALL / CREDENTIALED fetch; loopback-policy exceptions LOGGED.
//
// This module is the ENGINE; it does not auto-spend and it certifies nothing. It exposes
// pure rail functions (provenance attach, fence, budget accounting, web-tool allow-list)
// plus the verify→store orchestration (verifyAndStoreClaim) that wires the independent
// verifier seam to the existing memory store. Author≠checker is structural: the verifier
// is an injected spawn that NEVER sees the researcher's reasoning (only claim + sources).

import type { Db } from '../db/client';
import type { Embedder } from '../memory/embed';
import { fence, type FencedItem } from '../memory/fence';
import { storeMemory, type StoredMemory } from '../memory/store';
import { screen } from '../memory/screen';

// ── Named errors (every error has a name — trigger in the message) ──────────────────

/** Bad caller input at the research-rails boundary (malformed claim/source, missing
 *  required provenance field, illegal budget). Fail loud, named — never silent. */
export class ResearchInputError extends Error {
	override readonly name = 'ResearchInputError';
}

/** A capability the researcher session declared is not a permitted web tool (rail ⑥ /
 *  D-036 fail-closed). The bundle is REFUSED whole — never silently dropped, which would
 *  launder an over-privileged researcher. */
export class ResearchCapabilityError extends Error {
	override readonly name = 'ResearchCapabilityError';
	constructor(readonly tool: string) {
		super(
			`tool "${tool}" is not a permitted researcher web capability — only ` +
				`WebSearch/WebFetch are allowed (WORKFORCE-SPEC §7b, fail closed)`
		);
	}
}

// ── Rail ⑥ — the researcher web-capability allow-list (D-036, fail closed) ──────────
//
// The researcher is the ONLY launch role with web tools. WebSearch/WebFetch are Claude
// Code BUILT-IN tools (they ride toolPolicy.allow, not the cc-config skills/agents/mcp
// catalog), so the allow-list lives HERE as the authoritative researcher tool set. A
// declared web tool outside this set REFUSES the whole compose (never a silent drop) —
// the same fail-closed posture as runtime/capabilities.composeCapabilities.

/** The ONLY web tools a researcher session may wield (rail ⑥). Built-in CC tools. */
export const RESEARCHER_WEB_TOOLS: readonly string[] = ['WebSearch', 'WebFetch'] as const;

/** The non-web base tools a researcher needs (read its workspace, write the deliverable). */
export const RESEARCHER_BASE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Write'] as const;

/** The researcher role_version.capabilities object (D-036 shape — the web grant recorded
 *  ON the version so a verdict traces it). WebSearch/WebFetch are built-in tools, so they
 *  live under a `tools` key (NOT skills/agents/mcp, which are cc-config catalog plugins). */
export const RESEARCHER_CAPABILITIES: Record<string, unknown> = {
	skills: [],
	agents: [],
	mcp: [],
	tools: [...RESEARCHER_WEB_TOOLS]
};

/**
 * Rail ⑥ — validate a researcher session's declared web tool set against the allow-list,
 * FAIL CLOSED. Returns the validated toolPolicy.allow (base ⊕ web) for a researcher spawn.
 * A declared tool that is neither a base tool nor a permitted web tool throws
 * {@link ResearchCapabilityError} — refusing the whole compose, never silently dropping it
 * (a silent drop would launder an over-privileged bundle into a research run).
 */
export function composeResearcherToolPolicy(declaredWebTools: readonly string[] = RESEARCHER_WEB_TOOLS): {
	allow: string[];
} {
	const permitted = new Set<string>([...RESEARCHER_BASE_TOOLS, ...RESEARCHER_WEB_TOOLS]);
	for (const t of declaredWebTools) {
		if (typeof t !== 'string' || !RESEARCHER_WEB_TOOLS.includes(t)) {
			throw new ResearchCapabilityError(String(t));
		}
	}
	// base + the declared web subset, de-duped, order stable.
	const allow = [...RESEARCHER_BASE_TOOLS, ...declaredWebTools.filter((t) => permitted.has(t))];
	return { allow: [...new Set(allow)] };
}

// ── Rail ① — provenance per claim ───────────────────────────────────────────────────

/** One source cited for a claim (rail ①). url + retrieval date + the quoted basis. */
export interface SourceCitation {
	/** The fetched page URL — must be http(s) and NON-paywalled/credentialed (rail ⑥). */
	url: string;
	/** ISO retrieval date (when the page was fetched). */
	retrievedAt: string;
	/** The VERBATIM quoted basis from the source that supports the claim (rail ①). */
	quotedBasis: string;
}

/** A research finding: the claim text + its cited sources (rail ①). */
export interface ResearchClaim {
	/** The claim text (load-bearing assertion the deliverable would make). */
	claim: string;
	/** The cited sources (≥1 required for a load-bearing claim — rail ①). */
	sources: SourceCitation[];
}

const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;
/** Heuristic markers of a credentialed/paywalled fetch (rail ⑥): basic-auth in the URL,
 *  or an obvious account/login/paywall path. Conservative — a hit is REFUSED + logged. */
const CREDENTIALED_URL_RE = /:\/\/[^/@\s]+:[^/@\s]+@|\b(login|signin|account|paywall|subscribe)\b/i;

/**
 * Rail ① — validate a claim's provenance at the boundary (D-016 discipline). A load-bearing
 * claim MUST carry ≥1 source, each with a non-empty http(s) url, an ISO retrieval date, and
 * a non-empty verbatim quoted basis. A credentialed/paywalled-looking url is REFUSED (rail
 * ⑥) — the caller logs the loopback-policy exception. Throws {@link ResearchInputError},
 * naming the offending field — a claim with no provenance never becomes assertable (F-008).
 */
export function assertClaimProvenance(claim: ResearchClaim): void {
	if (!claim || typeof claim !== 'object') {
		throw new ResearchInputError('claim must be an object {claim, sources}');
	}
	if (typeof claim.claim !== 'string' || !claim.claim.trim()) {
		throw new ResearchInputError('claim.claim must be a non-empty string');
	}
	if (!Array.isArray(claim.sources) || claim.sources.length === 0) {
		throw new ResearchInputError(
			`claim "${truncate(claim.claim)}" has no cited source — a load-bearing claim requires ≥1 provenance source (rail ①)`
		);
	}
	claim.sources.forEach((s, i) => {
		if (!s || typeof s !== 'object') {
			throw new ResearchInputError(`claim source[${i}] must be an object {url, retrievedAt, quotedBasis}`);
		}
		if (typeof s.url !== 'string' || !HTTP_URL_RE.test(s.url)) {
			throw new ResearchInputError(`claim source[${i}].url must be a non-empty http(s) URL`);
		}
		if (CREDENTIALED_URL_RE.test(s.url)) {
			throw new ResearchInputError(
				`claim source[${i}].url "${truncate(s.url)}" looks paywalled/credentialed — refused (rail ⑥; log the loopback-policy exception)`
			);
		}
		if (typeof s.retrievedAt !== 'string' || Number.isNaN(Date.parse(s.retrievedAt))) {
			throw new ResearchInputError(`claim source[${i}].retrievedAt must be an ISO date string`);
		}
		if (typeof s.quotedBasis !== 'string' || !s.quotedBasis.trim()) {
			throw new ResearchInputError(`claim source[${i}].quotedBasis must be a non-empty verbatim quote`);
		}
	});
}

// ── Rail ② — fence a fetched page (DATA, never instructions) ────────────────────────

/**
 * Rail ② — fence one fetched web page before it reaches the researcher's context. REUSES
 * memory/fence.ts (the SAME D-026 "reference, not instructions" envelope recall uses) so a
 * fetched page can never act as an instruction — an embedded "SYSTEM: ignore your
 * methodology" lands inside the fence at a DATA position, exactly as a recalled memory.
 *
 * The page body is SCREENED first (screen.ts) so no raw secret in fetched content reaches
 * the context window either — fetched content is screened on the way IN, exactly as memory
 * is screened on the way to embed. The fence's `source: 'channel'` is the closest existing
 * InjectionSource (inbound untrusted content, D-035) — a fetched page is the same trust
 * class as an inbound channel body.
 */
export function fencePage(input: { url: string; body: string; citationId?: string }): FencedItem {
	if (typeof input.body !== 'string') {
		throw new ResearchInputError(`fetched page ${truncate(input.url)} body must be a string`);
	}
	// Screen the fetched content (rail ③ pre-screen): a secret in a page never reaches the
	// fence raw. We use the SCREENED text as the fenced body (redacted spans become
	// placeholders; the fence then makes the whole thing non-instructional).
	const screened = screen(input.body);
	return fence({ source: 'channel', body: screened.text, citationId: input.citationId });
}

// ── Rails ③+④ — verify (independent cheap-tier) then born-quarantined store ─────────

/** The verifier's verdict on ONE claim. The verifier sees ONLY {claim, sources} — never
 *  the researcher's reasoning (author≠checker, rail ④). */
export interface VerifierVerdict {
	/** true ⇒ the cited sources support the claim. */
	supported: boolean;
	/** true ⇒ ≥1 source is a DISTINCT corroborating second source. */
	corroborated: boolean;
	/** true ⇒ a cited source CONTRADICTS the claim (forces unverified, rail ④). */
	contradicted?: boolean;
	/** Short machine reason for the audit (no researcher reasoning ever appears here). */
	reason?: string;
}

/**
 * The independent verifier SEAM (rail ④, Option A). It is handed ONLY the claim + its cited
 * sources — structurally NOT the researcher's reasoning (the caller constructs this input
 * from {@link ResearchClaim} alone). In production this is a SEPARATE cheap-tier (haiku)
 * spawn; in tests it is a deterministic stub. author≠checker is enforced by the SHAPE: this
 * function literally cannot receive the researcher's reasoning — it is not in the type.
 */
export type VerifierFn = (input: {
	claim: string;
	sources: SourceCitation[];
}) => Promise<VerifierVerdict>;

/** The prefix stamped on a claim that did NOT verify (rail ④ / F-008 honest). A consumer
 *  rendering the deliverable shows this verbatim — the claim is never asserted as fact. */
export const UNVERIFIED_PREFIX = 'unverified: ';

export interface VerifyAndStoreOptions {
	db: Db;
	embedder: Embedder;
	verify: VerifierFn;
	/** The originating researcher session id (table:id) — memory provenance (m0033). */
	session?: string;
	/** The project the finding belongs to (table:id), when project-scoped. */
	project?: string;
	/** ingest_source id (table:id) when the finding came through a tracked ingest. */
	provenance?: string;
}

export interface StoredClaim {
	/** The persisted memory row (born quarantined via the screened ingest, rail ③). */
	stored: StoredMemory;
	/** true ⇒ the verifier passed (supported AND a 2nd source) — stored as fact. */
	verified: boolean;
	/** The content actually written (fact text, or `unverified: …`). */
	content: string;
	/** The verifier's verdict (audit). */
	verdict: VerifierVerdict;
}

/**
 * Rails ③+④ together — the load-bearing path a finding takes to the brain:
 *
 *   1. assertClaimProvenance (rail ①) — no provenance ⇒ refuse (named error).
 *   2. INDEPENDENT verify (rail ④) — the cheap-tier verifier session receives ONLY
 *      {claim, sources}. It is a SEPARATE spawn (author≠checker); this function never
 *      hands it the researcher's reasoning (not in the type).
 *   3. classify (rail ④, F-008): supported AND corroborated AND NOT contradicted ⇒ store
 *      the claim AS FACT; otherwise store it `unverified:`-prefixed (honest — never asserted
 *      as fact, even if the verifier merely lacked a second source).
 *   4. BORN QUARANTINED store (rail ③) — the finding reaches memory ONLY through the
 *      EXISTING screened ingest (storeMemory → gateCandidate → screen → embed). NO parallel
 *      write: a planted secret in the claim/source content is screened/quarantined exactly
 *      as any memory candidate. The provenance (sources) is appended to the stored content
 *      so the claim is never decoupled from its citation (rail ①).
 *
 * This NEVER auto-spends and NEVER certifies — it is the engine a research task calls per
 * load-bearing claim. The verifier and embedder are injected (deterministic in tests).
 */
export async function verifyAndStoreClaim(
	opts: VerifyAndStoreOptions,
	claim: ResearchClaim
): Promise<StoredClaim> {
	// Rail ① — provenance gate (fail closed, named). A claim with no source is not a
	// load-bearing finding; it never reaches the verifier OR memory.
	assertClaimProvenance(claim);

	// Rail ④ — independent verify. The verifier sees ONLY the claim + sources. We build its
	// input from the ResearchClaim alone — the researcher's reasoning is NOT in scope here
	// (author≠checker is structural: the VerifierFn type cannot receive it).
	const verdict = await opts.verify({ claim: claim.claim, sources: claim.sources });
	assertVerdictShape(verdict);

	// Rail ④ classify (F-008): a claim is stored AS FACT only when the INDEPENDENT verifier
	// found the sources support it AND a distinct second source corroborates it AND no source
	// contradicts it. Anything short of that is honest `unverified:` — never asserted as fact.
	const verified = verdict.supported === true && verdict.corroborated === true && verdict.contradicted !== true;
	const factText = claim.claim.trim();
	const content = verified ? factText : `${UNVERIFIED_PREFIX}${factText}`;

	// Rail ③ — born quarantined: the finding enters memory ONLY through the existing screened
	// ingest. We append the provenance citation to the content (rail ①) so the persisted row
	// can never assert a fact without its source attached. storeMemory runs the DO-NOT-CAPTURE
	// + secret/PII screen BEFORE embed (a planted secret is screened/quarantined here).
	const withProvenance = `${content}\n\n${renderProvenance(claim.sources)}`;
	const stored = await storeMemory(
		{ db: opts.db, embedder: opts.embedder },
		{
			content: withProvenance,
			kind: 'semantic',
			source: 'researcher',
			...(opts.session ? { session: opts.session } : {}),
			...(opts.project ? { project: opts.project } : {}),
			...(opts.provenance ? { provenance: opts.provenance } : {})
		}
	);

	return { stored, verified, content, verdict };
}

/** Render a claim's cited sources into a compact provenance block (rail ①). Appended to the
 *  stored content so a finding is never decoupled from its citation. */
export function renderProvenance(sources: SourceCitation[]): string {
	const lines = sources.map(
		(s, i) => `[${i + 1}] ${s.url} (retrieved ${s.retrievedAt}) — "${truncate(s.quotedBasis, 300)}"`
	);
	return `sources:\n${lines.join('\n')}`;
}

/** D-026 trust boundary: the verifier output is untrusted DATA. Validate its SHAPE before
 *  it decides whether a claim is asserted as fact — a malformed verdict must never silently
 *  pass a claim as verified (F-008). */
function assertVerdictShape(v: unknown): asserts v is VerifierVerdict {
	if (!v || typeof v !== 'object' || Array.isArray(v)) {
		throw new ResearchInputError('verifier returned a non-object verdict (untrusted output, D-026)');
	}
	const o = v as Record<string, unknown>;
	if (typeof o.supported !== 'boolean' || typeof o.corroborated !== 'boolean') {
		throw new ResearchInputError(
			'verifier verdict must carry boolean {supported, corroborated} (untrusted output, D-026)'
		);
	}
	if (o.contradicted !== undefined && typeof o.contradicted !== 'boolean') {
		throw new ResearchInputError('verifier verdict.contradicted must be a boolean when present (D-026)');
	}
}

// ── Rail ⑤ — bounded research budget (wall-clock + fetch count) ─────────────────────

/** The research budget for ONE task (rail ⑤). Both null = UNARMED (conservative default):
 *  with no bound the task is NOT permitted to fetch — honest, never silent crawling. */
export interface ResearchBudget {
	/** Wall-clock bound in ms. null = unarmed (no time budget ⇒ no fetch permitted). */
	maxWallClockMs: number | null;
	/** Max page fetches. null = unarmed (no fetch budget ⇒ no fetch permitted). */
	maxFetches: number | null;
}

/** Bounded accounting state for a running research task (rail ⑤). */
export interface ResearchBudgetState {
	budget: ResearchBudget;
	startedAt: number;
	fetches: number;
}

export type FetchGateVerdict =
	| { allowed: true }
	| { allowed: false; reason: 'budget_unarmed' | 'fetch_cap' | 'wall_clock'; detail: string };

/** Start a bounded research-budget accounting window (rail ⑤). `now` injectable for tests. */
export function startResearchBudget(budget: ResearchBudget, now: number = Date.now()): ResearchBudgetState {
	if (
		(budget.maxWallClockMs !== null && (!Number.isFinite(budget.maxWallClockMs) || budget.maxWallClockMs <= 0)) ||
		(budget.maxFetches !== null && (!Number.isInteger(budget.maxFetches) || budget.maxFetches < 0))
	) {
		throw new ResearchInputError(
			'research budget must carry null (unarmed) or a positive wall-clock and a non-negative fetch cap'
		);
	}
	return { budget, startedAt: now, fetches: 0 };
}

/**
 * Rail ⑤ — the fetch gate. Fail-closed by default (F-008): an UNARMED budget (either bound
 * null) permits NO fetch — the task surfaces an honest partial deliverable rather than
 * crawling silently. An armed budget permits a fetch only while BOTH the fetch cap and the
 * wall-clock bound hold. Call BEFORE each fetch; on `allowed:false` the task stops fetching
 * and returns what it has so far (honest partial), never spinning.
 */
export function checkFetchBudget(state: ResearchBudgetState, now: number = Date.now()): FetchGateVerdict {
	const { budget } = state;
	if (budget.maxFetches === null || budget.maxWallClockMs === null) {
		return {
			allowed: false,
			reason: 'budget_unarmed',
			detail:
				'research budget is unarmed (maxFetches/maxWallClockMs null) — no fetch permitted; ' +
				'the task returns an honest partial deliverable (rail ⑤, F-008)'
		};
	}
	if (state.fetches >= budget.maxFetches) {
		return {
			allowed: false,
			reason: 'fetch_cap',
			detail: `fetch cap reached (${state.fetches}/${budget.maxFetches}) — honest partial (rail ⑤)`
		};
	}
	if (now - state.startedAt >= budget.maxWallClockMs) {
		return {
			allowed: false,
			reason: 'wall_clock',
			detail: `wall-clock bound expired (${now - state.startedAt}ms ≥ ${budget.maxWallClockMs}ms) — honest partial (rail ⑤)`
		};
	}
	return { allowed: true };
}

/** Record one consumed fetch against the budget (rail ⑤). Mutates the state in place. */
export function recordFetch(state: ResearchBudgetState): void {
	state.fetches += 1;
}

// ── helpers ───────────────────────────────────────────────────────────────────────

function truncate(s: string, n = 120): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
