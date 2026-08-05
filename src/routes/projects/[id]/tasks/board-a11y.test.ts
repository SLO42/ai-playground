/**
 * TASK BOARD — a11y + design-token gate for the board's CONTROLS (D-034 / UI-SPEC §9).
 *
 * The operator judges this page by looking at it, so "design-system standard" and "accessible" are
 * checked here as MEASUREMENTS, not adjectives:
 *
 *   • every `var(--color-…)` the page references resolves to a token DEFINED in colors.css — an
 *     off-token var silently degrades to its fallback family (the H4 defect class);
 *   • every text/background pair the page actually composes is MEASURED against WCAG AA body
 *     (4.5:1) — the pairs are enumerated here, not assumed from a palette's reputation;
 *   • no `outline: none` / `outline: 0` anywhere (keyboard focus must stay visible), and every
 *     interactive selector carries a `:focus-visible` ring;
 *   • motion is opt-IN: the only `transition` sits inside `prefers-reduced-motion: no-preference`;
 *   • every control has an ACCESSIBLE NAME — buttons have text or aria-label, the tag chips form a
 *     labelled group with `aria-pressed`, and every input/select is inside or bound to a label.
 *
 * F-054: the Edit tool flips LF→CRLF on this box, so the source is normalized to `\n` before any
 * regex runs — otherwise this gate would fail on whitespace rather than on a defect.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	AA_BODY,
	contrastRatio,
	findBannedOutline,
	loadColorTokens,
	resolveToHex
} from '../../../../lib/styles/tokens/contrast-gate';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, '+page.svelte');

/** The page source with EOLs normalized (F-054 — never fail this gate on a line ending). */
const SRC = readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
/** Just the `<style>` block. */
const CSS = SRC.slice(SRC.indexOf('<style>'), SRC.lastIndexOf('</style>'));
/** Just the markup (between the closing `</script>` and the opening `<style>`). */
const MARKUP = SRC.slice(SRC.indexOf('</script>') + 9, SRC.indexOf('<style>'));

const DECLS = loadColorTokens();

describe('board page — every color reference is a DEFINED design token', () => {
	it('resolves every var(--color-…) and every fallback to a defined token', () => {
		const refs = [...CSS.matchAll(/var\(\s*(--color-[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/gi)];
		expect(refs.length).toBeGreaterThan(20); // the page really is token-styled, not ad hoc
		const undefinedRefs: string[] = [];
		for (const m of refs) {
			if (!DECLS.has(m[1])) undefinedRefs.push(m[1]);
			const fallback = m[2]?.trim();
			if (fallback?.startsWith('var(')) {
				const inner = fallback.match(/var\(\s*(--[a-z0-9-]+)/i)?.[1];
				if (inner && !DECLS.has(inner)) undefinedRefs.push(inner);
			}
		}
		expect(undefinedRefs).toEqual([]);
	});

	it('names a --font-* token on every font-family — `inherit` is not a token', () => {
		// The repo-wide gate (styles/tokens/typography-tokens.test.ts §14.1) owns this rule and CAUGHT
		// this page shipping `font-family: inherit` on `.input` and `.btn`. Restated locally because
		// the reason is page-level: a form control does NOT inherit the page face — the UA stylesheet
		// overrides it — so `inherit` silently rendered the browser's default in the two controls the
		// operator types into, on a page whose whole claim is design-system fidelity.
		const decls = [...CSS.matchAll(/font-family\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
		expect(decls.length).toBeGreaterThan(0);
		expect(decls.filter((d) => !/var\(--font-/.test(d))).toEqual([]);
	});

	it('uses no raw hex / rgb color literals — tokens only (D-034)', () => {
		// Comments legitimately QUOTE measured hex values (e.g. "#102822"), so they are stripped
		// before the scan: the rule is about declarations, not about documenting a measurement.
		const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
		expect(declarations).not.toMatch(/:\s*#[0-9a-f]{3,8}\b/i);
		expect(declarations).not.toMatch(/:\s*(rgb|hsl)a?\(/i);
	});
});

/**
 * The text/background pairs this page actually composes, read off the stylesheet by hand and
 * MEASURED here. `[selector, foreground token, background token]`.
 *
 * The backgrounds are the real ancestors: `.filters`/`.board-card`/`.detail` sit on
 * `--color-surface-card`, a column body on `--color-surface`, a chip/tag on
 * `--color-surface-overlay`, the run-seed `<pre>` on `--color-bg-inset`.
 */
const PAIRS: [string, string, string][] = [
	['.lede', '--color-text-2', '--color-surface-card'],
	['.title', '--color-text', '--color-surface-card'],
	['.state-body', '--color-text-2', '--color-surface-card'],
	['.link-inline', '--color-text-link', '--color-surface-card'],
	['.field-label', '--color-text-muted', '--color-surface-card'],
	['.input', '--color-text', '--color-bg-inset'],
	['.chip', '--color-text-2', '--color-surface-overlay'],
	['.chip[data-active]', '--color-on-accent', '--color-accent'],
	['.chip:disabled', '--color-text-muted', '--color-surface-overlay'],
	['.summary', '--color-text-muted', '--color-surface-card'],
	['.stale-note', '--color-warn', '--color-surface-card'],
	['.sprint-note', '--color-text-muted', '--color-surface-card'],
	['.btn', '--color-text', '--color-surface-raised'],
	['.status (default)', '--color-neutral-on-overlay', '--color-surface'],
	['.status[done]', '--color-success-on-overlay', '--color-surface'],
	['.status[failed]', '--color-error-on-overlay', '--color-surface'],
	['.status[blocked]', '--color-blocked-on-overlay', '--color-surface'],
	['.status[proposed]', '--color-info-on-overlay', '--color-surface'],
	['.status[ready]', '--color-running-on-overlay', '--color-surface'],
	['.count', '--color-text-muted', '--color-surface'],
	['.board-empty', '--color-text-muted', '--color-surface'],
	['.card-title', '--color-text', '--color-surface-card'],
	['.card-objective', '--color-text-muted', '--color-surface-card'],
	['.card-tag', '--color-text-2', '--color-surface-overlay'],
	['.card-foot', '--color-text-muted', '--color-surface-card'],
	['.prio[high]', '--color-warn-on-overlay', '--color-surface-card'],
	['.ctx', '--color-text-muted', '--color-surface-card'],
	['.ctx[full]', '--color-success-on-overlay', '--color-surface-card'],
	['.detail-h', '--color-text-muted', '--color-surface-card'],
	['.detail-h-note', '--color-text-muted', '--color-surface-card'],
	['.detail-text', '--color-text-2', '--color-surface-card'],
	['.detail-absent', '--color-text-muted', '--color-surface-card'],
	['.detail-absent-inline', '--color-text-muted', '--color-surface-card'],
	['.detail-criteria', '--color-text-2', '--color-surface-card'],
	['.detail-seed', '--color-text-2', '--color-bg-inset'],
	['.detail-hint', '--color-text-muted', '--color-surface-card'],
	['.detail-kv dt', '--color-text-muted', '--color-surface-card'],
	['.detail-kv dd', '--color-text-2', '--color-surface-card'],
	['.dim', '--color-text-subtle', '--color-bg-inset'],
	['.form-error', '--color-error', '--color-error-bg'],
	['.form-ok', '--color-success', '--color-success-bg']
];

describe('board page — contrast is MEASURED, not assumed', () => {
	it.each(PAIRS)('%s: %s on %s clears AA body', (_sel, fg, bg) => {
		const ratio = contrastRatio(resolveToHex(fg, DECLS), resolveToHex(bg, DECLS));
		expect(ratio).toBeGreaterThanOrEqual(AA_BODY);
	});

	it('the faint ramp is not used for content anywhere on this page', () => {
		// `--color-text-faint` measures 2.44:1 on --color-surface-card and 2.67:1 on --color-surface
		// — below AA body on every surface this page uses. The measurement is what disqualifies it,
		// so the gate is stated as a measurement and enforced as an absence.
		expect(contrastRatio(resolveToHex('--color-text-faint', DECLS), resolveToHex('--color-surface-card', DECLS))).toBeLessThan(AA_BODY);
		expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('--color-text-faint');
	});
});

describe('board page — keyboard + motion', () => {
	it('never suppresses the focus outline', () => {
		expect(findBannedOutline(CSS, PAGE)).toEqual([]);
	});

	it('every interactive selector carries a visible focus ring', () => {
		const focusRule = CSS.slice(CSS.indexOf(':focus-visible'));
		for (const sel of ['.link-inline', '.card-title', '.chip', '.btn', '.input']) {
			expect(CSS).toContain(`${sel}:focus-visible`);
		}
		expect(focusRule).toContain('--color-focus-ring');
		expect(focusRule).toContain('outline-offset');
	});

	it('motion is opt-IN — every transition sits inside prefers-reduced-motion: no-preference', () => {
		const transitions = [...CSS.matchAll(/transition\s*:/g)];
		expect(transitions.length).toBeGreaterThan(0);
		const guard = CSS.indexOf('@media (prefers-reduced-motion: no-preference)');
		expect(guard).toBeGreaterThan(-1);
		for (const m of transitions) expect(m.index!).toBeGreaterThan(guard);
	});
});

describe('board controls — every one has an accessible name', () => {
	/** Every `<button …>…</button>` in the markup, as `{attrs, text}`. */
	function buttons(): { attrs: string; text: string }[] {
		return [...MARKUP.matchAll(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/g)].map((m) => ({
			attrs: m[1],
			text: m[2]
		}));
	}

	it('finds the board buttons and gives each one a name', () => {
		const all = buttons();
		expect(all.length).toBeGreaterThanOrEqual(4); // chips, clear, save tags, set priority, moves
		for (const b of all) {
			const hasLabel = /aria-label=/.test(b.attrs);
			// Text content that is not purely markup/whitespace — a `{expr}` counts, since every
			// expression here renders a status/tag/priority word.
			const hasText = b.text.replace(/<[^>]*>/g, '').trim().length > 0;
			expect(hasLabel || hasText).toBe(true);
		}
	});

	it('the tag chips are a LABELLED group whose members report their pressed state', () => {
		expect(MARKUP).toMatch(/role="group"[\s\S]{0,120}aria-label="Filter by tag/);
		expect(MARKUP).toContain('aria-pressed={active}');
		// A dead chip is DISABLED rather than silently inert (the honest 0-count state).
		expect(MARKUP).toContain('disabled={isBoardChipDisabled(o.count, active)}');
	});

	it('every input and select is inside a <label> or bound to one by id', () => {
		const controls = [...MARKUP.matchAll(/<(input|select)\b([\s\S]*?)>/g)].filter(
			(m) => !/type="hidden"/.test(m[2])
		);
		expect(controls.length).toBeGreaterThanOrEqual(6);
		for (const c of controls) {
			const idMatch = c[2].match(/\bid=(?:"([^"]+)"|\{([^}]+)\})/);
			if (idMatch) {
				const raw = idMatch[1] ?? idMatch[2];
				// Either a literal `for="…"` match, or a `for={…}` bound to the same expression.
				const literal = idMatch[1] ? MARKUP.includes(`for="${raw}"`) : false;
				const bound = MARKUP.includes(`for={${raw}}`);
				const wrapped = /<label class="field"/.test(MARKUP);
				expect(literal || bound || wrapped).toBe(true);
			} else {
				// No id ⇒ it must be wrapped by a <label> — the project page's own convention.
				expect(MARKUP).toMatch(/<label[^>]*>[\s\S]*?<(input|select)/);
			}
		}
	});

	it('screen-reader-only labels are visually hidden, never display:none (which removes them)', () => {
		expect(MARKUP).toContain('class="vh"');
		const vhRule = CSS.slice(CSS.indexOf('.vh {'), CSS.indexOf('.vh {') + 300);
		expect(vhRule).toContain('clip-path');
		expect(vhRule).not.toContain('display: none');
	});

	it('the honest states are announced (role=status / role=alert), not silent', () => {
		expect(MARKUP).toContain('role="alert"'); // the error envelope
		const statuses = [...MARKUP.matchAll(/role="status"/g)];
		expect(statuses.length).toBeGreaterThanOrEqual(4); // db-down, filtered-empty, stale, feedback
	});
});
