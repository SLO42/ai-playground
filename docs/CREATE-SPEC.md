# CREATE-SPEC — "Create with AI" (generative project setup)

> Scoped OUT of the gap-closure track (operator, 2026-06-08) as its own feature; spec'd 2026-06-10. Builds AFTER wave v2.1 (PM, D-039) — creation should be able to end in a PM hire. Open forks for the operator are marked **⚑ FORK**.

## 1. What it is

The operator describes a project in plain language ("a ROUNDS mod that …", "a CLI that …", "a SvelteKit site for …") and Atelier **creates it for real**: repo + scaffold on disk, registered project row, plan macro (purpose/vision/role/DoD), founding tasks, declared deploy/publish targets (D-037), and optionally a hired PM (D-039). The opposite of a template dump: a conversation that ends in a working, managed project.

## 2. Flow

1. **Brief** — `/projects` → "Create with AI": name + free-text description + optional hints (ecosystem, repo URL to mirror, target platform). The agent asks 2–4 clarifiers ONLY where the brief genuinely forks (it must not interrogate). Clarifiers take positions per the §3 anti-sycophancy rail.
2. **Proposal** — the agent produces a creation plan: directory layout, stack + tooling, plan macro draft, initial task list (each with objective/purpose per D-039 standards), suggested targets ({adapterId, config} drafts), and—if requested—a PM charter draft. Rendered as a reviewable diff-style proposal.
3. **Confirm (D-010/D-018)** — creation is a gated action: the operator reviews the proposal and confirms. Nothing touches disk before this.
4. **Execute** — a build agent scaffolds under `CODE_ROOT/<slug>` (D-018 path confinement), `git init` + first commit, registers the project (scanner ingest path — the project row derives from the REAL scaffold, F-008), writes the plan macro, creates the tasks as `proposed` (validated by the D-039 panel when a PM exists, else born `ready` — ⚑ see fork 3), declares the targets.
5. **Hand-off** — lands on the new project workspace; optional final step: **hire the PM** (PM-SPEC §1) with the charter draft pre-filled.

## 3. Rails

- **Honest creation (F-008):** the registered project state derives from what was actually scaffolded (re-scan after execute), never from the proposal text. If a step fails mid-create, the project row reflects reality (partial scaffold = status honest + incident), no phantom tasks.
- **Confinement (D-016/D-018):** slug-validated record ids; scaffold strictly under `CODE_ROOT`; no writes outside the new project dir; the execute agent runs through the normal session launch path (capabilities, gates, analytics).
- **No secrets in scaffolds (D-026):** generated configs reference env names only; generated `.gitignore` covers `.env` from commit zero.
- **Anti-sycophancy (harvested: gstack office-hours/SKILL.md, MIT) — within the §2 step 1 rail:** the create agent's clarifiers and proposal take positions. Banned phrases: "that's an interesting approach" · "there are many ways to think about this" · "you might want to consider…" · "that could work" · "I can see why you'd think that". Instead: state what WILL or WON'T work on the evidence in the brief, and pair every position with its **falsifier** — the evidence that would change it (e.g. "single package, unless you expect independent release cadences"). Each clarifier challenges the strongest version of the brief, not a strawman. This rule changes the QUALITY of the 2–4 clarifiers, never their NUMBER — §2 step 1's must-not-interrogate rail wins (G4); the full Six-Forcing-Questions interview lives ONLY in the PM hire flow (PM-SPEC §1). This is also the single source of the banned-phrase list (PM-SPEC §1 references it).
- **Idempotent-ish:** re-running create with the same slug fails closed ("project exists — open it") rather than overwriting.
- **D-038:** the feature itself ships through BUILD → independent DoD-review like everything else.

## 4. ⚑ FORKS (operator decisions before build)

1. **Greenfield only, or also "adopt"?** v1 of this feature = greenfield creation only. Importing/adopting an existing repo stays the scanner's job (deep-import wizard is a separate deferred feature). *Recommended: greenfield-only first.*
2. **Pure-generative vs template-seeded:** pure generation (agent writes the scaffold) vs a small curated template library (ROUNDS mod, SvelteKit app, CLI) the agent specializes. Templates = faster + more reproducible; generation = unlimited range. *Recommended: pure-generative with the proposal step as the safety net; add templates later only if repeated creations converge.*
3. **PM hire default:** auto-offer (checkbox, default ON) vs explicit afterthought. *Recommended: default ON — a created project should be managed from day 0; operator unchecks to opt out.*
4. **Task fan-out size:** founding tasks = milestone-level (3–7) vs full backlog. *Recommended: milestone-level; the PM's first periodic review grows the backlog.*

## 5. Build shape (own wave, post-v2.1)

1. Brief + clarifier UI (palette entry "Create project with AI" included)
2. Proposal generator + diff-style review/confirm surface (reuse D-010 confirm primitives)
3. Gated execute path (scaffold agent + scanner ingest + plan/tasks/targets writers)
4. PM-hire hand-off (PM-SPEC integration)
5. Each feature: BUILD → independent D-038 DoD-review (v2-wave template)
