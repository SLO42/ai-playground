/* ============================================================================
   ai-playground v2 — CREATE PAGE COLOR-TOKEN GATE (H4 fix regression)
   H4 DoD-review found the hire-signal block (`.hire-signal`, `.hire-tag`,
   `.chip.proposed`) styled with CSS vars that DON'T EXIST in the token set
   (`--color-warning`, `--color-warning-muted`). Their fallbacks were
   `--color-accent` / `--color-surface-overlay`, so the warning hue silently
   degraded to accent (teal) at runtime — the warning-distinct intent was lost
   (recurrence of the V2.3-02b off-token defect class).

   Regression gate: every `var(--color-…)` this page references must resolve to
   a token DEFINED in colors.css — either directly, or via a fallback that is
   itself a defined `--color-…` token. A fallback to a DIFFERENT semantic family
   (or raw hex / a CSS keyword) is the exact defect and fails here. Scoped to
   this page; pre-existing off-token vars on other routes are out of scope.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadColorTokens } from '../../../lib/styles/tokens/contrast-gate';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, '+page.svelte');

/** Every `var(--color-…[, <fallback>])` reference in the file's <style>. */
function colorVarRefs(css: string): { token: string; fallback: string | null; raw: string }[] {
  const refs: { token: string; fallback: string | null; raw: string }[] = [];
  const re = /var\(\s*(--color-[a-z0-9-]+)\s*(,)?/gi;
  for (const m of css.matchAll(re)) {
    const token = m[1];
    let fallback: string | null = null;
    if (m[2]) {
      let depth = 1;
      let i = m.index! + m[0].length;
      let buf = '';
      while (i < css.length && depth > 0) {
        const ch = css[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
        buf += ch;
        i++;
      }
      fallback = buf.trim();
    }
    refs.push({ token, fallback, raw: m[0] });
  }
  return refs;
}

describe('H4 — create page references only DEFINED color tokens', () => {
  const decls = loadColorTokens();
  const css = readFileSync(PAGE, 'utf8');
  const refs = colorVarRefs(css);

  it('found color-token references to gate (sanity)', () => {
    expect(refs.length).toBeGreaterThan(5);
  });

  it('the specific defect tokens are GONE', () => {
    expect(css).not.toMatch(/--color-warning\b/);
    expect(css).not.toMatch(/--color-warning-muted\b/);
  });

  it.each(refs.map((r) => [r.token, r] as const))(
    '%s resolves to a defined token (directly or via a defined-token fallback)',
    (_t, ref) => {
      if (decls.has(ref.token)) return; // defined directly — fine
      const fbToken = ref.fallback?.match(/var\(\s*(--color-[a-z0-9-]+)/i)?.[1] ?? null;
      expect(
        fbToken !== null && decls.has(fbToken),
        `${ref.token} is not defined in colors.css and its fallback "${ref.fallback ?? '(none)'}" ` +
          `is not a defined --color-… token — this renders an off-token value and bypasses the contrast gate`
      ).toBe(true);
    }
  );
});
