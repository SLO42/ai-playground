/* ============================================================================
   ai-playground v2 — SHELL CONTAINING-BLOCK SOURCE GATE

   Guards the "dead space below the app shell" defect class (operator review
   2026-07-26 §1), introduced in bb6af37 and never regression-gated.

   The mechanism, precisely:
     `.shell` is `height: 100vh; overflow: hidden`, so the DOCUMENT must never
     scroll — `.content` is the app's one scroller. But `.shell` and `.content`
     were both `position: static`, so an absolutely-positioned descendant (every
     visually-hidden `.sr-only` legend/label) resolved against the INITIAL
     containing block. `overflow: hidden` on a static ancestor cannot clip an
     abspos box whose containing block is ABOVE that ancestor, so the box's
     static offset — far below the fold on a tall page — grew
     `documentElement.scrollHeight`: an outer document scrollbar and a dead band
     where the sidebar background stops. Measured on /agents: innerHeight 861 vs
     documentElement.scrollHeight 1316.

   This file is the CHEAP half of the gate — it runs in `npm test` and fails the
   moment the declaration is deleted or a stacking context is introduced. It
   CANNOT prove the layout: only a real browser computes the box tree, so the
   behavioural assertion lives in tests/e2e/layout-fluid.spec.ts ("14.2d"). Both
   are needed; neither alone is honest.

   F-054: source is normalised to LF before scanning (the Edit tool rewrites
   files CRLF on Windows, which would silently break line-anchored regexes).
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROUTES = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROUTES, '..');

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const read = (p: string) => lf(readFileSync(p, 'utf8'));

/** A CSS rule body with comments stripped — the guarded properties (`position`,
 *  `z-index`, `transform`, `filter`) all appear inside the explanatory comment
 *  on `.content`, so comment-stripping is load-bearing, not tidiness. */
function ruleBody(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(`(?:^|[}\\n])\\s*${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(bare);
  expect(m, `expected a \`${selector}\` rule in the stylesheet`).not.toBeNull();
  return m![1];
}

/** `prop: value` lookup within a rule body; null when the property is absent. */
function decl(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(body);
  return m ? m[1].trim() : null;
}

const layoutSrc = read(join(ROUTES, '+layout.svelte'));
const layoutStyle = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(layoutSrc)?.[1] ?? '';
const baseCss = read(join(SRC, 'lib', 'styles', 'tokens', 'base.css'));

describe('shell containing block — the app scroller owns its abspos descendants', () => {
  const content = ruleBody(layoutStyle, '.content');

  it('.content is positioned, so abspos descendants resolve against the scroller', () => {
    expect(
      decl(content, 'position'),
      'Deleting `position: relative` from `.content` (+layout.svelte) re-opens the ' +
        'dead-space defect: every `.sr-only` legend/label escapes to the initial ' +
        'containing block and grows documentElement.scrollHeight past the viewport.'
    ).toBe('relative');
  });

  it('.content creates NO stacking context and captures no fixed overlay', () => {
    // `relative` is layout-neutral and does not capture `position: fixed`. It
    // WOULD become both a stacking context and a fixed-containing-block if any
    // of these were added — which would re-parent the four fixed overlays
    // (CommandPalette / ConfirmDialog / RightTray / ToastHost) and the
    // full-height /projects/[id]/graph canvas into the scrolling content box.
    expect(decl(content, 'z-index'), '`z-index` on .content creates a stacking context').toBeNull();
    expect(decl(content, 'transform'), '`transform` on .content captures fixed').toBeNull();
    expect(decl(content, 'filter'), '`filter` on .content captures fixed').toBeNull();
    expect(decl(content, 'will-change')).toBeNull();
    expect(decl(content, 'contain')).toBeNull();
  });

  it('.content is still the scroller (the premise the fix rests on)', () => {
    expect(decl(content, 'overflow-y')).toBe('auto');
  });

  it('.shell still clips at exactly one viewport (the other half of the premise)', () => {
    const shell = ruleBody(layoutStyle, '.shell');
    expect(decl(shell, 'height')).toBe('100vh');
    expect(decl(shell, 'overflow')).toBe('hidden');
  });
});

describe('sr-only — one shared definition, and pages that dropped their copy still get it', () => {
  it('base.css defines the visually-hidden primitive as an abspos clip-rect', () => {
    const srOnly = ruleBody(baseCss, '.sr-only');
    // Pages that deleted their local duplicate (e.g. /settings) render unstyled
    // — i.e. their hidden legends become VISIBLE — if this rule ever goes away.
    expect(decl(srOnly, 'position')).toBe('absolute');
    expect(decl(srOnly, 'width')).toBe('1px');
    expect(decl(srOnly, 'clip')).toBe('rect(0, 0, 0, 0)');
  });

  it('base.css is loaded app-wide from the root layout', () => {
    expect(layoutSrc).toMatch(/import\s+['"]\$lib\/styles\/app\.css['"]/);
    expect(read(join(SRC, 'lib', 'styles', 'app.css'))).toMatch(/@import\s+['"]\.\/tokens\/base\.css['"]/);
  });

  it('per-page `.sr-only` duplicates are inventoried, not silently multiplying', () => {
    // Duplicating a design-system primitive per page is how it drifts: the
    // /settings copy had already become a second source of truth for the same
    // clip-rect. This is a LEDGER, not a ban — it fails when a NEW duplicate
    // appears, so the next one is a deliberate decision.
    //
    // KNOWN REMAINING DUPLICATE (deferred, not fixed here): agents/+page.svelte
    // is owned by a concurrently-running build lane; removing its local
    // `.sr-only` would collide. It is behaviourally harmless now that .content
    // is a containing block — it is cleanup, and it is written down here so it
    // does not evaporate.
    const known = new Set(['agents/+page.svelte']);

    const pages: string[] = [];
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === '+page.svelte' || name === '+error.svelte') pages.push(p);
      }
    })(ROUTES);

    const dupes = pages
      .filter((p) => /(?:^|[}\n])\s*\.sr-only\s*\{/.test(read(p).replace(/\/\*[\s\S]*?\*\//g, '')))
      .map((p) => relative(ROUTES, p).replace(/\\/g, '/'))
      .sort();

    const unexpected = dupes.filter((d) => !known.has(d));
    expect(
      unexpected,
      'New per-page `.sr-only` copies found. Use the shared primitive in ' +
        'src/lib/styles/tokens/base.css (loaded app-wide) instead of redeclaring it.'
    ).toEqual([]);
  });
});
