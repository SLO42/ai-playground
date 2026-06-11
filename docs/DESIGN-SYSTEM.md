# DESIGN-SYSTEM — ai-playground v2

The **concrete** design system — the values UI-SPEC §4 left as roles. Delivered by the operator (built in Claude design), dark-first teal/slate, three-layer tokens. This doc is the human-readable summary; the **live source of truth is the app's token CSS** at `src/lib/styles/tokens/` on branch `v2` (worktree `F:\code\ai-playground-v2`) — the build evolved the tokens (mono-body 14.1, caps tracking, contrast gate). [`docs/design-system/`](./design-system/) (`tokens/*.css`, `styles.css`, `components/*`) is the **historical design-phase reference** — do NOT copy its `tokens/typography.css` families verbatim; it pre-dates the §4 mono-body rule.

> **Relationship to UI-SPEC:** UI-SPEC §4 defines the token *roles* + the status-enum→role map; this doc + `docs/design-system/` supply the *values*. UI-SPEC §15's deferral is now **resolved** — the blue §15.1 seed is superseded by this teal/Lastik system.

---

## 1. Provenance & license

- **Source:** operator-supplied design system (`ai-playground Design System.zip`), generated via Claude design + the `ai-playground-design` skill. Imported 2026-06.
- **Palette/type:** original to this project (teal/slate dark, Lastik + JetBrains Mono). Not lifted from a third party.
- **⚠ Font license — Lastik (That That Type, Commercial License) — load-bearing constraints (D-034):**
  1. **Web = WOFF2/WOFF only** via `@font-face`. **TTF/OTF on the web is prohibited.** (`fonts.css` fixed to woff2/woff.)
  2. **Font binaries MUST NOT be committed to the public repo** ("not accessible to unlicensed third parties; not on GitHub/S3"). Provision at **build time** into `dashboard/static/fonts/` (or equivalent), **gitignored**. This repo tracks **no** `.woff/.woff2/.ttf/.otf`.
  3. **Single-operator / local serving only.** No SAS/public exposure that serves the font to unlicensed third parties. Re-check before any public or multi-user deployment.
  4. **Cut confirmed (✅):** ships **Lastik-Free**, **purchased** — the That That Type **Commercial EULA** applies, so (1)–(3) above stand.
- **JetBrains Mono** — OFL (open), Google Fonts; no constraint.
- **Fallback:** `--font-display` (Lastik) falls back to `ui-sans-serif, system-ui, …` — scoped to **headings/titles/brand only** (§4); the body never depends on Lastik (it is `--font-body` = mono), so the UI is fully functional if Lastik can't load (license/offline).
- **`--font-sans` (DEPRECATED alias):** kept so stale consumers resolve, but it is intentionally dual-defined in the build — the token layer (`tokens/typography.css`) aliases it to `--font-display` (Lastik) so legacy `var(--font-sans)` consumers keep the brand face, while the Tailwind `@theme` (`app.css`) maps the `font-sans` *utility* to JetBrains Mono so utility-classed body text follows the mono-body rule. **New code must use `--font-display` (headings) or `--font-body` (everything else), never `--font-sans`**; retiring the alias reconciles the two definitions.

---

## 2. Token architecture (three layers)

`primitive ramp → semantic alias → component`. Components reference **semantic aliases only**, never raw hex (design-system skill rule). Tailwind v4 CSS-first `@theme` (D-005); a palette swap is one file.

```
--teal-800 (#102822)  →  --color-surface-card  →  (Card uses --color-surface-card)
```

---

## 3. Color tokens

### 3.1 Surfaces (dark teal ramp, onyx→raised)
| Role | Token | Value |
|------|-------|-------|
| App background | `--color-bg` | `#03120e` (onyx) |
| Inset (wells, code) | `--color-bg-inset` | `#071914` |
| Panel | `--color-surface` | `#0b201a` |
| Card | `--color-surface-card` | `#102822` |
| Raised (popover/modal) | `--color-surface-raised` | `#16322b` |
| Hover surface | `--color-surface-overlay` | `#1d3d35` |
| Selected | `--color-surface-selected` | `#16302a` (accent-faint) |

### 3.2 Borders & focus
`--color-border #26413c` (hairline) · `--color-border-strong #3e505b` · `--color-border-faint #112721` · `--color-focus-ring #a6c9c2` (accent-bright). Dark UI: **borders carry hierarchy, not shadows.**

### 3.3 Text (cool teal-tinted ink ramp)
`--color-text #eef3f1` · `--color-text-2 #c3d0cc` · `--color-text-muted #93a7a2` · `--color-text-subtle #6f857f` · `--color-text-faint #51635e` · `--color-text-inverse #03120e` · `--color-text-accent/-link #a6c9c2`.

### 3.4 Accent (primary actions / active nav)
`--color-accent #8ab0ab` (muted sage-teal) · hover `#a6c9c2` · active `#5a7f78` · muted `#16302a` · **on-accent text `#03120e`** (onyx — accent is light, so text on a filled accent button is dark).
> Note: accent (sage `#8ab0ab`) is deliberately kept distinct from `--color-running` (cyan-teal `#3fb6ac`) and the sonnet tier — same family, different lightness/sat. Always pair status/accent with icon+label (§9) so the near-hues never carry meaning alone.

### 3.5 Status (load-bearing — UI-SPEC §4; each has a `-bg` faint tint)
| Role | Token | Value | Hue |
|------|-------|-------|-----|
| running | `--color-running` | `#3fb6ac` | cyan-teal (animated) |
| success | `--color-success` | `#5fb87a` | green |
| warn | `--color-warn` | `#d6a44e` | amber |
| error | `--color-error` | `#e0655f` | red |
| info | `--color-info` | `#5e9bd6` | blue |
| **blocked** | `--color-blocked` | `#cf7a45` | **rust (own role ✅)** |
| neutral/idle | `--color-neutral` | `#7c918b` | slate |

Maps onto UI-SPEC §4's status-enum→role table 1:1 (task/session/service/release/severity). `--color-blocked` satisfies §1.7 (gate blocks get their own hue).

### 3.6 Agent-tier accents (cheap→powerful ramp)
`--color-tier-local #7c918b` (slate) · `--color-tier-haiku #5e9bd6` (blue) · `--color-tier-sonnet #3fb6ac` (teal) · `--color-tier-opus #d8b76a` (gold). Fleet view reads tier at a glance (UI-SPEC §4/§5 AgentFleetGrid).

---

## 4. Typography

- **🔒 Mono-body rule (operator, 2026-06-10): ALL text that is not a header/title is MONOSPACE.** Body, labels, controls, tables, data, transcripts — everything reads in `--font-mono`. The display face is reserved for headings/titles/brand only.
- **`--font-display` (was the body role of `--font-sans`): Lastik** (self-hosted brand, weights 100–900) → `ui-sans-serif, system-ui, …` fallback. **Headings/titles/brand ONLY** (h1–h6, page/card/modal titles, logo).
- **`--font-mono`: JetBrains Mono** (Google/OFL) → `ui-monospace, SF Mono, …`. **Default body face** — body text, labels, buttons, inputs, ids, paths, costs, durations, transcripts, SurrealQL, numerics (`.tnum` tabular-nums for metrics). Tune size/line-height/tracking where mono runs wide on dense surfaces.
- **Scale** (role-named, desktop-dense): 2xs 11 · xs 12 · sm 13 · **base 14 (default)** · md 16 · lg 18 · xl 22 · 2xl 28 · 3xl 36 · 4xl 48 px.
- **Line-height** tight 1.2 / snug 1.35 / normal 1.5 / relaxed 1.65. **Weights** 400/500/600/700. **Tracking** tight −0.01 / wide 0.02 / caps **0.06em** (tightened for mono-width eyebrows, 14.1 — 0.08em pushed dense eyebrows past their columns).
- **Semantic type**: `--type-display/h1/h2/h3/body/body-sm/label/mono/mono-sm`. Shared primitives: `.eyebrow` (uppercase micro-label), `.mono`, `.tnum`.

---

## 5. Spacing · radius · elevation · motion · layout

- **Spacing** (4px base): 0,2,4,8,12,16,20,24,32,40,48,64. Semantic: `--gap-inline 8` · `--gap-stack 16` · `--pad-control 8` · `--pad-card 20` · `--pad-panel 24`.
- **Radius**: xs 3 (chips/badges) · sm 5 (buttons/inputs) · md 8 (cards/popovers) · lg 12 (panels/modals) · pill 999.
- **Elevation** (soft, near-black): `--shadow-sm/card/raised/overlay`, `--shadow-focus` (2px bg + 4px ring), `--glow-running` (status glow).
- **Motion** (UI-SPEC §7): `--motion-instant 80 / fast 140 / normal 240 / slow 420` ms; `--ease-out` (enter), `--ease-in-out`, `--ease-standard`. **`prefers-reduced-motion` → all durations 0ms (keeps end-state).** Baked-in keyframes: `ds-row-enter` (opacity+translateY8+blur4, bounce:0 — §7), `ds-pulse` (live-dot). GPU-only (transform/opacity/filter).
- **Z-ladder**: base 0 · sticky 100 · sidebar 200 · topbar 300 · tray 400 · overlay 500 · modal 510 · popover 600 · toast 700 · tooltip 800.
- **App-shell dims** (UI-SPEC §3): sidebar 248px · topbar 48 · status bar 28 · right tray 360. **Built responsive behavior:** static 248px rail at/above `--bp-narrow` 768px; **off-canvas drawer + hamburger below 768px** (task 6.3). The 56px collapsed rail (`--shell-sidebar-w-sm`) is defined but **unbuilt — future work** (zero consumers).

---

## 6. Components (delivered, in `docs/design-system/components/`)

React primitives + `.prompt.md` specs + `.d.ts` types + `components.css`:
**Core:** Button, IconButton, Input, Select, Switch, Checkbox.
**Display:** Card, **MetricCard**, Badge, **StatusBadge**, Tag, Avatar.
**Navigation:** Tabs.

Map onto UI-SPEC §5 inventory: `StatusBadge` → the status-pill (status-enum colors), `MetricCard` → KPI cards (tabular nums), `Card`/`Tabs`/`Input`/`Button` → shell + forms. Each `.prompt.md` carries the component's states (default/hover/active/disabled) wired to semantic tokens. Full interactive **dashboard UI kit** (AppShell, screens, workflows, charts, **and a designed Cannibalize feature** `cannibalize.jsx`) lives in the import (`ui_kits/dashboard/`) — reference for composing real screens; not committed here (size + it's the build's, not a planning doc).

---

## 7. Foundations honored (cross-check vs UI-SPEC)

- **§1 principles:** dark/dense/calm; honest states ("render `unknown`/`—`", skeletons not spinners); color = status/tier never decoration; voice terse/technical, buttons verb+object, status words == enums, no emoji.
- **§4 roles:** full coverage incl. `--color-blocked` + tier accents. ✅
- **§7 motion:** implemented (row-enter, reduced-motion end-state, GPU-only). ✅
- **§9 a11y:** `:focus-visible` two-color ring; color-not-alone; tabular nums. **Contrast IS CI-gated** — the deterministic WCAG gate is built (`src/lib/styles/tokens/contrast-gate.ts` resolves var() chains in `colors.css` to hex, AA_BODY 4.5 / AA_LARGE 3.0; `contrast-gate.test.ts` asserts 40+ token pairs + focus-ring checks in the vitest suite). The near-hue accent/running pair (§3.4) is not asserted as a dedicated distinguishability check — covered by the icon+label pairing rule (§3.4 note).

---

## 8. Build integration (deferred to scaffold)

At build (Phase 0.a / the cannibalization visual pass, ROADMAP v1.0 4.x):
1. `styles.css` is the single entry (`@import`s tokens + fonts + component css) → Tailwind v4 `@theme`.
2. **Provision Lastik woff2/woff into `dashboard/static/fonts/` — gitignored, never committed** (D-034). JetBrains Mono via the Google `@import` (or self-host OFL).
3. Run the **impeccable** contrast/a11y gate over the token pairs; fix any AA miss (§9).
4. Port the component primitives to Svelte 5 (the delivered ones are React/JSX references — same tokens, same states).

---

## 9. Open items

- ✅ **Lastik cut confirmed** — Lastik-Free, purchased (Commercial EULA; web=woff/woff2, no-repo, single-operator stand) — §1.
- ✅ **AA contrast gate** — built: `src/lib/styles/tokens/contrast-gate.test.ts` (deterministic WCAG check over 40+ token pairs + focus ring, in vitest). Narrow residual ⬜: an explicit accent-vs-running near-hue distinguishability assertion (currently covered by the §3.4 icon+label pairing rule).
- ✅ **React→Svelte 5 component port** — satisfied by **native Svelte 5 components** in `src/lib/components/` (full shell suite: Sidebar/Topbar/Statusbar/RightTray/CommandPalette/ConfirmDialog/GateBanner/ToastHost + screens) built against the same tokens; the React kit remains design reference only — it was not ported 1:1.

---

## 10. Design review — DoD #3/#5 reviewer checklist (Lane A-docs harvest A9, 2026-06-10)

How wave reviewers judge **"design-system standard" (D-038 #3)** and **"has purpose/reachable" (D-038 #5)** beyond the token/contrast gates. (harvested: gstack design-review/SKILL.md — Krug trunk test + AI-slop blacklist + fix discipline, MIT; adapted to Atelier's dark/dense app UI.)

### 10.1 Trunk test (run on every screen under review)

Land on the screen cold — no context. Without hunting, you must be able to answer:
1. What app/area is this? 2. What screen am I on? 3. What are the major sections? 4. What are my options at this level? 5. Where am I in the scheme of things (active nav state)? 6. How do I reach search/command (palette)?

Score PASS (all 6) / PARTIAL (4–5) / FAIL (≤3). A FAIL is a **HIGH-impact finding regardless of visual polish** — a screen that fails orientation fails #5.

### 10.2 AI-slop blacklist (patterns that fail #3 on sight)

The test: would the designer who built §3–§5 ship this? Flag any of —
- Off-token colors or decorative gradients (anything not from the §3 ramps; gradients have no role in this system)
- The icon-in-colored-circle 3-column feature grid; icons-in-circles as section decoration
- Centered-everything (this is a dense, left-aligned app UI)
- Uniform bubbly border-radius on every element (we have a radius hierarchy — §5)
- Decorative blobs, floating shapes, wavy dividers (an empty-feeling section needs better content, not decoration)
- Emoji as UI elements (UI-SPEC §1 voice rule: no emoji)
- Colored left-border as card accent (borders carry hierarchy via §3.2 tokens, not accent stripes)
- Generic copy ("Welcome to…", "Unlock the power of…") — voice is terse/technical, buttons verb+object
- Dashboard-card mosaics where layout should organize — cards only when the card IS the interaction
- Default font stacks on new surfaces (body = `--font-body` mono, headings = `--font-display` — §4 🔒 mono-body rule)

### 10.3 Detection-confidence tiers + guards

Tag every design finding by how measurable it is:
- **HIGH** — objective and measured: contrast below AA, console error, missing `:focus-visible`, off-token hex, reduced-motion ignored. Cite the measurement.
- **MEDIUM** — pattern match: a §10.2 blacklist hit, trunk-test PARTIAL, spacing off the §5 scale. Cite the element/screenshot.
- **LOW** — taste: "feels cramped", hierarchy preference. Advisory only.

Guards (HARVEST-GSTACK G2/G3):
- **LOW findings are NEVER auto-fixed** — they go into the verdict as advisory; an operator or product decision routes them (G3).
- **Suppression is 🔒-only and logged**: dismissing a finding as a blessed pattern is honored ONLY when it cites an operator-locked (🔒) rule in this doc or DECISIONS.md, and every applied suppression is logged in the review verdict ("suppressed: <finding> per <🔒 source>") (G2). No agent creates its own suppression list.
- **Fix discipline** (harvested: gstack design-review/SKILL.md fix loop, MIT): minimal fix, prefer token/CSS-level over structural change, one commit per finding, before/after screenshot evidence, re-test the affected screen after each fix.
