// TASK 10.3 — write side of `config/orchestration.yaml` (D-004 / D-010 / D-020).
//
// load.ts gives the READ + boundary VALIDATION side (loadOrchestration / validateBundles).
// This module is the WRITE side the /settings page drives: change the orchestration MODE
// (manual | event | periodic — D-004) and the trigger/interval knobs, persisting the file.
//
// The D-010 contract for a SENSITIVE config write is enforced at every step — the SAME
// validate → diff → CONFIRM → write shape cc-config/write.ts uses for Claude Code files:
//
//   • planOrchestrationWrite(...) — apply the proposed change to the parsed config IN MEMORY,
//        re-validate it through loadOrchestration's boundary checks, render the new YAML, and
//        compute a line diff vs what is on disk RIGHT NOW. PURE: no write. Returns a confirm
//        token bound to the exact on-disk bytes it diffed.
//   • applyOrchestrationWrite(...) — the CONFIRM. Re-validates, asserts the file STILL matches
//        the token (StaleConfirmError if a hand-edit landed since the diff — never silently
//        clobbered), then writes the file. The orchestrator reads `mode` ONCE per boot
//        (boot.ts: "a config re-edit takes effect on the next boot"), so the write persists
//        but the RUNNING orchestrator only reflects it after a restart — the /settings UI says
//        so honestly (it compares the running mode to the configured mode).
//
// Boundary discipline: the proposed change is validated through the SAME loadOrchestration
// (via the `_inject` test seam) BEFORE any byte hits disk — an out-of-enum mode or a malformed
// interval is rejected loudly, never written. We preserve every other key in the file (bundles,
// concurrency, comments are lost on a YAML round-trip — see renderOrchestration's note) so a
// mode flip never drops the operator's tuned routing bundles.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import {
	ORCH_MODES,
	DEFAULT_PROVIDERS,
	loadOrchestration,
	type OrchMode,
	type DefaultProvider,
	type Orchestration
} from './load';

/** Thrown when applyOrchestrationWrite is called but the file changed since the diff (D-010). */
export class StaleConfirmError extends Error {
	override readonly name = 'StaleConfirmError';
	constructor(
		message: string,
		readonly filePath: string
	) {
		super(message);
	}
}

/** Thrown when a proposed orchestration change fails boundary validation (defense in depth). */
export class OrchestrationWriteError extends Error {
	override readonly name = 'OrchestrationWriteError';
	constructor(message: string) {
		super(message);
	}
}

/** The operator-editable orchestration knobs (D-004). All optional → an absent knob is unchanged. */
export interface OrchestrationChange {
	/** The drain mode — manual | event | periodic (D-004). */
	mode?: OrchMode;
	/** Trigger names (event/periodic only); an empty list is valid (drains on manual only). */
	triggers?: string[];
	/** Periodic sweep interval in ms (periodic mode); must be a positive integer when set. */
	intervalMs?: number;
	/**
	 * MODEL-BENCHMARK-SPEC step 1 — the GLOBAL default-provider override (auto | local | cloud).
	 * A SENSITIVE routing write: it changes which provider every orchestrator-routed spawn runs on.
	 */
	defaultProvider?: DefaultProvider;
}

/** A unified per-line diff of the file's current bytes vs the proposed bytes (review surface). */
export interface OrchestrationDiff {
	filePath: string;
	/** True if the proposed content is byte-identical to disk (a no-op write). */
	unchanged: boolean;
	hunks: Array<{ op: '+' | '-' | ' '; line: string }>;
	/** sha256 of the bytes currently on disk at plan time — the confirm token. */
	currentDigest: string;
}

export interface OrchestrationPlan {
	filePath: string;
	/** The proposed full file content (validated, ready to write on confirm). */
	proposed: string;
	diff: OrchestrationDiff;
	/** The confirm token applyOrchestrationWrite requires — binds confirm to the diffed bytes. */
	confirmToken: string;
	/** The mode the proposed config carries (for the UI summary). */
	mode: OrchMode;
}

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Read a file's current bytes, or '' if it does not exist. */
function readCurrent(filePath: string): string {
	try {
		return readFileSync(filePath, 'utf8');
	} catch {
		return '';
	}
}

/**
 * A minimal line-level LCS diff of `current` vs `proposed` (mirrors cc-config/write.ts diffLines).
 * Faithful add/remove/context view — enough for the operator to review the exact change (D-010).
 */
function diffLines(current: string, proposed: string): OrchestrationDiff['hunks'] {
	const a = current === '' ? [] : current.split('\n');
	const b = proposed === '' ? [] : proposed.split('\n');
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const hunks: OrchestrationDiff['hunks'] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			hunks.push({ op: ' ', line: a[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			hunks.push({ op: '-', line: a[i] });
			i++;
		} else {
			hunks.push({ op: '+', line: b[j] });
			j++;
		}
	}
	while (i < n) hunks.push({ op: '-', line: a[i++] });
	while (j < m) hunks.push({ op: '+', line: b[j++] });
	return hunks;
}

/** Validate the SHAPE of a proposed change at the boundary (D-016 discipline) before merge. */
function assertChange(change: OrchestrationChange): void {
	if (change.mode !== undefined && !(ORCH_MODES as readonly string[]).includes(change.mode)) {
		throw new OrchestrationWriteError(
			`mode must be one of ${ORCH_MODES.join(' | ')} (got ${String(change.mode)})`
		);
	}
	if (change.triggers !== undefined) {
		if (!Array.isArray(change.triggers) || change.triggers.some((t) => typeof t !== 'string')) {
			throw new OrchestrationWriteError('triggers must be a list of strings');
		}
	}
	if (change.intervalMs !== undefined) {
		if (!Number.isInteger(change.intervalMs) || change.intervalMs < 1) {
			throw new OrchestrationWriteError('intervalMs must be a positive integer');
		}
	}
	if (
		change.defaultProvider !== undefined &&
		!(DEFAULT_PROVIDERS as readonly string[]).includes(change.defaultProvider)
	) {
		throw new OrchestrationWriteError(
			`defaultProvider must be one of ${DEFAULT_PROVIDERS.join(' | ')} (got ${String(change.defaultProvider)})`
		);
	}
}

/**
 * Render an Orchestration object to YAML, preserving key order so the diff is readable. A YAML
 * round-trip DOES drop the file's comments — acceptable here because the orchestration knobs are
 * a small, self-describing set and the /settings UI is the authored surface; the operator who
 * needs the doc-comments can still hand-edit. Bundles/concurrency are preserved verbatim (we
 * merge onto the PARSED config, never a fresh object) so a mode flip never drops tuned routing.
 */
function renderOrchestration(orch: Orchestration): string {
	// Project an ordered plain object so the most-edited knobs lead the file.
	const ordered: Record<string, unknown> = { mode: orch.mode };
	if (orch.triggers !== undefined) ordered.triggers = orch.triggers;
	if (orch.intervalMs !== undefined) ordered.intervalMs = orch.intervalMs;
	if (orch.defaultProvider !== undefined) ordered.defaultProvider = orch.defaultProvider;
	ordered.concurrency = orch.concurrency;
	if (orch.bundles !== undefined) ordered.bundles = orch.bundles;
	// Carry any forward-compat keys the loader round-tripped but doesn't model.
	for (const [k, v] of Object.entries(orch)) {
		if (!(k in ordered)) ordered[k] = v;
	}
	return yaml.dump(ordered, { lineWidth: 100, noRefs: true });
}

export interface PlanInput {
	/** Absolute path to orchestration.yaml. */
	filePath: string;
	/** The proposed knob change(s). */
	change: OrchestrationChange;
}

/**
 * Step 1 of the D-010 write contract: VALIDATE + DIFF. Loads the CURRENT config from disk,
 * merges the proposed change onto it, re-renders YAML, re-validates the rendered YAML through
 * loadOrchestration's boundary checks (so a bad merge is caught BEFORE the confirm), and diffs
 * the rendered bytes vs disk. Pure — no write. The confirmToken is the sha256 of the current
 * on-disk bytes; applyOrchestrationWrite refuses unless the file still matches it (no silent
 * clobber of a hand-edit landing between plan and confirm).
 */
export function planOrchestrationWrite(input: PlanInput): OrchestrationPlan {
	assertChange(input.change);

	// Load + boundary-validate the CURRENT config (throws ConfigError on a malformed file — we
	// refuse to write on top of an unparseable config rather than overwrite it blind).
	const current = loadOrchestration(input.filePath);
	const next: Orchestration = { ...current };
	if (input.change.mode !== undefined) next.mode = input.change.mode;
	if (input.change.triggers !== undefined) next.triggers = input.change.triggers;
	if (input.change.intervalMs !== undefined) next.intervalMs = input.change.intervalMs;
	if (input.change.defaultProvider !== undefined) next.defaultProvider = input.change.defaultProvider;

	const proposed = renderOrchestration(next);

	// Defense in depth: re-validate the RENDERED YAML through the SAME boundary the loader uses,
	// via its `_inject` seam (parse the rendered text, validate it). A render that somehow
	// produced an invalid config is caught here, before the operator can confirm it.
	const reparsed = yaml.load(proposed);
	loadOrchestration(input.filePath, { _inject: reparsed as Record<string, unknown> });

	const currentBytes = readCurrent(input.filePath);
	const currentDigest = sha256(currentBytes);
	return {
		filePath: input.filePath,
		proposed,
		diff: {
			filePath: input.filePath,
			unchanged: currentBytes === proposed,
			hunks: diffLines(currentBytes, proposed),
			currentDigest
		},
		confirmToken: currentDigest,
		mode: next.mode
	};
}

export interface ApplyInput {
	filePath: string;
	/** The proposed full file content from the plan the operator reviewed. */
	proposed: string;
	/** The confirm token from planOrchestrationWrite. MANDATORY (D-010). */
	confirmToken: string;
}

export interface ApplyResult {
	filePath: string;
	bytesWritten: number;
	/** The mode the written file carries (for the UI confirmation + live-reflect compare). */
	mode: OrchMode;
}

/**
 * Step 2 of the D-010 write contract: the CONFIRM. Re-validates the proposed bytes through the
 * loader boundary (never trust that the plan's bytes are still valid), asserts the file on disk
 * STILL matches the confirm token (StaleConfirmError otherwise — "never silently overwrite a
 * hand-edit", D-010), then writes. The RUNNING orchestrator reads `mode` per-boot, so this write
 * persists immediately but the live drain only reflects it after a restart — surfaced honestly
 * by the /settings page (running-vs-configured compare).
 */
export function applyOrchestrationWrite(input: ApplyInput): ApplyResult {
	if (!input.confirmToken) {
		throw new OrchestrationWriteError('missing confirm token — re-review the diff (D-010)');
	}
	// Re-validate the bytes we are about to write (defense in depth).
	let reparsed: unknown;
	try {
		reparsed = yaml.load(input.proposed);
	} catch (err) {
		throw new OrchestrationWriteError(`proposed content is not valid YAML: ${(err as Error).message}`);
	}
	const validated = loadOrchestration(input.filePath, { _inject: reparsed as Record<string, unknown> });

	// The confirm guard: the file MUST still be the bytes planOrchestrationWrite diffed.
	const onDisk = readCurrent(input.filePath);
	if (sha256(onDisk) !== input.confirmToken) {
		throw new StaleConfirmError(
			`orchestration.yaml changed on disk since the diff was generated — re-review before confirming (D-010): ${input.filePath}`,
			input.filePath
		);
	}

	writeFileSync(input.filePath, input.proposed, 'utf8');
	return {
		filePath: input.filePath,
		bytesWritten: Buffer.byteLength(input.proposed, 'utf8'),
		mode: validated.mode
	};
}
