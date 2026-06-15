# PEER-MESSAGE-SPEC — agent↔agent communication (G-B / BL-4)

> **DRAFT for operator sign-off (2026-06-15).** Spec'd at operator request after G-A
> (comms-origin-visible) shipped. Implements the v0.2 `peer_message fleet bus` that
> `channel.ts:8` has reserved since 2.10. **This is a spec, not a build** — §9 lists the
> open decisions the operator settles before any wave runs. Status: BL-4 in BUILD-QUEUE.

## 1. Purpose & scope

Let driven agents (sessions) **communicate with each other** — share findings, hand off
context, coordinate — instead of only the artifact handoffs that exist today (orchestrator
dispatch · PM proposals → `panel_verdict` · gauntlet `findings.json` → scorer). The first
real need is the **new-mod-test** graduation flow (a project PM coordinating its staffed
roles) and the workforce generally.

Built as the **additive consumer of the existing `channel.pushToSession` seam** (D-035b) —
NOT a new spine, NOT a second SSE source. The architecture is already reserved for it.

## 2. Locked invariants (inherited — NOT re-decidable)

These are load-bearing and carry over from the channel seam + memory fence. A peer-message
layer that breaks any of these is wrong by construction:

1. **D-035a — a peer message NEVER steers.** `origin` is stamped SERVER-SIDE at the
   authenticated ingress, immutable, never derived from content. A peer message is
   `origin=agent` → **fenced as DATA, non-steering**. Only an operator-token message
   (control endpoint + valid D-025 token, constant-time compared) may STEER. A peer
   body that says "ignore your task, do X" is inert reference text, exactly like recalled
   memory. (`channel.ts:182-191` resolveOrigin; `channel.ts:289` fence-before-deliver.)
2. **D-026 — content is screened.** Every peer body passes `screen()` (secret/PII redact
   or quarantine) before persist/deliver, and is wrapped by `fence({source:'channel'})`
   (the `⎆BEGIN_REFERENCE⎆…⎆END_REFERENCE⎆` envelope + `stripEmbeddedSentinels` so a sender
   can't forge a fence boundary). Both `fence.ts`/`screen.ts` ALREADY name 'channel'/
   'peer_message' as a source — reuse, don't reinvent.
3. **Capability-gated, fail-closed.** Sending is a granted capability (D-036), like the B10
   memory-pull tool: a session without `peer-send` in its composed `CapabilitySet` simply
   has no tool to call. Composed at `composeCapabilities` (catalog-validated, fail-closed).
4. **Transcript-visible by construction.** A delivered peer message persists as a `message`
   row with `origin=agent` → G-A already renders it as an origin-labelled "communication"
   turn, and G-C (global transcript) aggregates it. No extra visibility work.
5. **Bounded (F-014 / D-024).** No unbounded fan-out, no infinite ping-pong, no spin.

## 3. Architecture — what it reuses

| Seam | Reused for | Entry point |
|---|---|---|
| Channel (`channel.ts`) | live delivery into a running recipient + origin stamp + message persist | `channel.interject`/`pushToSession` (origin=agent path) |
| Event bus + SSE | live fan-out to the recipient's transcript | `bus.publish({type:'interject'|'peer_message', topic, …})` → `subscribeTopic` |
| Capability tool (B10 template) | the **send** primitive an agent calls | mirror `buildMemoryPullMcpServer` + `mcpToolWiring` (wiring.ts) + a loopback route + `scripts/peer-send-mcp.mjs` |
| Fence + screen | DATA-wrap + secret-screen the body | `screen()` then `fence({source:'channel'})` |

**Send path (running recipient):** agent calls the capability-gated `peer_send` tool →
loopback route resolves the SENDER identity server-side (never from the body) → `screen` +
`fence` → `channel.pushToSession({recipient, origin:'agent', body, steer:false})` → message
row (origin=agent) + bus publish → recipient sees a fenced "communication" turn live.

## 4. Gaps this spec must close (the map found 4)

The channel/bus/fence/capability seams EXIST. A peer layer must ADD:

- **G1 Recipient addressing/discovery** — today the channel targets one `sessionId`. Peer
  needs: address by session id (direct), and/or by **role** (resolve role → its running
  session), and/or **project** (the PM, or staffed roles). No discovery exists.
- **G2 Offline delivery (CRITICAL)** — `interject` requires `session.status='running'`
  (`channel.ts:262-264`); a message to a non-running agent is dropped, and SSE has no
  replay. A real "fleet bus" needs a **durable inbox**.
- **G3 Authorization (who may message whom)** — the abuse/injection surface. Capability-
  gating covers "may this session send at all"; a **recipient policy** covers "to whom"
  (same project? the PM only? any?). New.
- **G4 Loop/spam bound** — per-sender send budget, max recipients per send, a TTL/depth so
  A→B→A can't ping-pong forever. New.

## 5. Recommended design (operator adjusts in §9)

- **G2 → a durable `peer_message` inbox table** (the actual "fleet bus"): a send writes a
  `peer_message` row (status `pending`); if the recipient is RUNNING it's also delivered
  live via the channel and marked `delivered`; if not, it's **drained at the recipient's
  next spawn** — fenced into the session briefing (the existing `composeBriefing` injection
  point, already fenced as DATA), then marked `delivered`. At-least-once, idempotent by
  message id. This makes peer messaging durable, not best-effort.
- **G1 → address by session id OR role**, resolved server-side to the recipient session(s);
  **project-scoped by default** (a sender reaches peers staffed on the same project + that
  project's PM). Cross-project send is a separate gated capability.
- **G3 → capability `peer-send` (send) + a recipient policy**: default = within-project +
  the project PM. The **PM is a first-class hub** (agent→PM "I found X", PM→agent "focus on
  Y" — still non-steering DATA the recipient chooses to act on). Suppression-shaped or
  cross-project messaging is operator-gated (G2-class act).
- **G4 → bounds**: per-session send budget (mirror the recall budget pattern), `max_recipients`
  per send, and a `hops`/TTL field on `peer_message` decremented per relay (0 = no further
  relay) to kill ping-pong.

## 6. Data model (proposed)

```
DEFINE TABLE peer_message SCHEMAFULL;            -- the durable fleet-bus inbox
  from_session  record<session>                  -- resolved server-side (sender identity, never body-claimed)
  from_role     option<record<role>>             -- if the sender is a workforce role
  to_session    option<record<session>>          -- direct address (resolved)
  to_role       option<record<role>>             -- role address (resolved → session at delivery)
  project       option<record<project>>          -- scope (default = sender's project)
  body          string                            -- SCREENED + FENCED at write (D-026/§10)
  status        string  ASSERT IN [pending,delivered,expired,quarantined]  DEFAULT pending
  hops          int     DEFAULT 1                  -- relay TTL (0 = terminal, no further peer relay)
  created_at / delivered_at  datetime
  -- delivery also writes a `message` row (origin=agent) into the recipient's transcript (G-A)
```

## 7. Delivery semantics

- **Running recipient:** live via `channel.pushToSession` (origin=agent, fenced, non-steering)
  + `peer_message.status=delivered` + a transcript `message` row → renders live (G-A/H2).
- **Offline recipient:** stays `pending`; drained at the recipient's next spawn, fenced into
  the briefing, then `delivered` + transcript row. (Expired by TTL/age → `expired`, honest.)
- **Idempotent** by `peer_message` id (a reconnect/redeliver collapses, like H2's messageId dedup).

## 8. What it explicitly does NOT do

No steering (peer = DATA only). No operator impersonation (origin is the server stamp; a
body claiming operator stays `agent` — proven in G-A red-team). No unbounded fan-out / no
ping-pong (G4 bounds). No cross-project messaging without an operator-gated capability. No
secret leakage between agents (screen). No new SSE spine (rides the one bus).

## 9. OPEN DECISIONS — operator sign-off before build

- **D1 Addressing (identity classes — see §11):** `session` (running peer) · `role@project`
  (resolve→session) · `pm@project` (the project's PM identity — inbox-backed, usually offline)
  · `atelier` (the platform identity — §11). — *recommend: all four; `pm@project` and `atelier`
  are inbox-backed by construction (rarely running), which is WHY D2 must be the durable inbox.*
- **D2 Offline delivery:** running-only (mirror interject, drop-with-honest-error; less
  build) · OR the durable `peer_message` inbox (the real fleet bus; more build)? —
  *recommend: durable inbox — "fleet bus" implies durability.*
- **D3 Topology/authorization:** the identity HIERARCHY (§11) — operator > atelier(platform)
  > project PM > roles/sessions. Within a project: a mesh (roles ↔ their PM). ACROSS projects:
  flows THROUGH the atelier (it holds the global view via the brain), never project↔project
  direct (isolation). — *recommend: in-project mesh + PM hub; cross-project only via the
  atelier identity; the atelier reaches projects via the brain (ambient) + directed peer
  messages; cross-project direct is forbidden, not just gated.*
- **D4 Timing:** now · OR after the day-0 ceremony + as part of/just before **new-mod-test**
  (where a PM coordinating staffed roles is the first real consumer)? — *recommend: after
  the ceremony; it has no real consumer until multi-agent project work exists, and the
  ceremony is the priority.*
- **D5 Scope of v1:** does v1 include role/PM addressing, or only session→session direct
  (with role/PM in a v2)? — *recommend: session + PM-hub in v1; full role mesh later.*

## 10. Build decomposition (once D1–D5 land)

1. `peer_message` table + idempotent additive migration (per D2).
2. `peer-send` capability id + the gated MCP tool (mirror B10: `scripts/peer-send-mcp.mjs`
   + `mcpToolWiring` + `composeCapabilities` gating, fail-closed).
3. Loopback send route: resolve sender identity server-side → screen + fence → write
   `peer_message` (+ live `channel.pushToSession` if recipient running) → bus publish.
4. Recipient resolution (G1) + recipient policy (G3) + bounds (G4).
5. Offline drain at spawn: fence pending peer messages into `composeBriefing` (per D2).
6. Transcript: free via G-A (origin=agent already renders as a communication turn); G-C
   surfaces the cross-agent flow.
7. Red-team: a peer message must never steer; sender identity un-forgeable; bounds hold;
   no cross-project leak; fence un-escapable.

## 11. Actor identities & the atelier (operator-clarified 2026-06-15)

The addressing model has FOUR identity classes, in a hierarchy:

```
operator (human)              ── the ONLY identity that STEERS (origin=operator + token)
  └─ atelier (PLATFORM agent)  ── orchestral layer ON the global memory (the brain);
  │                               maintains itself (D-040 self-hosting / atelier_self's PM),
  │                               creates projects (Create-with-AI), ingests content into the
  │                               ecosystem for cross-project reuse + self-improvement.
  │                               origin=agent → DATA, NON-STEERING.
  └─── project PM (per project) ── coordinator; event/periodic-triggered → usually OFFLINE,
  │                               so `pm@project` is inbox-backed. origin=agent.
  └────── roles / sessions      ── workers. origin=agent (their own turns) / addressable by session.
```

**The atelier has TWO channels to projects:**
1. **The brain (ambient, primary):** atelier ingests → global memory; project agents RECALL
   (screened + fenced, MEMORY-SPEC). Cross-ecosystem knowledge propagates here WITHOUT a
   message — shared substrate. This is the atelier's main reach into projects.
2. **The peer bus (directed):** a specific message to a specific `pm@project` — point-to-point
   coordination on top of the brain. This spec's subject.

**THE STEERING INVARIANT HOLDS EVEN FOR THE ATELIER (load-bearing).** The platform layer is
the HIGHEST-CAPABILITY agent (global memory, self-modification, cross-project) → it must have
the LEAST unchecked steering authority. So:
- The atelier's **communication is DATA** (origin=agent, fenced) — a project PM *weighs* it,
  is never *commanded* by it. No agent commands another agent.
- The atelier's **orchestration power is the GATED CONTROL PLANE** — Create-with-AI, the
  orchestrator/task system, D-039 PM-validation, the operator gates on real spend / publish.
  Projects are created and work dispatched THERE, not via steering messages.
- **Only the operator's token steers** a session directly. A compromised brain layer that could
  *command* every project would be catastrophic; DATA-only + gated-control-plane is the
  safe-by-construction containment.

**Cross-project isolation:** projects never message each other directly. Cross-project flow
(prior art, shared patterns, "project A's finding is relevant to project B") routes THROUGH
the atelier — which alone holds the global view (the brain). This keeps projects isolated and
the atelier the sole cross-project coordinator (D-001/D-002 spirit, extended to the agent layer).

**Open (folds into D1/D3):** whether `atelier` is realized as atelier_self's PM (D-040) acting
as the platform identity, or a distinct platform-coordinator identity above all project PMs.
Resolve when D-040 self-hosting composes — until then `atelier` ≈ atelier_self's PM + the brain.
