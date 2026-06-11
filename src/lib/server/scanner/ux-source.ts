// TASK 11.5 / 14.5 — static-analysis UX inspection source (the real seam for ux-inspect.ts).
//
// The UX inspector detector (ux-inspect.ts, TASK 3.3) is a pure function over a
// `UxInspectionSource.inspect()` seam — it never touches a browser. This module is the REAL
// implementation of that seam for a SvelteKit project: it walks the project's own
// `src/routes/**/+page.svelte` route source and STATICALLY analyses each into a `UxSnapshot`.
//
// WHAT THE STATIC VARIANT PERFORMS vs DEFERS (14.5 — the contract that keeps stored findings
// TRUE; a browser-driven PlaywrightUxSource drops into the SAME seam with zero detector change
// and performs everything):
//
//   PERFORMS (provable from source, layout-aware where rendering is layout-composed):
//   • missing-title    — LAYOUT-AWARE: a route renders inside its +layout.svelte ancestor
//                        chain, so an inherited <svelte:head><title> counts (14.5; per-page
//                        analysis alone fabricated false findings the rendered app disproved).
//   • missing-landmark — LAYOUT-AWARE: an inherited <main> (the app-shell pattern) counts.
//   • image-missing-alt / unlabeled-control — genuinely page-local markup checks.
//
//   PROVE-OR-SILENT (14.5 — F-008/D-038): missing-title/missing-landmark are only emitted
//   when ABSENCE IS PROVABLE — i.e. neither the page nor its layout chain supplies the
//   title/<main> AND the chain renders no opaque markup (component tags / <svelte:component> /
//   <svelte:element> / {@html}) that could supply it at render time. When absence is
//   unprovable the snapshot declares the check `unverifiable` and the detector emits NOTHING —
//   a finding the source cannot prove would be FALSE data, which is worse than no data.
//
//   DEFERS to the browser-driven variant (cannot be made truthful statically):
//   • low-contrast        — computed contrast needs a rendered page; the proxy is an honest 0,
//                           so the rule NEVER fires from this source.
//   • component interiors — issues INSIDE imported components (their images/buttons/landmarks)
//                           are invisible here: this source UNDER-reports them (an honest gap,
//                           never a false row).
//   • layout resets       — `+page@`/`+layout@` routes: reset pages are not discovered, and a
//                           reset layout's ancestors are still credited (over-credit ⇒ at worst
//                           a missed finding, never a fabricated one).
//
// WHY STATIC, NOT BROWSER (honest — F-008 / D-019): a full browser-driven inspection (drive a
// real Playwright headless run over the LIVE dashboard and read computed contrast/AT tree) is
// the richer signal, but it is INFEASIBLE to run reliably from inside this build env (F-014:
// agent-browser on Windows is flaky + would need a live dev server + auth) and would make the
// maintain-cycle step depend on a live server. So the maintain cycle runs this STATIC source —
// real findings from real source, deterministic, no browser, no network — and the
// browser-driven variant is recorded as DEFERRED (the seam is unchanged, so a future
// PlaywrightUxSource drops in with zero detector change). Every snapshot field here is a real
// read of a real route file — nothing fabricated.
//
// Path-confinement (D-018): callers path-confine the project dir under CODE_ROOT (the
// maintain-cycle entry does this via confineToRoot) BEFORE constructing this source.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type {
	UxInspectionSource,
	UxSnapshot,
	UxImage,
	UxControl,
	UxUnverifiableCheck
} from './ux-inspect';

/** Directories never worth walking for routes (vendored / build / vcs). */
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.svelte-kit',
	'coverage',
	'target'
]);

/** Max bytes of a single route file we read (skip pathological/generated files). */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Derive a SvelteKit route path from a `+page.svelte` file relative to `src/routes`.
 * `src/routes/+page.svelte` → "/"; `src/routes/reports/+page.svelte` → "/reports";
 * `src/routes/projects/[id]/+page.svelte` → "/projects/[id]". POSIX-normalized + stable.
 */
export function routePathFor(routesRoot: string, file: string): string {
	const rel = relative(routesRoot, file).split(sep).join('/');
	// Drop the trailing "+page.svelte" segment.
	const dir = rel.replace(/\/?\+page\.svelte$/, '');
	if (dir === '' || dir === '+page.svelte') return '/';
	return '/' + dir;
}

/**
 * Find every `+page.svelte` under `routesRoot` (bounded depth, skipping vendored dirs).
 * Returns absolute file paths, sorted for a deterministic snapshot order.
 */
function findRouteFiles(routesRoot: string, maxDepth = 12): string[] {
	const out: string[] = [];
	const walk = (d: string, depth: number): void => {
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return; // unreadable dir — skip, don't fail the whole inspection
		}
		for (const name of entries) {
			const child = join(d, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(child);
			} catch {
				continue; // broken symlink / race — skip
			}
			if (st.isDirectory()) {
				if (depth < maxDepth && !SKIP_DIRS.has(name.toLowerCase())) walk(child, depth + 1);
				continue;
			}
			if (st.isFile() && name === '+page.svelte' && st.size <= MAX_FILE_BYTES) out.push(child);
		}
	};
	walk(routesRoot, 0);
	out.sort();
	return out;
}

// ── Static markup extraction ────────────────────────────────────────────────────────
//
// These are deliberately small, high-signal regex heuristics over the route markup — NOT a
// full HTML/Svelte parser. They mirror exactly what the ux-inspect detector keys off, so the
// SAME rules a browser run would feed get fed from static source. Conservative: when a tag is
// dynamic (`alt={...}`, `aria-label={...}`) we treat the accessible name as PRESENT (the
// component supplies it at runtime) so we don't fabricate a false "missing alt" finding.

/** Strip `<script>` and `<style>` blocks so we only inspect the template markup. */
function templateOnly(src: string): string {
	return src
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '');
}

/** Extract the document title from `<svelte:head><title>…</title>` (static or dynamic). */
function extractTitle(src: string): string {
	const head = /<svelte:head>([\s\S]*?)<\/svelte:head>/i.exec(src);
	const scope = head ? head[1] : src;
	const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(scope);
	if (!m) return '';
	// A dynamic title (`{data.x}`) is a real title supplied at runtime — count it as present
	// (collapse to a non-empty marker). Otherwise use the literal text.
	const inner = m[1].trim();
	if (inner === '') return '';
	return inner.includes('{') ? '(dynamic)' : inner;
}

/** Collect `<img …>` tags with their resolved alt (dynamic alt ⇒ treated as present). */
function extractImages(tmpl: string): UxImage[] {
	const images: UxImage[] = [];
	const imgRe = /<img\b([^>]*?)\/?>/gi;
	let m: RegExpExecArray | null;
	while ((m = imgRe.exec(tmpl)) !== null) {
		const attrs = m[1];
		const srcM = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|\{[^}]*\})/i.exec(attrs);
		const src = srcM ? (srcM[1] ?? srcM[2] ?? '(dynamic)') : '';
		// alt present at all? `alt="x"`, `alt={...}`, or `alt` (empty/decorative is intentional).
		const altM = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|\{[^}]*\})/i.exec(attrs);
		const hasBareAlt = /\balt(\s|>|\/|$)/i.test(attrs) && !/\balt\s*=/.test(attrs);
		let alt = '';
		if (altM) {
			// A dynamic alt is supplied at runtime — count as present (non-empty marker).
			alt = altM[0].includes('{') ? '(dynamic)' : (altM[1] ?? altM[2] ?? '');
		} else if (hasBareAlt) {
			// Bare `alt` (decorative, intentionally empty) — treat as present so we don't flag it.
			alt = '(decorative)';
		}
		images.push({ src, alt });
	}
	return images;
}

/** ARIA landmark roles present (implicit `<main>/<nav>/<header>/<footer>` + explicit role=). */
function extractLandmarks(tmpl: string): string[] {
	const set = new Set<string>();
	if (/<main\b/i.test(tmpl)) set.add('main');
	if (/<nav\b/i.test(tmpl)) set.add('navigation');
	if (/<header\b/i.test(tmpl)) set.add('banner');
	if (/<footer\b/i.test(tmpl)) set.add('contentinfo');
	const roleRe = /\brole\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
	let m: RegExpExecArray | null;
	while ((m = roleRe.exec(tmpl)) !== null) {
		const role = (m[1] ?? m[2] ?? '').trim().toLowerCase();
		if (role) set.add(role);
	}
	return [...set];
}

/**
 * Collect `<button>` controls with their resolved accessible label. A button is labeled when
 * it has visible text content, an `aria-label`, an `aria-labelledby`, or a `title`. An
 * icon-only button with NONE of these is unlabeled (the screen-reader blocker we flag).
 */
function extractButtons(tmpl: string): UxControl[] {
	const out: UxControl[] = [];
	const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
	let m: RegExpExecArray | null;
	while ((m = btnRe.exec(tmpl)) !== null) {
		const attrs = m[1];
		const inner = m[2];
		const hasAria =
			/\baria-label\s*=/.test(attrs) ||
			/\baria-labelledby\s*=/.test(attrs) ||
			/\btitle\s*=/.test(attrs);
		// Visible text = inner content with tags + svelte blocks/expressions stripped.
		const text = inner
			.replace(/<[^>]*>/g, ' ')
			.replace(/\{[^}]*\}/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		const hasDynamicText = /\{[^}]*\}/.test(inner) && text === '';
		// A dynamic-only label (`{label}`) is a real runtime label — count as present.
		out.push({ label: hasAria || text !== '' || hasDynamicText ? text || '(labeled)' : '' });
	}
	return out;
}

/**
 * Markup the static pass cannot see into: component tags (capitalized / svelte:component /
 * svelte:element) and `{@html}` injection. Any of these could supply a title or a <main> at
 * render time, so their presence makes ABSENCE of title/landmark unprovable (14.5).
 * `{@render}` is NOT opaque: snippet bodies live in the same file (or are the page itself,
 * for a layout's `{@render children()}`), so their markup is already in the analysed set.
 */
function hasOpaqueMarkup(tmpl: string): boolean {
	return (
		/<[A-Z]/.test(tmpl) || /<svelte:(component|element)\b/i.test(tmpl) || /\{@html\b/.test(tmpl)
	);
}

/**
 * Resolve the route's LAYOUT CHAIN (14.5): every `+layout.svelte` / `+layout@*.svelte` from
 * the page's own directory up to (and including) `routesRoot`. A SvelteKit page renders
 * INSIDE these, so a title/<main> declared there is genuinely present on the rendered route —
 * per-page analysis that ignores them fabricates false missing-title/missing-landmark
 * findings. Returns absolute file paths, nearest layout first. Bounded by the same walk depth
 * as route discovery; a chain that wanders outside `routesRoot` stops (defensive).
 */
export function layoutChainFor(routesRoot: string, pageFile: string, maxDepth = 12): string[] {
	const chain: string[] = [];
	const root = resolve(routesRoot);
	let dir = dirname(resolve(pageFile));
	for (let i = 0; i <= maxDepth; i++) {
		if (!dir.startsWith(root)) break; // escaped the routes tree — stop (defensive)
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			// Unreadable dir — skip its layouts; the caller treats missing chain info honestly.
		}
		for (const name of entries.sort()) {
			if (/^\+layout(@[^.]*)?\.svelte$/.test(name)) chain.push(join(dir, name));
		}
		if (dir === root) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return chain;
}

/**
 * Build ONE snapshot for a single route file from its static source, resolving the route's
 * layout chain for the title/landmark checks (14.5). The `contrastIssues` proxy is HONESTLY
 * 0: computed-contrast measurement requires a real rendered page (the browser-driven
 * variant — deferred). We never invent a contrast count, so this static source simply
 * reports 0 and the contrast rule stays silent rather than fabricating a number.
 */
export function snapshotForRoute(routesRoot: string, file: string): UxSnapshot {
	const route = routePathFor(routesRoot, file);
	let src = '';
	try {
		src = readFileSync(file, 'utf8');
	} catch {
		// Unreadable — we cannot prove ANYTHING about this route. Declare the absence checks
		// unverifiable instead of fabricating missing-title/missing-landmark (14.5 — F-008).
		return {
			route,
			title: '',
			images: [],
			landmarks: [],
			buttons: [],
			contrastIssues: 0,
			unverifiable: ['title', 'landmark']
		};
	}
	const tmpl = templateOnly(src);

	// Layout-aware title + landmarks (14.5): the rendered route includes its layout chain, so
	// an inherited <svelte:head><title> / <main> counts as present. Opaque markup anywhere in
	// the chain (components, {@html}) makes ABSENCE unprovable — record that honestly.
	let title = extractTitle(src);
	const landmarks = new Set(extractLandmarks(tmpl));
	let opaque = hasOpaqueMarkup(tmpl);
	for (const layoutFile of layoutChainFor(routesRoot, file)) {
		let lsrc = '';
		try {
			const st = statSync(layoutFile);
			if (!st.isFile() || st.size > MAX_FILE_BYTES) {
				opaque = true; // a layout we will not read could supply title/main — unprovable
				continue;
			}
			lsrc = readFileSync(layoutFile, 'utf8');
		} catch {
			opaque = true;
			continue;
		}
		const ltmpl = templateOnly(lsrc);
		if (!title) title = extractTitle(lsrc);
		for (const role of extractLandmarks(ltmpl)) landmarks.add(role);
		if (hasOpaqueMarkup(ltmpl)) opaque = true;
	}

	// Prove-or-silent (14.5): only when the FULL statically-visible chain lacks the marker AND
	// contains opaque markup is the check unverifiable. A proven-present marker needs no flag;
	// a fully-transparent chain proves absence, so the finding is TRUE.
	const unverifiable: UxUnverifiableCheck[] = [];
	if (opaque) {
		if (!title) unverifiable.push('title');
		if (!landmarks.has('main')) unverifiable.push('landmark');
	}

	return {
		route,
		title,
		images: extractImages(tmpl),
		landmarks: [...landmarks],
		buttons: extractButtons(tmpl),
		// Static analysis cannot measure rendered contrast — honest 0 (browser variant deferred).
		contrastIssues: 0,
		...(unverifiable.length > 0 ? { unverifiable } : {})
	};
}

export interface StaticUxSourceOptions {
	/** Sub-path of route files relative to the project dir (default "src/routes"). */
	routesSubdir?: string;
}

/**
 * Construct a real, static-analysis {@link UxInspectionSource} over a project directory.
 * `projectDir` MUST already be path-confined under CODE_ROOT by the caller (D-018). When the
 * project has no `src/routes` (a non-SvelteKit project), `inspect()` returns `[]` honestly —
 * a project with no inspectable UI yields no UX findings rather than a fabricated one.
 */
export function createStaticUxSource(
	projectDir: string,
	opts: StaticUxSourceOptions = {}
): UxInspectionSource {
	const routesRoot = join(projectDir, opts.routesSubdir ?? 'src/routes');
	return {
		inspect(): UxSnapshot[] {
			let isDir = false;
			try {
				isDir = statSync(routesRoot).isDirectory();
			} catch {
				isDir = false;
			}
			if (!isDir) return []; // no SvelteKit routes → no UX surface to inspect (honest empty)
			return findRouteFiles(routesRoot).map((f) => snapshotForRoute(routesRoot, f));
		}
	};
}
