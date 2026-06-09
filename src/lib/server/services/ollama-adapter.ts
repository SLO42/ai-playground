// TASK 10.5 — Ollama ServiceAdapter (control surface for the local model server).
//
// Bridges the local Ollama server (D-003/D-014 — the gpt-oss + embedding slot) into the
// services manager's supervision loop so the /services page can surface its live health
// and start / stop / restart it (UI-SPEC §210). Ollama is a long-lived local HTTP server
// on 127.0.0.1:11434 (D-025 loopback). Unlike SurrealDB we do NOT own a verified binary
// for it — it is an operator-installed tool on PATH — so this adapter is honest about that:
//
//   health()  → a bounded HTTP probe of the `/api/version` endpoint (the real liveness
//               signal; works whether Ollama was started by us or externally).
//   pid()     → the pid WE spawned (start()), else discovered via the OS (tasklist on
//               Windows / pgrep on POSIX) so an externally-started Ollama is still
//               supervisable + stoppable. null when no ollama process is found.
//   start()   → spawn `ollama serve` (detached, shell:true on Windows for PATH lookup) and
//               wait until the HTTP probe passes. Honest failure if the binary is absent.
//   stop()    → Windows-safe taskkill / POSIX SIGTERM of the discovered pid (F-001/F-002).
//
// All process work goes through proc.ts (Windows-safe, never process.kill(pid,0) — F-001).

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { killPid } from './proc';
import type { ServiceAdapter, ServiceName } from './manager';

const execFileP = promisify(execFile);
const isWindows = process.platform === 'win32';

/** Default loopback Ollama base url (D-003/D-025 — NO `/v1` suffix per CLAUDE.md). */
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

/**
 * Coerce a configured Ollama host into a valid CLIENT base url for the health probe.
 *
 * `OLLAMA_HOST` is OVERLOADED: Ollama itself uses it as the server's BIND address
 * (commonly `0.0.0.0:11434`, often with no scheme), while this adapter uses it as the
 * client URL it fetches. Two failure modes follow from feeding the bind value straight
 * to global `fetch`:
 *   1. NO SCHEME (`0.0.0.0:11434`) → global fetch treats it as a RELATIVE url and throws
 *      "Cannot use relative URL … with global fetch" → health() catches → false negative.
 *   2. `0.0.0.0` / `::` are bind-ALL addresses you cannot CONNECT to — they must be
 *      rewritten to a loopback connect address (D-025 loopback-only).
 * This normalizer makes the live probe tell the truth regardless of the bind-style env
 * value: it adds an `http://` scheme when absent and rewrites unroutable bind hosts to
 * `127.0.0.1`, then strips any trailing slash.
 */
export function normalizeClientHost(raw: string): string {
	let h = (raw ?? '').trim();
	if (!h) return DEFAULT_OLLAMA_HOST;
	// Add a scheme if missing so the value parses as an absolute url (else fetch sees it
	// as relative and throws). Default to http (loopback, plaintext — D-025).
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

export interface OllamaAdapterOptions {
	/** Base url for the health probe (loopback). Defaults to 127.0.0.1:11434. */
	host?: string;
	/** The binary/command to spawn for `serve` (defaults to `ollama` on PATH). */
	binary?: string;
	/** Health-probe timeout per attempt (ms). */
	probeTimeoutMs?: number;
}

/**
 * A {@link ServiceAdapter} for the local Ollama server. Loopback-only. Safe to
 * stop/restart from the operator surface — the dashboard does NOT depend on Ollama
 * for its own request path (it is the cheap/offline model slot, D-003), so acting on
 * it never severs the control plane (contrast SurrealDB, which the dashboard reads from).
 */
export class OllamaServiceAdapter implements ServiceAdapter {
	readonly name: ServiceName = 'ollama';
	private readonly host: string;
	private readonly binary: string;
	private readonly probeTimeoutMs: number;
	/** The pid WE spawned via start(), if any. Discovery fills the gap otherwise. */
	private spawnedPid: number | null = null;

	constructor(opts: OllamaAdapterOptions = {}) {
		this.host = normalizeClientHost(opts.host ?? DEFAULT_OLLAMA_HOST);
		this.binary = opts.binary ?? 'ollama';
		this.probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
	}

	/** True iff the Ollama HTTP API answers `/api/version` within the probe timeout. */
	async health(): Promise<boolean> {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), this.probeTimeoutMs);
		try {
			const res = await fetch(`${this.host}/api/version`, { signal: ctrl.signal });
			return res.ok;
		} catch {
			return false;
		} finally {
			clearTimeout(t);
		}
	}

	/**
	 * The current Ollama pid: the one we spawned if it is still recorded, else the OS
	 * process discovered by name (so an externally-launched Ollama is still controllable).
	 * Returns null when no ollama process is found. Best-effort, never throws.
	 */
	pid(): number | null {
		// Synchronous contract (ServiceAdapter.pid) — return the spawned pid synchronously;
		// discovery is async and used by stop(). Callers needing discovery use discoverPid().
		return this.spawnedPid;
	}

	/** Async OS discovery of the running ollama pid (Windows tasklist / POSIX pgrep). */
	async discoverPid(): Promise<number | null> {
		if (this.spawnedPid != null) return this.spawnedPid;
		try {
			if (isWindows) {
				// CSV, no header — first column is the image name, second the pid.
				const { stdout } = await execFileP('tasklist', [
					'/FI',
					'IMAGENAME eq ollama.exe',
					'/FO',
					'CSV',
					'/NH'
				]);
				const line = stdout.split(/\r?\n/).find((l) => l.toLowerCase().includes('ollama'));
				if (!line) return null;
				const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
				const pid = Number(cols[1]);
				return Number.isInteger(pid) && pid > 0 ? pid : null;
			}
			const { stdout } = await execFileP('pgrep', ['-x', 'ollama']);
			const pid = Number(stdout.trim().split(/\s+/)[0]);
			return Number.isInteger(pid) && pid > 0 ? pid : null;
		} catch {
			return null;
		}
	}

	/**
	 * Spawn `ollama serve` and wait until the HTTP probe passes. Detached + shell:true on
	 * Windows so the `ollama` PATH lookup works and the server outlives this call. Throws an
	 * honest error if the binary is missing or never becomes healthy (surfaced to the operator).
	 */
	async start(timeoutMs = 15_000): Promise<void> {
		if (await this.health()) {
			// Already up (possibly externally started) — record the discovered pid + done.
			this.spawnedPid = await this.discoverPid();
			return;
		}
		const child = spawn(this.binary, ['serve'], {
			windowsHide: true,
			detached: !isWindows,
			stdio: 'ignore',
			shell: isWindows
		});
		// A spawn error (ENOENT — binary not on PATH) rejects start() honestly.
		const spawnErr = new Promise<never>((_, reject) => {
			child.once('error', (e) => reject(new Error(`cannot start ollama: ${e.message}`)));
		});
		child.unref();

		const healthy = (async () => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (await this.health()) {
					this.spawnedPid = child.pid ?? (await this.discoverPid());
					return;
				}
				await new Promise((r) => setTimeout(r, 400));
			}
			throw new Error(`ollama did not become healthy within ${timeoutMs}ms`);
		})();

		await Promise.race([spawnErr, healthy]);
	}

	/**
	 * Stop the running Ollama process (Windows-safe taskkill /F /T — F-002). Discovers the
	 * pid if we did not spawn it. Idempotent: a no-op when no process is found.
	 */
	async stop(): Promise<void> {
		const pid = await this.discoverPid();
		if (pid != null) await killPid(pid);
		this.spawnedPid = null;
	}
}
