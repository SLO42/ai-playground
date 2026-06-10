# PM-SPEC — the per-project AI Project Manager (wave v2.1)

> Operator-shaped 2026-06-10. Governs the rebuild of the PM from typed-memory-functions (9.1/11.4) into a **hired, per-project manager with identity, charter, and validated authority**. Supersedes nothing — extends the existing pm_memory/decision/pm_review spine; do NOT regress 9.1/11.4.

## 1. Identity — the PM is hired, not implicit

- New `pm` table, **one row per project** (UNIQUE project link): `project`, `name`, `charter: option<string>` (operator-written directives: priorities, tone, escalation rules), `persona: option<string>`, `cadence: option<string>` (cron expr), `cadence_offset: option<duration>` (per-project stagger so PMs don't fire simultaneously), `authority: 'observe' | 'propose' | 'act'` (default **act** — see §4), `created_at`. Migration per F-015 (OVERWRITE, apply-twice + half-applied tests).
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
2. PM-created tasks enter status **`proposed`** and are routed to a **validation panel: 1–2 independent validator agents** that judge purpose/spec/duplication/feasibility against the project plan + charter, then **approve → `ready`** or **push back → returned to the PM with reasons** (the PM revises or withdraws; pushback reasons become PM memory — the PM learns its team's bar).
3. Panel verdicts are recorded (validator id, verdict, reasons) — same build→independent-review ethos as D-038, applied to management artifacts.
4. External/destructive actions (anything beyond creating proposed work) still hit the D-018/D-024 gates. Escalations to the operator go via the notification system per charter rules.

## 5. PRs/issues — triage-only

The PM **summarizes, links to tasks, flags risk areas, and proposes spawning a reviewer agent**. It does NOT review diffs itself (role separation; keeps PM context lean). Issue triage: classify, link/duplicate-check, propose a task (through §4 validation).

## 6. Honesty + scope rails

- F-008 throughout: memories derive from real signals; snapshots from live rows; "no findings" is a valid result; absent datetimes → null → '—' (F-013/F-015).
- Strictly per-project (existing `WHERE project = $project` discipline). No cross-project PM reads.
- All PM sessions route through the existing launch path (capabilities, gates, analytics events — analytics is first-class).

## 7. Build shape (wave v2.1 — after the v2.0 audits settle)

1. `pm` table + hire flow + charter editor (extend PM tab)
2. Trigger engine: per-project cron+offset + the four event hooks (reuse orchestrator bus)
3. Proposed-task pipeline: schema fields + validation panel runner + PM revise loop
4. GitHub issue/PR triage via SyncAdapter events
5. Each feature: BUILD → independent D-038 DoD-review (v2-wave template)
