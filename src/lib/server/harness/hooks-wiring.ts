// server/harness/hooks-wiring — wire the D-019 hook block into the driven session (TASK 8.4).
//
// The control-plane hook ingest (api/hooks/[event] → ingest.ts → agent_event) + the
// hook-proxy transport (scripts/hook-proxy.mjs) both exist and are unit-tested. The MISSING
// link that 8.4 closes: a real driven Claude Code session's isolated settings.json must
// actually CONTAIN the hook commands that invoke that proxy, or no lifecycle hook ever fires
// and the whole hook→agent_event observability path is dead for live sessions.
//
// This module is the PURE builder for that block. Given the env (HOOK_URL/HOOK_TOKEN, minted
// at boot in hooks.server.ts — D-025) and the proxy script's absolute path, it returns the
// Claude Code settings.json `hooks` map (the buildHookSettings shape) that getRuntime() threads
// onto every spawn's isolated --settings. No fs/spawn/network here — env + paths in, JSON out —
// so it is fully unit-testable and the wiring decision (firing vs honestly OFF) is verifiable.
//
// HONEST / BEST-EFFORT (F-008 / D-019): when HOOK_URL or HOOK_TOKEN is absent (no boot gate
// ran, e.g. a unit context), the block is undefined — the session spawns with NO hooks rather
// than a half-wired block that points nowhere. When present, the proxy itself still no-ops on
// any failure (server down/slow), so a wired-but-unreachable server never blocks the session.
//
// D-025 token discipline: the token is NEVER embedded in the settings.json command string (it
// would be readable off disk). It rides the spawned session's ENV — the CLI backend spawns with
// `...process.env`, and HOOK_TOKEN/HOOK_URL live there after the boot gate, so the inherited
// proxy reads both from its environment. buildHookSettings enforces this (token never serialized).

import { join } from 'node:path';
import { buildHookSettings, type HookSettings } from '../hooks/index';

/** Env the hook-wiring reads — the boot-minted loopback control-plane coordinates (D-025). */
export interface HookWiringEnv {
	/** Loopback base url of the control plane (informational — the proxy reads its own env). */
	HOOK_URL?: string;
	/** The per-boot D-025 token (informational here — NEVER baked into the command string). */
	HOOK_TOKEN?: string;
}

export interface BuildDrivenHookSettingsOptions {
	/** The control-plane env (HOOK_URL/HOOK_TOKEN). Injected so this stays pure/testable. */
	env: HookWiringEnv;
	/**
	 * Project root the proxy script path is resolved against (the running server's cwd in
	 * production). The proxy lives at `<root>/scripts/hook-proxy.mjs`. Injected for tests.
	 */
	projectRoot: string;
	/** Override the node binary that runs the proxy (default: the current process's node). */
	nodeBin?: string;
}

/**
 * Build the Claude Code settings.json `hooks` block for a DRIVEN session, or undefined when
 * the control plane is not wired (no HOOK_URL/HOOK_TOKEN — F-008 honest OFF rather than a
 * dead half-block). The returned block invokes `scripts/hook-proxy.mjs <event>` for each wired
 * lifecycle event; the proxy reads HOOK_URL/HOOK_TOKEN from the inherited env (D-025) and POSTs
 * the loopback ingest, no-opping on any failure (D-019). The token is NOT in the command string.
 */
export function buildDrivenHookSettings(
	opts: BuildDrivenHookSettingsOptions
): HookSettings | undefined {
	const baseUrl = opts.env.HOOK_URL?.trim();
	const token = opts.env.HOOK_TOKEN?.trim();
	// Honestly OFF when the boot gate has not surfaced the loopback coordinates: a session with
	// no hooks is correct (no observability) — never a block that points at nothing (F-008).
	if (!baseUrl || !token) return undefined;

	// The proxy is plain ESM run directly by node; resolve its absolute path under the server
	// root. A quoted path tolerates spaces in the install dir (Windows/MINGW lesson, MEMORY).
	const node = opts.nodeBin?.trim() || process.execPath;
	const scriptPath = join(opts.projectRoot, 'scripts', 'hook-proxy.mjs');
	const proxyCommand = `"${node}" "${scriptPath}"`;

	// buildHookSettings emits the per-event command-hook groups with per-hook timeouts and
	// NEVER serializes the token (it travels via env). baseUrl/token are accepted for the same
	// single-source contract but only the command shape lands in the block.
	return buildHookSettings({ proxyCommand, baseUrl, token });
}
