// verify-flow harness (TASK 15.3 B9 — HARVEST B9 + audited atomic discipline).
//
// Shared plumbing every codified live-verify flow uses, so a flow file is ONLY
// the feature's proven steps. Flows drive the 15.2 singleton browser daemon
// through its CLI (scripts/browser-verify/cli.mjs) — ONE reused browser, every
// op wall-clock-bounded (F-014), action proof via snapshot-diff (F-008), never
// screenshots.
//
// FLOW PROTOCOL (the runner parses this):
//   - a flow is a standalone `node tests/verify-flows/<feature>.mjs` script;
//   - human-readable step logs go to STDERR;
//   - the LAST stdout line is one JSON result:
//       { flow, status: 'pass'|'fail'|'skip', reason?, evidence: [...], durationMs }
//   - exit code 0 = pass, 1 = fail, 2 = skip (env unavailable — honest, F-014:
//     an unreachable app/daemon/db is an ENV failure, never a fake pass and
//     never a feature defect).
//
// EVERY ERROR HAS A NAME: bv() rethrows the daemon's named errors; env-class
// names (daemon won't start / can't be reached) classify as SKIP, everything
// else as FAIL. FlowSkip/FlowAssert give flows their own named exits.

import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
/** Worktree root (tests/verify-flows/lib → three levels up). */
export const REPO_ROOT = join(__dir, '..', '..', '..');
const CLI = join(REPO_ROOT, 'scripts', 'browser-verify', 'cli.mjs');

/** Base URL of the app under verification. 'localhost', not 127.0.0.1 — vite
 * dev binds localhost (dual-stack), same convention as daemon.live.test.ts. */
export const BASE = process.env.VF_BASE ?? 'http://localhost:5173';

/** Client-side wall-clock bound per daemon op (the CLI adds its own on top). */
export const DEFAULT_OP_BOUND_MS = 45_000;

/** Named error helper (same convention as the daemon/CLI). */
/** @param {string} name @param {string} message @returns {Error} */
export function namedError(name, message) {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** Thrown by a flow to record an HONEST environment skip (exit 2). */
export class FlowSkip extends Error {
	/** @param {string} reason */
	constructor(reason) {
		super(reason);
		this.name = 'flow-skip';
	}
}

/** Thrown when a feature assertion fails (exit 1 — a real defect signal). */
export class FlowAssert extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'flow-assert';
	}
}

/**
 * Assert or throw FlowAssert — flow failures are named, never silent.
 * @param {unknown} cond @param {string} message @returns {asserts cond}
 */
export function assert(cond, message) {
	if (!cond) throw new FlowAssert(message);
}

/**
 * bv error names that mean "the verify ENVIRONMENT is unavailable" (skip),
 * as opposed to "the feature under verification misbehaved" (fail).
 * Exported pure for the runner's unit tests.
 */
const ENV_ERROR_NAMES = new Set(['daemon-start-timeout', 'daemon-unreachable']);
/** @param {string | undefined} errName @returns {'env' | 'defect'} */
export function classifyBvFailure(errName) {
	return errName !== undefined && ENV_ERROR_NAMES.has(errName) ? 'env' : 'defect';
}

/**
 * Bounded reachability probe for any http URL (app preflight, ollama truth).
 * @param {string} url @param {number} [boundMs]
 */
export async function urlUp(url, boundMs = 3_000) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(boundMs), redirect: 'manual' });
		return res.status < 500;
	} catch {
		return false;
	}
}

/**
 * One bounded daemon-CLI invocation; resolves the parsed single-line JSON even
 * when ok:false (callers decide). Rejects ONLY when the output is unparseable,
 * naming WHICH channel failed (timeout vs exit code vs empty output) and
 * quoting the first stderr lines — never silence-as-success.
 * @param {string[]} args @param {number} [boundMs]
 * @returns {Promise<Record<string, any>>}
 */
export function bvRaw(args, boundMs = DEFAULT_OP_BOUND_MS) {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ timeout: boundMs, killSignal: 'SIGKILL', windowsHide: true },
			(err, stdout, stderr) => {
				const line = String(stdout).trim().split(/\r?\n/).pop() ?? '';
				try {
					resolve(JSON.parse(line));
				} catch {
					const channel = err
						? err.killed
							? `timeout ${boundMs}ms`
							: `exit ${err.code ?? 'unknown'}`
						: 'empty output';
					reject(
						namedError(
							'bv-unparseable',
							`bv ${args[0]}: no parseable result (channel: ${channel}). stderr: ${JSON.stringify(String(stderr).slice(0, 300))}`
						)
					);
				}
			}
		);
	});
}

/**
 * Strict daemon-CLI invocation: ok:false becomes a named throw.
 * @param {string[]} args @param {number} [boundMs]
 * @returns {Promise<Record<string, any>>}
 */
export async function bv(args, boundMs = DEFAULT_OP_BOUND_MS) {
	const out = await bvRaw(args, boundMs);
	if (out.ok !== true) {
		const e = out.error ?? { name: 'bv-failed', message: 'daemon CLI reported failure without detail' };
		throw namedError(e.name ?? 'bv-failed', `bv ${args[0]}: ${e.message}`);
	}
	return out;
}

/**
 * Bounded poll: re-evaluates `fn` until it returns truthy; returns that value.
 * Throws a NAMED poll-timeout (fail-class) when the bound elapses — flows use
 * this for SSE-driven in-place updates, never spin-retry (F-014).
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{ boundMs?: number, intervalMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function pollUntil(fn, { boundMs = 10_000, intervalMs = 500, label = 'condition' } = {}) {
	const deadline = Date.now() + boundMs;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() >= deadline) {
			throw namedError('poll-timeout', `${label} not true within ${boundMs}ms (channel: timeout)`);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

/**
 * Deterministic hydration + SSE gate: after a nav, wait (bounded) until the
 * Topbar's connection indicator says LIVE (`aria-label="connection live"`).
 * That label flips from the SSR'd 'unknown' only after the client hydrates
 * AND the one SSE stream attaches — exactly the preconditions for keyboard
 * listeners (Ctrl+K) and live row updates. Pressing/asserting before this is
 * the hydration race, not a feature defect.
 * @param {(args: string[], boundMs?: number) => Promise<Record<string, any>>} bvFn
 */
export async function awaitLive(bvFn) {
	await pollUntil(
		async () => (await bvFn(['text', '[aria-label="connection live"]'])).count > 0,
		{ boundMs: 15_000, label: 'shell hydrated + SSE connection live' }
	);
}

/**
 * Minimal .env reader (KEY=VALUE lines; quotes stripped; comments ignored).
 * process.env always wins — this only fills dev defaults so flows connect to
 * the SAME SurrealDB/Ollama the dev server uses. No secrets are logged.
 */
/** @param {string} [root] @returns {Record<string, string>} */
export function loadDotEnv(root = REPO_ROOT) {
	const path = join(root, '.env');
	/** @type {Record<string, string>} */
	const map = {};
	if (!existsSync(path)) return map;
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (!m || line.trim().startsWith('#')) continue;
		map[m[1]] = m[2].replace(/^["']|["']$/g, '');
	}
	return map;
}

/** SurrealDB connection params: process.env > .env > the documented dev defaults. */
export function dbEnv() {
	const dot = loadDotEnv();
	/** @param {string} k @param {string} fallback */
	const pick = (k, fallback) => process.env[k] ?? dot[k] ?? fallback;
	return {
		ws: pick('SURREAL_WS', 'ws://127.0.0.1:8000'),
		ns: pick('SURREAL_NS', 'playground'),
		db: pick('SURREAL_DB', 'v2'),
		user: pick('SURREAL_USER', 'root'),
		pass: pick('SURREAL_PASS', 'root')
	};
}

/** Default loopback Ollama base url (D-003/D-025 — NO `/v1` suffix per CLAUDE.md). */
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

/**
 * LIKE-FOR-LIKE port of the page's own probe-host normalizer
 * (src/lib/server/services/ollama-adapter.ts `normalizeClientHost`). The flow
 * layer is plain node (no TS loader), so it carries this JS port — parity with
 * the page's implementation is LOCKED by the 'normalizeClientHost parity' unit
 * suite in runner.test.ts; change BOTH together.
 *
 * Why it exists (15.3 DoD-review HIGH gap): `OLLAMA_HOST` is overloaded —
 * Ollama itself uses it as a BIND address (commonly `0.0.0.0:11434`, no
 * scheme), the page uses the normalized CLIENT url. Feeding the raw bind form
 * to global fetch throws ("relative URL"), so the flow's "independent truth"
 * probe read permanently DOWN and false-failed the gate whenever Ollama was
 * actually up.
 * @param {string} raw @returns {string}
 */
export function normalizeClientHost(raw) {
	let h = (raw ?? '').trim();
	if (!h) return DEFAULT_OLLAMA_HOST;
	// Add a scheme if missing so the value parses as an absolute url (else fetch
	// sees it as relative and throws). http: loopback plaintext, D-025.
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) h = `http://${h}`;
	try {
		const u = new URL(h);
		// You cannot connect to a bind-all address — rewrite to loopback (D-025).
		if (u.hostname === '0.0.0.0' || u.hostname === '::' || u.hostname === '[::]') {
			u.hostname = '127.0.0.1';
		}
		return u.toString().replace(/\/$/, '');
	} catch {
		// Unparseable — fall back to the loopback default rather than probe a bad url.
		return DEFAULT_OLLAMA_HOST;
	}
}

/**
 * Ollama base URL (truth source for the services-health flow), normalized with
 * the page's OWN `normalizeClientHost` semantics so the flow probes the same
 * CONNECT url the page probes — never the raw (possibly bind-form) env string.
 */
export function ollamaHost() {
	const dot = loadDotEnv();
	return normalizeClientHost(process.env.OLLAMA_HOST ?? dot.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST);
}

/**
 * Flow entrypoint: app preflight → run the steps → emit the ONE JSON result
 * line + exit code. Flows own their resource cleanup (try/finally INSIDE
 * `fn`); the daemon is deliberately left running — the RUNNER owns its
 * lifecycle (one reused browser across all flows, F-014).
 *
 * @param {string} name flow name (matches the file name)
 * @param {(ctx: {base: string, bv: typeof bv, step: (s: string) => void, assert: typeof assert, skip: (reason: string) => never, pollUntil: typeof pollUntil}) => Promise<void>} fn
 */
export async function runFlow(name, fn) {
	const started = Date.now();
	/** @type {string[]} */
	const evidence = [];
	/** @param {string} line */
	const step = (line) => {
		evidence.push(line);
		console.error(`[${name}] ${line}`);
	};
	/** @param {'pass' | 'fail' | 'skip'} status @param {string} [reason] @returns {never} */
	const emit = (status, reason) => {
		console.log(
			JSON.stringify({
				flow: name,
				status,
				...(reason ? { reason } : {}),
				evidence,
				durationMs: Date.now() - started
			})
		);
		process.exit(status === 'pass' ? 0 : status === 'skip' ? 2 : 1);
	};
	/** @param {string} reason @returns {never} */
	const skip = (reason) => {
		throw new FlowSkip(reason);
	};

	try {
		if (!(await urlUp(BASE + '/'))) {
			emit('skip', `app-unreachable: ${BASE} did not answer within bound (env failure, not a feature defect)`);
		}
		step(`app reachable at ${BASE}`);
		await fn({ base: BASE, bv, step, assert, skip, pollUntil });
		emit('pass');
	} catch (err) {
		const e = /** @type {{ name?: string, message?: string }} */ (err);
		if (err instanceof FlowSkip) emit('skip', err.message);
		else if (classifyBvFailure(e.name) === 'env') emit('skip', `${e.name}: ${e.message}`);
		else emit('fail', `${e.name ?? 'error'}: ${e.message}`);
	}
}
