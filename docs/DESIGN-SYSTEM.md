# DESIGN-SYSTEM — ai-playground v2

The **concrete** design system — the values UI-SPEC §4 left as roles. Delivered by the operator (built in Claude design), dark-first teal/slate, three-layer tokens. This doc is the human-readable summary; the **live source of truth is the app's token CSS** at `src/lib/styles/tokens/` in this worktree — the build evolved the tokens (mono-body, caps tracking, contrast gate). [`docs/design-system/`](./design-system/) (`tokens/*.css`, `styles.css`, `components/*`) is the **historical design-phase reference** — do NOT copy its `tokens/typography.css` families verbatim; it pre-dates the 🔒 mono-body rule (operator, 2026-06-10: ALL text that is not a header/title is monospace), which this frozen snapshot predates and does not contain. Concretely, `docs/design-system/tokens/typography.css:47` still defines `--type-body` from `--font-sans` (Lastik) — copying it violates that locked rule. The rule lives in `F:\code\ai-playground\docs\DESIGN-SYSTEM.md` §4.

> **Relationship to UI-SPEC:** UI-SPEC §4 defines the token *roles* + the status-enum→role map; this doc + `docs/design-system/` supply the *values*. UI-SPEC §15's deferral is now **resolved** — the blue §15.1 seed is superseded by this teal/Lastik system.

---

## 1. Provenance & license

- **Source:** operator-supplied design system (`ai-playground Design System.zip`), generated via Claude design + the `ai-playground-design` skill. Imported 2026-06.
- **Palette/type:** original to this project (teal/slate dark, Lastik + JetBrains Mono). Not lifted from a third party.
- **⚠ Font license — Lastik (That That Type, Commercial License) — load-bearing constraints (D-034):**
  1. **Web = WOFF2/WOFF only** via `@font-face`. **TTF/OTF on the web is prohibited.** (`fonts.css` fixed to woff2/woff.)
  2. **Font binaries MUST NOT be committed to the public repo** ("not accessible to unlicensed third parties; not on GitHub/S3"). Provision at **build time** into `static/fonts/` — the app is at the repo root in v2, there is no `dashboard/` — **gitignored**. This repo tracks **no** `.woff/.woff2/.ttf/.otf`.
  3. **Single-operator / local serving only.** No SAS/public exposure that serves the font to unlicensed third parties. Re-check before any public or multi-user deployment.
  4. **Cut confirmed (✅):** ships **Lastik-Free**, **purchased** — the That That Type **Commercial EULA** applies, so (1)–(3) above stand.
- **JetBrains Mono** — OFL (open), Google Fonts; no constraint.
- **Fallback:** `--font-sans` falls back to `ui-sans-serif, system-ui, …` so the UI is fully functional if Lastik can't load (license/offline).

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

- **`--font-display`: Lastik** (self-hosted brand, weights 100–900) → `ui-sans-serif, system-ui, …` fallback. **Display-only** (task 14.1): headings h1–h6, page/card/modal titles, brand/logo.
- **`--font-body` = `--font-mono`: JetBrains Mono** (Google/OFL) → `ui-monospace, Cascadia Mono, SF Mono, …`. **Mono is THE body/UI face app-wide** (operator directive, 14.1 — control-plane app): all non-heading text — body, labels, buttons, inputs, tables, statusbar — plus ids, paths, costs, durations, transcripts, SurrealQL, numerics (`.mono`, `.tnum` tabular-nums). `--font-sans` survives only as a deprecated alias of `--font-display`.
- **Scale** (role-named, desktop-dense): 2xs 11 · xs 12 · sm 13 · **base 14 (default)** · md 16 · lg 18 · xl 22 · 2xl 28 · 3xl 36 · 4xl 48 px.
- **Line-height** tight 1.2 / snug 1.35 / normal 1.5 / relaxed 1.65. **Weights** 400/500/600/700. **Tracking** tight −0.01 / wide 0.02 / caps 0.06em (was 0.08 — tightened for the wider mono glyphs, 14.1).
- **Semantic type**: `--type-display/h1/h2/h3` → `--font-display`; `--type-body/body-sm/label` → `--font-body`; `--type-mono/mono-sm` → `--font-mono`. Shared primitives: `.eyebrow` (uppercase micro-label), `.mono`, `.tnum`.

---

## 5. Spacing · radius · elevation · motion · layout

- **Spacing** (4px base): 0,2,4,8,12,16,20,24,32,40,48,64. Semantic: `--gap-inline 8` · `--gap-stack 16` · `--pad-control 8` · `--pad-card 20` · `--pad-panel 24`.
- **Radius**: xs 3 (chips/badges) · sm 5 (buttons/inputs) · md 8 (cards/popovers) · lg 12 (panels/modals) · pill 999.
- **Elevation** (soft, near-black): `--shadow-sm/card/raised/overlay`, `--shadow-focus` (2px bg + 4px ring), `--glow-running` (status glow).
- **Motion** (UI-SPEC §7): `--motion-instant 80 / fast 140 / normal 240 / slow 420` ms; `--ease-out` (enter), `--ease-in-out`, `--ease-standard`. **`prefers-reduced-motion` → all durations 0ms (keeps end-state).** Baked-in keyframes: `ds-row-enter` (opacity+translateY8+blur4, bounce:0 — §7), `ds-pulse` (live-dot). GPU-only (transform/opacity/filter).
- **Z-ladder**: base 0 · sticky 100 · sidebar 200 · topbar 300 · tray 400 · overlay 500 · modal 510 · popover 600 · toast 700 · tooltip 800.
- **App-shell dims** (UI-SPEC §3): sidebar 248px (collapsed 56) · topbar 48 · status bar 28 · right tray 360.

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
- **§9 a11y:** `:focus-visible` two-color ring; color-not-alone; tabular nums. **Contrast still to be CI-gated** (UI-SPEC §9) — run the impeccable detector over the `:root` token pairs before the v1.0 visual sign-off; the near-hue accent/running pair (§3.4) is the one to verify explicitly.

---

## 8. Build integration (deferred to scaffold)

At build (Phase 0.a / the cannibalization visual pass, ROADMAP v1.0 4.x):
1. `styles.css` is the single entry (`@import`s tokens + fonts + component css) → Tailwind v4 `@theme`.
2. **Provision Lastik woff2/woff into `static/fonts/` — gitignored, never committed** (D-034; the app is at the repo root — there is no `dashboard/`). JetBrains Mono via the Google `@import` (or self-host OFL).
3. Run the **impeccable** contrast/a11y gate over the token pairs; fix any AA miss (§9).
4. Port the component primitives to Svelte 5 (the delivered ones are React/JSX references — same tokens, same states).

---

## 9. Open items

- ✅ **Lastik cut confirmed** — Lastik-Free, purchased (Commercial EULA; web=woff/woff2, no-repo, single-operator stand) — §1.
- ⬜ **AA contrast gate** over all token pairs (impeccable) — §7/§9; verify accent-vs-running near-hue.
- ⬜ React→Svelte 5 component port at build.
