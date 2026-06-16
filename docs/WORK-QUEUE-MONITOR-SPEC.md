# WORK-QUEUE-MONITOR-SPEC — surface the background orchestrator queue (BL-9)

> **DRAFT (2026-06-16, operator-requested "spec both + queue + start").** The async control
> plane (`work_item` — memory reviews, skill consolidations, re-interview proposals, task
> re-runs) runs entirely invisibly today. This adds a READ-ONLY monitor so the operator can
> see backlog depth, daily-cap throttling, and stuck/stale items. Observability only — it
> does not enqueue, cancel, or mutate work.

## 1. Purpose & scope

`work_item` is the atomic background queue (`orchestrator/workqueue.ts`): claim tokens, daily
spawn caps (D-021), stale GC, handoff recovery, a dedup window. It is touched by exactly one
route loader (the re-interview enqueue on `/agents/ceremony`) — there is **no monitor**. The
operator cannot see whether the system is backlogged, cap-throttled, or wedged on a dead
claim. This surfaces it.

Scope = one read-only monitor view. NO new schema, NO enqueue/cancel/retry control (a control
plane is a separate, gated decision — view-only here).

## 2. Locked invariants

1. **READ-ONLY.** No enqueue/claim/cancel/retry button. Reading the queue only. (A future
   operator control plane is out of scope and would be separately gated.)
2. **Honest states (F-008).** Empty queue → "no work pending", never a fabricated row.
   Daily-cap and stale numbers come from the real `workqueue` readers — no invented metrics.
   If a status can't be read, honest error/unknown, not a zero.
3. **No new schema.** `work_item` exists; `workqueue.ts` already exposes the readers
   (`countByStatus`, `pendingDepth`, `spawnsSince`, `gcStale` is a mutator — do NOT call it
   from a loader; read its inputs instead). Add a thin read-only `listWorkItems(...)` lister
   only.
4. **Bounded reads (F-014/D-024).** History can be large — paginate/time-window the completed
   list; the live counts are cheap aggregates.

## 3. Architecture — reuse

| Need | Reuse |
|---|---|
| Status counts | `workqueue.ts` `countByStatus(status)` |
| Backlog depth | `workqueue.ts` `pendingDepth()` |
| Daily-cap accounting | `workqueue.ts` `spawnsSince(...)` + `DAY` + the D-021 cap constant |
| Stale detection (READ the threshold, do not run the GC) | `workqueue.ts` `gcStale` logic — surface "processing older than the stale window" as a derived read, never invoke the reaper from a loader |
| Handoff state | `workqueue.ts` `HandoffRow` / `recoverHandoffs` shape (read-only display) |
| Live updates | `onDbChange` SSE + `events/watched-tables.ts` (add `work_item`) |
| Datetime | F-013 — ISO-coerce, absent → '—' |

New code: a thin read-only `listWorkItems({status?, limit, before?})` + a `queueStats()`
aggregate (depth, per-status counts, today's spawns vs cap, stale count) + a page loader.

## 4. UI — one monitor

Placement: a view in the **Atelier** cluster (it is atelier-wide orchestration) or **Services**
(operational health) — builder's call; default Atelier, as a sibling/tab. Svelte 5 runes,
design tokens, a11y, honest states; live via SSE.

Show:
- **Headline stats:** pending depth · processing count · today's spawns vs the daily cap
  (D-021) with a clear "throttled / X remaining" state · stale count.
- **Active list:** pending + processing items — kind (memory-review / consolidation /
  re-interview / task-rerun), target ref, enqueued_at, claim age; flag any processing item
  older than the stale window as **STALE** (derived read, honest — not auto-reaped here).
- **Recent completed:** paginated/time-windowed history with terminal status + duration.
- Honest empty ("queue is idle"), honest error (reader unavailable).

## 5. Security

Read-only operational dashboard, same trust level as `/services`. No mutation, so no authz
beyond the existing dashboard. Work-item `ref`/payload may name internal entities — render as
plain text (no execution); if any payload field could carry stored content, screen it (D-026)
— most are internal ids, low risk.

## 6. Build decomposition (one task, BL-9)

1. Read-only `listWorkItems(...)` + `queueStats()` in/near `workqueue.ts` (or a sibling
   read module) — ISO-coerce datetimes; derived stale flag from the existing threshold; do
   NOT call the reaper/GC mutators from a loader. Unit-tested vs real SurrealDB.
2. The monitor view (Atelier cluster default), headline stats + active list + paginated
   completed, tokens + a11y + honest states; live SSE via watched-tables (`work_item`).
3. Tests: stats aggregate correct (depth/counts/cap-remaining/stale) incl. empty queue;
   a processing item past the stale window flags STALE; pagination bounds hold; absent
   datetime → '—'. svelte-check 0; bounded agent-browser smoke.

## 7. Open decisions (baked default — not a gate)

- **D1 placement:** Atelier cluster · Services · its own nav item? — *default: Atelier
  (it's atelier-wide orchestration), as a tab/sibling.*
- **D2 stale window source:** reuse the reaper's existing constant · a view-local threshold?
  — *default: reuse the reaper/`gcStale` threshold constant so the monitor and the GC agree.*
- **D3 cap display:** number only · a progress bar toward the D-021 cap? — *default: count +
  "X remaining / throttled" honest state; bar is a nicety.*
