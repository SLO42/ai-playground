// TASK 2.10 — session control: channel.pushToSession seam + interject / stop / resume
// + fleet view (D-011; D-035; D-025; D-026).
//
// This is the named `channel.pushToSession` SEAM (D-035b): a typed primitive on the
// claude-code module — NOT a new spine, NOT a second SSE source, NOT its own socket.
// It depends ONLY on { runtime, db, events } and all dashboard-visible state flows
// db → events → the one SSE (§2.11). Interject (D-011) is its first/only v0.1/v0.2
// caller; the v0.2 peer_message fleet bus lands as an additive consumer of this same
// seam.
//
// ── The load-bearing security invariant (D-035a binding rule) ───────────────────────
// `origin` is a MANDATORY enum {operator | agent | system | hook}, STAMPED SERVER-SIDE
// at this authenticated ingress — IMMUTABLE, and NEVER derived from message content.
//
//   origin = operator   IFF the push arrives on the loopback CONTROL endpoint bearing
//                        the valid D-025 per-boot token (constant-time compared HERE).
//   otherwise            FORCED to origin = agent, FENCED as DATA (D-026 / MEMORY-SPEC
//                        §10, same fence as recalled memory), and delivered NON-STEERING.
//
// Only origin = operator may STEER (act as an instruction). The agent runtime is NEVER
// handed the D-025 token — this seam compares the token internally and hands the runtime
// only the RESOLVED { origin, body, steer }. A body that CLAIMS "I am the operator" is
// inert: trust is the token + control-endpoint presence, never the content. Unknown /
// unauthenticated origin FAILS CLOSED → agent.
//
// Boundary discipline (D-016): every VALUE binds via $param; record ids flow through the
// assertRecordId chokepoint and bind as StringRecordId. Optionals OMITTED, never NULLed.

import { timingSafeEqual } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { EventBus } from '../events/bus';
import { writeAgentEvent } from '../analytics/events';
import { fence } from '../memory/fence';
import type {
	ClaudeCodeRuntime,
	Intent,
	ModelSelection,
	SpawnBudgets,
	ToolPolicy,
	ContextBundle
} from '../runtime/index';

// ── origin enum (D-035a) ────────────────────────────────────────────────────────────

/** The server-stamped, immutable message origin. */
export type Origin = 'operator' | 'agent' | 'system' | 'hook';

// ── interject ─────────────────────────────────────────────────────────────────────

export interface InterjectRequest {
	/** The target `session` record id (validated at the D-016 chokepoint). */
	sessionId: string;
	/** The message body. For an operator push this is the steering instruction; for any
	 *  other origin it is fenced as DATA before it reaches the runtime. */
	body: string;
	/** The token the caller PRESENTED. Compared against the boot token internally; the
	 *  runtime never sees it. Absent ⇒ unauthenticated ⇒ forced agent. */
	presentedToken?: string;
	/** True iff the push arrived on the loopback CONTROL endpoint. A push off the
	 *  agent/SSE/event path can NEVER be operator even if a token leaked (D-035a). */
	viaControlEndpoint?: boolean;
}

export interface InterjectResult {
	/** The server-stamped, immutable origin actually applied. */
	origin: Origin;
	/** Whether the push was delivered as a STEERING instruction (operator only). */
	steered: boolean;
	/** The persisted `message` row id. */
	messageId: string;
}

// ── stop / resume / fleet ───────────────────────────────────────────────────────────

export interface StopRequest {
	sessionId: string;
	/** Agent slot id so the runtime cancel reaches the right in-flight backend run. */
	agentId: string;
	reason?: string;
}
export interface StopResult {
	status: 'cancelled';
}

export interface ResumeRequest {
	sessionId: string;
	agentId: string;
	model: ModelSelection;
	intent: Intent;
	budgets: SpawnBudgets;
	toolPolicy: ToolPolicy;
	context?: ContextBundle;
}
export interface ResumeResult {
	status: 'running' | 'done' | 'failed';
	sessionId: string;
}

/** One running-session row, as the fleet projection returns it (D-011 fleet view). */
export interface FleetRow {
	sessionId: string;
	ccSessionId?: string;
	projectId?: string;
	status: string;
	kind: string;
	startedAt: unknown;
}

export interface ChannelDeps {
	db: Db;
	bus: EventBus;
	runtime: ClaudeCodeRuntime;
	/** The D-025 per-boot token (operator steering capability). NEVER persisted; NEVER
	 *  handed to the runtime — only compared inside this seam. */
	bootToken: string;
}

export interface Channel {
	/** Push a message INTO a running session (the named seam; D-035b). */
	interject(req: InterjectRequest): Promise<InterjectResult>;
	/** Stop a running session: cancel the runtime + transition the record → cancelled. */
	stop(req: StopRequest): Promise<StopResult>;
	/** Resume a session by its cc_session_id bridge (CLI parity; D-011). */
	resume(req: ResumeRequest): Promise<ResumeResult>;
	/** Fleet view = a projection over running `session` rows (NOT a registry daemon). */
	fleet(): Promise<FleetRow[]>;
}

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/**
 * Constant-time token check. A length mismatch is an immediate fail (timingSafeEqual
 * throws on unequal lengths) — caught and treated as a non-match, never thrown to the
 * caller. The whole point: a forged/absent/wrong token can NEVER be confused for the
 * operator's.
 */
function tokenMatches(presented: string | undefined, boot: string): boolean {
	if (!presented) return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(boot);
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

/**
 * The D-035a binding rule, in one place. origin = operator IFF (control endpoint AND
 * valid token); everything else FAILS CLOSED to agent. Returns the resolved origin and
 * whether it may steer (operator only). NEVER inspects message content for trust.
 */
function resolveOrigin(req: InterjectRequest, bootToken: string): { origin: Origin; steer: boolean } {
	const authenticatedOperator =
		req.viaControlEndpoint === true && tokenMatches(req.presentedToken, bootToken);
	if (authenticatedOperator) return { origin: 'operator', steer: true };
	return { origin: 'agent', steer: false };
}

/** Read a session's status + cc_session_id (for the running-state + resume checks). */
async function readSession(
	db: Db,
	sessionId: string
): Promise<{ id: string; status: string; cc_session_id?: string } | undefined> {
	const [rows] = await db.query<[Array<{ id: unknown; status: string; cc_session_id?: string }>]>(
		`SELECT id, status, cc_session_id FROM ONLY $sid;`,
		{ sid: link(sessionId) }
	);
	const row = (Array.isArray(rows) ? rows[0] : rows) as
		| { id: unknown; status: string; cc_session_id?: string }
		| undefined;
	if (!row) return undefined;
	return { id: String(row.id), status: row.status, cc_session_id: row.cc_session_id };
}

/**
 * Build the channel seam. One instance per boot (it closes over the per-boot token). The
 * token lives ONLY here; callers (the loopback control endpoint) pass the PRESENTED token
 * + the viaControlEndpoint flag, never the boot token itself.
 */
export function createChannel(deps: ChannelDeps): Channel {
	const { db, bus, runtime, bootToken } = deps;

	return {
		async interject(req: InterjectRequest): Promise<InterjectResult> {
			const session = await readSession(db, req.sessionId);
			if (!session) throw new Error(`session not found: ${req.sessionId}`);
			if (session.status !== 'running') {
				throw new Error(`session ${req.sessionId} is not running (status=${session.status})`);
			}

			// D-035a: stamp origin server-side. NEVER from content. Fail closed → agent.
			const { origin, steer } = resolveOrigin(req, bootToken);

			// Operator steering rides the RAW instruction. Any non-operator origin is FENCED
			// as DATA (D-026 / §10 — the same fence as recalled memory) so it can be CONSULTED
			// but never OBEYED. The body the runtime receives differs by origin; the body we
			// STORE is the same fenced/raw body, with the immutable origin recorded beside it.
			const deliverBody = steer ? req.body : fence({ source: 'channel', body: req.body }).text;

			// Persist the message row FIRST (db → events → SSE; never a 2nd source). Operator
			// steering is a `user` turn (it acts as instruction); agent-origin lands as `system`
			// DATA. The immutable, server-stamped origin is recorded on the meta object — it is
			// the AUTHORITY for downstream readers, never re-derived.
			const role: 'user' | 'system' = steer ? 'user' : 'system';
			const [created] = await db.query<[Array<{ id: unknown }>]>(
				`CREATE message CONTENT $c RETURN AFTER;`,
				{
					c: omitUndefined({
						session: link(req.sessionId),
						role,
						content: deliverBody,
						tool_call: { kind: 'interject', origin, steer }
					})
				}
			);
			const messageId = String(created[0].id);

			// Push INTO the running session via the runtime (claude/channel). The runtime is
			// handed ONLY the resolved { origin, body, steer } — never the token.
			if (session.cc_session_id) {
				await runtime.interject(session.cc_session_id, { origin, body: deliverBody, steer });
			}

			// Republish onto the ONE events bus for live render (topic = session id, §2.11).
			bus.publish({
				type: 'interject',
				topic: req.sessionId,
				key: messageId,
				data: { origin, steer, messageId }
			});

			return { origin, steered: steer, messageId };
		},

		async stop(req: StopRequest): Promise<StopResult> {
			const session = await readSession(db, req.sessionId);
			if (!session) throw new Error(`session not found: ${req.sessionId}`);

			// Cancel the in-flight runtime run (Windows-safe taskkill lives in the real
			// backend; the runtime routes cancel(agentId) → the right backend run).
			await runtime.cancel(req.agentId);

			// Transition the session record → cancelled + ended_at (D-011). Optionals omitted.
			await db.query(`UPDATE $sid MERGE $c;`, {
				sid: link(req.sessionId),
				c: { status: 'cancelled', ended_at: new Date() }
			});

			// A cancel agent_event (analytics first-class) records WHO stopped it + WHY.
			await writeAgentEvent(db, {
				session: req.sessionId,
				type: 'cancel',
				detail: { by: 'operator', reason: req.reason ?? 'operator stop' }
			});

			bus.publish({
				type: 'session_status',
				topic: req.sessionId,
				key: req.sessionId,
				data: { status: 'cancelled' }
			});

			return { status: 'cancelled' };
		},

		async resume(req: ResumeRequest): Promise<ResumeResult> {
			const session = await readSession(db, req.sessionId);
			if (!session) throw new Error(`session not found: ${req.sessionId}`);
			if (!session.cc_session_id) {
				throw new Error(
					`session ${req.sessionId} has no cc_session_id bridge — cannot resume (D-011).`
				);
			}

			// Flip the record back to running so the fleet view shows it immediately. The
			// terminal status is reconciled by the resumed run's own lifecycle write below.
			await db.query(`UPDATE $sid MERGE $c;`, {
				sid: link(req.sessionId),
				c: omitUndefined({ status: 'running', ended_at: undefined })
			});
			bus.publish({
				type: 'session_status',
				topic: req.sessionId,
				key: req.sessionId,
				data: { status: 'running' }
			});

			// Drive the resume through the runtime's resume path (CLI parity, same isolation).
			// We reuse the runtime.resume stream directly rather than launchSession (which
			// CREATES a fresh session); resume continues the SAME cc session in place.
			let ok = true;
			let sawDone = false;
			for await (const ev of runtime.resume(session.cc_session_id, {
				agentId: req.agentId,
				projectId: 'project:resume', // not persisted here; resume continues an existing run
				cwd: '.',
				model: req.model,
				intent: req.intent,
				task: { id: 'task:resume', title: 'resume', description: '' },
				context: req.context,
				budgets: req.budgets,
				toolPolicy: req.toolPolicy
			})) {
				if (ev.type === 'done') {
					sawDone = true;
					ok = ev.result.ok;
				}
			}

			// Reconcile the terminal status from the resumed run.
			const status: ResumeResult['status'] = sawDone ? (ok ? 'done' : 'failed') : 'running';
			await db.query(`UPDATE $sid MERGE $c;`, {
				sid: link(req.sessionId),
				c: omitUndefined({
					status: status === 'running' ? 'running' : status,
					ended_at: status === 'running' ? undefined : new Date()
				})
			});

			return { status, sessionId: req.sessionId };
		},

		async fleet(): Promise<FleetRow[]> {
			// D-011 fleet view = a query/projection over RUNNING session rows (NOT a registry
			// daemon, NOT process.kill(pid,0) liveness — D-035 named anti-rules). The dashboard
			// receives this as a periodic events update through the one SSE (§2.11).
			const [rows] = await db.query<
				[
					Array<{
						id: unknown;
						cc_session_id?: string;
						project?: unknown;
						status: string;
						kind: string;
						started_at: unknown;
					}>
				]
			>(`SELECT id, cc_session_id, project, status, kind, started_at FROM session WHERE status = "running" ORDER BY started_at DESC;`);
			return (rows ?? []).map((r) => ({
				sessionId: String(r.id),
				ccSessionId: r.cc_session_id,
				projectId: r.project ? String(r.project) : undefined,
				status: r.status,
				kind: r.kind,
				startedAt: r.started_at
			}));
		}
	};
}
