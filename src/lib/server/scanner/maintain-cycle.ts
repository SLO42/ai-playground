// TASK 11.5 — the UX-inspector loop in the maintain cycle (the loop the original app had).
//
// A schedulable + manually-triggerable UX INSPECTION pass over one project: it runs the
// pure ux-inspect detector (TASK 3.3) over the project's OWN UI source via the real
// static-analysis seam (ux-source.ts), then persists the `ux.*` findings as `security_finding`
// rows (the SAME §4.9 table the security + dependency scans use — 11.1's family convention:
// findings are categorized by rule prefix, NOT a parallel table). The findings then surface on
// the project Overview-Maintain panel (10.4) and roll up to /reports (11.1) with zero extra
// wiring — both read the shared table.
//
// D-004 (orchestration mode): a MANUAL trigger (the operator's button) is ALWAYS allowed. A
// PERIODIC / EVENT trigger is permitted ONLY when the configured mode is not "manual". The
// engine here is mode-AGNOSTIC (it records the trigger it was given); the GATE
// (`uxInspectionAllowed`) is enforced at the caller (the route action) — mirroring 11.4's
// pm-review split so a unit test can drive any trigger and the live policy is asserted at the
// boundary the operator hits.
//
// Path-confinement (D-018): the entry path-confines `dir` under CODE_ROOT via the reused
// scanner/registry confineToRoot (symlink + `..` resolved BEFORE the prefix check, fail-closed)
// BEFORE the static source reads any file. Boundary discipline (D-016): the project id is
// validated downstream by ux-repo (StringRecordId at the chokepoint).
//
// HONEST (F-008 / D-019): every finding is a real check of a real route file. A project with no
// SvelteKit UI yields `[]` (honest empty), and a clean inspection clears the live ux set
// without fabricating an issue. The browser-driven inspection variant is DEFERRED (see
// ux-source.ts) — the static pass is what runs here, and it is real.

import type { Db } from '../db/client';
import { confineToRoot } from './registry';
import { runUxInspection } from './ux-repo';
import { createStaticUxSource } from './ux-source';
import type { FindingRow } from './findings-repo';
import { loadOrchestration, type OrchMode } from '../config';

/** What kicked off a UX inspection — manual (button) vs scheduled (D-004). */
export type UxInspectionTrigger = 'manual' | 'periodic' | 'event';

export interface UxMaintainOptions {
	/** Confinement root (CODE_ROOT). The inspected dir must resolve under this (D-018). */
	codeRoot: string;
}

/**
 * The D-004 mode gate. A MANUAL trigger is always permitted; a non-manual (periodic/event)
 * trigger is permitted only when the orchestration mode is not "manual". Pure — the caller
 * supplies the live mode (read from orchestration.yaml). Mirrors 11.4's pm-review policy so
 * "manual mode" consistently means "button-triggered only" across the maintain surface.
 */
export function uxInspectionAllowed(trigger: UxInspectionTrigger, mode: OrchMode): boolean {
	if (trigger === 'manual') return true;
	return mode !== 'manual';
}

/**
 * Read the live orchestration mode for the D-004 gate, falling back to the most conservative
 * "manual" on any malformed/absent config (so a bad config never silently enables auto runs).
 */
export function readOrchestrationMode(configFile: string): OrchMode {
	try {
		return loadOrchestration(configFile).mode;
	} catch {
		return 'manual';
	}
}

/**
 * Run ONE UX-inspection pass over a project's own UI source. Path-confines `dir` under
 * CODE_ROOT (D-018), builds the real static-analysis inspection source over the project's
 * `src/routes`, runs the pure detector, scoped-soft-archives the project's stale ACTIVE `ux.*`
 * findings (D-015 — never touching its security/dependency findings), and persists the fresh
 * `ux.*` batch via the shared writeFindings(). Idempotent: re-inspecting replaces the live ux
 * set without losing history. Returns the freshly-written rows (F-008 — every one a real read
 * of a real route file). `trigger` is recorded by the caller's policy gate, not here.
 */
export async function runProjectUxInspection(
	db: Db,
	projectId: string,
	dir: string,
	opts: UxMaintainOptions
): Promise<FindingRow[]> {
	const rootPath = confineToRoot(dir, opts.codeRoot);
	const source = createStaticUxSource(rootPath);
	return runUxInspection(db, projectId, source);
}
