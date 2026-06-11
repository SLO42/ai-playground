import { describe, it, expect } from 'vitest';
import { inspectUx, type UxInspectionSource, type UxSnapshot } from './ux-inspect';

// TASK 3.3 VERIFY (pure detector) — given an inspector SNAPSHOT of a route (the input a
// real browser/Playwright would produce, MOCKED here per the no-live-externals standing
// rule), the pure detector flags UX issues as `ux.*` findings with a §4.9 severity. The
// detector does NO I/O of its own (no DB, no spawn, no browser) — it consults the injected
// UxInspectionSource seam, so the live-browser run is the caller's job and the logic stays
// deterministic + testable. F-008: every finding is a real check of a real snapshot field.

/** A deterministic, fully-mocked inspector source standing in for a real browser run. */
function mockSource(snapshots: UxSnapshot[]): UxInspectionSource {
	return { inspect: () => snapshots };
}

describe('§3.3 inspectUx — pure UX detector', () => {
	it('flags a missing page title (medium)', () => {
		const src = mockSource([
			{ route: '/dash', title: '', images: [], landmarks: ['main'], buttons: [], contrastIssues: 0 }
		]);
		const findings = inspectUx(src);
		const rules = findings.map((f) => f.rule);
		expect(rules).toContain('ux.missing-title');
		const t = findings.find((f) => f.rule === 'ux.missing-title')!;
		expect(t.severity).toBe('medium');
		expect(t.file).toBe('/dash'); // route rides in the reused `file` column
	});

	it('flags images without alt text (high — accessibility)', () => {
		const src = mockSource([
			{
				route: '/gallery',
				title: 'Gallery',
				images: [
					{ src: '/a.png', alt: 'a chart' },
					{ src: '/b.png', alt: '' },
					{ src: '/c.png', alt: '' }
				],
				landmarks: ['main'],
				buttons: [{ label: 'Close' }],
				contrastIssues: 0
			}
		]);
		const findings = inspectUx(src);
		const f = findings.find((x) => x.rule === 'ux.image-missing-alt')!;
		expect(f).toBeDefined();
		expect(f.severity).toBe('high');
		expect(f.detail).toContain('2'); // 2 of 3 images missing alt
	});

	it('flags an unlabeled (icon-only) control (high)', () => {
		const src = mockSource([
			{
				route: '/settings',
				title: 'Settings',
				images: [],
				landmarks: ['main'],
				buttons: [{ label: 'Save' }, { label: '' }],
				contrastIssues: 0
			}
		]);
		const findings = inspectUx(src);
		expect(findings.map((f) => f.rule)).toContain('ux.unlabeled-control');
	});

	it('flags a missing main landmark (medium)', () => {
		const src = mockSource([
			{ route: '/x', title: 'X', images: [], landmarks: ['nav'], buttons: [], contrastIssues: 0 }
		]);
		const findings = inspectUx(src);
		expect(findings.map((f) => f.rule)).toContain('ux.missing-landmark');
	});

	it('flags contrast issues with severity scaling by count', () => {
		const src = mockSource([
			{ route: '/y', title: 'Y', images: [], landmarks: ['main'], buttons: [], contrastIssues: 12 }
		]);
		const f = inspectUx(src).find((x) => x.rule === 'ux.low-contrast')!;
		expect(f).toBeDefined();
		expect(f.severity).toBe('high'); // >10 contrast hits escalates to high
	});

	it('a clean route produces NO findings (no false positives)', () => {
		const src = mockSource([
			{
				route: '/ok',
				title: 'All good',
				images: [{ src: '/ok.png', alt: 'fine' }],
				landmarks: ['main', 'nav'],
				buttons: [{ label: 'Go' }],
				contrastIssues: 0
			}
		]);
		expect(inspectUx(src)).toEqual([]);
	});

	it('sorts findings critical→low then by route', () => {
		const src = mockSource([
			{ route: '/b', title: 'B', images: [], landmarks: ['main'], buttons: [], contrastIssues: 3 },
			{
				route: '/a',
				title: '',
				images: [{ src: '/x', alt: '' }],
				landmarks: [],
				buttons: [],
				contrastIssues: 0
			}
		]);
		const findings = inspectUx(src);
		// First finding is the highest severity (image-missing-alt = high).
		expect(findings[0].severity).toBe('high');
		// Severity is monotonically non-increasing.
		const order = { critical: 3, high: 2, medium: 1, low: 0 } as const;
		for (let i = 1; i < findings.length; i++) {
			expect(order[findings[i - 1].severity]).toBeGreaterThanOrEqual(order[findings[i].severity]);
		}
	});

	it('an inspector that returns no snapshots yields no findings (never throws)', () => {
		expect(inspectUx(mockSource([]))).toEqual([]);
	});

	it('emits NO finding for a check the source declared unverifiable (14.5 — F-008)', () => {
		// A source that cannot truthfully evaluate a check (e.g. the static source when a
		// component may supply the title/main) declares it unverifiable; a finding it cannot
		// prove would be fabricated data, so the detector stays silent for that rule only.
		const src = mockSource([
			{
				route: '/maybe',
				title: '',
				images: [{ src: '/m.png', alt: '' }],
				landmarks: [],
				buttons: [],
				contrastIssues: 0,
				unverifiable: ['title', 'landmark']
			}
		]);
		const rules = inspectUx(src).map((f) => f.rule);
		expect(rules).not.toContain('ux.missing-title');
		expect(rules).not.toContain('ux.missing-landmark');
		// Verifiable checks on the same snapshot still fire.
		expect(rules).toContain('ux.image-missing-alt');
	});
});
