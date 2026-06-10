#!/usr/bin/env node
// scripts/gate-hook.mjs — the D-018/D-024 PreToolUse GATE hook (TASK 13.3; ARCHITECTURE §2.10e).
//
// Claude Code invokes this BEFORE every tool call in a driven session (cli-backend.ts
// registers it in the isolated settings.json when the spawn carries gates). It reads the
// PreToolUse payload from STDIN, POSTs { config, payload } to the long-lived SvelteKit
// server's gate endpoint over LOOPBACK (D-025 token from env), and prints the server's
// permission decision for Claude Code to enforce.
//
// FAIL CLOSED (D-024 / ROADMAP 2.13: "a gate error or unreachable server denies the
// action, never allows it"): missing env, a non-loopback HOOK_URL, a timeout, a non-OK
// response, a garbage response, or ANY throw → print a DENY decision and exit 0. This is
// the OPPOSITE of scripts/hook-proxy.mjs (analytics-only, no-ops on failure) — that
// best-effort transport must never carry a safety decision; this one must never fail open.
//
// The session's gate config (policy + projectRoot, pinned at spawn time by the backend)
// rides argv[2] as base64url JSON — configuration, not a secret. The D-025 token rides
// the spawned session's ENV only (never the command string / settings file).
//
// Plain ESM (run directly by node in the spawned session) — no TS/bundler dependency.
// Server-side logic lives in src/lib/server/claude-code/gate-transport.ts (unit-tested).

const TIMEOUT_MS = 8_000;

function deny(reason) {
	return {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason
		}
	};
}

function emit(obj) {
	process.stdout.write(JSON.stringify(obj));
	process.exit(0);
}

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

/** A decision is only trusted if it carries the documented PreToolUse output shape. */
function isDecision(data) {
	const d = data?.hookSpecificOutput;
	return (
		d &&
		d.hookEventName === 'PreToolUse' &&
		(d.permissionDecision === 'allow' || d.permissionDecision === 'deny' || d.permissionDecision === 'ask')
	);
}

async function main() {
	const config = process.argv[2];
	const base = (process.env.HOOK_URL || '').trim();
	const token = (process.env.HOOK_TOKEN || '').trim();

	// FAIL CLOSED — a gate hook with no config or no reachable loopback gate endpoint
	// denies the tool. (Contrast hook-proxy.mjs, which no-ops: analytics vs safety.)
	if (!config) return emit(deny('gate hook invoked with no gate config — failing closed (D-024)'));
	if (!base || !token) {
		return emit(deny('gate control plane not configured (HOOK_URL/HOOK_TOKEN) — failing closed (D-024)'));
	}
	if (!isLoopbackHost(hostOf(base))) {
		return emit(deny('gate endpoint is not loopback — failing closed (D-025/D-024)'));
	}

	const payload = await readStdin();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${base.replace(/\/+$/, '')}/api/gates/pretooluse`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-hook-token': token,
				origin: base
			},
			body: JSON.stringify({ config, payload }),
			signal: ctrl.signal
		});
		if (!res.ok) return emit(deny(`gate endpoint returned ${res.status} — failing closed (D-024)`));
		const data = await res.json().catch(() => null);
		if (!isDecision(data)) return emit(deny('gate endpoint returned no decision — failing closed (D-024)'));
		return emit(data);
	} catch {
		return emit(deny('gate endpoint unreachable/timed out — failing closed (D-024)'));
	} finally {
		clearTimeout(timer);
	}
}

// Any unexpected throw still resolves to an explicit DENY + exit 0.
main().catch(() => emit(deny('gate hook crashed — failing closed (D-024)')));
