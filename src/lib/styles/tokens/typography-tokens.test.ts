/* ============================================================================
   ai-playground v2 — TYPOGRAPHY TOKEN GATE (task 14.1)
   Operator directive: monospace for everything that is NOT a heading/title,
   app-wide. Lastik (operator-purchased display face, D-034) remains the face
   for headings/titles/brand ONLY.

   Fails the build if:
     1. the body/UI token (--font-body) does not resolve to a mono stack;
     2. the display token (--font-display) loses Lastik or gains mono;
     3. a semantic type alias points at the wrong face (headings ≠ display,
        body/label ≠ mono);
     4. base.css drops the h1–h6 display-face guard or the mono body default;
     5. a component hardcodes a literal font-family instead of the tokens.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDeclarations } from './contrast-gate';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..', '..');

const typographyCss = readFileSync(join(HERE, 'typography.css'), 'utf8');
const baseCss = readFileSync(join(HERE, 'base.css'), 'utf8');
const appCss = readFileSync(join(HERE, '..', 'app.css'), 'utf8');
const decls = parseDeclarations(typographyCss);

/** Resolve a token through whole-value `var(--x)` alias hops (no hex needed). */
function resolveFont(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`var() cycle at ${name}`);
  seen.add(name);
  const value = decls.get(name);
  if (!value) throw new Error(`token ${name} is not defined in typography.css`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return alias ? resolveFont(alias[1], seen) : value;
}

describe('14.1 — body/UI face is a mono stack', () => {
  it('--font-body is defined and resolves to a monospace stack', () => {
    const body = resolveFont('--font-body');
    expect(body).toMatch(/ui-monospace/);
    expect(body.trim()).toMatch(/monospace\s*$/); // generic family last
  });

  it('--font-body does not leak the display face', () => {
    expect(resolveFont('--font-body')).not.toMatch(/Lastik/i);
  });

  it('--font-mono stays a mono stack (code/ids/transcripts)', () => {
    const mono = resolveFont('--font-mono');
    expect(mono).toMatch(/ui-monospace/);
    expect(mono.trim()).toMatch(/monospace\s*$/);
  });
});

describe('14.1 — display face keeps Lastik (headings/titles/brand, D-034)', () => {
  it('--font-display leads with Lastik and falls back to system sans', () => {
    const display = resolveFont('--font-display');
    expect(display).toMatch(/^\s*'Lastik'/);
    expect(display.trim()).toMatch(/sans-serif\s*$/);
  });

  it('--font-display is NOT monospace', () => {
    expect(resolveFont('--font-display')).not.toMatch(/monospace/);
  });

  it('deprecated --font-sans alias resolves to the display face', () => {
    expect(resolveFont('--font-sans')).toMatch(/^\s*'Lastik'/);
  });
});

describe('14.1 — semantic type aliases point at the right face', () => {
  const headingAliases = ['--type-display', '--type-h1', '--type-h2', '--type-h3'];
  const bodyAliases = ['--type-body', '--type-body-sm', '--type-label'];
  const monoAliases = ['--type-mono', '--type-mono-sm'];

  it.each(headingAliases)('%s uses var(--font-display)', (tok) => {
    expect(decls.get(tok), `${tok} missing`).toMatch(/var\(--font-display\)\s*$/);
  });

  it.each(bodyAliases)('%s uses var(--font-body)', (tok) => {
    expect(decls.get(tok), `${tok} missing`).toMatch(/var\(--font-body\)\s*$/);
  });

  it.each(monoAliases)('%s uses var(--font-mono)', (tok) => {
    expect(decls.get(tok), `${tok} missing`).toMatch(/var\(--font-mono\)\s*$/);
  });
});

describe('14.1 — base.css wiring', () => {
  it('body renders the mono body type (font: var(--type-body))', () => {
    expect(baseCss).toMatch(/body\s*{[^}]*font:\s*var\(--type-body\)/s);
  });

  it('h1–h6 are guarded onto the display face', () => {
    expect(baseCss).toMatch(
      /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*{\s*font-family:\s*var\(--font-display\)/
    );
  });

  it('code/kbd/pre/samp stay mono', () => {
    expect(baseCss).toMatch(/code,\s*kbd,\s*pre,\s*samp\s*{\s*font-family:\s*var\(--font-mono\)/);
  });
});

describe('14.1 — Tailwind @theme bridge mirrors the token layer', () => {
  it('@theme --font-sans (default utility face) is mono', () => {
    const theme = /@theme\s*{([^}]*)}/s.exec(appCss);
    expect(theme, 'app.css must keep its @theme block').not.toBeNull();
    const themeDecls = parseDeclarations(theme![1]);
    expect(themeDecls.get('--font-sans')).toMatch(/ui-monospace/);
    expect(themeDecls.get('--font-display')).toMatch(/^\s*'Lastik'/);
    expect(themeDecls.get('--font-mono')).toMatch(/ui-monospace/);
  });
});

describe('14.1 — no component hardcodes a literal font-family', () => {
  // Every font-family declaration outside the token layer must consume a
  // --font-* token (a var(--font-… reference). fonts.css is exempt: its
  // @font-face legitimately *names* the Lastik family.
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(svelte|css)$/.test(entry)) out.push(p);
    }
    return out;
  }

  const files = walk(SRC_ROOT).filter((f) => !f.endsWith('fonts.css'));

  it('scans a non-trivial file set', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every font-family declaration references a --font-* token', () => {
    const violations: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, 'utf8');
      const re = /font-family\s*:\s*([^;}]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(css)) !== null) {
        if (!/var\(--font-/.test(m[1])) violations.push(`${file}: font-family: ${m[1].trim()}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
