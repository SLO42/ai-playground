// TASK 14.4e VERIFY — extraction write-path de-escape (audit-confirmed F-008).
//
// The live /memory surface rendered a stored row with literal escaped backslashes
// ("F:\\code\\ai-playground-v2") duplicating a clean row. Root cause: the local
// extraction model DOUBLE-ENCODED the JSON string contents of its reply, so after the
// one real JSON.parse the candidate content still carried `\\` pairs — and storeMemory
// faithfully persisted the artifact. These tests pin the write-path fix: parseExtraction
// collapses the doubled-backslash artifact (and ONLY that artifact — legitimate single
// backslashes and prose escapes are never touched).

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	EMBEDDING_MODEL,
	embeddingModelReady,
	parseExtraction,
	unescapeDoubleEncoded,
	resolveCapabilitiesForIntent
} from './wiring';
import { peerSendGranted, PEER_SEND_CAPABILITY_ID } from '../agent/tool-catalog';

// CONVERSATION-LAYER-SPEC (pillar 3) — the peer-send GRANT rides ONLY the conversation-purposeful
// WRITE intents (code-write / code-debug). These prove: the chosen intents carry the grant, others
// don't, and the resolved set reads peerSendGranted=true exactly for the granted intents. Uses the
// LIVE config/orchestration.yaml — code-write's `capabilities` block is intentionally empty (F-045),
// so the only capability a code-write spawn carries is the reserved peer-send grant added here.
describe('resolveCapabilitiesForIntent — peer-send grant on conversation-purposeful WRITE intents', () => {
	it('code-write is GRANTED peer-send (the reserved id rides the set; peerSendGranted=true)', () => {
		const caps = resolveCapabilitiesForIntent('code-write');
		expect(caps).toBeDefined();
		expect(caps!.skills).toContain(PEER_SEND_CAPABILITY_ID);
		expect(peerSendGranted(caps)).toBe(true);
	});

	it('code-debug is GRANTED peer-send (peerSendGranted=true)', () => {
		const caps = resolveCapabilitiesForIntent('code-debug');
		expect(peerSendGranted(caps)).toBe(true);
	});

	it('code-read / simple-question / deep-explore are NOT granted (peerSendGranted=false)', () => {
		for (const intent of ['code-read', 'simple-question', 'deep-explore'] as const) {
			const caps = resolveCapabilitiesForIntent(intent);
			expect(peerSendGranted(caps)).toBe(false);
			// The reserved id is absent from every dimension of a non-granted intent.
			expect((caps?.skills ?? []).includes(PEER_SEND_CAPABILITY_ID)).toBe(false);
		}
	});

	it('the grant is NOT duplicated and never mutates the bundle (idempotent shape)', () => {
		const a = resolveCapabilitiesForIntent('code-write');
		const b = resolveCapabilitiesForIntent('code-write');
		// Exactly one peer-send entry per resolve, and distinct array instances (no shared mutation).
		expect(a!.skills.filter((s) => s === PEER_SEND_CAPABILITY_ID).length).toBe(1);
		expect(a!.skills).not.toBe(b!.skills);
	});
});

describe('unescapeDoubleEncoded — the doubled-backslash artifact, and nothing else', () => {
	it('collapses \\\\ pairs when EVERY backslash is paired (the double-encoded signature)', () => {
		const overEscaped = 'Project root is F:\\\\code\\\\ai-playground-v2'; // literal \\ pairs
		expect(unescapeDoubleEncoded(overEscaped)).toBe('Project root is F:\\code\\ai-playground-v2');
	});

	it('leaves a CLEAN Windows path untouched (lone backslashes are real content)', () => {
		const clean = 'Project root is F:\\code\\ai-playground-v2';
		expect(unescapeDoubleEncoded(clean)).toBe(clean);
	});

	it('leaves prose with a lone backslash escape untouched', () => {
		const prose = 'split lines on \\n before parsing';
		expect(unescapeDoubleEncoded(prose)).toBe(prose);
	});

	it('leaves MIXED pairs-and-singles untouched (cannot prove double-encoding)', () => {
		const mixed = 'UNC \\\\server\\share'; // \\server is a pair, \share is a single
		expect(unescapeDoubleEncoded(mixed)).toBe(mixed);
	});

	it('is a no-op on backslash-free text', () => {
		expect(unescapeDoubleEncoded('nothing to do here')).toBe('nothing to do here');
	});
});

describe('parseExtraction — candidates come out de-escaped (the write-path fix)', () => {
	it('a double-encoded model reply yields the CLEAN fact, not the \\\\ artifact', () => {
		// Reconstruct the exact failure: the model intended `clean`, but escaped the JSON
		// string contents one extra time before the reply was serialized.
		const clean = 'Project root is F:\\code\\ai-playground-v2';
		const doubleEncoded = JSON.stringify([
			{ content: clean.replace(/\\/g, '\\\\'), kind: 'semantic' }
		]);
		const out = parseExtraction(doubleEncoded);
		expect(out).toHaveLength(1);
		expect(out[0].content).toBe(clean);
		expect(out[0].content).not.toContain('\\\\');
	});

	it('a correctly-encoded reply with a Windows path round-trips unchanged', () => {
		const clean = 'Build output lands in F:\\code\\x\\build';
		const reply = JSON.stringify([{ content: clean, kind: 'procedural' }]);
		const out = parseExtraction(reply);
		expect(out).toHaveLength(1);
		expect(out[0].content).toBe(clean);
		expect(out[0].kind).toBe('procedural');
	});

	it('still tolerates a non-JSON / empty reply (best-effort contract intact)', () => {
		expect(parseExtraction('no json here')).toEqual([]);
		expect(parseExtraction('[]')).toEqual([]);
	});
});

// ── embeddingModelReady — the three honest outcomes + no permanent latch (operator-hit bug) ──
//
// Operator hit this LIVE: a cold-boot fetch timeout to a busy Ollama made the probe report a
// PRESENT, exact-matching embedding model as absent ('has no qwen3-embedding:0.6b') and latched
// the memory loop OFF for the whole process. Root cause reproduced here against real local
// servers (a stub Ollama, a dead port, a hanging stub) — never a mocked fetch — so the timeout/
// unreachable path is the ACTUAL one exercised. The fix returns a 3-valued outcome instead of a
// bare boolean, so 'absent' (real "no model" answer) is never confused with 'unreachable'
// (refused/timeout), and a transient failure can recover on the very next probe.

describe('embeddingModelReady — present / absent / unreachable, never conflated', () => {
	const servers: http.Server[] = [];

	afterEach(async () => {
		// MANDATORY CLEANUP (F-014): tear down every server this block started.
		await Promise.all(
			servers.splice(0).map(
				(s) => new Promise<void>((resolve) => s.close(() => resolve()))
			)
		);
	});

	/** Start a local stub that answers /api/tags with the given handler, return its base URL. */
	async function startStub(handler: http.RequestListener): Promise<string> {
		const srv = http.createServer(handler);
		servers.push(srv);
		await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
		const { port } = srv.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	it("(a) PRESENT — Ollama reachable and the model exact-matches → 'present'", async () => {
		const base = await startStub((req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ models: [{ name: EMBEDDING_MODEL }, { name: 'gpt-oss:20b' }] }));
		});
		expect(await embeddingModelReady(base)).toBe('present');
	});

	it("(b) ABSENT — Ollama reachable but the model is NOT listed → 'absent' (the pull-hint case)", async () => {
		const base = await startStub((req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ models: [{ name: 'gpt-oss:20b' }] }));
		});
		expect(await embeddingModelReady(base)).toBe('absent');
	});

	it("(b') ABSENT — an EMPTY model list is a real answer of absence → 'absent', not 'unreachable'", async () => {
		const base = await startStub((req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ models: [] }));
		});
		expect(await embeddingModelReady(base)).toBe('absent');
	});

	it("(c) UNREACHABLE — connection refused (dead port) → 'unreachable', NEVER 'absent'", async () => {
		// Nothing listening here: fetch throws (ECONNREFUSED). This is the bug's shadow path —
		// the old bare-boolean code returned false and was reported as 'has no <model>'.
		const outcome = await embeddingModelReady('http://127.0.0.1:9');
		expect(outcome).toBe('unreachable');
	});

	it("(c') UNREACHABLE — a hanging Ollama that never responds → timeout → 'unreachable'", async () => {
		// The EXACT operator scenario: a cold Ollama busy loading a large model never answers in
		// time. The stub accepts the socket and hangs; AbortSignal.timeout fires → 'unreachable'.
		// (The probe's real 8s timeout makes this slow; we keep it as the faithful repro.)
		const base = await startStub(() => {
			/* hang forever — never write a response */
		});
		expect(await embeddingModelReady(base)).toBe('unreachable');
	}, 30_000);

	it("(c'') UNREACHABLE — a reachable Ollama answering a non-OK status is transient, not 'absent'", async () => {
		const base = await startStub((req, res) => {
			res.statusCode = 503;
			res.end('service unavailable');
		});
		expect(await embeddingModelReady(base)).toBe('unreachable');
	});

	it('RECOVERY — a transient unreachable does NOT latch: a later probe of a now-ready Ollama returns present', async () => {
		// First probe: dead endpoint → unreachable (memory loop would be OFF this call).
		expect(await embeddingModelReady('http://127.0.0.1:9')).toBe('unreachable');
		// Ollama comes up (cold-load finished). Because the probe is re-run per call and nothing
		// is latched, the next probe sees the model and returns present — the loop self-heals
		// WITHOUT a process restart (the operator's reported failure mode).
		const base = await startStub((req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ models: [{ name: EMBEDDING_MODEL }] }));
		});
		expect(await embeddingModelReady(base)).toBe('present');
	});
});
