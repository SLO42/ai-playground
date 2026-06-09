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

describe('createStaticUxSource → inspectUx end-to-end (real source → real findings)', () => {
	it('skips vendored routes and produces the expected ux.* findings', () => {
		const source = createStaticUxSource(root);
		const snaps = source.inspect();
		const routes = snaps.map((s) => s.route).sort();
		expect(routes).toEqual(['/', '/broken', '/dynamic']); // node_modules skipped

		const findings = inspectUx(source);
		const broken = findings.filter((f) => f.route === '/broken').map((f) => f.rule);
		expect(broken).toContain('ux.missing-title');
		expect(broken).toContain('ux.image-missing-alt');
		expect(broken).toContain('ux.unlabeled-control');
		expect(broken).toContain('ux.missing-landmark');
		// The clean + dynamic routes raise no findings (no false positives).
		expect(findings.filter((f) => f.route === '/').length).toBe(0);
		expect(findings.filter((f) => f.route === '/dynamic').length).toBe(0);
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
