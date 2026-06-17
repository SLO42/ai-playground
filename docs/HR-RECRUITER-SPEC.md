# HR-RECRUITER-SPEC — automated certification & hiring (the workforce hires itself)

> Drafted 2026-06-17 from a live operator signal: hand-running the §7b researcher cert
> (author regex plants → adjudicate by DB-spelunk → re-version on fail) is "too much."
> It contradicts the platform premise — *agents do the work*. This spec moves the operator
> from **author + laborer** → **approver**. Open forks are marked **⚑ FORK**.

## 1. Problem (observed, not hypothetical)
Certifying ONE role (researcher) required the operator to: hand-author 4 noncompliance/
absence/presence regex keys; discover mid-adjudication that the UI shows neither the finding
text, the matched/missed plant, nor the scorer's basis (so they queried SurrealDB directly);
and absorb a deterministic FAIL caused by an over-strict key, with manual re-version the only
recovery. That is the examinee's harness being operated by hand. It does not scale past the
6th role, let alone per-project specialist hires (a C#/ROUNDS reviewer, etc.).

## 2. What it is
A certified, GLOBAL **recruiter** ("HR") catalog role that owns the role-certification
lifecycle end-to-end and surfaces the operator a single **hire / no-hire** decision with
evidence — instead of the whole ceremony. It is the workforce hiring itself, under operator
audit.

## 3. The integrity boundary (why this is NOT lights-out, and must not be)
The gauntlet exists to certify agents OBJECTIVELY. If the thing being certified can author its
own bar or wave through its own borderline cases, certification is theater (a lax key = a free
pass; self-adjudication = gaming). So the automation is bounded by four invariants:

- **B1 — no self-certification.** A role can never certify itself. The recruiter is a DISTINCT
  certified role; it never runs its own gauntlet. The recruiter itself is bootstrapped by the
  OPERATOR (day-0-style, like the launch five) before it can hire anyone.
- **B2 — operator approves the key-SET, doesn't author it.** The recruiter DRAFTS fixtures +
  keys (harvest → draft already exists); the operator reviews and approves/rejects the SET in
  one pass (§3.8 key-authorship authority preserved — just shifted from "type every regex" to
  "approve a batch"). No agent self-serves a weak key.
- **B3 — deterministic scoring stays untouched.** `scorer.ts` remains the sole, confidence-blind,
  out-of-session key reader (§3.4). Auto-adjudication (below) is a SEPARATE judgment layer over
  the AMBIGUOUS queue only — it never rescores plants and is itself audited.
- **B4 — operator keeps the D-039 hire gate.** The final flip to `hired`/`certified` is one
  operator click on a decision brief. The recruiter proposes; the operator disposes (D-039).

Net: the operator's job shrinks to **approve a key-set** + **resolve only escalated ambiguities**
+ **approve the hire**. The regex authoring, the runs, the clear-case adjudication, the
re-versioning, and the evidence assembly are the recruiter's.

## 4. What the recruiter automates (each REUSES an existing piece)
1. **Draft fixtures + keys** — harvest a role's defect classes → propose fixtures + draft keys.
   (Draft-key seeding already exists: `launch-fixtures.ts` ships every launch role's fixtures
   with INERT draft keys.) → operator approves the SET (B2).
2. **Run the gauntlet** — `gauntlet.ts runGauntlet` is already programmatic (materialize
   workspace / serve stub-web / launch candidate / score / persist `interview_run`). The
   recruiter drives it; the candidate stays sandboxed (no DB).
3. **Auto-adjudicate the CLEAR ambiguous cases** — e.g. an `extra_finding` that is a correct
   injection-flag → `dismiss`; a fabricated/false claim → `false_positive`. A confidence/clarity
   threshold gates this; genuinely-ambiguous items ESCALATE to the operator queue (B3). Every
   auto-decision is logged with its basis (auditable, reversible).
4. **Re-version on fail + propose the fix** — on a terminal-fail (§2.2), call the existing
   `reversionFailedRole` (clone prompt_core → fresh draft) AND classify the fail: a genuine
   candidate miss (re-run / try a higher tier) vs a KEY DEFECT (e.g. the over-strict
   `authoritative-port-18789` plant that failed a correct researcher) → propose a key fix for
   operator approval. Closes the loop the operator hand-ran today.
5. **Surface ONE hire decision** — a decision brief: candidate + tier, recall, FP, per-plant
   found/missed with basis, the auto-dismissed and escalated items, and a recommendation.
   Operator approves (D-039) or rejects. (Reuses the `decision_brief` / panel surfaces.)

## 5. Operator's residual (the light gate)
- Approve the **key-SET** once per role (review drafted plants — accept / tweak / reject).
- Resolve only **ESCALATED** ambiguous items (genuinely unclear) — not every extra finding.
- Approve / reject the **hire** (D-039).
That's it. No regex authoring, no DB-spelunking, no manual re-version.

## 6. Prerequisite — the adjudication UI (the gap we hit live)
Even the operator's residual gate needs it: the adjudication queue MUST render, per ambiguous
item, the finding (`file` + `class` + verbatim `evidence`), the scorer `note`, and per-fixture
**found/missed plant ids + basis** (and the run's pass_criteria). Today it shows none of this —
the operator resolved a real run only by querying `interview_run.ambiguous` / `.results` in
SurrealDB by hand. This ships FIRST; it's also the surface the recruiter's escalations render in.

## 7. Build shape (own waves, after wave-create-ai)
1. **Adjudication-UI completion** — render finding / matched+missed plant / scorer basis /
   pass_criteria on `/agents/ceremony` adjudication. (Unblocks even the all-manual flow.)
2. **Recruiter role** — definition + its OWN gauntlet fixtures + operator-run bootstrap cert
   (day-0-style). Distinct from the per-project PM (B1).
3. **Cert-lifecycle orchestrator** — draft → approve-set → run → auto-adjudicate → re-version →
   hire-decision, driven by the recruiter via `launchSession` + `runGauntlet`.
4. **Auto-adjudication policy** — clear-case rules + a confidence/escalation threshold; audited,
   reversible, never rescores plants (B3).
5. **Hire-gate surface** — the one-click decision brief + evidence (D-039).
Each feature: BUILD → independent D-038 review (v2-wave), red-team on the integrity boundary.

## 8. ⚑ FORKS (operator decides)
1. **HR (global) vs PM (per-project) ownership.** Recommend a GLOBAL recruiter role for catalog
   certification (cross-project, one hiring brain); per-project PMs still REQUEST a hire, the
   recruiter fulfils it. (PM stays project-scoped; HR is the cert authority.)
2. **Key-approval granularity.** Per-ROLE key-set approval (recommend — one review per role) vs
   per-fixture. 
3. **Auto-adjudication aggressiveness.** Clear-cases-only + escalate-the-rest (recommend) vs
   fuller autonomy under after-the-fact audit (faster, but more trust in the recruiter).
4. **Recruiter cert standard.** What fixtures certify a *recruiter*? (It must demonstrate it can
   draft a teeth-bearing key, catch a too-strict/teethless key, and adjudicate clear vs
   ambiguous — i.e. it's certified on the very judgment it will automate.)

## 9. Non-goals (v1)
- Not removing the operator from hiring (B4 stays).
- Not auto-authoring keys without approval (B2 stays).
- Not making the scorer confidence-aware (B3 — the cert bar stays deterministic).
