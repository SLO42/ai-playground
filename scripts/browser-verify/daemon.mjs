// browser-verify daemon — the ONE long-lived Playwright browser per workspace
// (TASK 15.2 B3 — the structural fix for F-010/F-014).
//
// Pattern source (provenance): gstack BROWSER.md headless-Chromium-daemon
// architecture + browse/src/server.ts idle auto-shutdown (MIT). Mechanisms
// OURS, fail-closed:
//   - chromium.launchServer() owns the browser; the daemon itself attaches
//     over the ws endpoint and owns the single shared page (Playwright ws
//     clients get ISOLATED contexts, so page state can only be shared by
//     routing commands through this daemon — the CLI is a thin client);
//   - readiness == the atomically-written state file (.playground/) carrying
//     pid + wsEndpoint + started_at (+ loopback control port + token);
//   - idle auto-shutdown via the injected-clock monitor (timer reset on use);
//   - CRASH = EXIT IMMEDIATELY with an honest error + crash marker. No
//     self-heal, no spin-retry (F-014). The next invocation reports it.
//   - every op is wall-clock-bounded and serialized through an op queue (one
//     page, one actor — two concurrent CLI calls cannot interleave goto()s);
//   - control server binds 127.0.0.1 ONLY and requires the state-file token
//     (fail-closed: no token, no service).
//
// Config via env (set by cli.mjs): BV_STATE_DIR, BV_IDLE_MS, BV_WORKSPACE.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { chromium } from 'playwright-core';
import {
	writeStateFile,
	cleanStateFile,
	readStateFile,
	writeCrashMarker,
	discoverDaemon
} from './state-file.mjs';
import { createIdleMonitor } from './idle.mjs';
import { captureNodes, diffSnapshots, MAX_NODES } from './snapshot.mjs';
import { isPidAlive } from './pid-live.mjs';
import { validatePressKey, validateTextSelector } from './op-validate.mjs';

const STATE_DIR = process.env.BV_STATE_DIR || resolve(process.cwd(), '.playground');
const IDLE_MS = Number(process.env.BV_IDLE_MS || 10 * 60 * 1000); // default 10 min quiet
const WORKSPACE = process.env.BV_WORKSPACE || process.cwd();
const IDLE_TICK_MS = 5_000;
/** Hard wall-clock ceiling on any single op, regardless of per-op timeout. */
const OP_CEILING_MS = 60_000;

const log = (...args) => console.log(`[bv-daemon ${new Date().toISOString()}]`, ...args);

/** @param {string} name @param {string} message */
function namedError(name, message) {
	const err = new Error(message);
	err.name = name;
	return err;
}

function withTimeout(promise, ms, opName) {
	let timer;
	const bound = new Promise((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					namedError('op-timeout', `${opName}: wall-clock bound ${ms}ms exceeded (channel: timeout)`)
				),
			ms
		);
	});
	return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

// ─── lifecycle state ─────────────────────────────────────────────────────────

let shuttingDown = false;
/** @type {import('playwright-core').BrowserServer | null} */
let browserServer = null;
/** @type {import('playwright-core').Browser | null} */
let browser = null;
/** @type {import('playwright-core').Page | null} */
let page = null;
/** @type {import('node:http').Server | null} */
let control = null;
let generation = 0;
const idle = createIdleMonitor({ quietMs: IDLE_MS });
const startedAt = new Date().toISOString();

/** Best-effort sync cleanup — remove the state file only if it is OURS. */
function removeOwnStateFile() {
	const read = readStateFile(STATE_DIR);
	if (!read.ok || read.state.pid === process.pid) cleanStateFile(STATE_DIR);
}

async function gracefulShutdown(why, code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`shutting down (${why})`);
	removeOwnStateFile();
	try {
		control?.close();
	} catch {
		/* control server already gone */
	}
	try {
		await withTimeout(
			(async () => {
				await browser?.close();
				await browserServer?.close();
			})(),
			10_000,
			'shutdown-close-browser'
		);
	} catch (err) {
		log(`browser close failed during shutdown: ${err.message}`);
	}
	process.exit(code);
}

/** Browser died under us: honest error, crash marker, immediate exit. NO self-heal (F-014). */
function crashExit(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`FATAL browser crash: ${reason} — exiting immediately (no self-heal)`);
	try {
		writeCrashMarker(STATE_DIR, {
			reason,
			daemonPid: process.pid,
			browserPid: browserServer?.process()?.pid ?? null,
			workspace: WORKSPACE
		});
	} catch (err) {
		log(`could not write crash marker: ${err.message}`);
	}
	removeOwnStateFile();
	try {
		control?.close();
	} catch {
		/* already closed */
	}
	process.exit(1);
}

process.on('exit', () => {
	// Last-ditch sync cleanup — every exit path must leave no state file behind.
	try {
		removeOwnStateFile();
	} catch {
		/* nothing left to do on exit */
	}
});
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => void gracefulShutdown(sig));
}
process.on('uncaughtException', (err) => crashExit(`uncaughtException: ${err.message}`));
process.on('unhandledRejection', (err) =>
	crashExit(`unhandledRejection: ${err instanceof Error ? err.message : String(err)}`)
);

// ─── op queue: one page, one actor ──────────────────────────────────────────

let opChain = Promise.resolve();
function enqueue(fn) {
	const run = opChain.then(() => fn());
	opChain = run.catch(() => {
		/* failures surface to the caller; the queue itself never jams */
	});
	return run;
}

// ─── ops ─────────────────────────────────────────────────────────────────────

function requirePage() {
	if (!page) throw namedError('no-page', 'daemon has no live page (browser not attached)');
	return page;
}

async function opNav(params) {
	const rawUrl = typeof params.url === 'string' ? params.url : '';
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw namedError('nav-url-invalid', `nav: not a URL: ${JSON.stringify(rawUrl)}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw namedError('nav-url-invalid', `nav: only http(s) URLs allowed, got ${parsed.protocol}`);
	}
	const timeout = boundedTimeout(params.timeoutMs, 30_000);
	const p = requirePage();
	// F-010: NEVER 'networkidle' — the dashboard holds an open SSE stream.
	await p.goto(parsed.href, { waitUntil: 'load', timeout });
	generation += 1; // navigation retires all refs
	return { url: p.url(), title: await p.title() };
}

async function opSnapshot() {
	const p = requirePage();
	generation += 1;
	const nodes = await p.evaluate(captureNodes, {
		assignRefs: true,
		generation,
		maxNodes: MAX_NODES
	});
	return { generation, count: nodes.length, nodes };
}

async function opAct(params) {
	const ref = typeof params.ref === 'string' ? params.ref : '';
	if (!/^g\d+:e\d+$/.test(ref)) {
		throw namedError('act-ref-invalid', `act: ref must look like g<gen>:e<n>, got ${JSON.stringify(ref)}`);
	}
	const p = requirePage();
	const selector = `[data-bv-ref="${ref}"]`;

	// FAIL-FAST STALE REF (task (c)): an instant in-page existence probe
	// converts Playwright's 30s actionability wait on a gone element into an
	// immediate, named, actionable error.
	const exists = await p.evaluate((sel) => document.querySelector(sel) !== null, selector);
	if (!exists) {
		throw namedError(
			'stale-ref',
			`act: ref ${ref} is not in the live DOM (page changed since that snapshot) — re-snapshot`
		);
	}

	// SNAPSHOT-DIFF ACTION PROOF (task (d)): before/after captures, pure diff.
	const capOpts = { assignRefs: false, generation, maxNodes: MAX_NODES };
	const before = await p.evaluate(captureNodes, capOpts);
	await p.click(selector, { timeout: boundedTimeout(params.timeoutMs, 5_000) });
	// Give the UI a moment to settle; if the click navigated, bound the wait.
	await p.waitForLoadState('load', { timeout: 3_000 }).catch(() => {
		/* still loading past the bound — capture what is there now, honestly */
	});
	await p.waitForTimeout(350);
	const after = await p.evaluate(captureNodes, capOpts);
	const diff = diffSnapshots(before, after);
	return {
		ref,
		changed: diff.changed,
		added: diff.added,
		removed: diff.removed,
		summary:
			diff.changed > 0
				? `clicked ${ref} and ${diff.changed} things changed (+${diff.added.length}/-${diff.removed.length})`
				: `clicked ${ref} and NOTHING observable changed — treat as a failure signal, not success`
	};
}

/**
 * Keyboard press with the SAME snapshot-diff action proof as act() (TASK 15.3
 * B9 — codified verify-flows need the keyboard backbone: the Cmd/Ctrl-K
 * command palette has no pointer-only open path). Key validated at the
 * boundary (op-validate.mjs); proof captures are ref-less like act's.
 */
async function opPress(params) {
	const key = validatePressKey(params.key);
	const p = requirePage();
	const capOpts = { assignRefs: false, generation, maxNodes: MAX_NODES };
	const before = await p.evaluate(captureNodes, capOpts);
	await p.keyboard.press(key);
	// If the press navigated/toggled, bound the settle wait (same as act).
	await p.waitForLoadState('load', { timeout: 3_000 }).catch(() => {
		/* still loading past the bound — capture what is there now, honestly */
	});
	await p.waitForTimeout(350);
	const after = await p.evaluate(captureNodes, capOpts);
	const diff = diffSnapshots(before, after);
	return {
		key,
		changed: diff.changed,
		added: diff.added,
		removed: diff.removed,
		summary:
			diff.changed > 0
				? `pressed ${key} and ${diff.changed} things changed (+${diff.added.length}/-${diff.removed.length})`
				: `pressed ${key} and NOTHING observable changed — treat as a failure signal, not success`
	};
}

/**
 * READ-ONLY text extraction (TASK 15.3 B9): visible innerText of elements
 * matching a CSS selector, bounded (60 elements × 600 chars). The a11y
 * snapshot captures interactive/landmark nodes only — verify-flows assert
 * page TRUTH (e.g. the /services "probe: healthy" claim, a run row's status)
 * from this, never from screenshots. Mutates nothing.
 */
async function opText(params) {
	const selector = validateTextSelector(params.selector);
	const p = requirePage();
	const out = await p.evaluate(
		(args) => {
			let list;
			try {
				list = Array.from(document.querySelectorAll(args.selector));
			} catch {
				return { invalid: true, total: 0, texts: [] };
			}
			const texts = [];
			for (const el of list) {
				if (texts.length >= args.maxEls) break;
				if (!(el instanceof HTMLElement)) continue;
				texts.push((el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, args.maxLen));
			}
			return { invalid: false, total: list.length, texts };
		},
		{ selector, maxEls: 60, maxLen: 600 }
	);
	if (out.invalid) {
		throw namedError('text-selector-invalid', `text: not a valid CSS selector: ${JSON.stringify(selector)}`);
	}
	return { selector, count: out.total, texts: out.texts };
}

async function opScreenshot(params) {
	const rawPath = typeof params.path === 'string' ? params.path : '';
	if (!rawPath) throw namedError('screenshot-path-invalid', 'screenshot: path is required');
	const target = resolve(rawPath);
	const ext = extname(target).toLowerCase();
	if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
		throw namedError('screenshot-path-invalid', `screenshot: path must end .png/.jpg, got ${ext || '(none)'}`);
	}
	mkdirSync(dirname(target), { recursive: true });
	const p = requirePage();
	await p.screenshot({ path: target, timeout: boundedTimeout(params.timeoutMs, 15_000) });
	return { path: target };
}

function opStatus() {
	return {
		pid: process.pid,
		browserPid: browserServer?.process()?.pid ?? null,
		wsEndpoint: browserServer?.wsEndpoint() ?? null,
		startedAt,
		workspace: WORKSPACE,
		url: page?.url() ?? null,
		idleMs: IDLE_MS,
		idleForMs: idle.idleFor(),
		generation
	};
}

function boundedTimeout(requested, fallback) {
	const t = Number(requested);
	if (!Number.isFinite(t) || t <= 0) return fallback;
	return Math.min(t, OP_CEILING_MS - 5_000);
}

// ─── control server (loopback + token, fail-closed) ─────────────────────────

let token = '';

function tokenOk(req) {
	const got = req.headers['x-bv-token'];
	if (typeof got !== 'string' || got.length === 0) return false;
	const a = Buffer.from(String(got));
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
	return new Promise((resolveBody, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > 1_048_576) {
				reject(namedError('body-too-large', 'control request body exceeds 1MB'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			if (!raw) return resolveBody({});
			try {
				resolveBody(JSON.parse(raw));
			} catch {
				reject(namedError('body-not-json', 'control request body is not valid JSON'));
			}
		});
		req.on('error', reject);
	});
}

function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(body);
}

async function handle(req, res) {
	if (req.method !== 'POST') return send(res, 405, { ok: false, error: { name: 'method-not-allowed', message: 'POST only' } });
	if (!tokenOk(req)) return send(res, 401, { ok: false, error: { name: 'token-invalid', message: 'missing or wrong X-BV-Token' } });

	idle.touch(); // any authorized contact resets the quiet period

	let params;
	try {
		params = await readBody(req);
	} catch (err) {
		return send(res, 400, { ok: false, error: { name: err.name, message: err.message } });
	}

	const route = req.url ?? '';
	try {
		switch (route) {
			case '/status':
				return send(res, 200, { ok: true, ...opStatus() });
			case '/stop':
				send(res, 200, { ok: true, stopping: true, pid: process.pid });
				setImmediate(() => void gracefulShutdown('stop requested via control endpoint'));
				return;
			case '/nav':
				return send(res, 200, {
					ok: true,
					...(await enqueue(() => withTimeout(opNav(params), OP_CEILING_MS, 'nav')))
				});
			case '/snapshot':
				return send(res, 200, {
					ok: true,
					...(await enqueue(() => withTimeout(opSnapshot(), OP_CEILING_MS, 'snapshot')))
				});
			case '/act':
				return send(res, 200, {
					ok: true,
					...(await enqueue(() => withTimeout(opAct(params), OP_CEILING_MS, 'act')))
				});
			case '/press':
				return send(res, 200, {
					ok: true,
					...(await enqueue(() => withTimeout(opPress(params), OP_CEILING_MS, 'press')))
				});
			case '/text':
				return send(res, 200, {
					ok: true,
					...(await enqueue(() => withTimeout(opText(params), OP_CEILING_MS, 'text')))
				});
			case '/screenshot':
				return send(res, 200, {
					ok: true,
					...(await enqueue(() => withTimeout(opScreenshot(params), OP_CEILING_MS, 'screenshot')))
				});
			default:
				return send(res, 404, { ok: false, error: { name: 'unknown-op', message: `no such op: ${route}` } });
		}
	} catch (err) {
		const status = err.name === 'stale-ref' || err.name?.endsWith('-invalid') ? 400 : 500;
		return send(res, status, { ok: false, error: { name: err.name ?? 'op-failed', message: err.message } });
	} finally {
		idle.touch(); // long ops should not count toward their own quiet period
	}
}

// ─── boot ────────────────────────────────────────────────────────────────────

async function main() {
	mkdirSync(STATE_DIR, { recursive: true });

	// Singleton guard: never spawn a sibling next to a live daemon.
	const found = await discoverDaemon(STATE_DIR, { isPidAlive });
	if (found.kind === 'live') {
		log(`sibling daemon already live (pid ${found.state.pid}) — refusing to start a second browser`);
		process.exit(3);
	}
	if (found.kind === 'stale') log(`recovered stale state: ${found.reason}`);

	log(`launching chromium (idle quiet period ${IDLE_MS}ms, workspace ${WORKSPACE})`);
	browserServer = await withTimeout(
		chromium.launchServer({ headless: true }),
		60_000,
		'browser-launch'
	);
	const wsEndpoint = browserServer.wsEndpoint();
	const browserPid = browserServer.process()?.pid ?? -1;

	// Crash detection on BOTH channels: browser process exit + ws disconnect.
	browserServer.process()?.on('exit', (code, signal) => {
		crashExit(`browser process ${browserPid} exited unexpectedly (code=${code} signal=${signal})`);
	});

	// The daemon is itself a ws client of its own launchServer — the reuse path.
	browser = await withTimeout(chromium.connect(wsEndpoint, { timeout: 15_000 }), 20_000, 'browser-connect');
	browser.on('disconnected', () => crashExit('browser ws connection lost (browser killed or crashed)'));
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	page = await context.newPage();

	token = randomBytes(24).toString('hex');
	control = createServer((req, res) => void handle(req, res));
	await new Promise((resolveListen, rejectListen) => {
		control.once('error', rejectListen);
		control.listen(0, '127.0.0.1', () => resolveListen(undefined));
	});
	const addr = control.address();
	const controlPort = typeof addr === 'object' && addr ? addr.port : -1;

	// Readiness signal LAST (interrupt contract): the state file appears only
	// once everything behind it actually works.
	writeStateFile(STATE_DIR, {
		pid: process.pid,
		browserPid,
		wsEndpoint,
		controlPort,
		token,
		startedAt,
		workspace: WORKSPACE,
		idleMs: IDLE_MS
	});
	log(`ready: pid=${process.pid} browserPid=${browserPid} controlPort=${controlPort}`);

	setInterval(() => {
		if (!shuttingDown && idle.due()) {
			void gracefulShutdown(`idle for ${idle.idleFor()}ms (quiet period ${IDLE_MS}ms)`);
		}
	}, IDLE_TICK_MS);
}

main().catch((err) => {
	log(`startup failed: [${err.name}] ${err.message}`);
	removeOwnStateFile();
	process.exit(1);
});
