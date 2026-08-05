# DECISIONS — RETIRED COPY (not authoritative, do not read for decisions)

> **This file is a redirect, not a ledger.** Nothing below is a decision.

The authoritative decisions ledger for Atelier lives in the **docs checkout**, branch
`v2-main`:

### `F:\code\ai-playground\docs\DECISIONS.md` — D-000 … D-042

---

## Why this copy was retired

This worktree used to carry its own copy of the ledger. It drifted. It froze at **D-034**
and silently omitted every decision authored after it — while still *looking* complete,
which is the dangerous part. The omissions included the most load-bearing decisions in the
project:

| Absent from this copy | What it locks |
|---|---|
| D-035 / D-035a | Steering origin — only `origin=operator` may steer; origin is stamped server-side and immutable |
| D-036 | Per-task capabilities allow-listed from the synced catalog; an unknown id fails closed |
| D-037 | Publish / deploy is **operator-gated**, always |
| D-038 | **Definition of Done** — the six-point gate every feature ships against |
| D-039 | Auto-created PM tasks are born `proposed` and pass a validation panel; the operator keeps approval |
| D-040 | Self-hosting seam (`atelier_self`) |
| D-041 | Cross-project wall |
| D-042 | Versioning |

It also carried **stale statuses** for decisions since resolved upstream — most visibly
D-012 (OpenClaw), still marked 🟡 "audit during spike S.2" here long after OpenClaw was
locked as **DROPPED**.

A second copy is exactly what caused this, so this file is **not** re-synced from the
authoritative one — it is retired in place. Keep one ledger.

## Nothing was lost

Every D-000..D-034 entry that lived here is present, and current, in the authoritative file
above. The full prior text of this file remains in git history:

```bash
git log --follow -- docs/DECISIONS.md
```

## Related pointers

- **Operating manual:** `F:\code\ai-playground\CLAUDE.md` — §7 is the quick-reference index
  of the decisions you must not silently cross.
- **Failure log:** `docs/fails.md` in this worktree is still appended to — but it is **not
  the full set**. It has FORKED bidirectionally from `F:\code\ai-playground\docs\fails.md`;
  scan BOTH. `CLAUDE.md` (worktree root) carries the measured breakdown, and re-unifying
  the two is an operator action (mark, never delete).
- The other planning docs in this directory are a **frozen 2026-06 snapshot** of the v2
  plan, not a description of the built system — see [README.md](./README.md).
