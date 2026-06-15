// The control-plane PEER-SEND endpoint (G-B; PEER-MESSAGE-SPEC; D-025/D-026/D-035a/D-036).
//
// scripts/peer-send-mcp.mjs — the stdio MCP server the G-B capability-wiring seam registers in a
// GRANTED session's isolated `.mcp.json` (tool-catalog.buildPeerSendMcpServer → the same
// --mcp-config delivery as memory-pull) — POSTs { to, body, hops? } here over LOOPBACK when a live
// agent invokes the `peer_send` tool. We authorize (D-025: per-boot token + loopback Origin/Host,
// the SAME authorizeHookRequest the gate/analytics/memory-pull endpoints use), resolve the SENDER
// SERVER-SIDE, and dispatch to sendPeer.
//
// THE LOCKED INVARIANT (D-035a — do NOT weaken). The SENDER identity is NEVER taken from the
// request BODY. It is the `x-atelier-session` header the MCP server set from its ATELIER_SESSION_ID
// env — a value pinned into the isolated spawn env by the server at launch (an agent cannot set its
// own env, same trust basis as CLAUDE_CONFIG_DIR). The endpoint reads the LIVE session row for that
// id (sendPeer → resolveSender) to learn the sender's role+project; a body that CLAIMS a different
// sender/origin is inert. The persisted message is origin=agent, FENCED as DATA, NON-STEERING.
//
// FAIL CLOSED / HONEST (F-008): an unauthorized caller → 401, no body leaked. A request with no
// server-resolved session → 400 (we will not stamp an unverifiable sender). A policy violation
// (cross-project), a bounds deny (budget/hops), a bad address → an honest ok:false with a NAMED
// reason the MCP server surfaces to the agent — never a fabricated success, never a silent drop.

import { json } from '@sveltejs/kit';
import { authorizeHookRequest } from '$lib/server/hooks';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { getBus, getBootToken, getRuntime } from '$lib/server/harness';
import { createChannel } from '$lib/server/claude-code';
import {
	sendPeer,
	type SendPeerResult,
	type DeliverLive,
	SendBudgetError,
	HopsExhaustedError,
	SenderResolutionError,
	PeerAddressError,
	CrossProjectError,
	PeerRepoError,
	IdempotencyError
} from '$lib/server/peer/send';
import { PEER_CLIENT_KEY_MAX } from '$lib/server/peer/repo';
import type { PeerAddress, ToKind } from '$lib/server/peer/resolve';
import type { RequestHandler } from './$types';

/** An honest failure result (F-008 — never a fabricated send). */
function errorResult(reason: string): { ok: false; error: string } {
	return { ok: false, error: reason };
}

const VALID_KINDS: ReadonlySet<string> = new Set(['session', 'role', 'pm', 'atelier']);

/**
 * Coerce the agent-controlled `to` object into a typed PeerAddress. The agent controls ONLY the
 * destination + body — NEVER the sender. Every field is defended: an unknown/absent kind is the
 * caller's error (the resolver throws PeerAddressError on a missing coordinate downstream). We map
 * the spec's `{ kind, ref }` flat form to the resolver's coordinate fields by kind:
 *   session → ref is the to_session id; role → ref is the to_role id (+ top-level project);
 *   pm → project (ref ignored); atelier → no coordinate.
 * Returns null when `kind` is not one of the four classes (a clean 400, not a resolver throw).
 */
function coerceAddress(to: unknown): PeerAddress | null {
	const t = (to && typeof to === 'object' ? to : {}) as Record<string, unknown>;
	const kind = typeof t.kind === 'string' ? t.kind : '';
	if (!VALID_KINDS.has(kind)) return null;
	const ref = typeof t.ref === 'string' ? t.ref : undefined;
	const project = typeof t.project === 'string' ? t.project : ref; // pm/role may carry project in either slot
	switch (kind as ToKind) {
		case 'session':
			return { kind: 'session', ...(ref ? { toSession: ref } : {}) };
		case 'role':
			return {
				kind: 'role',
				...(ref ? { toRole: ref } : {}),
				...(typeof t.project === 'string' ? { project: t.project } : {})
			};
		case 'pm':
			return { kind: 'pm', ...(project ? { project } : {}) };
		case 'atelier':
		default:
			return { kind: 'atelier' };
	}
}

export const POST: RequestHandler = async ({ request }) => {
	// D-025 auth — per-boot token + loopback Origin/Host. Fail-closed: a 401 with NO body.
	const auth = authorizeHookRequest(request.headers, process.env);
	if (!auth.ok) {
		return json(errorResult('unauthorized peer-send request (D-025)'), { status: 401 });
	}

	// D-035a — the SENDER is the server-controlled spawn-env header, NEVER the body. Absent ⇒ we
	// cannot stamp a verifiable sender → 400 (a spawn without ATELIER_SESSION_ID can't peer-send).
	const senderSessionId = request.headers.get('x-atelier-session')?.trim();
	if (!senderSessionId) {
		return json(
			errorResult('peer send: no authenticated sender session (x-atelier-session missing) — refused'),
			{ status: 400 }
		);
	}

	let body: unknown = null;
	try {
		body = await request.json();
	} catch {
		body = null; // shadow path — malformed body coerces to an empty send (resolver/repo handle it)
	}
	const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

	const address = coerceAddress(b.to);
	if (!address) {
		return json(errorResult('peer send: `to.kind` must be one of session|role|pm|atelier'));
	}
	const rawBody = typeof b.body === 'string' ? b.body : '';
	const hops = typeof b.hops === 'number' ? b.hops : undefined;
	const clientKey = typeof b.client_key === 'string' ? b.client_key : undefined;
	// Length-cap the agent-supplied idempotency token at the boundary (it lands in the indexed
	// dedup_key VALUE — an unbounded key bloats the UNIQUE index). A clean 400, not a deep throw.
	if (clientKey !== undefined && clientKey.length > PEER_CLIENT_KEY_MAX) {
		return json(
			errorResult(`peer send: client_key exceeds the ${PEER_CLIENT_KEY_MAX}-char cap`),
			{ status: 400 }
		);
	}

	const db = tryGetDb();
	if (!db) {
		return json(errorResult('peer bus unavailable: no database connection'));
	}

	// LIVE delivery seam (best-effort, fail-open — F-014). We wire channel.interject with NO operator
	// token + viaControlEndpoint:false, so the channel stamps origin=agent + steer=false by its OWN
	// fail-closed rule (D-035a): a peer push can NEVER steer. The channel persists the delivered
	// `message` row (origin=agent) → G-A renders it as a 'communication' turn (transcript visibility
	// is FREE). When the runtime is unavailable (no credential), we pass NO deliver fn → rows still
	// persist as pending and the recipient drains them later (honest, never a fake live push).
	let deliver: DeliverLive | undefined;
	const runtimeAvail = await getRuntime(db);
	if (runtimeAvail.available) {
		const channel = createChannel({
			db,
			bus: getBus(),
			runtime: runtimeAvail.runtime,
			bootToken: getBootToken()
		});
		deliver = async (recipientSessionId: string, fencedBody: string): Promise<boolean> => {
			// NON-STEERING by construction: no presentedToken, viaControlEndpoint:false ⇒ origin=agent,
			// steer=false. The body delivered is the EXACT screen()→fence() envelope the engine already
			// persisted (peer_message.body via repo.buildPeerBody — the ONE D-026 write-time chokepoint),
			// handed to us as `fencedBody`. We deliver it preFenced:true so the channel does NOT re-fence
			// (a second fence would nest two DATA blocks) — the delivered turn is BYTE-IDENTICAL to the
			// durable row. PM2: this removes the old second screen() call-site on the live path (the
			// divergence risk) — there is now ONE chokepoint, so a redact-class secret is redacted
			// identically in BOTH the recipient delivery AND the persisted row, with no path that can
			// drift. Quarantine-class bodies never reach here (sendPeer skips delivery when
			// persisted.status=='quarantined'). A throw/!running is fail-open at the call site.
			const res = await channel.interject({
				sessionId: recipientSessionId,
				body: fencedBody,
				viaControlEndpoint: false,
				preFenced: true
			});
			return res.origin === 'agent'; // delivered as a non-steering agent turn
		};
	}

	try {
		const result: SendPeerResult = await sendPeer(
			{ senderSessionId, address, body: rawBody, ...(hops !== undefined ? { hops } : {}), ...(clientKey ? { clientKey } : {}) },
			{ db, deliver, publish: (ev) => getBus().publish(ev) }
		);
		return json({ ok: true, ...result });
	} catch (err) {
		// EVERY ERROR HAS A NAME — map each to an honest ok:false the agent can act on. A 4xx for a
		// caller/policy fault; a generic ok:false (200) for an engine fault (the agent retries/abandons).
		if (err instanceof SenderResolutionError) return json(errorResult(err.message), { status: 400 });
		if (err instanceof CrossProjectError) return json(errorResult(err.message), { status: 403 });
		if (err instanceof SendBudgetError) return json(errorResult(err.message), { status: 429 });
		if (err instanceof HopsExhaustedError) return json(errorResult(err.message), { status: 400 });
		if (err instanceof PeerAddressError) return json(errorResult(err.message), { status: 400 });
		// A duplicate send (the sender's OWN client_key retry collided on the dedup index) is an
		// idempotent no-op the agent can treat as already-sent — a named 409, never a raw index leak.
		if (err instanceof IdempotencyError) return json(errorResult(err.message), { status: 409 });
		if (err instanceof PeerRepoError) return json(errorResult(err.message));
		return json(errorResult(`peer send failed: ${(err as Error).message}`));
	}
};
