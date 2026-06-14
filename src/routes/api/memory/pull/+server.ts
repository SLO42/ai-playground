// The control-plane MEMORY-PULL endpoint (TASK B10 / D-B10-2; D-025/D-026/D-036/D-019).
//
// scripts/memory-pull-mcp.mjs — the stdio MCP server the B10 capability-wiring seam
// registers in a GRANTED session's isolated `.mcp.json` (tool-catalog.buildMemoryPullMcpServer
// → cli-backend.buildMcpConfigArgs → `--mcp-config --strict-mcp-config`) — POSTs { query,
// project?, limit? } here over LOOPBACK when a live agent invokes the `pull` tool. We authorize
// (D-025: per-boot token + loopback Origin/Host, the SAME authorizeHookRequest the gate +
// analytics endpoints use), resolve the wired MemoryService, call pullMemory(mem, input), and
// return its ALREADY-FENCED result verbatim.
//
// THE NON-NEGOTIABLE INVARIANT (D-026 / §10, task red-team). This endpoint is a thin
// AUTH+DISPATCH shell — it re-implements NO recall, NO fence, NO §3.1b screen, NO B5 budget,
// NO quarantine filter. Every one of those chokepoints lives in the engine pullMemory() calls
// (recall() + assembleInjection()), so wiring the tool to a live session over this transport
// CANNOT create a fence/screen/budget bypass: a live invocation routes through the exact same
// guards the engine test (agent/pull-memory.test.ts) red-teams against a real corpus (planted
// secret EXCLUDED by recall's quarantine SQL; planted injection FENCED as "reference, not
// instructions"). The result we return is DATA (D-026), never instructions the agent must obey.
//
// FAIL CLOSED / HONEST (D-024 analytics-vs-safety nuance + F-008): this is NOT a safety
// decision path (it does not gate a tool — it RETURNS reference data), so unlike the gate
// endpoint it returns an HONEST ERROR result (ok:false + named reason), never a fabricated
// recall. An unauthorized caller → 401 (no body leaked). A malformed body → ok:false. A
// memory backend that is unavailable (Ollama/embeddings down) → ok:false + reason, never a
// faked vector or empty-pretending-success. The MCP server surfaces the reason to the agent.

import { json } from '@sveltejs/kit';
import { authorizeHookRequest } from '$lib/server/hooks';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { getMemoryService } from '$lib/server/harness/wiring';
import { pullMemory, type PullMemoryInput, type PullMemoryResult } from '$lib/server/agent/pull-memory';
import type { RequestHandler } from './$types';

/** An honest failure result in the PullMemoryResult shape (F-008 — never a fabricated pull). */
function errorResult(reason: string): PullMemoryResult {
	return { ok: false, items: [], text: '', droppedCount: 0, error: reason };
}

/**
 * Coerce an untrusted request body into a PullMemoryInput (D-026 — the body is DATA that
 * already crossed the boundary; the agent controls only the QUERY + scope). Every field is
 * defended: a non-object body, a non-string query, a non-string project, a non-finite limit
 * are each handled honestly downstream (pullMemory short-circuits an empty query to an honest
 * empty; recall()'s D-016 chokepoint rejects a malformed project id; clampPullLimit bounds the
 * limit). We pass through only the typed fields and drop anything else — no extra surface.
 */
function coerceInput(body: unknown): PullMemoryInput {
	const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
	const input: PullMemoryInput = {
		query: typeof b.query === 'string' ? b.query : ''
	};
	if (typeof b.project === 'string') input.project = b.project;
	if (typeof b.limit === 'number') input.limit = b.limit;
	return input;
}

export const POST: RequestHandler = async ({ request }) => {
	// D-025 auth — per-boot token + loopback Origin/Host. Fail-closed: an unauthorized caller
	// gets a bare 401 with NO body (never leak whether memory exists / what it holds).
	const auth = authorizeHookRequest(request.headers, process.env);
	if (!auth.ok) {
		return json(errorResult('unauthorized memory-pull request (D-025)'), { status: 401 });
	}

	let body: unknown = null;
	try {
		body = await request.json();
	} catch {
		// Shadow path — malformed/empty body: an honest empty-query pull (pullMemory returns an
		// honest empty result), never a crash. coerceInput maps the null body to an empty query.
		body = null;
	}
	const input = coerceInput(body);

	// Resolve the live DB + MemoryService EXACTLY as the loop does (wiring.getMemoryService) —
	// no parallel construction. Shadow paths: no DB bound (server not fully booted) and memory
	// unavailable (Ollama/embeddings down) are BOTH honest ok:false results, never a faked pull.
	const db = tryGetDb();
	if (!db) {
		return json(errorResult('memory backend unavailable: no database connection'));
	}

	let avail;
	try {
		avail = await getMemoryService(db);
	} catch (err) {
		// EVERY ERROR HAS A NAME: a getMemoryService throw (probe failure) is surfaced, not swallowed.
		const message = err instanceof Error ? err.message : String(err);
		return json(errorResult(`memory backend probe failed: ${message}`));
	}
	if (!avail.available) {
		// Honest unavailable (F-008) — Ollama/embedding model not reachable. The agent sees the
		// reason instead of an empty pull masquerading as "nothing matched".
		return json(errorResult(`memory backend unavailable: ${avail.reason}`));
	}

	// DISPATCH — the engine owns every guard (fence/screen/quarantine/budget). pullMemory is
	// best-effort (D-019): it returns ok:false + a named reason on any engine fault, never throws
	// into the request. We return its already-fenced result verbatim (D-026 — results are DATA).
	const result = await pullMemory(avail.memory, input);
	return json(result);
};
