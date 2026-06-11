#!/usr/bin/env node
// verify-flows runner (TASK 15.3 B9) — executes every ACTIVE codified
// live-verify flow against ONE reused browser daemon (15.2) with per-flow
// wall-clock bounds and an HONEST per-flow pass/fail/skip report. Designed to
// become the consolidated end-gate live pass (F-014: bounded, single server,
// mandatory cleanup of anything it started).
//
// ATOMIC DISCIPLINE (F-015 class, harvested gstack stage→verify→rename, MIT —
// mechanism ours, fail-closed): a new flow lands as <name>.draft.mjs and is
// IGNORED by the default run (drafts are reported, never silently dropped).
// `--graduate <name>` runs the draft once against the live app and ONLY on a
// real pass renames it (atomic fs rename) to <name>.mjs — active. A skip does
// NOT graduate: it never proved anything. No observable half-state exists:
// a flow is either a draft (inert) or active (proven once).
//
// Exit codes: 0 = every executed flow passed (skips allowed, listed);
//             1 = at least one flow FAILED (or a graduation failed);
//             2 = nothing was actually verified (no active flows, or all
//                 skipped) — an end gate must not read that as green.
//
// SUBPROCESS DISCIPLINE: each flow runs as its own bounded child process —
// a hung flow is killed at the bound and reported as a TIMEOUT failure with
// the channel named; an unparseable flow names exit code + first stderr.

import { execFile } from 'node:child_process';
import { readdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { urlUp, bvRaw, BASE } from './harness.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
export const FLOWS_DIR = join(__dir, '..');
export const DEFAULT_FLOW_BOUND_MS = 180_000;

// ─── pure pieces (unit-tested in runner.test.ts) ─────────────────────────────

/**
 * @typedef {{ flow: string, status: 'pass' | 'fail' | 'skip', reason?: string,
 *             evidence: string[], durationMs: number }} FlowResult
 */

/**
 * Split a directory listing into active flows and inert drafts. Only top-level
 * `.mjs` files are flows; `.draft.mjs` is the staged (ignored) state; anything
 * else (lib/, tests, dotfiles) is not a flow.
 */
/** @param {string[]} fileNames @returns {{ active: string[], drafts: string[] }} */
export function splitFlows(fileNames) {
	const active = [];
	const drafts = [];
	for (const f of fileNames) {
		if (!f.endsWith('.mjs')) continue;
		if (f.endsWith('.draft.mjs')) drafts.push(f);
		else active.push(f);
	}
	return { active: active.sort(), drafts: drafts.sort() };
}

/**
 * Parse a flow child's stdout into its result object (the protocol's LAST
 * stdout line). Returns null when no parseable, protocol-shaped line exists —
 * the caller then names the failing channel instead of guessing.
 */
/** @param {string} stdout @returns {FlowResult | null} */
export function parseFlowResult(stdout) {
	const line = String(stdout).trim().split(/\r?\n/).pop() ?? '';
	try {
		const parsed = JSON.parse(line);
		if (
			parsed &&
			typeof parsed.flow === 'string' &&
			['pass', 'fail', 'skip'].includes(parsed.status)
		) {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Honest rollup. Exit code 1 on ANY fail; otherwise 0 only if at least one
 * flow actually PASSED; an all-skip (or empty) run exits 2 — "nothing was
 * verified" must never read as green at an end gate.
 */
/** @param {FlowResult[]} results */
export function summarize(results) {
	const pass = results.filter((r) => r.status === 'pass').length;
	const fail = results.filter((r) => r.status === 'fail').length;
	const skip = results.filter((r) => r.status === 'skip').length;
	const exitCode = fail > 0 ? 1 : pass > 0 ? 0 : 2;
	return { pass, fail, skip, total: results.length, exitCode };
}

// ─── flow execution (bounded child process) ──────────────────────────────────

/**
 * Run ONE flow file as a bounded child process. Never throws — every outcome
 * becomes an honest result row with the failing channel named.
 */
/**
 * @param {string} flowPath @param {number} [boundMs] @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<FlowResult>}
 */
export function runOneFlow(flowPath, boundMs = DEFAULT_FLOW_BOUND_MS, env = process.env) {
	return new Promise((resolve) => {
		const started = Date.now();
		execFile(
			process.execPath,
			[flowPath],
			{ timeout: boundMs, killSignal: 'SIGKILL', windowsHide: true, env },
			(err, stdout, stderr) => {
				const durationMs = Date.now() - started;
				const flow = flowPath.replace(/\\/g, '/').split('/').pop() ?? flowPath;
				if (err && err.killed) {
					resolve({
						flow,
						status: 'fail',
						reason: `flow-bound-exceeded: wall-clock ${boundMs}ms (channel: timeout — the flow was killed, F-014 no spin)`,
						evidence: [],
						durationMs
					});
					return;
				}
				const parsed = parseFlowResult(stdout);
				if (parsed) {
					resolve({ ...parsed, durationMs: parsed.durationMs ?? durationMs });
					return;
				}
				resolve({
					flow,
					status: 'fail',
					reason: `flow-protocol-violation: no result JSON on stdout (channel: ${err ? `exit ${err.code ?? 'unknown'}` : 'empty output'}). stderr: ${JSON.stringify(String(stderr).slice(0, 300))}`,
					evidence: [],
					durationMs
				});
			}
		);
	});
}

// ─── main ────────────────────────────────────────────────────────────────────

/** @param {FlowResult[]} results @param {string[]} drafts */
function printReport(results, drafts) {
	console.log('\n── verify-flows report ─────────────────────────────────────');
	for (const r of results) {
		const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
		console.log(`  [${mark}] ${r.flow} (${r.durationMs}ms)${r.reason ? ` — ${r.reason}` : ''}`);
	}
	for (const d of drafts) {
		console.log(`  [DRAFT] ${d} — ignored (graduate with: verify:flows -- --graduate ${d.replace(/\.draft\.mjs$/, '')})`);
	}
	const sum = summarize(results);
	console.log(
		`  ${sum.pass} passed · ${sum.fail} failed · ${sum.skip} skipped · ${drafts.length} draft(s)`
	);
	console.log(JSON.stringify({ verifyFlows: { ...sum, results, drafts } }));
	return sum;
}

/** @param {string} name @param {string} flowsDir @param {number} boundMs */
async function graduate(name, flowsDir, boundMs) {
	const draftPath = join(flowsDir, `${name}.draft.mjs`);
	const activePath = join(flowsDir, `${name}.mjs`);
	if (existsSync(activePath)) {
		console.error(`graduate: ${name}.mjs already active — nothing to do (idempotent re-run absorbed)`);
		return 0;
	}
	if (!existsSync(draftPath)) {
		console.error(`graduate: no such draft ${name}.draft.mjs in ${flowsDir}`);
		return 1;
	}
	const result = await runOneFlow(draftPath, boundMs);
	console.log(JSON.stringify(result));
	if (result.status !== 'pass') {
		// A skip is NOT a pass — an unverified flow must not become active.
		console.error(`graduate: draft ${name} did not PASS (${result.status}: ${result.reason ?? ''}) — NOT renamed`);
		return 1;
	}
	renameSync(draftPath, activePath); // atomic: draft → active, no half-state
	console.error(`graduate: ${name}.draft.mjs passed live and is now ACTIVE as ${name}.mjs`);
	return 0;
}

async function main() {
	const { values } = parseArgs({
		options: {
			bound: { type: 'string' },
			graduate: { type: 'string' }
		}
	});
	const boundMs = values.bound ? Number(values.bound) : Number(process.env.VF_FLOW_BOUND_MS ?? DEFAULT_FLOW_BOUND_MS);
	if (!Number.isFinite(boundMs) || boundMs <= 0) {
		console.error('--bound must be a positive number of ms');
		process.exit(2);
	}
	const flowsDir = process.env.VF_FLOWS_DIR ?? FLOWS_DIR;

	if (values.graduate) {
		process.exit(await graduate(values.graduate, flowsDir, boundMs));
	}

	const { active, drafts } = splitFlows(readdirSync(flowsDir));
	if (active.length === 0) {
		printReport([], drafts);
		console.error('verify-flows: no active flows — nothing verified');
		process.exit(2);
	}

	// App preflight: skip ALL flows honestly when the dev server is down — the
	// runner never boots servers itself (F-014: reuse the ONE running server;
	// the operator/end-gate owns server lifecycle).
	if (!(await urlUp(BASE + '/'))) {
		const results = active.map(
			(flow) =>
				/** @type {FlowResult} */ ({
					flow,
					status: 'skip',
					reason: `app-unreachable: ${BASE} did not answer (env failure — start the dev server, then re-run)`,
					evidence: [],
					durationMs: 0
				})
		);
		process.exit(printReport(results, drafts).exitCode);
	}

	// Daemon lifecycle: remember whether one was already live — we only stop
	// what WE caused to start (F-014 mandatory cleanup, reuse otherwise).
	const statusBefore = await bvRaw(['status'], 20_000).catch(() => ({ running: false }));
	const daemonWasRunning = statusBefore.running === true;

	const results = [];
	for (const flow of active) {
		console.error(`\n▶ ${flow} (bound ${boundMs}ms)`);
		results.push(await runOneFlow(join(flowsDir, flow), boundMs));
	}

	if (!daemonWasRunning) {
		await bvRaw(['stop'], 20_000).catch(() => {
			/* daemon already gone — nothing left to stop */
		});
	}

	process.exit(printReport(results, drafts).exitCode);
}

// Import-safe: unit tests import the pure pieces without running main.
const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((err) => {
		console.error(`[verify-flows] fatal: ${err.message}`);
		process.exit(1);
	});
}
