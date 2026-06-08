#!/usr/bin/env node
// scripts/hook-proxy.mjs — the D-019 hook-proxy (TASK 1.9).
//
// Claude Code invokes this for each wired lifecycle hook (SessionStart,
// UserPromptSubmit, PostToolUse, Stop). It reads the hook payload from STDIN, POSTs
// it to the long-lived SvelteKit server over LOOPBACK (carrying the D-025 per-boot
// token from env, with a short timeout), then prints the server's response (or {})
// and EXITS 0 — ALWAYS.
//
// GRACEFUL DEGRADATION (D-019): if the server is down/slow/erroring, or env is
// missing, or anything throws, we print {} and exit 0 so the Claude Code session
// proceeds untouched. This is ANALYTICS-ONLY (D-024) — no safety decision is ever
// returned from here; the response is always the empty/continue object.
//
// This file is plain ESM (run directly by Node in the spawned session) so it has NO
// TypeScript / bundler dependency. Its transport logic mirrors src/lib/server/hooks/
// proxy.ts (which carries the unit tests for the same behavior).

const CONTINUE = {};

// Per-hook timeout budgets (ms) — mirror proxy-config.ts hookTimeoutMs.
const TIMEOUTS = {
	SessionStart: 30_000,
	UserPromptSubmit: 15_000,
	PostToolUse: 10_000,
	Stop: 10_000
};

function isLoopbackHost(host) {
	if (!host) return false;
	const h = host.trim().toLowerCase();
	if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
	if (h === '0.0.0.0' || h === '::' || h === '[::]') return false;
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (m) {
		const o = m.slice(1, 5).map(Number);
		if (o.some((n) => n > 255)) return false;
		return o[0] === 127;
	}
	return false;
}

function hostOf(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
}

async function readStdin() {
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function emit(obj) {
	// Print the continue/empty response Claude Code reads, then exit 0 unconditionally.
	process.stdout.write(JSON.stringify(obj ?? CONTINUE));
	process.exit(0);
}

async function main() {
	const event = process.argv[2];
	const base = (process.env.HOOK_URL || '').trim();
	const token = (process.env.HOOK_TOKEN || '').trim();

	// Not configured, or off the loopback boundary (D-025) → no-op.
	if (!event || !TIMEOUTS[event] || !base || !token) return emit(CONTINUE);
	if (!isLoopbackHost(hostOf(base))) return emit(CONTINUE);

	const payload = await readStdin();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUTS[event]);
	try {
		const res = await fetch(`${base.replace(/\/+$/, '')}/api/hooks/${event}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-hook-token': token,
				origin: base
			},
			body: JSON.stringify(payload),
			signal: ctrl.signal
		});
		if (!res.ok) return emit(CONTINUE);
		const data = await res.json().catch(() => CONTINUE);
		return emit(data && typeof data === 'object' ? data : CONTINUE);
	} catch {
		return emit(CONTINUE); // server down/slow/error → session proceeds (D-019)
	} finally {
		clearTimeout(timer);
	}
}

// Any unexpected throw still degrades to a clean {} + exit 0.
main().catch(() => emit(CONTINUE));
