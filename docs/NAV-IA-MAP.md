# NAV-IA-MAP — every feature has a home + a clear path to it

Operator rule (2026-07-23): **everything that needs UI gets its UI, linked to a page or clear navigation — no orphan routes.** This is the living tracker + the reachability contract every wave's D-038 review checks.

## Reachability DoD (added as cross-cutting reviewer check #4)
A feature is REACHABLE when: it renders on a route; that route is either a nav item OR linked from a parent page that is a nav item (≤2 clicks from nav); the nav/link label is plain-language and unambiguous; and honest empty/loading/error states are shown (F-008). A wave that adds a user-facing surface without a nav path fails review.

## Current navigation (v2 worktree `src/lib/components/shell/nav.ts`, 3 groups / 14 items)
- **Portfolio**: Home `/` · Projects `/projects`
- **Harness**: Agents `/agents` · Claude Code `/claude-code` · Workflows `/workflows` · Loops `/loops`
- **Knowledge & system**: Brain `/brain` · Atelier `/atelier` · Memory `/memory` · Skills `/skills` · Cannibalize `/cannibalize` · Reports `/reports` · Services `/services` · Settings `/settings`

Frontend audit (2026-07-23): no orphan routes today; sub-routes reached via in-page tabs/links.

## Map: specced feature → home page → nav path → new nav entry? → status

| Feature (spec) | Primary UI home | Nav path | New nav entry? | Status |
|---|---|---|---|---|
| Brain-Observer vitals + journal (BRAIN-ALIVE-UI §4) | `/brain` Observer panel | Knowledge&system › Brain | No — extends Brain | specced |
| Council theater + Think-Now + focus mode (ALIVE-UI §5-6) | `/brain` (+ focus overlay) | Brain | No | specced |
| Observer operator proposal queue (OBSERVER §2.7) | `/brain` proposal queue | Brain | No | specced |
| Self-improvement effectiveness rollups (SELF-IMPROVEMENT §4) | `/reports` | Knowledge&system › Reports | No — extends Reports | specced |
| Learning-candidate / adopt queue (SELF-IMPROVEMENT §3) | `/brain` (shared operator queue) | Brain | **Consider** a dedicated "Improve" item if the queue grows; default: under Brain | specced — decision at build |
| Tool/route effectiveness (SELF-IMPROVEMENT §4) | `/reports` (routing already lives there) | Reports | No | specced |
| Per-role model config + effectiveness (per-role-model-config) | `/settings` (config) + `/agents` (per-role) + `/reports` (effectiveness) | Settings / Agents / Reports | No | specced |
| Artifact version history + audit trail (VERSIONING §6) | inline on `/agents` (cc_agent+role), `/skills`, `/claude-code` (catalog), `/brain` (identity changes) | those pages | No — inline surfaces; **consider** a global "Audit" view later | specced |
| Safety-defaults: autonomy-OFF / budget banner (safety-defaults) | global banner + `/services` + `/atelier` | Services / Atelier | No — global banner + existing pages | queued |
| Loops review/modify/configure (loops audit v3) | `/loops` (add edit controls) | Harness › Loops | No — extends Loops | queued |
| Local-runtime-lifecycle status (load/unload) | `/services` (it's a managed service) | Services | No | specced |
| Boot-status / autonomy-health row (analytics-visibility) | `/services` or `/atelier` | Services / Atelier | No | queued |
| HR/hire scene events + adjudication visibility (analytics-visibility) | `/agents` (hire queue exists) + Memory scene | Agents | No | queued |
| n8n workflows the brain authors (n8n-spec, later) | likely under `/workflows` or a new "Integrations" | Workflows | **Likely new entry** when built (P5) | spec-later |

## Rules from this map
- **Default: extend an existing page + its nav item.** Reserve a NEW nav entry for a genuinely distinct top-level surface the operator visits on purpose (candidates flagged above: "Improve", global "Audit", "Integrations/n8n").
- **Brain is the apex operator surface** — observer, alive-UI, proposals, and identity/version changes all converge there; keep it from becoming a junk drawer by using in-page tabs.
- Any new nav entry is itself a design decision recorded here before it ships; nav stays small and legible (the current 3-pillar / 14-item shape is the ceiling to respect).
- This map is updated in the same wave that adds the feature; a feature marked `specced/queued` flips to `live` only when its route is reachable from nav on a live render (part of that wave's live-verify).
