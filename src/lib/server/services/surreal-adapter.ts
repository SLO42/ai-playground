// TASK 3.5 — SurrealDB ServiceAdapter (wraps db/provision.ts SurrealServer).
//
// Bridges the managed SurrealDB server (the production-path SurrealServer — verified
// binary, loopback, surrealkv) into the services manager's supervision loop. start()
// re-spawns a FRESH server bound to the SAME address + data dir, so an auto-restart
// reconnects on the same ws:// url with the same persisted store. stop() delegates to
// SurrealServer.stop() which is Windows-safe (taskkill //F //PID //T — F-001/F-002).

import { SurrealServer, type SurrealServerOptions } from '../db/provision';
import type { ServiceAdapter, ServiceName } from './manager';

/**
 * A ServiceAdapter backed by a managed SurrealServer pinned to a FIXED bind address +
 * data dir (so restarts are stable + reconnectable). Pass a concrete `bind` (NOT
 * port 0) when you need the ws:// url to survive a restart.
 */
export class SurrealServiceAdapter implements ServiceAdapter {
	readonly name: ServiceName = 'surrealdb';
	private server: SurrealServer;

	constructor(private readonly opts: SurrealServerOptions) {
		this.server = new SurrealServer(opts);
	}

	/** The ws:// url of the (current) server — stable across restarts when bind is fixed. */
	get wsUrl(): string {
		return this.server.wsUrl;
	}

	async start(): Promise<void> {
		// A new server instance each spawn — the prior child is already gone (crash) or
		// stopped. Same opts → same bind + data dir → same reconnectable endpoint.
		if (!this.server.running) this.server = new SurrealServer(this.opts);
		await this.server.start();
	}

	async stop(): Promise<void> {
		await this.server.stop();
	}

	async health(): Promise<boolean> {
		return this.server.health();
	}

	pid(): number | null {
		return this.server.pid;
	}
}
