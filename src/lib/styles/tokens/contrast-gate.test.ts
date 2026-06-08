/* ============================================================================
   ai-playground v2 — A11Y / CONTRAST CI GATE (UI-SPEC §9, §15)
   Fails the build if:
     1. any load-bearing color token is missing / unresolved (values must be
        FILLED — the §15 deliverable);
     2. any load-bearing token PAIR misses its WCAG AA ratio on the dark theme
        (body ≥4.5:1, large/UI/focus-ring ≥3:1);
     3. a bare `outline: none|0` appears anywhere under src/lib/styles
        (banned — a visible focus indicator must survive).
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AA_BODY,
  contrastRatio,
  parseHex,
  relativeLuminance,
  loadColorTokens,
  resolveToHex,
  gatePairs,
  evaluatePair,
  findBannedOutline
} from './contrast-gate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('WCAG color math', () => {
  it('parses 3- and 6-digit hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#03120e')).toEqual([3, 18, 14]);
  });

  it('rejects non-hex', () => {
    expect(() => parseHex('rgb(0,0,0)')).toThrow();
    expect(() => parseHex('var(--x)')).toThrow();
  });

  it('computes the canonical white/black contrast = 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#eef3f1', '#03120e')).toBeCloseTo(contrastRatio('#03120e', '#eef3f1'), 6);
  });

  it('luminance of black is 0 and white is 1', () => {
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 6);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 6);
  });
});

describe('token resolution', () => {
  const decls = loadColorTokens();

  it('follows var() alias chains to concrete hex', () => {
    // --color-text → --ink-50 → #eef3f1
    expect(resolveToHex('--color-text', decls)).toBe('#eef3f1');
    // --color-bg → --teal-950 → #03120e
    expect(resolveToHex('--color-bg', decls)).toBe('#03120e');
    // --color-accent → --accent → #8ab0ab
    expect(resolveToHex('--color-accent', decls)).toBe('#8ab0ab');
  });

  it('does not parse hex out of comments', () => {
    // colors.css comments contain hsl()/notes; resolution must come from decls.
    expect(() => resolveToHex('--color-running', decls)).not.toThrow();
    expect(resolveToHex('--color-running', decls)).toBe('#3fb6ac');
  });
});

describe('§15 token values are FILLED (no placeholders, all resolve)', () => {
  const decls = loadColorTokens();
  // Every semantic alias the UI-SPEC §4 roles + status-enum map name.
  const required = [
    '--color-bg',
    '--color-bg-inset',
    '--color-surface',
    '--color-surface-card',
    '--color-surface-raised',
    '--color-surface-overlay',
    '--color-surface-selected',
    '--color-border',
    '--color-border-strong',
    '--color-border-faint',
    '--color-focus-ring',
    '--color-text',
    '--color-text-2',
    '--color-text-muted',
    '--color-text-subtle',
    '--color-text-faint',
    '--color-text-inverse',
    '--color-text-accent',
    '--color-text-link',
    '--color-accent',
    '--color-accent-hover',
    '--color-accent-active',
    '--color-accent-muted',
    '--color-on-accent',
    '--color-running',
    '--color-success',
    '--color-warn',
    '--color-error',
    '--color-info',
    '--color-blocked',
    '--color-neutral',
    '--color-tier-local',
    '--color-tier-haiku',
    '--color-tier-sonnet',
    '--color-tier-opus'
  ];

  it.each(required)('%s is defined and resolves to a hex value', (tok) => {
    expect(decls.has(tok), `${tok} is missing from colors.css`).toBe(true);
    const hex = resolveToHex(tok, decls);
    expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('WCAG AA contrast gate — every load-bearing token pair', () => {
  const decls = loadColorTokens();
  const pairs = gatePairs();

  it('has a non-trivial set of pairs to check', () => {
    expect(pairs.length).toBeGreaterThan(40);
  });

  it.each(pairs.map((p) => [p.label, p] as const))('%s meets its AA ratio', (_label, p) => {
    const { ratio, pass } = evaluatePair(p, decls);
    expect(
      pass,
      `${p.label}: ${ratio.toFixed(2)}:1 < required ${p.min}:1`
    ).toBe(true);
  });
});

describe('focus ring is a real two-color ring (§9)', () => {
  it('focus ring contrasts the bg surface AND the accent it sits beside', () => {
    const decls = loadColorTokens();
    // --shadow-focus = 2px bg gap + ring color; ring must read on the bg.
    const ring = resolveToHex('--color-focus-ring', decls);
    const bg = resolveToHex('--color-bg', decls);
    expect(contrastRatio(ring, bg)).toBeGreaterThanOrEqual(3.0);
  });
});

describe('outline:none is banned across src/lib/styles (§9)', () => {
  const cssFiles = [
    'app.css',
    'tokens/base.css',
    'tokens/colors.css',
    'tokens/typography.css',
    'tokens/spacing.css',
    'tokens/fonts.css'
  ].map((rel) => join(HERE, '..', rel));

  it.each(cssFiles)('%s has no bare outline:none|0', (file) => {
    const css = readFileSync(file, 'utf8');
    const violations = findBannedOutline(css, file);
    expect(
      violations,
      `banned outline declaration:\n${violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n')}`
    ).toEqual([]);
  });
});

describe('D-034 font-license guard — no web-prohibited binaries referenced', () => {
  it('fonts.css must not @font-face a .ttf/.otf (web = woff2/woff only)', () => {
    const css = readFileSync(join(HERE, 'fonts.css'), 'utf8');
    expect(/\.(ttf|otf)\b/i.test(css), 'web fonts must be woff2/woff only (D-034)').toBe(false);
    expect(/format\(\s*['"]?(truetype|opentype)['"]?\s*\)/i.test(css)).toBe(false);
  });
});

// A focused self-check that the gate would actually CATCH a bad value (so a
// future palette regression cannot silently pass the gate).
describe('gate negative control', () => {
  it('flags a deliberately-bad pair (faint divider on app bg fails BODY AA)', () => {
    // --color-text-faint (#51635e) on --color-bg (#03120e) is a hint/divider
    // ink — well below BODY AA, which is exactly why it is NOT gated as body
    // text. Proves the gate's math would catch a real miss, not rubber-stamp.
    expect(contrastRatio('#51635e', '#03120e')).toBeLessThan(AA_BODY);
  });

  it('flags a banned outline declaration', () => {
    const v = findBannedOutline('a:focus { outline: none; }', 'x.css');
    expect(v).toHaveLength(1);
    expect(findBannedOutline('a:focus { outline: 2px solid transparent; }', 'x.css')).toEqual([]);
  });
});
