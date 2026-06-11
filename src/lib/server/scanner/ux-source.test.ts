import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticUxSource, routePathFor, snapshotForRoute } from './ux-source';
import { inspectUx } from './ux-inspect';

// TASK 11.5 UNIT — the static-analysis UX inspection source. It must read a SvelteKit
// project's own `src/routes/**/+page.svelte` and produce real UxSnapshots that, when fed to
// the pure inspectUx detector, yield the SAME family of ux.* findings a browser run would
// (missing title / image-missing-alt / unlabeled-control / missing-landmark). Honest (F-008):
// the contrast proxy is 0 (static cannot measure rendered contrast — browser variant deferred),
// and a project with no routes yields []. No DB, no browser, no network.

let root: string;
let routesRoot: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'v2-uxsrc-'));
	routesRoot = join(root, 'src', 'routes');
	mkdirSync(routesRoot, { recursive: true });

	// "/" — a clean page: titled, alt'd image, labeled button, has <main>.
	writeFileSync(
		join(routesRoot, '+page.svelte'),
		`<svelte:head><title>Home</title></svelte:head>
<main>
  <img src="/logo.png" alt="Company logo" />
  <button>Save</button>
</main>`
	);

	// "/broken" — every issue: no title, img missing alt, icon-only button, no main landmark.
	const broken = join(routesRoot, 'broken');
	mkdirSync(broken, { recursive: true });
	writeFileSync(
		join(broken, '+page.svelte'),
		`<section>
  <img src="/x.png" />
  <button><svg /></button>
</section>`
	);

	// "/dynamic" — dynamic accessible names must NOT be flagged (runtime supplies them).
	const dyn = join(routesRoot, 'dynamic');
	mkdirSync(dyn, { recursive: true });
	writeFileSync(
		join(dyn, '+page.svelte'),
		`<svelte:head><title>{data.name}</title></svelte:head>
<main>
  <img src={src} alt={altText} />
  <button aria-label="close">×</button>
  <button>{label}</button>
</main>`
	);

	// "/inherits" + "/inherits/deep" — 14.5 layout inheritance: the title and <main> live ONLY
	// in the section +layout.svelte; the pages themselves are bare. The rendered app HAS a
	// title and a main landmark on these routes, so the static source must credit the layout
	// chain instead of fabricating ux.missing-title / ux.missing-landmark.
	const inherits = join(routesRoot, 'inherits');
	mkdirSync(inherits, { recursive: true });
	writeFileSync(
		join(inherits, '+layout.svelte'),
		`<script>let { children } = $props();</script>
<svelte:head><title>Section shell</title></svelte:head>
<main>{@render children?.()}</main>`
	);
	writeFileSync(
		join(inherits, '+page.svelte'),
		`<section><p>The layout supplies the title and the main landmark.</p></section>`
	);
	const deep = join(inherits, 'deep');
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(deep, '+page.svelte'), `<p>Deep page — inherits through the chain.</p>`);

	// "/widget" — 14.5 prove-or-silent: the page renders a COMPONENT the static source cannot
	// see into; a component may supply the title/<main>, so absence is UNPROVABLE — the source
	// must NOT fabricate missing-title/missing-landmark. The page-LOCAL issue (img without alt)
	// is still provable and must still be flagged.
	const widget = join(routesRoot, 'widget');
	mkdirSync(widget, { recursive: true });
	writeFileSync(
		join(widget, '+page.svelte'),
		`<section><Widget /><img src="/w.png" /></section>`
	);

	// A vendored route that must be skipped entirely.
	const vendored = join(routesRoot, '..', '..', 'node_modules', 'pkg', 'src', 'routes');
	mkdirSync(vendored, { recursive: true });
	writeFileSync(join(vendored, '+page.svelte'), `<section><img src="/v.png" /></section>`);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('routePathFor — file → SvelteKit route path', () => {
	it('maps the root +page.svelte to "/"', () => {
		expect(routePathFor(routesRoot, join(routesRoot, '+page.svelte'))).toBe('/');
	});
	it('maps a nested route', () => {
		expect(routePathFor(routesRoot, join(routesRoot, 'broken', '+page.svelte'))).toBe('/broken');
	});
	it('preserves dynamic param segments', () => {
		expect(routePathFor(routesRoot, join(routesRoot, 'projects', '[id]', '+page.svelte'))).toBe(
			'/projects/[id]'
		);
	});
});

describe('snapshotForRoute — static markup extraction', () => {
	it('reads a clean page with no issues', () => {
		const s = snapshotForRoute(routesRoot, join(routesRoot, '+page.svelte'));
		expect(s.route).toBe('/');
		expect(s.title).toBe('Home');
		expect(s.images).toEqual([{ src: '/logo.png', alt: 'Company logo' }]);
		expect(s.landmarks).toContain('main');
		expect(s.buttons[0].label).not.toBe('');
		expect(s.contrastIssues).toBe(0); // static cannot measure contrast — honest 0
	});

	it('flags the issues on a broken page', () => {
		const s = snapshotForRoute(routesRoot, join(routesRoot, 'broken', '+page.svelte'));
		expect(s.title).toBe(''); // missing title
		expect(s.images[0].alt).toBe(''); // img missing alt
		expect(s.buttons[0].label).toBe(''); // icon-only, unlabeled
		expect(s.landmarks).not.toContain('main'); // no main landmark
	});

	it('treats dynamic accessible names as present (no false positives)', () => {
		const s = snapshotForRoute(routesRoot, join(routesRoot, 'dynamic', '+page.svelte'));
		expect(s.title).not.toBe(''); // {data.name} is a real runtime title
		expect(s.images[0].alt).not.toBe(''); // alt={altText} supplied at runtime
		expect(s.buttons.every((b) => b.label !== '')).toBe(true); // aria-label + {label}
	});
});

describe('layout-chain resolution (14.5) — inherited <title>/<main> count', () => {
	it('credits a title and main landmark supplied only by the route layout', () => {
		const s = snapshotForRoute(routesRoot, join(routesRoot, 'inherits', '+page.svelte'));
		expect(s.title).not.toBe(''); // <svelte:head><title> lives in +layout.svelte
		expect(s.landmarks).toContain('main'); // <main> lives in +layout.svelte
	});

	it('resolves the chain through nested ancestors', () => {
		const s = snapshotForRoute(routesRoot, join(routesRoot, 'inherits', 'deep', '+page.svelte'));
		expect(s.title).not.toBe('');
		expect(s.landmarks).toContain('main');
	});

	it('marks title/landmark UNVERIFIABLE (not missing) when a component may supply them', () => {
		const s = snapshotForRoute(routesRoot, join(routesRoot, 'widget', '+page.svelte'));
		// The static source cannot see inside <Widget /> — absence is unprovable, so it must
		// declare the checks unverifiable rather than report a false "missing".
		expect(s.unverifiable ?? []).toContain('title');
		expect(s.unverifiable ?? []).toContain('landmark');
	});

	it('still PROVES absence on a pure-HTML page (the check is not vacuous)', () => {
		const s = snapshotForRoute(routesRoot, join(routesRoot, 'broken', '+page.svelte'));
		// No layout above /broken supplies these and the page has no components — provable.
		expect(s.title).toBe('');
		expect(s.landmarks).not.toContain('main');
		expect(s.unverifiable ?? []).toEqual([]);
	});
});

describe('createStaticUxSource → inspectUx end-to-end (real source → real findings)', () => {
	it('skips vendored routes and produces the expected ux.* findings', () => {
		const source = createStaticUxSource(root);
		const snaps = source.inspect();
		const routes = snaps.map((s) => s.route).sort();
		// node_modules skipped; layout files are chain inputs, not routes.
		expect(routes).toEqual(['/', '/broken', '/dynamic', '/inherits', '/inherits/deep', '/widget']);

		const findings = inspectUx(source);
		const broken = findings.filter((f) => f.route === '/broken').map((f) => f.rule);
		expect(broken).toContain('ux.missing-title');
		expect(broken).toContain('ux.image-missing-alt');
		expect(broken).toContain('ux.unlabeled-control');
		expect(broken).toContain('ux.missing-landmark');
		// The clean + dynamic routes raise no findings (no false positives).
		expect(findings.filter((f) => f.route === '/').length).toBe(0);
		expect(findings.filter((f) => f.route === '/dynamic').length).toBe(0);
		// 14.5 — layout-supplied title/main: NO missing-title/missing-landmark fabricated.
		expect(findings.filter((f) => f.route === '/inherits').length).toBe(0);
		expect(findings.filter((f) => f.route === '/inherits/deep').length).toBe(0);
		// 14.5 — component may supply title/main: unverifiable checks stay SILENT, while the
		// provable page-local issue (img without alt) is still flagged.
		const widget = findings.filter((f) => f.route === '/widget').map((f) => f.rule);
		expect(widget).toEqual(['ux.image-missing-alt']);
		// No contrast findings ever from the static source (proxy is 0 — honest).
		expect(findings.some((f) => f.rule === 'ux.low-contrast')).toBe(false);
	});

	it('returns [] honestly for a project with no src/routes', () => {
		const empty = mkdtempSync(join(tmpdir(), 'v2-uxsrc-empty-'));
		try {
			expect(createStaticUxSource(empty).inspect()).toEqual([]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
