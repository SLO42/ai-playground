# static/fonts — Lastik (uncommitted, D-034)

Lastik is license-restricted (That That Type Commercial, D-034). The font
binaries (`Lastik-Free.woff2`, `.woff`, `.ttf`) MUST NOT be committed to this
repo. They are provisioned at build time into this directory and served at
`/fonts/*`, where `src/lib/styles/tokens/fonts.css` `@font-face`-references them.

## Operator provisioning (optional)

The font binary is **optional**. To brand the UI with Lastik, the operator drops
their licensed woff2 (and woff) here — gitignored, never committed (D-034):

```
static/fonts/Lastik-Free.woff2
static/fonts/Lastik-Free.woff
```

Web = WOFF2/WOFF only. Do **not** add `.ttf`/`.otf` — TTF/OTF on the web is
prohibited by the Lastik (That That Type, Commercial) EULA.

## When the binary is absent (default)

`src/lib/styles/tokens/fonts.css` lists `local('Lastik')` first, so an operator
with Lastik installed system-wide loads it with **zero network request**. When no
local font and no dropped-in woff2 exist:

- `font-display: swap` + the `--font-sans` system fallback chain
  (`ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`) render all
  text cleanly — no FOIT lockup, no layout break.
- The browser may log a benign `[404] /fonts/Lastik-Free.woff2` for the absent
  optional source. This is expected and does **not** break rendering — the
  fallback is already showing. To silence it entirely, provision the binary or
  install Lastik locally.

JetBrains Mono loads from Google Fonts.
