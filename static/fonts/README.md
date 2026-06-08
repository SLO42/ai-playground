# static/fonts — Lastik (uncommitted, D-034)

Lastik is license-restricted (That That Type Commercial, D-034). The font
binaries (`Lastik-Free.woff2`, `.woff`, `.ttf`) MUST NOT be committed to this
repo. They are provisioned at build time into this directory and served at
`/fonts/*`, where `src/lib/styles/tokens/fonts.css` `@font-face`-references them.

To provision locally, copy the binaries here (gitignored):

```
static/fonts/Lastik-Free.woff2
static/fonts/Lastik-Free.woff
static/fonts/Lastik-Free.ttf
```

If absent, the `--font-sans` fallback chain (system sans) resolves cleanly —
no FOIT lockup. JetBrains Mono loads from Google Fonts.
