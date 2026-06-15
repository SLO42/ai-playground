# GLOBAL-TRANSCRIPT-SPEC — atelier-wide reasoning/actions/communications timeline (G-C / BL-5)

> **DRAFT (2026-06-15).** A unified timeline of the atelier's reasoning + actions +
> communications across all agents — not just per-session. Operator-raised alongside G-A/G-B.
> Builds AFTER G-B (consumes its peer_message comms) — serial. Defaults baked (§5).

## 1. Purpose

Today: per-session transcript (`/claude-code?session=`), a fleet LIST (status only),
`agent_event` (analytics). No cross-agent view. G-C is the **single pane** to watch what the
atelier is doing: every session's turns + channel/peer communications + PM proposals/verdicts
+ role lifecycle, on one timeline, filterable by project.

## 2. Substrate (all existing — read-only aggregate)

| Stream | Table | Contributes |
|---|---|---|
| Session turns (reasoning/actions) | `message` (kind+origin, G-A) | assistant/thinking/tool turns, origin-labelled |
| Communications | `message` origin≠agent + `peer_message` (G-B) | operator interjects + agent↔agent comms |
| Management artifacts | `panel_verdict`, `role_event` | PM proposals, verdicts, hire/swap/staffing events |
| Work lifecycle | `session`, `interview_run` | spawns, results, certifications |

Reuse the shared `SessionTranscript` renderer (transcript-core.ts) — add `verdict` and
`role_event` turn kinds; everything else already maps.

## 3. Design

A new read that **merges these streams by timestamp**, scoped (global OR per-project), time-
windowed + **paginated** (atelier-wide is large — bounded by construction, F-014). A new view
(sidebar entry in KNOWLEDGE & SYSTEM, near Reports/Memory) renders the merged timeline: each
entry labelled by **actor** (the G-A origin + role/PM/atelier identity) and **project**, live
via the existing onDbChange SSE (watch the contributing tables). Read-only.

## 4. Security / honesty

Transcript content is already screened (G-A write-side); verdicts/role_events are harness-
authored (safe). No new untrusted surface. Honest empty/loading/paginated states (F-008).
Bounded query (time window + page size) — never an unbounded atelier-wide scan.

## 5. Open decisions (baked default — tunable)

- **D1 scope default:** per-project (with a global toggle) · vs global-first? — *default: per-project default + global toggle (most views are project-scoped).*
- **D2 event classes:** turns + comms + verdicts + role_events · include raw tool analytics? — *default: turns + comms + verdicts + role_events; exclude raw analytics noise (it's on the analytics views).*
- **D3 window:** last-N / last-24h default? — *default: paginated, newest-first, page size ~50, time-filterable.*
- **D4 live vs historical:** live-tail + scrollback? — *default: live-tail (SSE) + paginated scrollback.*

## 5b. Inbox / comms lens (operator-raised 2026-06-15)

Today there is NO UI for the agent fleet's `peer_message` inbox — delivered peer messages
appear in the transcript (G-A communication turns), but **pending / expired / quarantined**
messages have no surface (`pendingInbox` is read only by the spawn-time drain). G-C MUST add
an **inbox lens**: per-agent and fleet-wide, the `peer_message` rows filterable by `status`
(pending / delivered / expired / quarantined), showing from→to (sender/recipient identity),
the screened+fenced body, and age/hops. Honest about the D-040 placeholder (pm/atelier rows
sit `pending` until the `session.pm` seam lands — show them as "awaiting recipient identity",
not silently). This is the operational view ("what's queued / stuck / dropped") that the
timeline (reasoning/actions) doesn't give. Reuses the same `peer_message` substrate.

## 6. Build decomposition

1. The aggregate read: merge `message`/`peer_message`/`panel_verdict`/`role_event` (+ session/
   interview_run context) by timestamp, scoped + paginated; a typed timeline-entry shape.
2. Extend `transcript-core.ts` with `verdict` + `role_event` turn kinds (+ actor/project labels).
3. The global-transcript page + sidebar entry; live via onDbChange; honest empties; bounded.
4. Tests (aggregate ordering, scope filter, pagination, the new turn kinds); bounded UX smoke.
