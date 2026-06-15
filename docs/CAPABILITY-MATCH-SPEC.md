# CAPABILITY-MATCH-SPEC — project capability-needs + PM role-matching (BL-3)

> **DRAFT (2026-06-15).** The matching heuristic that makes "the PM decides whether existing
> roles fill a project's needs or a new hire is required" DATA-DRIVEN, not vibes. Refines
> WORKFORCE-SPEC §6 (project_staff) / §7 (hiring) — build alongside them in wave-v2.3.
> Exercised first by **new-mod-test** (the new ROUNDS mod: PM reuses generic roles, hires a
> C#/ROUNDS specialist for the gap). Defaults baked (§6).

## 1. Purpose

A new project needs roles for its language/domain (e.g. C#/BepInEx/Unity for a ROUNDS mod)
that differ per project but reuse across projects when applicable. Today the *mechanism* is
specced (roles are global catalog entities; projects opt-IN via `project_staff`; PM proposes
staffing through §4 + operator gate D-039; the gauntlet is the fit-proof). The GAP: nothing
lets the PM **match** a project's needs to the catalog with data. BL-3 adds (a) a structured
needs declaration, (b) the matching logic.

## 2. Locked invariants

1. **The gauntlet provenance IS "covers."** A role covers exactly the defect classes its
   certified fixtures prove (§3.8) — NOT what its prose claims. "Reuse if applicable" means
   *certified on the relevant classes*, never "sounds related."
2. **PM proposes, operator gates (D-039).** The PM emits a staffing/hire RECOMMENDATION; the
   operator confirms (a new hire = operator-gated role authoring + gauntlet, like day-0).
3. **PM has no write to certifications/keys (§4.4).** It reads provenance, recommends; it
   cannot self-certify a role into "covers X."
4. **No role certifies itself / panels its own staffing change** (§4.4/§6).

## 3. The two pieces

### 3a. Project capability-needs (structured declaration)
A project declares its needs as DATA, not prose: `languages`, `frameworks`, and the
**defect-classes that matter** (the same vocabulary the gauntlet keys use — e.g.
`non-idempotent-ddl`, `off-token-color`, a C#-specific class). Sources: declared by
Create-with-AI at scaffold time (derived from intent + the §2.1 reference-repo), editable by
the operator. Lives on the project (a `capability_needs` object or a `project_capability_need`
child table).

### 3b. PM matching logic
Given the needs + the catalog (each role's PROVEN coverage = the union of its certified
fixtures' defect-classes), the PM scores each catalog role's coverage against the needs and
recommends one of:
- **REUSE** — an existing certified role's proven classes ⊇ the need → propose `project_staff`
  (one-click hire of the existing role). Cheapest.
- **EXTEND** — a generic role is close but unproven on the domain → propose adding domain
  fixtures + re-certifying a NEW version (the role grows; reusable everywhere). Best when it's
  a natural extension (e.g. code-reviewer + C# correctness fixtures).
- **HIRE** — a genuine gap (different methodology, e.g. a `rounds-card-developer` that BUILDS,
  not reviews) → propose a new specialized role + its domain gauntlet (operator-gated).
All three route through the §4 panel + operator gate; the recommendation cites the EVIDENCE
(which needs each candidate role proves / leaves uncovered).

## 4. Data model (proposed)

```
-- on project (or a child table):
  capability_needs object { languages:[], frameworks:[], defect_classes:[] }   -- structured, screened
-- role coverage is DERIVED (not stored): union of defect-classes across the role's
--   certified (passing) fixtures' keys — read at match time (§3.8 provenance).
-- the match recommendation is a PM-SPEC §4 proposal artifact (staffing/hire), evidence-bearing.
```

## 5. How it's driven

- **Create-with-AI** declares `capability_needs` at project creation (from intent + the
  reference-repo prior art); operator edits.
- When staffing a project (new project, or a gap surfaces), the **PM runs the match** and
  proposes REUSE/EXTEND/HIRE per role-need, evidence-cited, through D-039 → operator confirms.
- The atelier's cross-project view (PEER-MESSAGE §11) helps: a specialist hired for project A
  is visible + reusable for project B with the same need.

## 6. Open decisions (baked default — tunable)

- **D1 needs source:** operator-declared · AI-derived (Create-with-AI) · both? — *default: AI-derived at create + operator-editable.*
- **D2 match scoring:** rule-based coverage-overlap (defect-class set math) · LLM-judged · hybrid? — *default: rule-based set-overlap as the spine (auditable), LLM only to SUGGEST candidate need→class mappings (operator/PM confirms).*
- **D3 extend-vs-hire threshold:** when is "close" an EXTEND vs a HIRE? — *default: same methodology + missing only domain fixtures → EXTEND; different methodology/output → HIRE; PM proposes, operator decides.*
- **D4 needs vocabulary:** free defect-class strings · a controlled vocabulary shared with gauntlet keys? — *default: shared controlled vocabulary with the gauntlet key classes (so "covers" is computable); allow new classes via the fixture-authoring path.*
- **D5 storage:** `capability_needs` object on project · child table? — *default: object on project (simple); child table only if it needs history.*

## 7. Build decomposition (with wave-v2.3 §6/§7)

1. `capability_needs` on project + migration; the controlled defect-class vocabulary (shared
   with gauntlet key classes).
2. The role-coverage derivation: union of defect-classes over a role's certified fixtures (§3.8).
3. The match engine: needs × coverage → REUSE/EXTEND/HIRE recommendations, evidence-cited.
4. PM wiring: emit the recommendation as a §4 staffing/hire proposal through D-039 (operator gate).
5. Create-with-AI: declare `capability_needs` at scaffold (from intent + reference-repo).
6. UI: the match result on the project (which roles cover what, the gaps, the recommendations).
7. Tests + red-team: "covers" can't be claimed without certified provenance; no self-certification.
