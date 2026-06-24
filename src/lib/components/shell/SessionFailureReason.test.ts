/* ============================================================================
   ai-playground v2 — MC-4 Honest failure surfacing: contrast + DRY regressions
   (re-review fix, D-038 DoD).

   Two defects this guards against re-introducing:

     GAP 1 (HIGH, measured contrast): SessionFailureReason's `.fail-label` text
       sits ~11px/700 on --color-surface-overlay → BODY-AA (≥4.5:1). It MUST use
       --color-error-on-overlay (error-300, 5.31:1), never raw --color-error
       (error-500, 3.50:1 — only AA_LARGE). The token-pair contrast gate covers
       the *-on-overlay pairings, but NOT which token a component picks — so this
       test locks the component's choice and re-checks the measured ratio with the
       shipped tokens (reuse of contrast-gate primitives, D-016).

     GAP 2 (MEDIUM, DRY/maintenance hazard): /claude-code must render the failure
       banner via the SHARED SessionFailureReason component, not a duplicated
       inline markup + .fail-label/.fail-text/.sess-fail-reason/.tp-fail-reason
       CSS block — or the contrast fix above silently drifts on one surface.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AA_BODY, contrastRatio, loadColorTokens, resolveToHex } from '../../styles/tokens/contrast-gate';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT = join(HERE, 'SessionFailureReason.svelte');
const CLAUDE_CODE = join(HERE, '..', '..', '..', 'routes', 'claude-code', '+page.svelte');

/** The `color:` token inside a named CSS rule in a .svelte <style> block. */
function colorTokenOfRule(css: string, selector: string): string | null {
  // Match `.selector { ... color: var(--x); ... }`. Comments stripped first.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`);
  const block = re.exec(stripped);
  if (!block) return null;
  const m = /color\s*:\s*var\(\s*(--[\w-]+)\s*\)/.exec(block[1]);
  return m ? m[1] : null;
}

describe('GAP 1 — SessionFailureReason .fail-label uses the BODY-AA on-overlay token', () => {
  const src = readFileSync(COMPONENT, 'utf8');

  it('.fail-label color is --color-error-on-overlay (not raw --color-error)', () => {
    const tok = colorTokenOfRule(src, 'fail-label');
    expect(tok, '.fail-label must set color: var(--color-error-on-overlay)').toBe('--color-error-on-overlay');
  });

  it('the banner sits on --color-surface-overlay (the surface the AA pairing assumes)', () => {
    // If the background ever changes, the on-overlay token choice must be revisited.
    expect(/background\s*:\s*var\(\s*--color-surface-overlay\s*\)/.test(src)).toBe(true);
  });

  it('that label token measures ≥ BODY AA (4.5:1) on the overlay surface with the shipped tokens', () => {
    const decls = loadColorTokens();
    const fg = resolveToHex('--color-error-on-overlay', decls);
    const bg = resolveToHex('--color-surface-overlay', decls);
    const ratio = contrastRatio(fg, bg);
    expect(ratio, `--color-error-on-overlay on overlay = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY);
  });

  it('the OLD token (--color-error) genuinely fails BODY AA there — proves this guard is real', () => {
    const decls = loadColorTokens();
    const ratio = contrastRatio(resolveToHex('--color-error', decls), resolveToHex('--color-surface-overlay', decls));
    expect(ratio).toBeLessThan(AA_BODY);
  });
});

describe('WI-3 — advisory note on a NON-failed session (work-preserved) surfaces, distinct from a failure', () => {
  const src = readFileSync(COMPONENT, 'utf8');

  it('renders an advisory branch for a non-failed session that carries a note', () => {
    // The component gates failure on status==='failed' but ALSO renders an advisory when
    // !failed && note present (the WI-3 "work preserved on branch …; merge needed" note on a
    // done-but-couldn't-merge session). Lock that the advisory branch exists.
    expect(/isAdvisory/.test(src), 'an isAdvisory derived branch must exist').toBe(true);
    expect(/\{:else if isAdvisory\}/.test(src), 'an {:else if isAdvisory} render branch must exist').toBe(true);
  });

  it('the advisory uses the WARN tone (not the error border), visually distinct from a failure', () => {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
    // advisory label color is the gated warn-on-overlay token
    const tok = colorTokenOfRule(stripped, 'advisory-label');
    expect(tok).toBe('--color-warn-on-overlay');
    // the advisory variant overrides the (error) left border to warn
    expect(/\.fail-reason\.advisory\s*\{[^}]*border-left-color\s*:\s*var\(\s*--color-warn\s*\)/.test(stripped)).toBe(true);
  });

  it('the advisory label token measures ≥ BODY AA (4.5:1) on the overlay surface', () => {
    const decls = loadColorTokens();
    const ratio = contrastRatio(
      resolveToHex('--color-warn-on-overlay', decls),
      resolveToHex('--color-surface-overlay', decls)
    );
    expect(ratio, `--color-warn-on-overlay on overlay = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY);
  });
});

describe('GAP 2 — /claude-code renders the failure banner via the shared component (no duplicate)', () => {
  const src = readFileSync(CLAUDE_CODE, 'utf8');

  it('imports SessionFailureReason', () => {
    expect(/import\s+SessionFailureReason\s+from\s+['"][^'"]*SessionFailureReason\.svelte['"]/.test(src)).toBe(true);
  });

  it('uses the <SessionFailureReason> element', () => {
    expect(/<SessionFailureReason\b/.test(src)).toBe(true);
  });

  it('no longer carries the duplicated .fail-label / banner CSS (drift hazard)', () => {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/\.fail-label\s*\{/.test(stripped), 'duplicated .fail-label CSS must be gone').toBe(false);
    expect(/\.sess-fail-reason\s*[,{]/.test(stripped), 'duplicated .sess-fail-reason CSS must be gone').toBe(false);
    expect(/\.tp-fail-reason\s*[,{]/.test(stripped), 'duplicated .tp-fail-reason CSS must be gone').toBe(false);
  });
});
