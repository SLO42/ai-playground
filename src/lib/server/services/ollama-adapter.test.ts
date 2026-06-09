// TASK 10.5-FIX — REAL OllamaServiceAdapter health()/discoverPid() coverage.
//
// The /services live false-negative ("probe: unreachable" for a healthy Ollama) was a
// defect on the REAL adapter probe path, NOT in the FakeAdapter used by runtime.test.ts.
// Root cause: `OLLAMA_HOST` is overloaded — the live process inherited Ollama's own BIND
// value `0.0.0.0:11434` (no scheme), and global `fetch` treats a scheme-less host as a
// RELATIVE url and throws → health() caught it → false. So this suite exercises the REAL
// adapter against a probe-only stub HTTP server (started here, killed after) covering:
//   • healthy-up   — the stub answers /api/version 200 → health() true
//   • down         — nothing listening (connection refused) → health() false
//   • timeout      — the stub stalls past the probe timeout → health() false (no hang)
//   • host normalization — a bind-style `0.0.0.0:PORT` (no scheme) probes the loopback
//     server truthfully (the exact regression), and a trailing slash / scheme-less host
//     are accepted. This is the path that misbehaved live.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OllamaServiceAdapter, normalizeClientHost } from './ollama-adapter';

let server: Server | null = null;

/** Start a probe-only stub HTTP server on an ephemeral loopback port; resolve its port. */
function startStub(handler: (path: string) => { status: number; delayMs?: number }): Promise<number> {
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			const { status, delayMs } = handler(req.url ?? '/');
			const send = () => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ version: '0.0.0-stub' }));
			};
			if (delayMs) setTimeout(send, delayMs);
			else send();
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server!.address();
			resolve(typeof addr === 'object' && addr ? addr.port : 0);
		});
	});
}

/** Stop the stub server (mandatory cleanup — F-014: kill every process/listener we start). */
function stopStub(): Promise<void> {
	return new Promise((resolve) => {
		if (!server) return resolve();
		server.close(() => resolve());
		server = null;
	});
}

afterEach(async () => {
	await stopStub();
});

describe('normalizeClientHost — the OLLAMA_HOST bind/connect overload (live false-negative root cause)', () => {
	it('adds a scheme to a scheme-less host (the exact "relative URL" bug)', () => {
		// `0.0.0.0:11434` with NO scheme is what global fetch rejected as relative.
		expect(normalizeClientHost('0.0.0.0:11434')).toBe('http://127.0.0.1:11434');
		expect(normalizeClientHost('127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
	});

	it('rewrites bind-all hosts (0.0.0.0 / ::) to loopback you can connect to', () => {
		expect(normalizeClientHost('http://0.0.0.0:11434')).toBe('http://127.0.0.1:11434');
		expect(normalizeClientHost('http://[::]:11434')).toBe('http://127.0.0.1:11434');
	});

	it('preserves a good host and strips a trailing slash', () => {
		expect(normalizeClientHost('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
		expect(normalizeClientHost('http://localhost:11434')).toBe('http://localhost:11434');
	});

	it('falls back to the loopback default for empty/garbage input', () => {
		expect(normalizeClientHost('')).toBe('http://127.0.0.1:11434');
		expect(normalizeClientHost('   ')).toBe('http://127.0.0.1:11434');
	});
});

describe('OllamaServiceAdapter.health() — REAL probe path against a stub server', () => {
	it('healthy-up: returns true when the server answers /api/version 200', async () => {
		const port = await startStub(() => ({ status: 200 }));
		const adapter = new OllamaServiceAdapter({ host: `http://127.0.0.1:${port}` });
		expect(await adapter.health()).toBe(true);
	});

	it('down: returns false when nothing is listening (connection refused)', async () => {
		// Bind then immediately release the port so it is almost certainly free → ECONNREFUSED.
		const port = await startStub(() => ({ status: 200 }));
		await stopStub();
		const adapter = new OllamaServiceAdapter({ host: `http://127.0.0.1:${port}` });
		expect(await adapter.health()).toBe(false);
	});

	it('timeout: returns false (no hang) when the server stalls past the probe timeout', async () => {
		const port = await startStub(() => ({ status: 200, delayMs: 500 }));
		const adapter = new OllamaServiceAdapter({ host: `http://127.0.0.1:${port}`, probeTimeoutMs: 100 });
		const t0 = Date.now();
		expect(await adapter.health()).toBe(false);
		// Proves the AbortController bound the wait (well under the server's 500ms stall).
		expect(Date.now() - t0).toBeLessThan(450);
	});

	it('a non-2xx response is reported unhealthy (honest)', async () => {
		const port = await startStub(() => ({ status: 503 }));
		const adapter = new OllamaServiceAdapter({ host: `http://127.0.0.1:${port}` });
		expect(await adapter.health()).toBe(false);
	});

	it('REGRESSION: a bind-style scheme-less 0.0.0.0:PORT host probes the live server truthfully', async () => {
		// This is the live defect: pass the bind value with NO scheme. Pre-fix this threw
		// "Cannot use relative URL" inside health() → false. Post-fix it normalizes to
		// loopback and the REAL probe sees the running stub.
		const port = await startStub(() => ({ status: 200 }));
		const adapter = new OllamaServiceAdapter({ host: `0.0.0.0:${port}` });
		expect(await adapter.health()).toBe(true);
	});
});

describe('OllamaServiceAdapter.discoverPid() — real OS discovery path, best-effort', () => {
	it('never throws and returns an integer pid or null', async () => {
		const adapter = new OllamaServiceAdapter({ host: 'http://127.0.0.1:11434' });
		const pid = await adapter.discoverPid();
		expect(pid === null || (Number.isInteger(pid) && pid > 0)).toBe(true);
	});
});
