// TASK 16.3 — W-D7a workforce data plane (WORKFORCE-SPEC §2). Public surface of
// the module: lifecycle state machine, repo (rows/normalizers/harness mutations),
// deployability resolver (§2.4), track-record rollup skeleton (§2.5).
//
// NOTE (§4.4): readGauntletKeyForScoring is deliberately re-exported — it is the
// table's SINGLE legitimate read path and only W-D7b's deterministic scorer may
// import it. No session/briefing/recall/PM code path may touch gauntlet_key.

export * from './lifecycle';
export * from './repo';
export * from './deployability';
export * from './track-record';
// TASK 16.6 (W-D7b) — the gauntlet engine: findings contract (§3.3), deterministic
// scorer (§3.4 — the sanctioned gauntlet_key consumer), runner/budget/adjudication
// (§3.1/§3.6/§3.7), fixture activation + sentinel sweep (§3.7/§4.2).
export * from './findings';
export * from './scorer';
export * from './gauntlet';
export * from './activation';
// TASK 16.7 (W-D7c) — launch content (5 role definitions + draft prompt cores + fixture
// WORK sets, HONEST: proposed/no-keys/draft) and the day-0 bootstrap ceremony MECHANISM
// (§8 — prompt-core review, key diff+confirm, admission reference-run + bootstrap-
// interview triggers, all operator-gated + INERT; re-exports the §3.4 adjudication
// write-path from gauntlet.ts — not forked).
export * from './launch-fixtures';
export * from './ceremony';
// WORKFORCE-SPEC §7b (operator-LOCKED 2026-06-16) — RESEARCH RAILS for the `researcher`
// role: per-claim provenance, the D-026 fence on fetched pages (reuses memory/fence.ts),
// born-quarantined ingest (reuses memory/store.storeMemory — no parallel write), the
// bounded fetch/wall-clock budget (rail ⑤), the web-tool allow-list (fail closed), and the
// Option-A independent cheap-tier verifier orchestration (author≠checker). Seeds nothing,
// certifies nothing — the engine a research task + the gauntlet call.
export * from './research';
// WORKFORCE-SPEC §7b.4 — the researcher INTERVIEW SUBSTRATE: the loopback stub-web (a
// controlled mini-web served on 127.0.0.1, mirroring the Thunderstore stub precedent) and
// the fail-closed fetch ALLOWLIST (the interview fetch reaches the stub ONLY — the live
// internet is unreachable in the gauntlet, §7b.4). Serves DATA only; research.fencePage
// fences the bytes (D-026); neither executes page content.
export * from './stub-web';
// TASK 16.7b (W-D7c surfaces) — the read-only workforce panel aggregator feeding the
// /agents workforce surface (§8 'Surfaces' + 'Degraded/empty states'). Read-only:
// reuses repo/deployability/track-record, no row writes, no gauntlet_key read.
export * from './panel';
// WORKFORCE-SPEC §5 (operator decision 4, 2026-06-16) — drift detection + auto-raise:
// computes the armed drift signals per role_version over the track window (confidence-
// miscalibration from the A1 calibration; escaped_defect / operator_feedback observed
// events) and idempotently/boundedly auto-creates review_proposal{status:'proposed'}
// rows. NEVER swaps/mutates/authors a prompt — operator-gated (D-010/D-039).
export * from './drift';
// WORKFORCE-SPEC §5 — the OPERATOR-GATED RESOLUTION half on top of drift's auto-raised
// proposals: the prompt-core DIFF (D-010), authorChallenger (createRoleVersion path),
// regauntletChallenger (reuse runGauntlet at the incumbent's certified tier × model_id +
// record the comparison), swapFromProposal (D-039 operator-confirmed swap), rejectProposal
// (close + cooldown). NEVER auto-swaps, NEVER auto-authors-and-deploys (operator-gated).
export * from './resolution';
// WORKFORCE-SPEC §7 (LOCKED operator decision 2026-06-16) — TIER-AWARE HIRING, STRICT (no
// waiver): tierHiringGrid (two evidence planes per version × tier, null-honest, reusing the
// track-record interview/panel planes + checkDeployability), the strict recommendation
// (emit ONLY on same-fixture_set_sha + both-passing + cheaper-wins), and the STRICT
// tier_change proposal (proposeTierChange via §5 createReviewProposal; resolveTierChangeGate
// = the (prompt_sha × target-tier model_id) passing-interview gate; swapTierChange = the
// D-039 operator-confirmed tier swap). NO auto-swap, NO waiver, NO inherited cert across tiers.
export * from './tier-hiring';
// WORKFORCE-SPEC §6 (project_staff) — the opt-IN, FAIL-CLOSED staffing data plane:
// staffRole/unstaffRole (the Hire ceremony + soft un-staff, idempotent + concurrency-safe),
// resolveStaff (the fail-closed staffing resolver routing consumes for the §7 explicit
// override), and the row reads. NO governance lands here — the matcher/proposal are above.
export * from './staff';
// CAPABILITY-MATCH-SPEC (BL-3) — the operator-curated defect-class vocabulary, the
// project capability_needs (enum-closed set/get), roleProvenCoverage (§3.8 PROVEN coverage),
// and the PROPOSE-ONLY matcher recommendStaffing (REUSE/EXTEND/HIRE, evidence-cited). The
// matcher NEVER staffs/hires — staffing-proposal.ts gates it through the §5 lifecycle + D-039.
export * from './capability-match';
// CAPABILITY-MATCH-SPEC §4/§5 (BL-3) — the operator-gated STAFFING PROPOSAL bridge: a matcher
// REUSE recommendation → review_proposal{kind:'staffing'} → operator D-039 confirm → staffRole.
// PROPOSE-ONLY creation; the project_staff row is written ONLY on the operator confirm. Reuses
// the §5 createReviewProposal + setProposalStatus lifecycle — it does NOT fork it.
export * from './staffing-proposal';
// HR-RECRUITER-SPEC §7.3 (HR-3) — the recruiter-driven CERT-LIFECYCLE ORCHESTRATOR: draft a
// target role's key-SET into ONE operator approve-surface (PROPOSE-ONLY, B2), run the gauntlet
// on approval (reuse runGauntlet, operator-triggered), and on a terminal FAIL re-version
// (reversionFailedRole) + classify candidate-miss vs KEY-DEFECT + emit a propose-only key-fix.
// PROPOSE+GATE: never confirms a key (B2), never flips a cert (B4), never certifies the
// recruiter itself (B1), never rescores (B3). Pure/deterministic orchestration; the recruiter
// AGENT drives it via launchSession. runRecruiterCampaign is the END-TO-END loop (run →
// auto-adjudicate → raise the hire brief) — the single production entry the recruiter calls.
export * from './recruiter';
// HR-RECRUITER-SPEC §7.4 (HR-4) — the AUTO-ADJUDICATION policy over an 'adjudicating' run's ambiguous
// queue: clear-cases-only (the SOLE auto-resolution is an injection-flag dismiss), escalate-on-doubt
// with per-item pre-filled recommendations for the operator's HR-1 ceremony. B3: never rescores, never
// auto-FPs a judgment, never auto-confirms a partial. Wired into runRecruiterCampaign.
export * from './auto-adjudicate';

// HR-RECRUITER-SPEC §7.5 (HR-5) — the OPERATOR HIRE-GATE: assemble the recruiter's hire decision
// from a TERMINAL interview_run (B3 read-only), raise ONE decision_brief per candidate (PROPOSE-
// ONLY, B4), and apply the operator's approve (flip the cert + optionally feed the BL-3 staffing
// flow) / reject (neither). The recruiter PROPOSES; the operator DISPOSES (B4 — no flip/no staffing
// without an explicit operator confirm). Reuses createDecisionBrief / confirmStaffing /
// transitionLifecycle — does not duplicate them.
export * from './recruiter-hire';
