/* ============================================================================
   ai-playground v2 — PROJECT ACTIVITY COLOR-TOKEN GATE
   Same regression gate as project-status-tokens.test.ts, scoped to the new
   ProjectActivity.svelte: every `var(--color-…[, <fallback>])` the component
   references must resolve to a token DEFINED in colors.css — either directly, or
   via a fallback that is itself a defined `--color-…` token. An undefined token
   with no defined-token fallback renders an off-token value (falls back to
   `inherit` at computed-value time) and BYPASSES the contrast gate — that exact
   class of defect (CC-STATUS `--color-text-primary`) is what this catches.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadColorTokens } from '../../styles/tokens/contrast-gate';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT = join(HERE, 'ProjectActivity.svelte');

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

describe('ProjectActivity references only DEFINED color tokens', () => {
	const decls = loadColorTokens();
	const css = readFileSync(COMPONENT, 'utf8');
	const refs = colorVarRefs(css);

	it('found color-token references to gate (sanity)', () => {
		expect(refs.length).toBeGreaterThan(5);
	});

	it('uses NO raw hex outside a token fallback (design-tokens only)', () => {
		// Strip every var(...) fallback (a token's documented fallback hex is allowed by convention)
		// then assert the remaining CSS carries no bare #rrggbb — tokens only on the live path.
		const withoutFallbacks = css.replace(/var\([^)]*\)/g, '');
		expect(withoutFallbacks).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
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
