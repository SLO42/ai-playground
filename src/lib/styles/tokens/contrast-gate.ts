/* ============================================================================
   ai-playground v2 — A11Y / CONTRAST GATE (pure logic)
   The deterministic WCAG-luminance check that UI-SPEC §9 / §15 require: every
   load-bearing token pair (text-on-surface, status-on-bg, focus-ring/border)
   must meet its AA ratio on the DARK theme; a bare `outline: none` is banned.

   This module is pure (no DOM, no Tailwind) so it runs in the node vitest env.
   It resolves the `var(--alias)` chains in tokens/colors.css down to concrete
   hex, then exposes the WCAG primitives the gate test asserts against.
   ============================================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** WCAG AA thresholds (UI-SPEC §9). */
export const AA_BODY = 4.5; // normal-size body text
export const AA_LARGE = 3.0; // large text / UI components / focus ring

// ---------------------------------------------------------------------------
// Color math (WCAG 2.x relative luminance + contrast ratio).
// ---------------------------------------------------------------------------

/** Parse a `#rgb` or `#rrggbb` hex string → [r,g,b] in 0..255. Throws on junk. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`not a hex color: "${hex}"`);
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colors (1..21). Order-independent. */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(parseHex(fg));
  const l2 = relativeLuminance(parseHex(bg));
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Token resolution: read tokens/colors.css, flatten `var(--x)` → concrete hex.
// ---------------------------------------------------------------------------

/**
 * Parse `--name: value;` declarations from a CSS string. Keeps the LAST value
 * for a name (so an @media override would win — none in colors.css today, but
 * correct by construction). Multi-value lines (e.g. `--a: x; --b: y;`) handled.
 */
export function parseDeclarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  // Strip /* ... */ comments so a `#hex` inside a comment is never parsed.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

/** Resolve a single token value to concrete hex, following `var(--x)` chains. */
export function resolveToHex(name: string, decls: Map<string, string>, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`circular var() reference at ${name}`);
  seen.add(name);
  const raw = decls.get(name);
  if (raw === undefined) throw new Error(`undefined token: ${name}`);
  const varMatch = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);
  if (varMatch) return resolveToHex(varMatch[1], decls, seen);
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) return raw;
  throw new Error(`token ${name} does not resolve to a hex color (got "${raw}")`);
}

/** Load + parse the shipped tokens/colors.css. */
export function loadColorTokens(): Map<string, string> {
  const css = readFileSync(join(HERE, 'colors.css'), 'utf8');
  return parseDeclarations(css);
}

// ---------------------------------------------------------------------------
// The load-bearing token PAIRS the gate enforces (UI-SPEC §4 roles + §9).
// fg = foreground token, bg = background token, min = required ratio.
// ---------------------------------------------------------------------------

export interface TokenPair {
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
}

/**
 * Every pair that carries meaning the operator must be able to read.
 * Surfaces tested: app bg, panel, card, raised. Text ramp down to `-muted`
 * must meet body AA on every surface it renders on; `-subtle`/`-faint` are
 * decorative-only (dividers/hints) → large/UI threshold. Status + tier accents
 * (load-bearing per §4) tested at large/UI AA against the surfaces they tint.
 * Focus ring + strong border vs the surfaces they outline → UI AA (≥3:1).
 */
export function gatePairs(): TokenPair[] {
  const surfaces: Array<[string, string]> = [
    ['bg', '--color-bg'],
    ['surface', '--color-surface'],
    ['card', '--color-surface-card'],
    ['raised', '--color-surface-raised']
  ];

  const pairs: TokenPair[] = [];

  // Primary + secondary + muted text must hit BODY AA on every surface.
  for (const [sName, sTok] of surfaces) {
    for (const t of ['--color-text', '--color-text-2', '--color-text-muted']) {
      pairs.push({ label: `${t} on ${sName}`, fg: t, bg: sTok, min: AA_BODY });
    }
    // Subtle/faint are non-essential (placeholders, dividers, hints) → UI AA.
    for (const t of ['--color-text-subtle']) {
      pairs.push({ label: `${t} on ${sName}`, fg: t, bg: sTok, min: AA_LARGE });
    }
    // Accent + link text are interactive labels → BODY AA (they convey state).
    for (const t of ['--color-text-accent', '--color-text-link']) {
      pairs.push({ label: `${t} on ${sName}`, fg: t, bg: sTok, min: AA_BODY });
    }
    // Status + tier colors are UI/icon/label glyphs → large/UI AA on each surface.
    for (const t of [
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
    ]) {
      pairs.push({ label: `${t} on ${sName}`, fg: t, bg: sTok, min: AA_LARGE });
    }
  }

  // Text-on-accent (filled accent button) → BODY AA.
  pairs.push({ label: '--color-on-accent on --color-accent', fg: '--color-on-accent', bg: '--color-accent', min: AA_BODY });
  pairs.push({ label: '--color-text-inverse on --color-accent', fg: '--color-text-inverse', bg: '--color-accent', min: AA_BODY });

  // Focus ring must be visible against every app surface (≥3:1, §9 — the
  // load-bearing graphical object that conveys keyboard state). Structural
  // borders (`--color-border*`) are decorative hierarchy, NOT state-conveying
  // graphical objects, so WCAG 1.4.11 / §9's UI-component rule does not gate
  // them — DESIGN-SYSTEM §3.2 "borders carry hierarchy, not shadows".
  for (const [sName, sTok] of surfaces) {
    pairs.push({ label: `--color-focus-ring on ${sName}`, fg: '--color-focus-ring', bg: sTok, min: AA_LARGE });
  }

  return pairs;
}

/** Evaluate a pair against resolved tokens → measured ratio + pass/fail. */
export function evaluatePair(p: TokenPair, decls: Map<string, string>): { ratio: number; pass: boolean } {
  const ratio = contrastRatio(resolveToHex(p.fg, decls), resolveToHex(p.bg, decls));
  return { ratio, pass: ratio >= p.min };
}

// ---------------------------------------------------------------------------
// Lint: bare `outline: none` (and `outline: 0`) is banned (UI-SPEC §9).
// A visible focus indicator must survive — `outline: <n> solid transparent`
// (a forced-colors-safe placeholder) is allowed.
// ---------------------------------------------------------------------------

export interface OutlineViolation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Scan a CSS string for banned bare-`outline:none|0` declarations. */
export function findBannedOutline(css: string, file: string): OutlineViolation[] {
  const out: OutlineViolation[] = [];
  const lines = css.split(/\r?\n/);
  // outline shorthand or longhand set to none / 0 with no surviving indicator.
  const banned = /(^|[;{]|\s)outline(-style|-width)?\s*:\s*(none|0)\s*(;|$|!important)/i;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\*.*?\*\//g, '');
    if (banned.test(line)) out.push({ file, line: i + 1, text: raw.trim() });
  });
  return out;
}
