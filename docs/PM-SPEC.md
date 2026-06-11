# PM-SPEC — the per-project AI Project Manager (wave v2.1)

> Operator-shaped 2026-06-10. Governs the rebuild of the PM from typed-memory-functions (9.1/11.4) into a **hired, per-project manager with identity, charter, and validated authority**. Supersedes nothing — extends the existing pm_memory/decision/pm_review spine; do NOT regress 9.1/11.4.

## 1. Identity — the PM is hired, not implicit

- New `pm` table, **one row per project** (UNIQUE project link): `project`, `name`, `charter: option<string>` (operator-written directives: priorities, tone, escalation rules), `persona: option<string>`, `cadence: option<string>` (cron expr), `cadence_offset: option<duration>` (per-project stagger so PMs don't fire simultaneously), `authority: 'observe' | 'propose' | 'act'` (default **act** — see §4), `created_at`. Migration per F-015 (OVERWRITE, apply-twice + half-applied tests).
- **PM model (operator, 2026-06-10): the PM runs on a strong frontier model — default Fable 5 (`claude-fable-5`)**, set via `config/workforce.yaml pm.model_id` (operator-tunable, per-project overridable on the pm row later if needed). PM sessions route with the explicit `{provider, model_id}` override (F-005 short-circuit) — the PM is the conductor, not a gauntleted workforce role; its model choice is config, not certification (WORKFORCE-SPEC roles still certify per (prompt_sha × model_id)).
- **Hiring = context-building.** Creating a PM (PM tab → "Hire PM", replaces bare bootstrap) runs: project scan + plan-macro read + recent-history digest → founding `pm_memory` rows (extends the existing `bootstrapPm`) + the operator writes the charter in the same flow. A project with no PM renders the honest empty state + hire CTA (current behavior preserved).
- **Hire interview — the Six Forcing Questions (harvested: gstack office-hours/SKILL.md, MIT).** The hire flow's charter step is a structured interview — long-form BY DESIGN; this is the ONE surface allowed to interrogate (it never leaks into Create-with-AI clarifiers — CREATE-SPEC §2 step 1's must-not-interrogate rail wins there, G4). Asked one at a time; smart-skip any the brief/project scan already answers; push past the first polished answer once; the operator may skip any or all (respected immediately, recorded as "unanswered at hire" — an honest gap, F-008, never backfilled):
  1. **Demand reality** — what evidence exists that someone actually wants this project's output (would be upset if it vanished)? "Interested" is not evidence.
  2. **Status quo** — what is done today to solve this, even badly, and what does that workaround cost?
  3. **Specificity** — name the actual human this serves (a category is not a person); what concrete consequence do they face if it stays unsolved?
  4. **Narrowest wedge** — the smallest version that delivers real value this week, not after the platform exists?
  5. **Observation** — has anyone watched a real user/run, unaided? What surprised? ("nothing surprising" usually means "not watching".)
  6. **Future-fit** — if this project's ecosystem looks meaningfully different in 3 years, does it become more or less essential, and why?
  Answers land as founding `pm_memory` rows + charter inputs, recorded in the operator's words. The interview voice follows the anti-sycophancy rules (single list: CREATE-SPEC §3) — a position plus its falsifier on every answer, no hedge phrases.

## 2. Context — three layers, one manual

| Layer | Source | Freshness |
|---|---|---|
| **Charter** | operator-written at hire, editable anytime | durable |
| **Accumulated memory** | existing `pm_memory` (observations/risks/learnings/patterns/decisions), grown by reviews + outcomes | append-only (D-015) |
| **Fresh snapshot** | computed per action from live rows (tasks/sessions/findings/sprints) — the existing `runPmReview` assembly | never stale, never assumed |

Charter is injected into every PM session/review as fenced context (D-008/D-026) alongside the existing plan + memory bundle. **No other manual context maintenance** — the rest assembles itself.

## 3. Triggers — when the PM wakes (D-004-gated)

- **Periodic**: per-project **configurable cron + offset** (pm row). Periodic respects orchestration mode (manual mode = no automatic fires; existing `uxInspectionAllowed`-style gate pattern).
- **Event** (all four, operator 2026-06-10): ① session failed / task blocked > threshold; ② **GitHub issue/PR arrives** (via the 9.4/12.4 SyncAdapter; needs per-project creds — degrade honestly when absent); ③ new security/UX finding lands; ④ release completes/fails (retro memory + follow-up proposals).
- **Manual**: chat + "run review" (exist today; keep).
- **⑤ Watches (v2.3, operator-directed 2026-06-11 — needs WORKFORCE-SPEC §7b researcher):** per-project watch declarations `{what: package|game|upstream-repo|api, source, cadence}` checked on schedule by a BOUNDED §7b researcher task (provenance + verify-before-write rails); a detected CHANGE becomes a pm_memory observation with provenance → the PM judges relevance against charter/plan and proposes work through §4 like any evidence. Watch origins, all three: operator-set; **PM-proposed** (the PM reads its own dependencies and proposes its watches — §4-validated, operator-approved once, then standing); Create-with-AI-seeded (a new project's proposal includes its obvious watches). Watch checks respect D-004 mode + the research.* budgets; no watch fires for an un-hired project. No-change checks write NOTHING (F-008 — silence is the honest result).

## 4. Authority — "Act with Purpose" (operator standard)

The PM **auto-creates** tasks/priorities/escalations — but nothing it creates is born actionable:

1. Every PM-created artifact MUST carry: **objective** (clear, single), **purpose** (why this, why now — ties to plan/charter/finding), **full spec** (acceptance criteria a build agent could execute against), and provenance (which trigger/evidence produced it). Schema-enforced fields, not prose convention.
2. PM-created tasks enter status **`proposed`** and are routed to a **validation panel: 1–2 independent validator agents** that judge purpose/spec/duplication/feasibility against the project plan + charter, then **approve → `ready`** or **push back → returned to the PM with reasons** (the PM revises or withdraws; pushback reasons become PM memory — the PM learns its team's bar). **Panel composition is role-aware (HARVEST-GSTACK Lane D): validators are drawn from the role catalog by role fit to the artifact under review + TRACK RECORD** (per-role rollup of verdicts, refutation outcomes, calibration events, fix-loop rates — Lane D D6) — never just role name.
3. Panel verdicts are recorded (validator id, verdict, reasons) — same build→independent-review ethos as D-038, applied to management artifacts. **Verdict evidence rule (harvested: gstack review/SKILL.md confidence calibration, MIT; G1-adapted — Lane A-docs A1):** a presence-claim in a panel verdict ("duplicates task X", "spec already covered by Y") must quote the motivating artifact text verbatim; an absence-claim ("no acceptance criteria", "missing provenance", "no duplicate found") instead names the expected artifact + the search that proved absence, and is EXEMPT from suppression. A claim the validator cannot evidence is tagged "(unverified)" — kept in the verdict, never silently dropped.
4. External/destructive actions (anything beyond creating proposed work) still hit the D-018/D-024 gates. Escalations to the operator go via the notification system per charter rules.
5. **Decision classification (harvested: gstack autoplan/SKILL.md, MIT)** — every decision the PM or a validator takes is classified, and the class governs who decides:
   - **Mechanical** — one clearly right answer under the rails (schema-mandated, config-derivable, already settled by a 🔒 decision). Self-decide; log decision + class on the artifact/verdict.
   - **Taste** — reasonable people could disagree: close alternatives, borderline scope, validator disagreement. Self-decide with a recorded recommendation AND surface it on the next operator decision brief (§4.7) — decided-but-visible, never buried.
   - **Operator Challenge** — the decision runs against direction the operator gave (charter text, a 🔒 decision, an explicit instruction). **NEVER auto-decided against the operator, no matter how many agents agree.** It escalates as a decision brief carrying: what the operator said (verbatim) · what the agents recommend · why · **context we might be missing** (explicit blind-spot acknowledgment) · **cost if wrong** (what is lost if the operator's original direction was right and we changed it). The operator's direction is the default; agents make the case for change, not the other way around. One framing exception: if the challenge is a security or feasibility blocker (not a preference), the brief states that explicitly and urgently — the operator still decides.
   - **Auto-decide replaces the operator's JUDGMENT, never the ANALYSIS.** Every validation criterion still runs at full depth regardless of class; "no findings" is valid only with 1–2 sentences of what was examined and why nothing was flagged; a criterion is never compressed to a bare checkmark.
   - Decision principles for the self-decided classes (re-derived for our rails, G5): completeness over shortcut (D-038) · reuse over rebuild (§4.6) · explicit over clever · action over stale deliberation (flag concerns, don't block on them). Any numeric bound a principle needs (blast-radius size, effort ceiling) lives in `config/workforce.yaml pm.decide.*` and **ships unarmed (null)** — until the operator sets it from our own history, anything that would need the bound classifies as Taste and surfaces (G5/F-008: no imported magic numbers).
6. **Panel Step-0 scope challenge (harvested: gstack plan-eng-review/SKILL.md Step 0, MIT; tripwires re-derived per G5)** — before judging purpose/spec/duplication/feasibility, validators interrogate the artifact's scope, reuse-first:
   1. **Reuse:** what existing code/flow/table already partially or fully solves each sub-problem? Can outputs be captured from existing flows instead of building parallel ones? Duplicating existing functionality = pushback, citing the existing artifact verbatim (G1 presence-claim).
   2. **Minimum change set:** what is the smallest set of changes that achieves the stated objective? Deferrable work is flagged and written down (follow-up proposal or pm_memory) — never silently dropped.
   3. **Complexity tripwires — operator-tunable, never imported:** `panel.scope.max_files` / `panel.scope.max_new_services` (config/workforce.yaml) **ship null (unarmed)**; until the operator sets them from our own wave history, complexity is raised as an evidenced judgment finding, never a numeric verdict. When armed, exceeding a tripwire is a smell that forces the challenge ("can the same objective be met with fewer moving parts?") — not an auto-reject.
   4. **Built-in check:** for each pattern/infra component the artifact introduces — does the stack (SvelteKit/SurrealDB/the harness) already provide it? A custom solution where a built-in exists is a scope-reduction finding.
   5. **Settle-once:** once the PM accepts a pushback or the operator decides a scope question, validators commit — scope is not re-litigated in later criteria, and the PM may not silently shrink approved scope (changes go back through the panel).
7. **PM decision briefs — one canonical format (G4):** every PM question/escalation to the operator (Operator Challenges, taste surfacing, proposal gates, hire/swap confirms) renders in the **WORKFORCE-SPEC §8 decision-brief format** — the single source of truth; this spec defines no second format. A brief is a question: the operator's answer is the decision, and the briefed matter does not proceed while the brief is open.

## 5. PRs/issues — triage-only

The PM **summarizes, links to tasks, flags risk areas, and proposes spawning a reviewer agent**. It does NOT review diffs itself (role separation; keeps PM context lean). Issue triage: classify, link/duplicate-check, propose a task (through §4 validation).

## 6. Honesty + scope rails

- F-008 throughout: memories derive from real signals; snapshots from live rows; "no findings" is a valid result; absent datetimes → null → '—' (F-013/F-015).
- Strictly per-project (existing `WHERE project = $project` discipline). No cross-project PM reads.
- All PM sessions route through the existing launch path (capabilities, gates, analytics events — analytics is first-class).

## 7. Role workforce integration (HARVEST-GSTACK Lane D — builds with v2.1)

- **Catalog roles**: five harvest-derived roles (`security-officer`, `code-reviewer`, `qa-lead`, `design-reviewer`, `investigator`) — capability bundle + default tier from the D-036 catalog; **prompt cores are PRODUCT rows (`role`/`role_version`, hash-bound) — superseded by WORKFORCE-SPEC header (the catalog supplies capability bundles only)**. Roles run as ordinary sessions (routed/gated/transcribed/evented).
- **Track records (Lane D D6)**: per-role rollup of review verdicts, refutation outcomes, A1 calibration events, fix-loop rates, cost per certified outcome — surfaced on /agents + the PM dashboard; consumed by §4 panel composition and the PM's "hire <role>" proposals. Data plane + rollup: **WORKFORCE-SPEC.md §2**.
- **Role interviews (Lane D D7)**: a role version is deployable only after passing its calibration gauntlet (golden tasks with planted defects); ANY prompt-core revision re-interviews before it touches real work. Results recorded with evidence (F-008). Full gauntlet spec: **WORKFORCE-SPEC.md §3**.
- The PM's §5 "proposes spawning a reviewer agent" = proposes hiring `code-reviewer` from the catalog; staffing/performance-review/tier-aware-hiring evolutions are spec'd in **WORKFORCE-SPEC.md §5–§7** (build wave v2.3).

## 8. Build shape (wave v2.1 — after the v2.0 audits settle)

1. `pm` table + hire flow + charter editor (extend PM tab)
2. Trigger engine: per-project cron+offset + the four event hooks (reuse orchestrator bus)
3. Proposed-task pipeline: schema fields + validation panel runner + PM revise loop
4. GitHub issue/PR triage via SyncAdapter events
5. **Lane D workforce: catalog roles + track-record rollup + interview gauntlet + role-aware panel composition (§7)**
6. Each feature: BUILD → independent D-038 DoD-review (v2-wave template)
