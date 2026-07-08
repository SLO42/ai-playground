# CONCIERGE-BROKER-SPEC — atelier from passive hub to active broker

**Status:** DRAFT (2026-07-07) · implements D-041 #4 · gates D-035a / D-026 · queued `concierge-broker` (gate:operator)
**One-liner:** the concierge advises in prose today; make it answer a structured "who is proven on X?" and broker a mediated cross-project introduction — without ever opening a direct project↔project channel.

## 1. Current state (verified seams)

Concierge BUILT (Stages 1/2/3), **advises only**:
- Entry `handleAtelierMessages` (`concierge/concierge.ts:854`), fired best-effort by `triggerConcierge` (`wire.ts:231`) from the peer send route when `to_kind:'atelier'`. Fail-open, never blocks the send.
- Turn `runConciergeTurn` (`:692`): `classifyAtelierIntent` (`:326`) → `recommend_agent` (Stage-1, on-disk agent library) / `skill_request` (Stage-3, gated skills.sh) / `hire_request` (deferred stub) / `open_question` (Stage-2, one bounded LLM turn on local `gpt-oss:20b`).
- Returns `ConciergeTurnResult` → **only ever emits `replyText`** (advisory prose) back to the requester (`to_kind:'session'`, `reply_to`, `:883`). origin=agent, steer=false.
- Grounding = **global memory recall only** (`ConciergeRecallFn`) — NOT a capability index.

Peer bus BUILT: address classes `session|role|pm|atelier` (`peer/resolve.ts:57`); `CrossProjectError` (`:51`) — project↔project direct is fail-closed; **atelier is the sole cross-project identity** (`:201`). `resolveAtelier` (`:157`) is still a documented **placeholder** (D-040 not composed) but Stage-1 wires a live `atelier_self` session via the `ATELIER_SELF_PM` sentinel. `pm`/`atelier` are **not drainable by session identity** (`drain.ts:67`) → an outbound leg to a second project's PM inboxes as **pending** until that PM spawns (event latency, not a dead path).

Capability data BUILT: `workforce/capability-match.ts` — `roleProvenCoverage(db,roleId):string[]` (`:293`, PROVEN via passing gauntlet fixtures, not claimed), `recommendStaffing(db,projectId)` (`:421`, propose-only). **Callers = `pm-propose.ts` + `create/*` only — NOT the concierge**, and both are **project-scoped**.

## 2. Broker gaps (NEEDS-BUILDING)

1. **No structured capability QUERY.** No `capability_query` intent; concierge never imports `capability-match`. "Who's proven on X?" has no path from the bus into `roleProvenCoverage`.
2. **No cross-project aggregator.** `roleProvenCoverage` needs a `roleId` and is project-scoped. There is no "which role ANYWHERE proves class X" over the whole catalog.
3. **No mediated introduction.** `handleAtelierMessages` only replies to the requester. It never originates a NEW leg to a *second* project. A brokered introduction (relay a redacted ask/answer between project A's PM and a proven role in project B, without a direct A↔B channel) has no implementation, no relay-screening pass, no audit trail.

## 3. Design

The concierge already IS the one legitimate cross-project identity. A broker = two additive capabilities on that identity: **answer** (query) and **connect** (mediated relay). No topology change; `CrossProjectError` stays.

### 3.1 `capability_query` intent (the "answer")
- Add an intent to `classifyAtelierIntent`: a PM asks "who is proven on `<defect class / capability>`?"
- Wire the concierge to a **new cross-project aggregator** `provenRolesForCapability(db, capabilityClass): {role, coverage[], maturity, staffedIn[]}[]` — reuses `roleProvenCoverage` per catalog role (union over passing fixtures), filtered to the class, ranked by proven coverage + (once per-hire-soul lands) maturity. Read-only.
- Returns a **structured, screened** answer over the bus (still `replyText` + optional structured `recommendations`), origin=agent, non-steering. This alone delivers most broker value with zero new comms path.

### 3.2 Mediated introduction (the "connect")
- When the PM asks to be *connected* (not just told), the concierge originates a NEW `atelier → session` message to the target project's `pm`/proven role — **allowed because atelier is the cross-project identity**; A↔B direct stays forbidden (the concierge is the mediator, every leg has atelier as one endpoint).
- Each relayed payload is **re-screened (D-026)** at the relay boundary (it now carries other-project content) and fenced as DATA (D-035a — a relayed message never steers; only operator steers).
- **Audit trail**: record the brokered introduction (who asked, what class, who was connected, what was relayed) — a `broker_introduction` record, so cross-project influence is observable (the whole point of the single chokepoint).
- Respect the pending-inbox reality: the target leg inboxes as pending until that PM spawns (honest, F-008 — surface "introduction queued, awaiting <role>").

### 3.3 Bounds
- Reuse the send-path bounds (`MAX_SENDS_PER_SESSION`, hops, dedup). A brokered introduction is a NEW originated message (not a hop-relay) — cap introductions per requester/'window to avoid a broker-amplified spam path.

## 4. Safety invariants (load-bearing)
- **Cross-project-forbidden PRESERVED.** `CrossProjectError` / `resolve.ts` topology UNCHANGED. The broker mediates — atelier is one endpoint of every leg; it never opens a direct A↔B channel or weakens the resolver (D-041/D-035a).
- **Non-steering (D-035a).** Every broker answer + relayed leg is origin=agent, `steer=false`, fenced. A relayed introduction is DATA; only operator steers.
- **Re-screen relayed content (D-026).** Third-party/other-project payloads pass the screen at the relay boundary — a brokered answer can carry another project's text.
- **Fail-open / honest (F-008).** Broker turn never throws off the send path; offline target → pending, surfaced honestly, never fabricated. resolveAtelier stays the sentinel path (note the D-040 placeholder dependency).
- **Read-only answer path.** §3.1 reads capability data; it never mutates workforce/staffing.

## 5. Build tasks
- **CB-1** `provenRolesForCapability` cross-project aggregator (reuse `roleProvenCoverage` over the catalog, class-filtered, ranked). Real-surreal test over seeded certified roles.
- **CB-2** `capability_query` intent + classifier + wire the concierge turn to CB-1; structured+screened reply. Unit + intent tests.
- **CB-3** Mediated introduction: concierge originates the second leg (atelier→target), re-screen at the boundary, `broker_introduction` audit record, dedup/bounds. redTeam (prove no direct A↔B, no steer, no unscreened relay).
- **CB-4** Command-center / `/atelier` surface: brokered introductions + capability answers visible (origin-labelled, honest pending states).

**Verify:** real-surreal tests (CB-1 returns proven roles across projects; CB-3 relays only via atelier legs, re-screens, audits); redTeam CB-3 is the gate (topology unchanged, non-steering, screened, bounded); `npm run db:up` if `broker_introduction` ships a table.

## 6. Open forks
1. **Introduction vs answer-only.** Ship §3.1 (answer) first — it's most value, least risk — and gate §3.2 (mediated introduction) behind its own review. Recommend: CB-1/CB-2 first, CB-3 as a follow-on.
2. **Aggregator ranking.** Coverage-only now; fold in per-hire-soul maturity/calibration once D-041 lands (the specs compose).
3. **resolveAtelier hardening.** The broker's outbound legs want a stable atelier identity — decide whether to harden `resolveAtelier` off the placeholder now or ride the sentinel path until D-040. Recommend the sentinel path (works today) + note the D-040 dependency.
