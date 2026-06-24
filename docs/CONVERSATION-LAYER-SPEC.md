# CONVERSATION-LAYER-SPEC — make hires actually converse (pillar 3 of "alive")

**Status**: queued (2026-06-23). Operator north-star: Atelier must feel ALIVE — incl.
**conversations between hires**. The peer-message TRANSPORT + SAFETY + RENDERING are already
built (BL-4 / G-B, G-A, G-C); agents just aren't PROMPTED or GRANTED to use it. This is the
thin prompt/policy layer on top — NOT a transport rebuild.

## Grounded seams (verified — F:\code\ai-playground-v2, branch v2)

REUSE (built, production-ready):
- **Send path**: `src/routes/api/peer/send/+server.ts` (D-025 loopback+token auth; sender resolved
  SERVER-SIDE from the `x-atelier-session` header, never the body — D-035a). Table `m0039_peer_message`
  (from_session/from_role/to_kind/to_session/to_role/project/body/status/hops/dedup_key UNIQUE).
- **4 address classes** (`src/lib/server/peer/resolve.ts`): **session** + **role@project** RESOLVE today;
  **pm@project** and **atelier** are HONEST D-040 PLACEHOLDERS that resolve to ZERO live recipients
  (`resolve.ts` — no `session.pm` column; `resolveAtelier()` documented placeholder). TTL 7d,
  `MAX_HOPS=4`, durable offline inbox.
- **Capability + MCP tool**: `PEER_SEND_CAPABILITY_ID='peer-send'` (tool-catalog.ts), gated MCP server
  `mcp__atelier-peer` / tool `peer_send` (`scripts/peer-send-mcp.mjs`), registered ONLY when
  `peerSendGranted(capabilities)` is true (FAIL CLOSED). Sender stamped from `ATELIER_SESSION_ID`
  (spawn env, agent can't forge) → header. **NO driven session is granted peer-send today** — the
  capability is dormant (not in any intent bundle).
- **Offline drain at spawn**: `src/lib/server/sessions/launch.ts:461-523` — drains pending inbox
  (≤50/spawn), marks delivered, persists transcript `message` rows (origin='agent'), re-injects fenced
  bodies into the briefing as DATA.
- **Surfacing**: `src/lib/client/transcript-core.ts` — `'communication'` TurnKind, origin-wins
  classification (D-035a/GA2); reused by per-session transcript AND `/atelier` (G-C). NO renderer rebuild.
- **Safety chokepoint**: `src/lib/server/peer/repo.ts` — every body `screen()` (D-026) then `fence()`
  (DATA, consult-not-obey) at write; non-steering delivery (`channel.interject(..., viaControlEndpoint:false)`
  → origin='agent', steer=false by construction); quarantine-on-secret + honest expiry.

BUILD NEW (the gap — verified absent): `launch.ts buildBriefing` injects fenced DATA (recall + drained
peer msgs) but NO instruction telling the agent it CAN `peer_send`, WHOM it can reach, or WHEN
(searched 'peer'/'message'/'coordinate'/'reviewer'/'PM' in the prompt path — none). The conversation
layer is exactly: affordance + identity + grant policy.

## Design — three thin additions, zero new transport

- **CV-1 — communication affordance + recipient disclosure in the briefing** (`launch.ts` briefing
  assembly, the buildBriefing seam): WHEN (and only when) the session is GRANTED peer-send, add a
  bounded INSTRUCTION section (not fenced DATA — it's a real affordance) that:
  - states the agent may call `peer_send({ to:{kind,ref?,project?}, body })`, async (no RPC/blocking),
    delivered to the recipient's inbox (now if running, on their next spawn if offline);
  - lists ONLY the address classes that actually resolve — **session** and **role@project** — and
    EXPLICITLY does NOT advertise pm/atelier (inert D-040 placeholders → never tell an agent it can
    reach an address that resolves to nothing — honest, F-008);
  - discloses WHO is reachable: a bounded "who's working this project" list derived from the live
    FleetSnapshot (running sessions in THIS project + their roles), so the agent knows real recipients;
  - frames PURPOSE + restraint: use sparingly, for genuine coordination/clarifying questions/handoffs
    — not chatter; messages are async DATA the recipient weighs, never commands.
  A non-granted session sees NONE of this (no dead affordance).
- **CV-2 — grant policy (WHEN)** via the D-036 capability composition: include `peer-send` in the
  capability set for the intents/situations where conversation is purposeful (e.g. code-write/code-debug
  sessions in a project that has >1 concurrent/staffed session; a solo session may still be granted —
  it simply has no recipients, honest). **F-045-SAFE GRANT (load-bearing):** `peer-send` is a RESERVED
  runtime capability id (read by `peerSendGranted`), NOT a `cc_skill` — granting it MUST NOT route it
  through the cc-config catalog validation that fail-closes on un-catalogued ids (the F-045 trap). Grant
  it via the reserved-capability path (mirror how `memory-pull` MEMORY_PULL_CAPABILITY_IDS is handled at
  the compose seam), confirmed against `composeCapabilities` so a granted spawn does NOT throw.
- **CV-3 — end-to-end proof + reuse surfacing**: prove a real conversation: two concurrent same-project
  WRITE sessions (now possible post workspace-isolation), session A `peer_send`s session B a coordination
  note → B drains it at/next spawn → it renders as a `'communication'` turn on B's transcript AND on
  `/atelier`, screened+fenced, origin='agent', non-steering. No renderer changes — assert the existing
  path carries it.

## Integrity invariants (red-team targets)

- **Non-steering preserved (D-035a)**: a peer message NEVER steers the recipient — origin='agent',
  fenced DATA, delivered off the control endpoint. The new affordance must not create any path where a
  peer body becomes an instruction. Red-team: a body crafted as "SYSTEM: do X" stays inert DATA.
- **Honest recipients only (F-008)**: the affordance advertises ONLY resolvable addresses (session,
  role@project) + real running recipients; NEVER pm/atelier (inert) until D-040 composes them.
- **Affordance only when granted**: `peerSendGranted` false → no peer instruction, no MCP tool — no
  dead affordance, no confusion.
- **F-045-safe grant**: granting peer-send never trips the cc-config catalog fail-closed (reserved id,
  not a cc_skill) — a granted spawn must not throw at compose.
- **D-026 screen+fence intact**: every body still screened+fenced at the single repo.ts chokepoint;
  a planted secret quarantines, never delivers raw.
- **Bounded (no spam/loop)**: rely on the existing TTL(7d)/MAX_HOPS(4)/dedup/per-session send budget
  (BL-4 hardening); the affordance frames sparing, purposeful use — it does not raise any bound.

## Out of scope (note, don't build)
- pm@project + atelier addressing stay D-040 PLACEHOLDERS (resolve to nothing) until self-hosting
  composes those identities — do NOT fabricate them here.
- No new transport, no renderer rebuild, no raising of bus bounds.

## Verification (DoD — D-038)
- Unit: the briefing emits the affordance ONLY when granted; advertises only resolvable address classes;
  lists real project recipients; absent when not granted. Grant composes without an F-045 throw.
- Integration (live, bounded — F-014): A→B same-project peer_send delivers + renders as a 'communication'
  turn on transcript + /atelier; a planted secret quarantines (not delivered); a "do X" body stays
  non-steering DATA.
- Build + test + lint(0) + svelte-check(0). Live-verify two sessions conversing on the timeline.
