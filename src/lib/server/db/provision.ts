// SurrealDB production provisioning + lifecycle (TASK 0.b-pre).
// D-006: run SurrealDB as a managed local server binary, spawned on LOOPBACK,
// connected over ws://127.0.0.1 via the `surrealdb` JS SDK (no native addon).
// D-007: surrealkv backend for persistence. SEC-009: SHA-256-verify the binary
// before spawn, fail hard on mismatch. This is the production path; S0 was a
// throwaway spike. 3.5 hardens this lifecycle further.

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Surreal } from 'surrealdb';
import { SURREAL_BINARY_SHA256, verifyBinary } from './binary';

const execFileP = promisify(execFile);
const isWindows = process.platform === 'win32';

// Repo layout: this file is src/lib/server/db/provision.ts -> repo root is 4 up.
const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..', '..', '..', '..');

/** Absolute path to the pinned 2.6.5 server binary committed under bin/. */
export const SURREAL_BINARY_PATH = join(
	REPO_ROOT,
	'bin',
	'surreal-v2.6.5.windows-amd64.exe'
);

export interface SurrealServerOptions {
	/** Path to the server binary. Defaults to the committed pinned binary. */
	binaryPath?: string;
	/** Expected SHA-256 pin. Defaults to the canonical pinned hash. */
	expectedHash?: string;
	/** Data dir for the surrealkv store. Required for persistence. */
	dataDir: string;
	/** Bind address — MUST be loopback. `host:port`; port 0 = OS-assigned. */
	bind?: string;
	/** Initial root user (provisioning/migration only — D-026c). */
	username?: string;
	/** Initial root password. */
	password?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function parseBind(bind: string): { host: string; port: number } {
	// IPv6 not used here; v2 binds 127.0.0.1. Split on the LAST colon.
	const idx = bind.lastIndexOf(':');
	if (idx < 0) throw new Error(`Invalid bind address "${bind}" (need host:port)`);
	const host = bind.slice(0, idx);
	const port = Number(bind.slice(idx + 1));
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid bind port in "${bind}"`);
	}
	return { host, port };
}

/**
 * Managed SurrealDB server process. Loopback-only, surrealkv-backed.
 * Lifecycle: start() (verifies binary first, then spawns + waits healthy),
 * health(), stop(). All listeners bind 127.0.0.1 (D-025 startup assertion).
 */
export class SurrealServer {
	readonly binaryPath: string;
	readonly expectedHash: string;
	readonly dataDir: string;
	readonly host: string;
	private port: number;
	readonly username: string;
	readonly password: string;

	private child: ChildProcess | null = null;
	private _pid: number | null = null;

	constructor(opts: SurrealServerOptions) {
		this.binaryPath = opts.binaryPath ?? SURREAL_BINARY_PATH;
		this.expectedHash = opts.expectedHash ?? SURREAL_BINARY_SHA256;
		this.dataDir = opts.dataDir;
		const { host, port } = parseBind(opts.bind ?? '127.0.0.1:8000');
		// D-025: every listener binds loopback ONLY — assert at construction.
		if (!LOOPBACK_HOSTS.has(host)) {
			throw new Error(
				`SurrealServer bind host "${host}" is not loopback — refusing to expose a routable listener (D-025).`
			);
		}
		this.host = host;
		this.port = port;
		this.username = opts.username ?? 'root';
		this.password = opts.password ?? 'root';
	}

	get pid(): number | null {
		return this._pid;
	}

	get running(): boolean {
		return this._pid !== null && this.child !== null && this.child.exitCode === null;
	}

	/** ws:// RPC URL for the SDK. Reflects the bound port (after start if port 0). */
	get wsUrl(): string {
		return `ws://${this.host}:${this.port}/rpc`;
	}

	/**
	 * Verify the binary (fail hard on mismatch — SEC-009), then spawn the server
	 * on loopback with the surrealkv backend and wait until it accepts a ws://
	 * connection. Throws BinaryIntegrityError before any spawn on a bad binary.
	 */
	async start(timeoutMs = 30_000): Promise<void> {
		if (this.running) return;

		// 1. Integrity gate FIRST. On mismatch this throws — no process spawned.
		await verifyBinary(this.binaryPath, this.expectedHash);

		// 2. Resolve port (0 -> OS-assigned free loopback port).
		if (this.port === 0) this.port = await freeLoopbackPort();

		// 3. Spawn loopback-only, surrealkv backend. execFile-style arg array;
		//    shell:true on Windows so paths-with-spaces in the resolved binary
		//    don't break detached spawn (carried fail F-002).
		const args = [
			'start',
			'--no-banner',
			'--bind',
			`${this.host}:${this.port}`,
			'--username',
			this.username,
			'--password',
			this.password,
			`surrealkv://${this.dataDir}`
		];

		const child = spawn(this.binaryPath, args, {
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: isWindows
		});
		this.child = child;
		this._pid = child.pid ?? null;

		// Strict cleanup if the process dies during boot.
		let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
		child.once('exit', (code, signal) => {
			exited = { code, signal };
			this._pid = null;
		});

		try {
			await this.waitHealthy(timeoutMs, () => exited);
		} catch (err) {
			await this.stop().catch(() => {});
			throw err;
		}
	}

	/** True if a ws:// client can connect + auth right now. */
	async health(): Promise<boolean> {
		const db = new Surreal();
		try {
			await db.connect(this.wsUrl);
			await db.signin({ username: this.username, password: this.password });
			return true;
		} catch {
			return false;
		} finally {
			await db.close().catch(() => {});
		}
	}

	private async waitHealthy(
		timeoutMs: number,
		getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const exit = getExit();
			if (exit) {
				throw new Error(
					`SurrealDB server exited during startup (code=${exit.code}, signal=${exit.signal})`
				);
			}
			if (await this.health()) return;
			await delay(250);
		}
		throw new Error(
			`SurrealDB server did not become healthy on ${this.wsUrl} within ${timeoutMs}ms`
		);
	}

	/**
	 * Stop the server. Windows-safe: taskkill the process tree (F-001 — never
	 * process.kill(pid,0)); POSIX uses SIGTERM. Idempotent.
	 */
	async stop(): Promise<void> {
		const pid = this._pid;
		const child = this.child;
		this._pid = null;
		this.child = null;
		if (!pid) return;

		if (isWindows) {
			// /T kills the child tree (shell:true wraps the binary), /F forces.
			await execFileP('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
		} else {
			try {
				process.kill(pid, 'SIGTERM');
			} catch {
				/* already gone */
			}
		}
		// Best-effort: detach our handle.
		child?.removeAllListeners();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Ask the OS for a free loopback TCP port (bind :0, read, release). */
function freeLoopbackPort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		import('node:net')
			.then(({ createServer }) => {
				const srv = createServer();
				srv.once('error', reject);
				srv.listen(0, '127.0.0.1', () => {
					const addr = srv.address();
					const port =
						addr && typeof addr === 'object' ? addr.port : 0;
					srv.close(() => resolvePort(port));
				});
			})
			.catch(reject);
	});
}
