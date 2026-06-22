/* ============================================================================
   ai-playground v2 — PROJECT STATUS COLOR-TOKEN GATE (CC-STATUS fix regression)
   CC-STATUS DoD-review found ProjectStatus.svelte styling four selectors
   (`.board-name`, `.tile-figure`, `.fig-n`, `.leg-count`) with the UNDEFINED
   custom property `--color-text-primary` and NO fallback. At computed-value
   time `color: var(--color-text-primary)` is invalid → falls back to `inherit`,
   so it only rendered correctly by an inheritance accident; the contrast gate
   (which checks *-on-overlay pairings) cannot catch an undefined token. The fix
   swaps all four to the canonical defined token `--color-text`.

   Regression gate (same shape as routes/projects/create/page-tokens.test.ts):
   every `var(--color-…)` this component references must resolve to a token
   DEFINED in colors.css — either directly, or via a fallback that is itself a
   defined `--color-…` token. An undefined token with no defined-token fallback
   is the exact defect and fails here. Scoped to this component.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadColorTokens } from '../../styles/tokens/contrast-gate';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT = join(HERE, 'ProjectStatus.svelte');

/** Every `var(--color-…[, <fallback>])` reference in the file. */
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

describe('CC-STATUS — ProjectStatus references only DEFINED color tokens', () => {
  const decls = loadColorTokens();
  const css = readFileSync(COMPONENT, 'utf8');
  const refs = colorVarRefs(css);

  it('found color-token references to gate (sanity)', () => {
    expect(refs.length).toBeGreaterThan(5);
  });

  it('the specific defect token is GONE', () => {
    // --color-text-primary is undefined in colors.css; --color-text is the canonical token.
    expect(css).not.toMatch(/--color-text-primary\b/);
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
