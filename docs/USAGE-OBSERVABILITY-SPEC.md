# USAGE-OBSERVABILITY-SPEC — who is granted / using what skills + tools

**Status**: queued (2026-06-25). Operator: "can we see what agents/hires/tasks use what
tools/skills?" Today: NO attribution view. The catalog (`/claude-code`) shows what EXISTS;
`/agents` shows the STATIC D-036 bundle→agent declaration ("what *could* be granted"); the
per-session transcript shows raw `tool_use` events. There is no per-session/task/agent roll-up
of granted-vs-used capabilities.

## Grounded facts (verified — F:\code\ai-playground-v2, branch v2)

- **Granted capability set IS known at spawn, NOT persisted.** `launch.ts` has `input.capabilities`
  (CapabilitySet, ~line 102/711) + `peerSendGranted(input.capabilities)` (~678); the session row is
  CREATEd at launch.ts:428 (`CREATE session CONTENT $content`). The `session` schema persists
  `model{provider,model_id,tier}`, `role`, `role_version`, `tool_iter_count` (schema.ts ~126-140,
  1216-1217) — but **NO granted-capability / skills / tools field**. So attribution can't be queried.
- **Tool USAGE is persisted but not rolled up.** `tool_use` is a `message`-row kind (launch.ts:286/333,
  messages.ts m0037 replay discriminator); `tool_iter_count` bumps per tool_use (launch.ts:839). So the
  raw per-session tool calls exist in the `message` table; there is NO per-tool breakdown or cross-session
  roll-up (analytics has no tool-usage aggregate — grep-confirmed).
- **Surfaces today:** `/claude-code` (catalog, read-only), `/agents` (static bundle→agent declaration
  from orchestration.yaml), transcript (`/claude-code?session=`, `/atelier`) (raw tool_use events).

## Design — persist the grant, roll up the usage, surface both

- **UO-1 — persist the granted capability set on the session** (additive migration, F-015): at the
  session CREATE (launch.ts:428), persist what was GRANTED — the composed CapabilitySet
  (`skills[]/agents[]/mcp[]`) + the reserved grants actually in effect (e.g. `peer-send` when
  `peerSendGranted` is true) + the `toolPolicy.allow` tool list + the `intent`. Normalize/omit-absent
  (F-013/§6.1); coerce in the session normalizer (never raw SDK). Capability ids + tool names are NOT
  secrets, but still pass the standard screen path for any free-text. Read-back exposed on the session
  row + fleet projection.
- **UO-2 — tool-usage roll-up (read model)**: a bounded query that aggregates the session's `tool_use`
  `message` rows into a per-tool breakdown (tool name → count) for a session, and a cross-session
  roll-up keyed by skill/tool → the sessions/tasks/agents that were granted it and/or called it
  ("skill X granted to tasks A/B/C; tool Bash called N times across sessions"). Bounded/paginated
  (never an unbounded scan — F-014). Honest empties (F-008).
- **UO-3 — the observability surface**: a view answering the operator's question — per session/task/agent:
  GRANTED capabilities (UO-1) + USED tools (UO-2), and a catalog-side roll-up (per skill/tool: who's
  granted it, who used it). Extend `/agents` (it already owns the capability-bundle view) OR add a panel
  on `/claude-code`/the project command-center — pick the one consistent with the nav/design; reuse the
  existing catalog + transcript components, design-system tokens, a11y. Honest loading/empty/error states.

## Integrity invariants
- **Honest, live data only (F-008)**: granted = the ACTUAL composed set persisted at spawn (never the
  static bundle declaration mislabeled as "granted"); used = the ACTUAL tool_use rows (never fabricated);
  a session with no data reads honest-empty.
- **Additive + idempotent (F-015)**: the new session field + any index apply twice cleanly; legacy rows
  (field absent) render honestly as "not recorded" (older sessions predate the field — F-013, omit→'—',
  never a fake empty set).
- **D-026**: any free-text persisted/rendered is screened; capability/tool ids are opaque, not secrets.
- **Bounded (F-014)**: every roll-up query is paginated/capped; no unbounded scan of the message table.
- **No grant/usage CONFLATION**: granted ≠ used — the surface must distinguish "granted but never called"
  from "used", so the operator sees dead grants (a capability provisioned but unused) honestly.

## Verification (DoD — D-038)
- Unit: session persists the granted set + toolPolicy + intent at CREATE (assert on a row with peer-send
  granted → the row carries it; a non-granted row omits it honestly); migration idempotent + legacy-row
  honest.
- Integration (live SurrealDB): a session with tool_use rows → the roll-up returns the per-tool counts;
  the cross-session roll-up maps skill/tool → sessions; honest-empty for a no-data session.
- Build + test + lint(0) + svelte-check(0). Live-verify the surface renders granted+used honestly.
