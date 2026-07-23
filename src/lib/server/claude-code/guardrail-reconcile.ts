// CCH-2 (CLAUDE-CODE-HARNESS-SPEC §5) — WIRE the D-024 PRIMARY guardrail boundary.
//
// `writeProjectGuardrails` (guardrails.ts) authors the per-project `.claude/settings.json`
// carrying Claude Code's OWN `permissions.deny` rules — the boundary Claude Code enforces
// LOCALLY, even with THIS server down (guardrails.ts §5-7). It is the PRIMARY D-024 boundary;
// the runtime's network PreToolUse/canUseTool gate (gates.ts, composed onto every spawn's
// isolated config) is defense-in-depth ON TOP of it. The primary boundary had NO production
// caller — the settings.json file was NEVER written to any project root — so a spawn relied on
// the network gate alone (which does not hold with the server down). This module + the
// scanProject registration hook + the boot call in hooks.server.ts close that gap.
//
// This module owns the BOOT-TIME RECONCILE: seed/refresh the guardrail for EVERY registered
// project (so a project registered BEFORE this seam existed is covered too), BEFORE the
// orchestrator can drive a spawn. Reads the DB (listProjects) + writes fs, so it lives HERE —
// NOT in guardrails.ts, which is deliberately pure (no DB, no server) so its guarantee holds
// with everything else down.
//
// SHADOW PATHS + honest failure (F-014): a project row whose root_path no longer exists (moved/
// deleted) is SKIPPED with a named warning — never a fabricated `.claude/` phantom tree under a
// non-existent path (writeProjectGuardrails' mkdirSync would otherwise materialize one). An
// unwritable root logs a named warning and is skipped. NEITHER crashes boot. Idempotent +
// merge-preserving (writeProjectGuardrails unions the deny list into any existing file), so a
// hand-edited settings.json is never clobbered and a re-run adds nothing.

import { statSync } from 'node:fs';
import type { Db } from '../db/client';
import { listProjects } from '../projects/repo';
import { isPlatformSelfRoot, resolveConfinedTarget, writeProjectGuardrails } from './guardrails';

export interface GuardrailReconcileResult {
	/** How many projects had their `.claude/settings.json` guardrail seeded/refreshed. */
	seeded: number;
	/** How many projects were skipped (root missing/not a directory, or a write error). */
	skipped: number;
	/**
	 * How many projects were INTENTIONALLY exempted — the platform's own self-host worktree
	 * (D-040): seeding the D-024 guardrail there would self-clamp the control-plane repo
	 * (CCH-2 red-team fix). An exemption is a deliberate no-op, NOT a fault (distinct from skipped).
	 */
	exempted: number;
	/** One NAMED line per skipped/exempted project (paths only — no secrets; F-008 honest). */
	warnings: string[];
}

/**
 * Seed/refresh the D-024 PRIMARY guardrail (`.claude/settings.json` `permissions.deny`) for every
 * REGISTERED project. Idempotent (merge-preserving) and best-effort per project (F-014): a per-
 * project fault logs a named warning and is skipped — it NEVER throws out (so one bad project root
 * can't sink the whole reconcile) and NEVER crashes boot.
 *
 * A `listProjects` DB failure DOES propagate (the caller in hooks.server.ts try/catches it into an
 * honest degraded-boot warning) — we do not fabricate an empty project list on a read error (F-008).
 *
 * The platform's OWN self-host worktree (D-040) is EXEMPTED, never seeded — writing the guardrail
 * there would self-clamp the control-plane repo Atelier runs from (CCH-2 red-team fix).
 *
 * @param db the runtime DB (least-priv) — read-only here (listProjects).
 * @param opts.codeRoot the CODE_ROOT the guardrail's config-protection spans (carried onto the
 *        GuardrailInput; the deny globs are already code-root-agnostic, with a leading recursive
 *        glob, so they bite anywhere under any project root).
 * @param opts.selfRoot the platform's own worktree to EXEMPT (defaults to process.cwd() — the dir
 *        the server booted from). Injectable for tests.
 */
export async function reconcileProjectGuardrails(
	db: Db,
	opts: { codeRoot: string; selfRoot?: string }
): Promise<GuardrailReconcileResult> {
	const projects = await listProjects(db);
	let seeded = 0;
	let skipped = 0;
	let exempted = 0;
	const warnings: string[] = [];

	for (const p of projects) {
		const root = p.root_path;
		// SELF-HOST EXEMPTION (CCH-2 red-team fix): a project row whose root IS the platform's own
		// worktree (or an ancestor containing it) must NOT be guarded — seeding .claude/settings.json
		// there self-clamps the control-plane repo Atelier runs from (denies git push / .claude reads /
		// --force + disableBypassPermissionsMode, self-re-injecting every boot). Intentional no-op,
		// counted honestly as `exempted` (NOT a fault-skip). Checked BEFORE statSync so an existing
		// self-root is never written.
		if (root && isPlatformSelfRoot(root, opts.selfRoot)) {
			exempted++;
			warnings.push(
				`[startup] guardrail reconcile: EXEMPT ${p.id} — root is the platform's own self-host worktree (${root}); ` +
					`not seeding a self-clamping .claude/settings.json into the control-plane repo (D-040/CCH-2). Intentional, not a fault.`
			);
			continue;
		}
		// Shadow path (missing/moved root): a project row can outlive its directory. Guard existence
		// BEFORE writeProjectGuardrails, whose recursive mkdirSync would otherwise CREATE a phantom
		// `<root>/.claude` tree under a path that no longer exists (F-008 — never fabricate state).
		let isDir = false;
		try {
			isDir = statSync(root).isDirectory();
		} catch {
			isDir = false;
		}
		if (!root || !isDir) {
			skipped++;
			warnings.push(
				`[startup] guardrail reconcile: SKIP ${p.id} — root_path is not an existing directory (${root || '(empty)'}); the runtime network gate still applies (F-014).`
			);
			continue;
		}
		// RE-CONFINE under CODE_ROOT (SF2-4b): scanProject confines a scan target at REGISTRATION,
		// but a `project` row can outlive/predate that seam (moved dir, imported/hand-edited row) and
		// carry a root_path that now escapes CODE_ROOT. Re-apply the D-018 confinement HERE, fail
		// CLOSED: a root resolving OUTSIDE CODE_ROOT (after symlink + `..` normalization) is SKIPPED —
		// never seed a guardrail whose `additionalDirectories` would grant an agent fs access outside
		// the code root. Checked AFTER the existence gate so a missing root is skipped as such first.
		try {
			resolveConfinedTarget(root, opts.codeRoot);
		} catch (err) {
			skipped++;
			warnings.push(
				`[startup] guardrail reconcile: SKIP ${p.id} — root_path escapes CODE_ROOT, re-confined fail-closed (${(err as Error).message}); not seeding a guardrail outside the code root. The runtime network gate still applies (F-014).`
			);
			continue;
		}
		try {
			writeProjectGuardrails({ projectRoot: root, codeRoot: opts.codeRoot });
			seeded++;
		} catch (err) {
			skipped++;
			warnings.push(
				`[startup] guardrail reconcile: SKIP ${p.id} — could not write ${root}/.claude/settings.json (${(err as Error).message}); the runtime network gate still applies (F-014).`
			);
		}
	}

	return { seeded, skipped, exempted, warnings };
}
