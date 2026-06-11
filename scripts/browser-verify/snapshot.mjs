// snapshot — DOM/a11y outline capture + pure diff (TASK 15.2 B3, harvest B3).
//
// Pattern source (provenance): gstack browse snapshot system — "@e refs you
// can click/fill/inspect later" + snapshot-diff action proof (BROWSER.md,
// MIT). Mechanisms OURS:
//   - captureNodes runs IN the page (passed to page.evaluate, so it must be
//     fully self-contained — no closures over module scope);
//   - refs are generation-tagged DOM attributes (`data-bv-ref="g3:e7"`); a
//     navigation or re-snapshot makes old refs physically absent from the
//     DOM, which is what lets the daemon's instant existence probe convert
//     Playwright's 30s stale-element wait into an immediate named error;
//   - diffSnapshots is PURE (unit-testable, injected nothing) and powers the
//     act() proof: "clicked and N things changed (list)" vs the honest
//     failure signal "clicked and nothing changed" (F-008).

/** Hard cap on captured nodes — bounds payload size on pathological pages. */
export const MAX_NODES = 500;

/**
 * Evaluated inside the browser via page.evaluate(captureNodes, opts).
 * MUST stay self-contained (it is serialized by toString()).
 *
 * @param {{ assignRefs: boolean, generation: number, maxNodes: number }} opts
 * @returns {{ ref: string | null, tag: string, role: string, name: string }[]}
 */
export function captureNodes(opts) {
	const { assignRefs, generation, maxNodes } = opts;
	const SELECTOR =
		'a, button, input, select, textarea, summary, [role], [tabindex], ' +
		'h1, h2, h3, h4, h5, h6, nav, main, header, aside, dialog, [aria-label]';

	if (assignRefs) {
		// Previous generation's refs are retired wholesale — exactly one
		// generation is ever present in the DOM.
		for (const el of Array.from(document.querySelectorAll('[data-bv-ref]'))) {
			el.removeAttribute('data-bv-ref');
		}
	}

	const visible = (el) => {
		if (typeof el.checkVisibility === 'function') {
			return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
		}
		return !!(el.offsetParent || el === document.body);
	};

	const accName = (el) => {
		const aria = el.getAttribute('aria-label');
		if (aria) return aria.trim();
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			return (el.placeholder || el.name || el.value || '').trim();
		}
		if (el instanceof HTMLImageElement) return (el.alt || '').trim();
		const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
		if (text) return text.slice(0, 80);
		return (el.getAttribute('title') || '').trim();
	};

	const implicitRole = (el) => {
		const explicit = el.getAttribute('role');
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		const map = {
			a: el.hasAttribute('href') ? 'link' : 'generic',
			button: 'button',
			input: 'textbox',
			select: 'combobox',
			textarea: 'textbox',
			nav: 'navigation',
			main: 'main',
			header: 'banner',
			aside: 'complementary',
			dialog: 'dialog',
			summary: 'button'
		};
		if (/^h[1-6]$/.test(tag)) return 'heading';
		return map[tag] || 'generic';
	};

	const out = [];
	let i = 0;
	for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
		if (out.length >= maxNodes) break;
		if (!(el instanceof HTMLElement)) continue;
		if (!visible(el)) continue;
		i += 1;
		let ref = null;
		if (assignRefs) {
			ref = `g${generation}:e${i}`;
			el.setAttribute('data-bv-ref', ref);
		}
		out.push({ ref, tag: el.tagName.toLowerCase(), role: implicitRole(el), name: accName(el) });
	}
	return out;
}

/** Stable identity line for a node — the unit the diff counts. */
export function nodeLine(node) {
	return `${node.tag}[${node.role}] "${node.name}"`;
}

/**
 * Pure multiset diff between two captures. Refs are ignored on purpose —
 * they are addressing, not content; re-snapshotting an unchanged page must
 * diff as zero changes.
 *
 * Shadow paths: nil input → named TypeError (callers must capture BOTH sides
 * before asking for proof); empty arrays are legal (blank page) and diff
 * normally.
 *
 * @param {{ tag: string, role: string, name: string }[]} before
 * @param {{ tag: string, role: string, name: string }[]} after
 * @returns {{ added: string[], removed: string[], changed: number }}
 */
export function diffSnapshots(before, after) {
	if (!Array.isArray(before) || !Array.isArray(after)) {
		const err = new TypeError(
			'diff-input-nil: diffSnapshots requires before AND after node arrays'
		);
		err.name = 'DiffInputNil';
		throw err;
	}
	const count = (nodes) => {
		const m = new Map();
		for (const n of nodes) {
			const line = nodeLine(n);
			m.set(line, (m.get(line) ?? 0) + 1);
		}
		return m;
	};
	const b = count(before);
	const a = count(after);
	const added = [];
	const removed = [];
	for (const [line, n] of a) {
		const delta = n - (b.get(line) ?? 0);
		for (let k = 0; k < delta; k++) added.push(line);
	}
	for (const [line, n] of b) {
		const delta = n - (a.get(line) ?? 0);
		for (let k = 0; k < delta; k++) removed.push(line);
	}
	return { added, removed, changed: added.length + removed.length };
}
