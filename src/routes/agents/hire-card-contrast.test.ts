/* ============================================================================
   ai-playground v2 — COMPLETION-LEDGER Wave A, AV-1 re-review fix (D-038 DoD).

   DEFECT (HIGH detection / MEDIUM severity, measured): the hiring & certification
   ledger's tone badge, `.hire-op`, renders at --text-xs/semibold — NON-large text —
   on `.hire-log-row`'s --color-surface-overlay background. Its tone rules were
   authored with the BASE-surface semantic tokens (--color-error / --color-success)
   instead of the *-on-overlay ramp the codebase ships for exactly that surface.

   --color-success-on-overlay happens to alias success-500, so the `good` tone passed
   at 4.87:1 and MASKED the wrong-token-family choice. --color-error-on-overlay is a
   genuinely lighter error-300, so the `bad` tone shipped at 3.50:1 — under BODY AA —
   and `bad` is the tone for hire_rejected and role_reversioned, two of the ledger's
   most consequential states.

   The token-pair contrast gate (contrast-gate.ts) covers the *-on-overlay PAIRINGS
   but not which token a component picks, so this test locks the component's choice
   and re-measures with the shipped tokens (reusing the gate primitives, D-016 spirit
   of reuse-before-write). Same shape as SessionFailureReason.test.ts GAP 1.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AA_BODY,
  AA_LARGE,
  contrastRatio,
  loadColorTokens,
  resolveToHex
} from '../../lib/styles/tokens/contrast-gate';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, '+page.svelte');
const src = readFileSync(PAGE, 'utf8');
/** Comments carry token names in prose; strip them so they can't satisfy a regex. */
const css = src.replace(/\/\*[\s\S]*?\*\//g, '');

/** The `prop:` token inside the rule for an exact (possibly attribute-) selector. */
function tokenOfRule(selector: string, prop: 'color' | 'border-color'): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) return null;
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*var\\(\\s*(--[\\w-]+)\\s*\\)`).exec(block[1]);
  return m ? m[1] : null;
}

describe('AV-1 hiring ledger — tone badges use the BODY-AA on-overlay text tokens', () => {
  it('the badge really does sit on --color-surface-overlay (the surface the AA pairing assumes)', () => {
    // If the row background ever changes, every token choice below must be revisited.
    expect(
      /\.hire-log-row\s*\{[^}]*background\s*:\s*var\(\s*--color-surface-overlay\s*\)/.test(css),
      '.hire-log-row must set background: var(--color-surface-overlay)'
    ).toBe(true);
  });

  it('the badge text is non-large (xs/semibold) — so BODY AA, not LARGE, is its bar', () => {
    const block = /\.hire-op\s*\{([^}]*)\}/.exec(css);
    expect(block, '.hire-op rule must exist').not.toBeNull();
    expect(/font-size\s*:\s*var\(\s*--text-xs\s*\)/.test(block![1])).toBe(true);
  });

  it("data-tone='bad' text is --color-error-on-overlay (not raw --color-error)", () => {
    expect(
      tokenOfRule(".hire-op[data-tone='bad']", 'color'),
      "the bad tone labels hire_rejected / role_reversioned — it must use the on-overlay ramp"
    ).toBe('--color-error-on-overlay');
  });

  it("data-tone='good' text is --color-success-on-overlay (locks the token FAMILY, not just the value)", () => {
    // Resolves to the same hex today; naming it explicitly stops the pairing from
    // silently drifting if success-on-overlay is ever re-tuned for this surface.
    expect(tokenOfRule(".hire-op[data-tone='good']", 'color')).toBe('--color-success-on-overlay');
  });

  it('both tone TEXT tokens measure ≥ BODY AA (4.5:1) on the overlay with the shipped tokens', () => {
    const decls = loadColorTokens();
    const bg = resolveToHex('--color-surface-overlay', decls);
    for (const tok of ['--color-error-on-overlay', '--color-success-on-overlay']) {
      const ratio = contrastRatio(resolveToHex(tok, decls), bg);
      expect(ratio, `${tok} on overlay = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it('the OLD token (--color-error) genuinely fails BODY AA there — proves this guard is real', () => {
    const decls = loadColorTokens();
    const ratio = contrastRatio(
      resolveToHex('--color-error', decls),
      resolveToHex('--color-surface-overlay', decls)
    );
    expect(ratio, `--color-error on overlay = ${ratio.toFixed(2)}:1`).toBeLessThan(AA_BODY);
  });

  it('the tone BORDERS stay on the base tokens and still clear the 3:1 UI-component bar', () => {
    // Prior art: SessionFailureReason's advisory variant — on-overlay text, base-token border.
    expect(tokenOfRule(".hire-op[data-tone='bad']", 'border-color')).toBe('--color-error');
    expect(tokenOfRule(".hire-op[data-tone='good']", 'border-color')).toBe('--color-success');
    const decls = loadColorTokens();
    const bg = resolveToHex('--color-surface-overlay', decls);
    for (const tok of ['--color-error', '--color-success']) {
      const ratio = contrastRatio(resolveToHex(tok, decls), bg);
      expect(ratio, `${tok} border on overlay = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('colour is never the ONLY signal — the badge always renders a text label too', () => {
    // The a11y argument for keeping tone as a secondary cue depends on this staying true.
    expect(/<span class="hire-op" data-tone=\{[^}]*\}>\s*\{hireLabel\(ev\.op\)\}/.test(src)).toBe(true);
  });
});
