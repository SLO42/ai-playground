# FILE-SNAPSHOT-SPEC — see file content in-app, backed by the DB

> Drafted 2026-06-17 (operator): "anything that references a file should have a reference to the
> database entry so we can see what was in the file in-app." Today the DB holds a project's ROW +
> metadata, but the actual code files live on disk (CODE_ROOT) — you can't read their content in
> the app. This closes that, honestly.

## 1. The principle
Any row that REFERENCES a file links a DB-stored SNAPSHOT of that file's content, so the app can
render "what the file was when it was referenced" — never just a dangling path.

## 2. The table — `file_snapshot` (content-addressed, point-in-time)
`{id, path, content_sha, content, bytes, captured_at, captured_by (entity/event ref), project?}`.
- **Content-addressed**: dedup by `content_sha` — identical content stores ONCE (a file read 50×
  unchanged = one row). No bloat.
- **Point-in-time, NOT a live mirror**: a snapshot is explicitly "as-of `captured_at`"; the app
  labels it so. Disk stays the source of truth for code (F-008) — the snapshot never claims to be
  current (that's the stale-shown-as-live trap we fixed for live-queries; don't reintroduce it).
- **Bounded**: a `bytes` cap (e.g. skip/truncate huge/binary files → store a marker + sha, not the
  blob); generated `.gitignore`d secrets are screened (D-026 — never snapshot a `.env`).

## 3. Capture points (where a snapshot is taken + linked)
- **scaffold-create** (Create-with-AI executor): each generated file → a snapshot, linked from the
  project. So a freshly-created project's files are readable in-app immediately.
- **agent read/edit** (session transcript tool_use/tool_result on a file): link a snapshot to the
  transcript turn → "what the agent saw / wrote," viewable inline.
- **finding-cite** (a gauntlet/review finding referencing `file:line`): link the snapshot so the
  cited content is shown next to the finding (the cert/review surfaces already cite files).
- **config-write**: configs already mirror to `cc_*`; align that with this convention.

## 4. Surface
An in-app "view file" affordance wherever a file is referenced (project file tree, transcript
turn, finding) → renders the snapshot content (syntax-aware, read-only) with its `captured_at` +
sha + a "may be stale; disk is truth" note. Honest empty when no snapshot captured yet.

## 5. Rails
- F-008: snapshot is as-of-capture, labeled; disk is truth.
- D-026: never snapshot secrets/.env; screen content on capture.
- D-016: path validated; project-scoped.
- Dedup-by-sha; byte cap; binary/huge → marker not blob.
- New migration additive + idempotent (F-015); `file_snapshot` in WATCHED_TABLES if a surface
  live-updates on it.

## 6. Build shape
1. `file_snapshot` table + the content-addressed capture helper (sha + dedup + screen + cap).
2. Wire the capture points (scaffold, transcript tool turns, finding-cite).
3. The in-app "view file" surface.
Each: BUILD → D-038 review. Pairs with MEMORY-SCENE (the scene can show file-touch activity).
