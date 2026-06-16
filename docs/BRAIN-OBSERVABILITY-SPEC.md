# BRAIN-OBSERVABILITY-SPEC — make the self-learning brain visible (BL-8)

> **DRAFT (2026-06-16, operator-requested "spec both + queue + start").** Surfaces three
> currently-invisible memory/learning tables so the "self-healing / self-learning brain"
> claim is *visible and honest* (F-008) and so BL-7 Part B (outcome→keep/prune) has the
> history+utilization evidence it requires before anything is retired. READ-ONLY — this is
> an observability surface, it never mutates the brain.

## 1. Purpose & scope

Today `/memory` shows live memory rows + the knowledge graph (`explorer.listMemories` /
`listGraph`). Three load-bearing tables have **zero UI**:

- **`memory_history`** — append-only audit of every add / supersede / **archive** on a memory
  row (before/after content, screen_status, timestamp). The "why did the brain change/forget
  X" forensic trail (MEMORY-SPEC §5.2, D-015).
- **`skill` + `causal_chain`** — the learned-skill graduation pipeline (a trigger→outcome
  chain that succeeded N times graduates into a reusable skill). The headline self-learning
  capability, fully dark — no list, success rate, or graduation log.
- **`retrieval_outcome`** — the D-030 ranking signal: each recalled memory logs recalled →
  cited `[#N]` → utilized. This is exactly what BL-7A strengthened; right now you cannot see
  whether the citation loop is working.

Scope = three read-only lenses, reachable from the existing **Memory** nav cluster. NO new
schema, NO mutation, NO retire/prune action (that is BL-7 Part B, operator-gated).

## 2. Locked invariants

1. **READ-ONLY.** No control writes any memory/skill/outcome/history row. No archive/retire
   button (BL-7 Part B owns that, operator-gated). A reader-only surface.
2. **Fenced content (D-026).** `memory_history` before/after snapshots and skill bodies are
   memory content — render them **screened/fenced as DATA** (reuse the same screen/fence
   path the rest of the memory UI uses); never let stored content act as instructions, never
   surface a raw secret a screen would have caught.
3. **Honest states (F-008).** Empty history / no graduated skills / zero outcomes → honest
   empty, never fabricated rows or invented metrics. An un-utilized memory shows "recalled,
   not yet cited", not a faked score.
4. **No new schema.** All three tables exist (schema.ts). Add read-only repo listers + page
   loaders only. (A new read index is acceptable IF a query needs it and is additive/OVERWRITE
   per F-015 — prefer none.)

## 3. Architecture — reuse

| Need | Reuse |
|---|---|
| Memory rows + graph | `explorer.ts` (`listMemories`, `listGraph`) — the existing pattern |
| Outcome write path (to understand the shape) | `recall.ts` `recordOutcomes`, `outcomes.ts` `recordTurnOutcomes` (they WRITE `retrieval_outcome`; BL-8 only READS) |
| Skill graduation | `loop.ts` (`consolidate`, `screenSkillForGraduation`), `index.ts` `fenceSkill` |
| Screen + fence for display | `memory/screen.ts` + `memory/fence.ts` (same DATA boundary the memory UI already uses) |
| Live updates | the existing `onDbChange` SSE + `events/watched-tables.ts` (add the three tables if live refresh is wanted) |
| Datetime rendering | F-013 discipline — ISO-coerce in the normalizer, absent → '—' |

New code is thin **read-only listers** (e.g. `listMemoryHistory(memoryId?)`, `listSkills()`,
`listCausalChains(skillId?)`, `listRetrievalOutcomes(memoryId?)`) + page loaders.

## 4. UI — three lenses under Memory

Place as sub-views/tabs of `/memory` (or sibling routes `/memory/history`, `/memory/skills`,
`/memory/outcomes` — builder's call, keep it inside the Memory cluster). Svelte 5 runes,
design tokens only, a11y (focus-visible, labelled regions), honest loading/empty/error.

- **History lens** — for a selected memory (or recent activity feed): the audit timeline of
  add/supersede/archive, before→after diff (fenced), screen_status, timestamp, reason. Answers
  "what changed and why / why was this archived".
- **Learned-skills lens** — list of graduated skills: title, graduation date, success/failure
  counts (from causal_chain), last used, source trigger; expand to view the causal_chain
  (trigger→outcome) that produced it (fenced). Honest "no skills graduated yet" when empty.
- **Utilization lens** — the D-030 signal: per memory (or a leaderboard), times recalled vs
  cited vs utilized, current rank/score input. Surfaces "recalled but never used" rows (the
  low-value candidates BL-7B will later let the operator retire — here, view-only). Pairs
  directly with the BL-7A cite-directive (does the loop actually produce citations?).

## 5. Security

Read-only; capability-wise it is operator-facing dashboard data (same trust level as the
existing `/memory` page). The only real risk is content display — handled by §2.2 (screen +
fence on every rendered snapshot/skill body). No mutation surface, so no authz beyond the
existing dashboard.

## 6. Build decomposition (one task, BL-8)

1. Read-only repo listers for `memory_history`, `skill`+`causal_chain`, `retrieval_outcome`
   (ISO-coerce datetimes; screen/fence content fields). Unit-tested vs real SurrealDB.
2. The three lenses under the Memory cluster (tabs or sibling routes), tokens + a11y + honest
   states; optional live SSE via watched-tables.
3. Tests: each lister returns shaped rows incl. empty/absent-datetime cases; a history snapshot
   with a planted secret is screened on display; a skill body with an embedded sentinel stays
   fenced (non-steering). svelte-check 0; bounded agent-browser smoke of the three lenses.

## 7. Open decisions (baked default — not a gate)

- **D1 layout:** tabs on `/memory` · sibling routes `/memory/{history,skills,outcomes}`? —
  *default: builder's call; keep inside the Memory nav cluster, discoverable.*
- **D2 history entry point:** per-memory drill-down · a global recent-activity feed · both? —
  *default: both — a global recent feed + per-memory drill-down from the existing row.*
- **D3 utilization shape:** per-memory detail · a leaderboard of most/least-used? —
  *default: both — leaderboard + per-memory, with the "recalled-but-never-cited" filter.*
