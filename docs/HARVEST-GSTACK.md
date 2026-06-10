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
| B7 | **Capability-gated guidance** — round-trip-verify a tool before a briefing advertises it; actively REMOVE stale guidance | D-036 integration; gates B10's advertisement |
| B10 | **Memory pull-tool (operator-approved 2026-06-10)** — mid-session recall: a tiny MCP stdio server shipped with Atelier, registered in the session's ISOLATED CC config (the gbrain `claude mcp add` mechanism), proxying to the loopback memory API under the D-025 boot token. Push briefings + pull search. RAILS: advertised only per capability bundle (D-036) AND only after B7's round-trip verify; results wrapped in the MEMORY-SPEC §10 untrusted-content envelope (recall = data, never instructions — D-026 injection surface preserved); recall query wall-clock-bounded (B5's budget); project-scoped like all memory reads | v2.2b, paired with B7 |
| B8 | **Baseline-relative verification** — console/perf/bundle baselines persisted; reviewers judge DELTAS vs baseline | End-gate + DoD #4 |

## Lane C — absorbed into already-planned waves (spec amendments only now)

| Harvest | Into |
|---|---|
| Decision Classification (mechanical / taste / **User Challenge** — never auto-decide against the operator) + "auto-decide replaces judgment, never analysis" | PM-SPEC §4 (v2.1 build) |
| EM Step-0 Scope Challenge (reuse-first interrogation, numeric tripwires re-derived per G5) | PM-SPEC §4 validation-panel criteria |
| AskUserQuestion decision-brief format (completeness score + dual effort label) | PM-SPEC PM-question format |
| Anti-sycophancy banned-phrase/falsifier list → CREATE-SPEC; **full Six-Forcing-Questions interview → PM charter/hire interview ONLY** (CREATE-SPEC §2.1's "must not interrogate" rail wins — G4) | CREATE-SPEC + PM-SPEC §1 |

## Lane D — role workforce (operator-approved 2026-06-10): harvested methodologies become hireable agents

The harvested role methodologies don't stay as inline prompt text — they graduate into **catalog roles** the platform can hire, completing the D-036 capability story:

1. **Role = catalog entry**: prompt core (the harvested, G-guarded methodology) + capability bundle (D-036: skills/tools the role needs, nothing more) + default model tier. *Storage superseded by WORKFORCE-SPEC header: prompt cores are PRODUCT rows (`role`/`role_version`, hash-bound); the catalog supplies capability bundles only.* Surfaced on /agents (which currently shows 1 lonely cc_agent).
2. **Launch roles (five, all harvest-derived)**: `security-officer` (A8 methodology), `code-reviewer` (A1/A2/A15), `qa-lead` (A6), `design-reviewer` (A9), `investigator` (A10).
3. **Consumers**: wave review panels compose role lenses instead of one generalist reviewer; the PM's D-039 validation panel draws its 1–2 validators from roles; PM PR-triage "proposes a reviewer" = proposes spawning `code-reviewer` (already in PM-SPEC §5); the periodic security-review wave runs `security-officer`; debug sessions get `investigator`.
4. **Communication layer — no new machinery**: roles run as ordinary Atelier sessions — routed (D-020), gated (D-018), transcribed, analytics-evented, surfaced in the fleet/RightTray like every other agent. "Adding them to the workforce" is catalog rows + consumers, not a new runtime.
5. **PM utilizes them**: PM-SPEC §4 panel composition becomes role-aware (the PM picks validators by role fit to the artifact under review); PM proposals can include "hire <role> for X" — validated like any other PM-created work (D-039).

**Sequence within the plan**: Lane A inlines the methodologies as prompt text first (immediate value); **v2.1 promotes them to catalog roles + PM integration** (PM-SPEC amendment alongside Lane C); wave reviewer lenses then reference catalog roles instead of inlined text (single source).

**D6 — Track records (operator-approved 2026-06-10, builds v2.1):** per-role rollup over data we ALREADY write — review verdicts, adversarial refutation outcomes, fix-loop rates caused, A1 calibration events, cost per certified feature. Surfaced on /agents (role card) + PM dashboard. The PM's §4 panel composition selects validators by **role fit + track record**, not role fit alone. No new collection — a rollup + UI.

**D7 — Role interviews / calibration gauntlet (operator-approved 2026-06-10, builds v2.1):** a role VERSION joins the workforce only after passing a gauntlet of golden tasks with planted, known defects (seeded vuln for `security-officer`, planted absence-defect + hallucination bait for `code-reviewer`, contrast/slop plants for `design-reviewer`, …). Prompt cores are VERSIONED; any revision re-interviews before deployment — gate integrity stops depending on prompts never changing. Gauntlet fixtures live with the catalog; results recorded like any review verdict (F-008: pass/fail with evidence, never vibes). This is the leak-harness positive-control principle applied to the workforce itself.

**spec'd: docs/WORKFORCE-SPEC.md (builds v2.3):** performance-review loop (PM proposes prompt-core revisions, new version interviews against the incumbent's record, operator gates the swap) · per-project staffing (`project_staff` shape mirroring `project_target`; PM proposes staffing from incident/finding history) · tier-aware hiring (cost-vs-quality per role feeding D-020 routing).

## Sequencing

1. **Resume + finish wave 14.4–14.7** — RESUMED 2026-06-10 (`wf_4cc0b816-4f2`).
2. **Lane A-docs batch** → independent review (it edits the review system; review mandatory).
3. **Lane A-code batch** (A4/A7 wave-script logic) → reviewed as code.
4. **Lane C + Lane D spec amendments** — PM-SPEC (incl. role-aware panels) + CREATE-SPEC edits.
5. **Wave v2.2a** (B1/B3/B9) — **OPERATOR-CONFIRMED: before v2.1** (protects v2.1's build).
6. **v2.1 PM build** (incl. Lane D catalog roles + PM integration) → then **wave v2.2b** (B2, B4–B8, B10).

## Rails

- Provenance: every harvested prompt/checklist gets `(harvested: gstack <path>, MIT)` at point of use.
- No invented numbers (F-008) AND no inherited exclusion lists without re-derivation (G5).
- Skips stay skipped. The Codex outside-voice cross-model pass was **killed** by the audit (FP noise erodes gate credibility) — do not re-promote; only the A14 subprocess-hardening mechanics survived from that area.
