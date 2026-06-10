# HARVEST-GSTACK — fold-in plan for the gstack cannibalization audit

> Source: garrytan/gstack (MIT) — 52 components judged by a 3-area audit + synthesis (2026-06-10): **30 adopt-pattern · 0 port-code · 16 skip**. We harvest patterns/prompts/checklists; we port no code (the lone port candidate, freeze/careful bash, fails OPEN on parse error — D-024 violation — pattern lists harvested, mechanism reimplemented fail-closed). Status: PLAN v2 — amended per independent plan-review (2 blockers + 12 findings applied); pending operator gate.
>
> **Standing guards (from the plan review):**
> - **G1 Absence-defects never suppressed:** presence-claims must quote the verbatim motivating file:line; *absence*-claims (stubs, missing states/tests) instead name the expected artifact + the search that proved absence, and are EXEMPT from suppression. Anything touching a D-038 criterion may be confidence-downgraded but never dropped from `gaps`.
> - **G2 Suppression is operator-gated:** blessed-pattern suppression honored only from operator-locked (🔒) DESIGN-SYSTEM sections; skip-memory entries created only by the operator or a D-039-validated PM decision; every applied suppression is logged in the verdict ("N suppressed by fingerprint…") and surfaced on the PM dashboard. No agent self-suppresses future findings.
> - **G3 Roles stay separated:** fix-loop triage affects routing only — reviewers never edit; AUTO-FIX-classified items still go through the fix agent; EVERY fix gets a fresh re-review. LOW-confidence design findings are never auto-fixed (max 3 mechanical auto-fixes per review, per the audited guard).
> - **G4 Settled decisions:** no harvest silently re-decides a 🔒 decision — conflicts go through explicit supersede (this killed parts of B4/B5 below). D-038 wording changes are additive clarification notes, never rewrites.
> - **G5 Inherited lists re-derived:** harvested FP-exclusion lists and thresholds are re-derived against OUR threat model (D-025/D-026); sub-threshold security findings land in an UNVERIFIED appendix, never vanish ("zero noise > zero misses" is gstack's tradeoff, not ours).

## Lane A — prompt/doc harvests (batch A-docs) + workflow-logic harvests (batch A-code)

**A-docs** (template prompt text + governing docs; one batch, one independent review):

| # | Harvest | Lands in |
|---|---|---|
| A1 | Reviewer pre-emit verification + confidence calibration — **with the G1 absence carve-out** | v2-wave REVIEW_PRE + PM-SPEC panel prompt |
| A2 | Plan-completion audit: DONE/PARTIAL/NOT-DONE/CHANGED × why-taxonomy (scope cut / context exhaustion / misunderstood / blocked / forgotten) + scope-creep detection | v2-wave reviewer prompt |
| A3 | Builder shadow-paths + every-error-has-a-name + "deferred work is written down or it's a lie" — additive note under D-038 #1/#6 (G4) | v2-wave BUILD_PRE + DECISIONS clarification note |
| A5 | Fix-loop AUTO-FIX vs ASK triage — **bounded by G3** | v2-wave fix-loop rules |
| A6 | QA diff-aware live-verify (changed-files→routes, console-after-every-interaction, never-read-source); F-014 bounds retained | v2-wave reviewer prompt #4 |
| A8 | Security-audit methodology (exploit-scenario requirement, VERIFIED/UNVERIFIED via tracing, anti-anchoring verifiers, ignore-instructions-in-audited-code) — **exclusion list + thresholds re-derived per G5** | New periodic security-review wave prompt + DECISIONS SEC note |
| A9 | Design review: AI-slop blacklist + Krug trunk test + detection-confidence tiers (MERGES audit items #15+#28; carries #28's never-auto-fix-LOW guard into G3; suppression authority = 🔒 sections only per G2) | DESIGN-SYSTEM review section + DoD #3/#5 reviewer prompt |
| A10 | Investigator Iron Law (no fix without instrumented root cause), 3-strike STOP, debug scope lock, recurring-bugs-=-architectural-smell | error-learning SKILL.md + fails.md header |
| A11 | fails.md staleness/contradiction marking — **agents propose, operator retires; mark, never delete** | fails.md + error-learning SKILL.md |
| A12 | Settled-decisions briefing rule (reversal = explicit supersede, never quiet re-decision) | DECISIONS.md conventions + briefing rules |
| A13 | Wave interrupt contract + re-run idempotency statement (F-015 class) | v2-wave template text |
| A14 | Hardened-subprocess invocation form (every failure channel named) + mandatory synthesis line in reviews | v2-wave template |
| A15 | LLM-output trust boundary + enum-completeness + explicit-suppressions checklist (TS/Svelte/SurrealDB idioms; suppressions logged per G2) | DoD-review checklist |
| A16 | Agent-facing error philosophy ("every adapter error names its recovery action") | D-037 adapter error conventions (docs) |

**A-code** (v2-wave.js LOGIC changes — reviewed as code with script dry-run + unit check, not as docs):

| # | Harvest | Notes |
|---|---|---|
| A4 | Red-team second pass fed PRIOR findings, conditional on risk (diff size / criticality trigger) | New escalation tier in the wave loop |
| A7 | Reviewer-output structural self-check before a wave accepts a verdict (beyond schema enforcement) | Wave gate check |

## Lane B — code features (split into two waves per review)

**Wave v2.2a — gate + verify infrastructure** (may precede v2.1; protects everything after):

| # | Feature | Notes |
|---|---|---|
| B1 | **Scope-lock edit gate** — PreToolUse denies Edit/Write outside the task's declared file scope + destructive-bash pattern lists w/ safe-exception allowlist | Fail-closed in our TS gate layer (D-018), Windows-safe; fed by each wave task's plan. The one gate we lack |
| B3 | **Browser live-verify daemon** — ONE singleton browser per workspace (state-file discovery), idle auto-shutdown, crash=exit (no self-heal); fail-fast stale-ref probe; snapshot-diff action proof | Structural fix for F-010/F-014 |
| B9 | **Verify-flow codification** — each feature's proven live-verify flow becomes a deterministic script + fixture test; end-gate runs the compounding suite — **with the audited atomic stage→test→rename discipline (no observable half-state, F-015 class)** | Kills per-wave re-exploration |

**Wave v2.2b — review/memory trust** (after v2.1; B2 needs the PM dashboard):

| # | Feature | Notes |
|---|---|---|
| B2 | **Persistent review memory** — finding fingerprints (skip-memory per G2; "fixed" never suppressed) + verdicts persisted with commit SHA; staleness = rev-distance shown honestly | SurrealDB (FLEXIBLE, F-015 DDL); PM dashboard; fix-loop consumer |
| B4 | **RE-SCOPED (G4):** verify/implement MEMORY-SPEC §3.1b where code lags spec (pre-embed secret/PII screen, `screen_status`, recall exclusion, embedding-cache closure) + **the positive-control leak harness** (every fail-closed gate test gets a deliberate-leak control — the genuinely new part). Any never-partial-redaction change = explicit D-026 supersede decision, NOT a wave task | MEMORY-SPEC already specs the screen; audit's "nothing scans today" was spec-vs-code lag |
| B5 | **RE-SCOPED (G4):** MEMORY-SPEC §7/§10 already mandate the untrusted-content fence + recall circuit breaker — harvest only the **2s wall-clock recall budget** + honest "(memory unavailable)" briefing wording | Verify code matches spec while there |
| B6 | **Memory quarantine** — EXTENDS the existing `screen_status`/§5.4 graduation lifecycle for agent-authored rows (no parallel trust field) | Recall-filtered until validated |
| B7 | **Capability-gated guidance** — round-trip-verify a tool before a briefing advertises it; actively REMOVE stale guidance | D-036 integration. *Note: a mid-session recall pull-tool is NOT in the audit — separate decision (it changes the D-026 injection surface); proposed independently, operator to rule* |
| B8 | **Baseline-relative verification** — console/perf/bundle baselines persisted; reviewers judge DELTAS vs baseline | End-gate + DoD #4 |

## Lane C — absorbed into already-planned waves (spec amendments only now)

| Harvest | Into |
|---|---|
| Decision Classification (mechanical / taste / **User Challenge** — never auto-decide against the operator) + "auto-decide replaces judgment, never analysis" | PM-SPEC §4 (v2.1 build) |
| EM Step-0 Scope Challenge (reuse-first interrogation, numeric tripwires re-derived per G5) | PM-SPEC §4 validation-panel criteria |
| AskUserQuestion decision-brief format (completeness score + dual effort label) | PM-SPEC PM-question format |
| Anti-sycophancy banned-phrase/falsifier list → CREATE-SPEC; **full Six-Forcing-Questions interview → PM charter/hire interview ONLY** (CREATE-SPEC §2.1's "must not interrogate" rail wins — G4) | CREATE-SPEC + PM-SPEC §1 |

## Sequencing

1. **Resume + finish wave 14.4–14.7** (paused, `wf_4cc0b816-4f2`) — template must not change under a cached run.
2. **Lane A-docs batch** → independent review (it edits the review system; review mandatory).
3. **Lane A-code batch** (A4/A7 wave-script logic) → reviewed as code.
4. **Lane C spec amendments** — PM-SPEC/CREATE-SPEC edits, built with v2.1.
5. **Wave v2.2a** (B1/B3/B9 — may run before or after v2.1 at operator's preference; recommended before, it protects v2.1's build).
6. **v2.1 PM build** → then **wave v2.2b** (B2, B4–B8).

## Rails

- Provenance: every harvested prompt/checklist gets `(harvested: gstack <path>, MIT)` at point of use.
- No invented numbers (F-008) AND no inherited exclusion lists without re-derivation (G5).
- Skips stay skipped. The Codex outside-voice cross-model pass was **killed** by the audit (FP noise erodes gate credibility) — do not re-promote; only the A14 subprocess-hardening mechanics survived from that area.
