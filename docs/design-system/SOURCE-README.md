# ai-playground v2 — Design System

The brand + UI design system for **ai-playground v2**: a local-first **project lifecycle platform** *and* a **Claude Code harness** — a single dashboard + lightweight engine that helps a solo operator **create, develop, maintain, and release** software projects by **driving, orchestrating, and managing Claude Code** across a whole project portfolio.

This is a **dark-first, information-dense, keyboard-driven developer tool** for a single power user on their own machine. No marketing chrome, no onboarding, no auth UI. Optimize for *at-a-glance status + fast action*.

---

## Sources

This system was derived from the **ai-playground v2 planning docs** (read-only, mounted at `docs/`). Key inputs (paths preserved in case the reader has access):

| Doc | What it gave this system |
|-----|--------------------------|
| `docs/PRODUCT.md` | Product definition, the two pillars, jobs 1–10, voice ("honest reporting", "no fake data") |
| `docs/ARCHITECTURE.md` | Page set, the one SSE event stream, harness layer, gates, status enums |
| `docs/DATA-MODEL.md` | Entity status enums (task/session/service/release/severity) → status color roles |
| `docs/DEVELOPMENT.md` | Stack: SvelteKit 2.x + Svelte 5 (runes) + Tailwind v4, bits-ui, SurrealDB, Ollama, Claude Code |
| `docs/UI-SPEC.md` | **The design contract** — IA, app shell, component inventory, live-update UX, motion model, a11y, voice, anti-slop acceptance criteria, the candidate type pairing |

> No production UI existed yet (these are planning docs — "visual styling is intentionally DEFERRED"). This system **fills in the deferred token values** from the UI-SPEC's structure + the operator-supplied palette, and recreates the specified screens as the UI kit.

**Color seed:** the operator supplied a teal/slate palette (muted-teal, charcoal-blue, dark-slate-grey, carbon-black, onyx). It maps directly onto the UI-SPEC §4 dark surface + role system; status hues are layered on top and kept semantically distinct.

---

## CONTENT FUNDAMENTALS

The product voice is **terse, technical, and honest**. UI vocabulary == system vocabulary.

- **Person & tone.** No marketing "we"/"you" — labels are nouns and verbs, not sentences. Direct, calm, never cheerful-for-its-own-sake. Tone adapts to operator state (frustrated → calm/direct); **voice stays constant**.
- **Casing.** Sentence case for buttons and labels ("Start run", "Save config"). Lowercase for status words and enums, always (`in_progress`, `blocked`, `shipped`) because **status words match the data-model enums exactly**. `UPPERCASE` only for tiny eyebrow micro-labels (tracked +0.08em).
- **Buttons** = verb + object: "Start run", "Stop agent", "Save config", "Register project". Never "OK", "Submit", "Click here".
- **Errors** = `[what failed]. [likely cause]. [recovery].`, blame-free, quoting the real message: *"Couldn't save config. Connection lost. Reconnect and retry."* Never a raw code alone.
- **Empty states**, three subtypes: first-use ("No projects yet — register one"), user-cleared ("All caught up"), no-results ("No tasks match 'blocked' — clear filters"). Never an empty void.
- **Success** = past tense + specific, proportional to stakes: "Config saved", "Agent stopped".
- **Unknown / outage** = name it, never fabricate. Render literally `unknown` or `—`, never a plausible-looking number (this is load-bearing — fake data is the cardinal sin, F-008).
- **Numbers carry units** and are monospace + tabular: `1,284 tok`, `$0.0214`, `3.1s`, `p95 412ms`.
- **No emoji.** This is a developer tool; emoji are not part of the brand. Status is conveyed by a colored dot + word + icon, never an emoji.
- **No buzzwords, no hype.** "Lighter by default", "honest states", "constrained autonomy" are the kinds of phrases used — plain, specific, engineering-register.

**Example microcopy:**
> `register project` · `Start run` · `Stop agent` · `3 agents running` · `blocked — config-protection gate` · `as of 14:32 · reconnecting…` · `No sessions yet — start a run` · `Couldn't reach Ollama. Service stopped. Start it from /services.`

---

## VISUAL FOUNDATIONS

**Overall vibe:** a calm, dense, dark teal terminal-adjacent dashboard. Reads like a well-built IDE / observability tool — restrained, monospace-forward, status-driven. Color means *something* (status/tier), never decoration.

- **Color.** Dark-first, built on the operator's teal/slate seed. App background is **onyx** (`#03120e`); surfaces step up through a derived teal ramp (panel → card → raised → overlay). Borders do more work than shadows. Accent is **muted-teal** for primary actions and active nav. Status hues (running/success/warn/error/info/blocked/neutral) are kept distinct and **always paired with an icon + word** — never color-only. Agent tiers have their own cool→warm ramp (local slate → Haiku blue → Sonnet teal → Opus gold) so the fleet reads at a glance.
- **Type.** Two families: **Lastik** (the brand's self-hosted rounded display/UI typeface) for all UI prose, headings, labels, and metric values; **JetBrains Mono** for everything machine — transcripts, record ids, paths, SurrealQL, costs, durations, counts. Mono stays **first-class**: monospacing there is functional (column alignment, tabular numerals, code legibility), so it is deliberately *not* replaced by Lastik. Dense scale (14px body default; down to 11–12px for meta). 600 weight for headings; Regular/Medium for body.
- **Spacing.** One 4px-based scale. Calm density: generous enough to scan, tight enough to be information-dense. **Cards are never nested** — flatten with spacing, dividers, and type hierarchy.
- **Backgrounds.** Flat dark surfaces. **No gradients on content**, no imagery, no patterns, no textures. The only "gradient" is functional (a faint inset highlight on cards). Full-bleed is the dark app canvas itself.
- **Borders & corners.** Hairline 1px borders (`--color-border` = dark-slate) are the primary separators; `--color-border-strong` (charcoal-blue) for emphasis. Tight corner radii: 3px chips, 5px controls, 8px cards, 12px panels.
- **Cards.** Flat `--color-surface-card` fill, 1px hairline border, 8px radius, a barely-there shadow (`--shadow-card`) plus a 2% inset top highlight. Interactive cards lift to `--color-surface-raised` + stronger border on hover. No colored left-border accent stripes (an explicit anti-slop ban).
- **Shadows.** Soft, low-spread, near-black — dark UIs lean on borders, so shadows only separate true overlays (popovers, modals, the command palette, toasts). `sm` → `card` → `raised` → `overlay`.
- **Animation.** Subtle and purposeful. Enters: `opacity 0→1` + `translateY 8px→0` + `blur 4→0`, ~420ms ease-out, **bounce:0** (no springy overshoot — the #1 motion-slop tell). GPU-only (transform/opacity/filter). High-frequency live updates (metric/ticker churn) get an instant transition or none. Enter ≠ exit (exits faster/subtler). `prefers-reduced-motion` collapses durations to ~0 **but always lands on the final visible state** (never stuck at opacity:0). Running states use a quiet pulsing dot, never a spinner-heavy UI.
- **Hover / press.** Hover = a step up the surface ramp + border strengthen (buttons) or a tint (ghost). Press = a tiny `scale(0.99)` + a half-pixel translate; icon buttons `scale(0.94)`. Never color-flip wildly.
- **Focus.** Two-layer ring: a bg-colored gap + a 2px `--color-focus-ring` (bright teal) at ≥3:1. `outline:none` alone is banned — keyboard is the backbone.
- **Transparency / blur.** Used sparingly — only modal scrims and the right-tray slide-over. No frosted-glass everywhere.
- **Honest states are first-class.** Loading (skeletons shaped like content, not spinners), empty, error (real message + retry), stale/disconnected (dim + "as of <time>"), unknown ("—"). These have dedicated visual treatments.

**Anti-slop bans (frozen from UI-SPEC §9):** no purple/pink gradients, no gradient text, no icon-tile-above-heading, no `01/02/03` section markers, no cream/beige backgrounds (dark-first always), no nested cards, no fake/placeholder numbers dressed as real, no light-gray-for-elegance that fails contrast.

---

## GESTALT PRINCIPLES

The system leans on Gestalt grouping to make a dense, dark dashboard *scannable* without adding chrome. Each principle maps to concrete mechanisms already in the tokens/components:

- **Proximity** — the single 4px spacing scale does the grouping. Related controls sit at `--gap-inline` (8px); separate blocks at `--gap-stack` (16px); unrelated regions at `--pad-panel` (24px). The sidebar nav is clustered by the product's **two pillars** (Portfolio · Harness · Knowledge & system) so related destinations read as one unit before you read a single label.
- **Similarity** — status is a *visual language*: every status anywhere is the same shape (a soft `StatusBadge` with a dot + word) tinted by a fixed role color. Agent tiers share one cool→warm ramp. Because like things look alike, "all the blocked items" or "all the Opus runs" pop out across screens without hunting.
- **Common region** — `Card` (and panels) are bounded regions: one hairline border + one surface step groups its contents into a single perceived object. The rule "**never nest cards**" protects this — nested regions destroy the grouping signal. The board columns and sidebar groups are common regions too.
- **Continuity & alignment** — everything rides a grid. Metric rows, fleet grids, task board, and list rows align to shared edges so the eye follows clean vertical/horizontal scan-lines. Mono + tabular numerals keep numeric columns on a continuous axis.
- **Figure / ground** — the onyx ground recedes; surfaces step *up* toward the viewer via the teal ramp + soft elevation, so panels read as figure against ground. Overlays (popover/modal/tray) use the strongest elevation + a scrim to sit clearly above the plane.
- **Focal point (emphasis)** — accent (muted-teal) is *rationed*: exactly one primary `Button` per region, the active nav item, and live/running indicators. Because accent is scarce, it always means "the one thing here." Everything else is neutral ink.
- **Closure** — structure is implied, not boxed. Task-board columns are defined by a heading + aligned cards (no heavy container); dividers are hairlines, not full frames. The eye completes the grouping, keeping the UI calm.
- **Common fate** — live updates move together: new rows share one enter motion (fade + rise + deblur, bounce:0), so simultaneously-arriving items are perceived as a related batch rather than random flicker.

> Gestalt here is a *subtraction* tool: prefer spacing, alignment, shared shape, and one bounded region over borders, boxes, and color. When a layout feels noisy, group with proximity + a common region before adding any new line or tint.

## ICONOGRAPHY

The planning docs don't ship an icon set (bits-ui provides unstyled primitives, not icons). For a dense, mono-forward developer tool the right match is a **clean 1.5px line/stroke icon set**.

- **Choice: [Lucide](https://lucide.dev)** (ISC license), loaded from CDN. Its consistent 24×24 / 1.5–2px stroke geometry sits perfectly with JetBrains Mono and the dark surfaces. **⚠️ Substitution flagged:** Lucide is *not* specified in the docs — it is a sensible default for this register. Swap freely if the team standardizes on another stroke set (Phosphor, Tabler) — keep the 1.5–2px stroke weight and the line (not filled) style.
- **Usage rules.** Icons are functional, not decorative. Pair status icons with a word (never icon-only status). Size 14–16px inline with text, 16–18px in toolbars. Stroke `currentColor` so they inherit text color/state. Icon-only controls (`IconButton`) **must** carry an accessible `label`.
- **A few tiny functional glyphs** (chevron in `Select`, check in `Checkbox`, × in `Tag`) are inlined as minimal SVG in the components — these are universal UI marks, not illustration.
- **No emoji, no unicode-as-icon** beyond the occasional `▲ ▼ → ●` arrows/dots in metrics and live indicators.
- **No bespoke illustration.** The docs contain none; this system invents none. Empty states use words + a single line icon, not spot illustrations.

CDN: `<script src="https://unpkg.com/lucide@latest"></script>` then `lucide.createIcons()`, or per-icon SVG.

---

## Index / manifest

**Root**
- `styles.css` — the single entry point consumers link. `@import`s only.
- `readme.md` — this guide.
- `SKILL.md` — Agent-Skills-compatible wrapper.

**`tokens/`** — `fonts.css` (webfonts), `colors.css` (palette + roles + status + tiers), `typography.css`, `spacing.css` (spacing/radius/elevation/motion/z/shell dims), `base.css` (reset + shared primitives).

**`components/`** — React primitives + `components.css` (the class layer).
- `core/` — **Button**, **IconButton**, **Input**, **Select**, **Switch**, **Checkbox**
- `display/` — **Card**, **Badge**, **StatusBadge**, **Tag**, **Avatar**, **MetricCard**
- `navigation/` — **Tabs**

**`guidelines/`** — foundation specimen cards (Colors, Type, Spacing) shown in the Design System tab.

**`ui_kits/`** — full-screen product recreations:
- `dashboard/` — the ai-playground v2 dashboard (home, project workspace, Claude Code harness hub, …).

**`assets/`** — logo + brand marks.

> The compiler bundles all components into `_ds_bundle.js` (auto-generated). Consume in card/kit HTML via `const { Button } = window.AiPlaygroundDesignSystem_b5e18a` after loading the bundle.
