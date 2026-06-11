# PM-SPEC — the per-project AI Project Manager (wave v2.1)

> Operator-shaped 2026-06-10. Governs the rebuild of the PM from typed-memory-functions (9.1/11.4) into a **hired, per-project manager with identity, charter, and validated authority**. Supersedes nothing — extends the existing pm_memory/decision/pm_review spine; do NOT regress 9.1/11.4.

## 1. Identity — the PM is hired, not implicit

- New `pm` table, **one row per project** (UNIQUE project link): `project`, `name`, `charter: option<string>` (operator-written directives: priorities, tone, escalation rules), `persona: option<string>`, `cadence: option<string>` (cron expr), `cadence_offset: option<duration>` (per-project stagger so PMs don't fire simultaneously), `authority: 'observe' | 'propose' | 'act'` (default **act** — see §4), `created_at`. Migration per F-015 (OVERWRITE, apply-twice + half-applied tests).
- **PM model (operator, 2026-06-10): the PM runs on a strong frontier model — default Fable 5 (`claude-fable-5`)**, set via `config/workforce.yaml pm.model_id` (operator-tunable, per-project overridable on the pm row later if needed). PM sessions route with the explicit `{provider, model_id}` override (F-005 short-circuit) — the PM is the conductor, not a gauntleted workforce role; its model choice is config, not certification (WORKFORCE-SPEC roles still certify per (prompt_sha × model_id)).
- **Hiring = context-building.** Creating a PM (PM tab → "Hire PM", replaces bare bootstrap) runs: project scan + plan-macro read + recent-history digest → founding `pm_memory` rows (extends the existing `bootstrapPm`) + the operator writes the charter in the same flow. A project with no PM renders the honest empty state + hire CTA (current behavior preserved).

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

## 4. Authority — "Act with Purpose" (operator standard)

The PM **auto-creates** tasks/priorities/escalations — but nothing it creates is born actionable:

1. Every PM-created artifact MUST carry: **objective** (clear, single), **purpose** (why this, why now — ties to plan/charter/finding), **full spec** (acceptance criteria a build agent could execute against), and provenance (which trigger/evidence produced it). Schema-enforced fields, not prose convention.
2. PM-created tasks enter status **`proposed`** and are routed to a **validation panel: 1–2 independent validator agents** that judge purpose/spec/duplication/feasibility against the project plan + charter, then **approve → `ready`** or **push back → returned to the PM with reasons** (the PM revises or withdraws; pushback reasons become PM memory — the PM learns its team's bar). **Panel composition is role-aware (HARVEST-GSTACK Lane D): validators are drawn from the role catalog by role fit to the artifact under review + TRACK RECORD** (per-role rollup of verdicts, refutation outcomes, calibration events, fix-loop rates — Lane D D6) — never just role name.
3. Panel verdicts are recorded (validator id, verdict, reasons) — same build→independent-review ethos as D-038, applied to management artifacts. **Verdict evidence rule (harvested: gstack review/SKILL.md confidence calibration, MIT; G1-adapted — Lane A-docs A1):** a presence-claim in a panel verdict ("duplicates task X", "spec already covered by Y") must quote the motivating artifact text verbatim; an absence-claim ("no acceptance criteria", "missing provenance", "no duplicate found") instead names the expected artifact + the search that proved absence, and is EXEMPT from suppression. A claim the validator cannot evidence is tagged "(unverified)" — kept in the verdict, never silently dropped.
4. External/destructive actions (anything beyond creating proposed work) still hit the D-018/D-024 gates. Escalations to the operator go via the notification system per charter rules.

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
