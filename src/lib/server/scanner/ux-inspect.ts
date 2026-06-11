// TASK 3.3 — UX inspector (pure detector; ARCHITECTURE §2.7 / PRODUCT job 4 / ROADMAP 3.3).
//
// Pure UX inspection: given an inspector SNAPSHOT of each route (the structured input a
// real browser/Playwright run would produce — page title, images+alt, ARIA landmarks,
// control labels, contrast-issue count), apply a small, high-signal heuristic rule set and
// emit `ux.*` findings against the DATA-MODEL §4.9 severity enum. UX findings ARE security
// findings on the Maintain surface (UI-SPEC §162/§190/§207), so each finding reuses the
// SecurityFinding shape — writeFindings/listFindings persist + serve them UNCHANGED, riding
// the same `security_finding` table the security + dependency scans use (no schema change;
// the route lives in the reused `file` column, the issue text in `detail`).
//
// NO database, NO process spawn, NO BROWSER — the detector consults the injected
// UxInspectionSource seam and nothing else. Spinning up a real headless browser to PRODUCE
// the snapshots is the CALLER's job (the seam), so the detector stays deterministic +
// testable with a mocked snapshot, and the live-browser run is deferred to the seam impl.
// Mirrors the security.ts / dependencies.ts split (pure detector + db-backed registry).
//
// F-008: every finding is a real check of a real snapshot field — nothing fabricated. The
// snapshots themselves come from a real inspection at runtime (the seam), never invented.

import type { SecurityFinding, Severity } from './security';

/** One image observed on a route (the inspector reports its src + resolved alt text). */
export interface UxImage {
	src: string;
	/** Resolved accessible alt text ("" = missing/empty — flagged). */
	alt: string;
}

/** One interactive control observed on a route. */
export interface UxControl {
	/** Accessible label (visible text or aria-label). "" = unlabeled (icon-only) — flagged. */
	label: string;
}

/**
 * A check the PRODUCING source could not truthfully evaluate for a route (14.5).
 * `title` ⇒ skip ux.missing-title; `landmark` ⇒ skip ux.missing-landmark.
 */
export type UxUnverifiableCheck = 'title' | 'landmark';

/**
 * A structured snapshot of a single route, as a real browser inspection would produce it.
 * This is the inspector INPUT — keeping it a plain serializable shape means the same
 * detector runs over a live Playwright snapshot or a mocked one with zero code change.
 */
export interface UxSnapshot {
	/** The route path inspected (e.g. "/dash") — stored in the finding's `file` column. */
	route: string;
	/** The document title (`<title>` / accessible name). "" = missing — flagged. */
	title: string;
	images: UxImage[];
	/** ARIA landmark roles present on the page (e.g. "main", "nav"). */
	landmarks: string[];
	buttons: UxControl[];
	/** Count of computed-contrast failures the inspector measured (0 = none). */
	contrastIssues: number;
	/**
	 * Checks the producing source could NOT truthfully evaluate for this route (14.5 —
	 * F-008/D-038): e.g. the static source cannot prove a title/<main> ABSENT when an
	 * imported component might supply it at render time. The detector emits NO finding for
	 * an unverifiable check — a finding it cannot prove would be fabricated (false) data.
	 * A browser-driven source (PlaywrightUxSource) omits this entirely: it observes the
	 * RENDERED page, so every check is verifiable there.
	 */
	unverifiable?: UxUnverifiableCheck[];
}

/**
 * The inspection seam. An implementation drives a REAL headless browser (Playwright) over
 * the running dashboard and returns one UxSnapshot per route. A test supplies a mocked set.
 * The detector never calls anything but this — so the browser is the seam's concern, the
 * detector's purity is preserved, and the live-browser run is a deferred-live-proof detail.
 */
export interface UxInspectionSource {
	inspect(): UxSnapshot[];
}

/** A UX-inspection finding — a SecurityFinding plus the route it was observed on. */
export interface UxFinding extends SecurityFinding {
	/** The route path (duplicated from `file` for typed convenience; same value). */
	route: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * Inspect every snapshot the source returns and emit `ux.*` findings. PURE — no I/O beyond
 * the injected `source.inspect()`. Tolerant: a source returning `[]` (or a snapshot with
 * empty collections) yields `[]` rather than throwing. Findings are sorted severity
 * (critical→low) then by route then rule for a stable Maintain-surface ordering.
 */
export function inspectUx(source: UxInspectionSource): UxFinding[] {
	const snapshots = source.inspect() ?? [];
	const findings: UxFinding[] = [];

	for (const s of snapshots) {
		const route = s.route;
		const add = (rule: string, severity: Severity, detail: string): void => {
			findings.push({ rule, severity, file: route, line: 1, detail, route });
		};
		// Checks the source declared it cannot truthfully evaluate (14.5): SKIP them — no
		// finding, not a hedged one. Wrong data is wrong (F-008/D-038).
		const unverifiable = new Set(s.unverifiable ?? []);

		// (1) Missing page title — orientation + a11y (medium).
		if (!unverifiable.has('title') && (!s.title || s.title.trim() === '')) {
			add('ux.missing-title', 'medium', `Route ${route} has no page title.`);
		}

		// (2) Images without alt text — accessibility blocker (high). Count, don't spam one
		// finding per image; the count + route is enough to act on.
		const noAlt = (s.images ?? []).filter((img) => !img.alt || img.alt.trim() === '').length;
		if (noAlt > 0) {
			add(
				'ux.image-missing-alt',
				'high',
				`Route ${route} has ${noAlt} of ${s.images.length} image(s) missing alt text.`
			);
		}

		// (3) Unlabeled (icon-only) controls — screen-reader blocker (high).
		const unlabeled = (s.buttons ?? []).filter((b) => !b.label || b.label.trim() === '').length;
		if (unlabeled > 0) {
			add(
				'ux.unlabeled-control',
				'high',
				`Route ${route} has ${unlabeled} control(s) without an accessible label.`
			);
		}

		// (4) Missing main landmark — keyboard/AT navigation (medium).
		const landmarks = s.landmarks ?? [];
		if (!unverifiable.has('landmark') && !landmarks.includes('main')) {
			add('ux.missing-landmark', 'medium', `Route ${route} has no "main" ARIA landmark.`);
		}

		// (5) Contrast failures — readability (medium, escalates to high past a threshold).
		const c = s.contrastIssues ?? 0;
		if (c > 0) {
			add(
				'ux.low-contrast',
				c > 10 ? 'high' : 'medium',
				`Route ${route} has ${c} element(s) failing contrast checks.`
			);
		}
	}

	findings.sort((a, b) => {
		const sv = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
		if (sv !== 0) return sv;
		const r = a.route.localeCompare(b.route);
		return r !== 0 ? r : a.rule.localeCompare(b.rule);
	});
	return findings;
}
