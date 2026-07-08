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
import { writeProjectGuardrails } from './guardrails';

export interface GuardrailReconcileResult {
	/** How many projects had their `.claude/settings.json` guardrail seeded/refreshed. */
	seeded: number;
	/** How many projects were skipped (root missing/not a directory, or a write error). */
	skipped: number;
	/** One NAMED warning per skipped project (paths only — no secrets; F-008 honest). */
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
 * @param db the runtime DB (least-priv) — read-only here (listProjects).
 * @param opts.codeRoot the CODE_ROOT the guardrail's config-protection spans (carried onto the
 *        GuardrailInput; the deny globs are already code-root-agnostic, with a leading recursive
 *        glob, so they bite anywhere under any project root).
 */
export async function reconcileProjectGuardrails(
	db: Db,
	opts: { codeRoot: string }
): Promise<GuardrailReconcileResult> {
	const projects = await listProjects(db);
	let seeded = 0;
	let skipped = 0;
	const warnings: string[] = [];

	for (const p of projects) {
		const root = p.root_path;
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

	return { seeded, skipped, warnings };
}
