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
import { existsSync } from 'node:fs';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { EventBus } from '../events/bus';
import { writeAgentEvent } from '../analytics/events';
import { fence } from '../memory/fence';
import { eventToMessage } from '../sessions/launch';
import type {
	ClaudeCodeRuntime,
	Intent,
	ModelSelection,
	SpawnBudgets,
	ToolPolicy,
	ContextBundle
} from '../runtime/index';

/**
 * TASK 14.6 — an honest "this backend cannot do that" refusal (F-008). Thrown BEFORE any
 * state is written when the wired backend did not declare the capability; the control
 * endpoint maps it to 501 so the UI can disable/explain the control instead of a stub
 * reporting false success.
 */
export class ControlNotSupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ControlNotSupportedError';
	}
}

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
	/** The operator's resume instruction — the next user message the resumed conversation
	 *  receives. Absent ⇒ a neutral "continue" instruction. */
	message?: string;
}
export interface ResumeResult {
	status: 'done' | 'failed';
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

/** Read a session's status + cc_session_id + project link (running-state/resume checks). */
async function readSession(
	db: Db,
	sessionId: string
): Promise<
	{ id: string; status: string; cc_session_id?: string; project?: string } | undefined
> {
	const [rows] = await db.query<
		[Array<{ id: unknown; status: string; cc_session_id?: string; project?: unknown }>]
	>(`SELECT id, status, cc_session_id, project FROM ONLY $sid;`, { sid: link(sessionId) });
	const row = (Array.isArray(rows) ? rows[0] : rows) as
		| { id: unknown; status: string; cc_session_id?: string; project?: unknown }
		| undefined;
	if (!row) return undefined;
	return {
		id: String(row.id),
		status: row.status,
		cc_session_id: row.cc_session_id,
		...(row.project ? { project: String(row.project) } : {})
	};
}

/**
 * The per-session continuation offset = MAX(existing seq for this session) + 1, so an APPENDED
 * turn (a resumed turn, an operator/agent interject) replays AFTER everything already persisted
 * instead of colliding at seq 0 and interleaving (m0037; the resume fix shipped at 6a22906).
 * `seq IS NOT NONE` excludes legacy pre-m0037 rows (their NONE seq must not anchor the offset);
 * math::max over [] is NONE → base 0. FAIL-OPEN (F-014): any read error falls back to 0 and logs
 * — a continuation-offset read must never break the append; worst case a turn sorts to the front.
 */
async function nextSeq(db: Db, sessionId: string): Promise<number> {
	try {
		const [maxRows] = await db.query<[Array<{ m: number | null }>]>(
			`SELECT math::max(seq) AS m FROM message WHERE session = $sid AND seq IS NOT NONE GROUP ALL;`,
			{ sid: link(sessionId) }
		);
		const prevMax = maxRows?.[0]?.m;
		if (typeof prevMax === 'number' && Number.isFinite(prevMax)) return prevMax + 1;
	} catch (seqErr) {
		console.warn(
			`[channel] seq continuation read failed for ${sessionId} (fail-open, base 0): ${(seqErr as Error).message}`
		);
	}
	return 0;
}

/** Read a project's root_path (the cwd a resumed session must run in — the CLI keys its
 *  conversation transcripts by cwd, so resume MUST re-anchor at the original root). */
async function readProjectRoot(db: Db, projectId: string): Promise<string | undefined> {
	const [rows] = await db.query<[Array<{ root_path?: string }>]>(
		`SELECT root_path FROM ONLY $pid;`,
		{ pid: link(projectId) }
	);
	const row = (Array.isArray(rows) ? rows[0] : rows) as { root_path?: string } | undefined;
	return row?.root_path || undefined;
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

			// TASK 14.6 (F-008) — fail-closed capability + bridge prechecks BEFORE any write.
			// The old path skipped delivery silently when the bridge was missing and still
			// returned success (and the only production backend was an unimplemented stub):
			// the UI showed a control that "worked" and did nothing. Now: not supported ⇒ an
			// honest refusal; no bridge ⇒ an honest "cannot reach the session" error.
			if (!runtime.capabilities().interject) {
				throw new ControlNotSupportedError(
					'interject is not supported by this backend — nothing was delivered'
				);
			}
			if (!session.cc_session_id) {
				throw new Error(
					`session ${req.sessionId} has no cc_session_id bridge yet — the interjection cannot reach the live session (retry once the session has reported its id)`
				);
			}

			// D-035a: stamp origin server-side. NEVER from content. Fail closed → agent.
			const { origin, steer } = resolveOrigin(req, bootToken);

			// Operator steering rides the RAW instruction. Any non-operator origin is FENCED
			// as DATA (D-026 / §10 — the same fence as recalled memory) so it can be CONSULTED
			// but never OBEYED. The body the runtime receives differs by origin; the body we
			// STORE is the same fenced/raw body, with the immutable origin recorded beside it.
			const deliverBody = steer ? req.body : fence({ source: 'channel', body: req.body }).text;

			// DELIVER FIRST (14.6/F-008): the persisted message row is the UI's evidence the
			// interjection reached the session, so it must exist IFF delivery really happened.
			// The runtime resolves only on real, acknowledged delivery (and is handed ONLY the
			// resolved { origin, body, steer } — never the token); a failed/unconfirmed push
			// throws here and NOTHING is persisted or published — never a false success.
			await runtime.interject(session.cc_session_id, { origin, body: deliverBody, steer });

			// Persist the message row (db → events → SSE; never a 2nd source). Operator
			// steering is a `user` turn (it acts as instruction); agent-origin lands as `system`
			// DATA. The immutable, server-stamped origin is recorded on the meta object — it is
			// the AUTHORITY for downstream readers, never re-derived.
			const role: 'user' | 'system' = steer ? 'user' : 'system';
			// APPEND, do not interleave (m0037; GA1 red-team): an interject MUST stamp a
			// continuation seq = MAX(existing seq)+1 — the old path omitted seq, so the schema
			// DEFAULT 0 collided with launch turn 0 and the interject sorted to the TOP of the
			// transcript (`ORDER BY seq ASC, at ASC` wove it in). MIRRORS the resume fix (6a22906).
			const seq = await nextSeq(db, req.sessionId);
			// Stamp `kind` EXPLICITLY rather than leaning on the schema DEFAULT 'assistant_text':
			// the interject is a pushed-in channel turn whose render authority is `origin` (the
			// classifier maps a non-agent origin → 'communication' regardless of kind), so we
			// record the row's role-shaped kind ('user' for an operator steer, 'system' for fenced
			// data) — NEVER the agent-prose default the bug relied on to look like the agent.
			const kind: 'user' | 'system' = role;
			const [created] = await db.query<[Array<{ id: unknown }>]>(
				`CREATE message CONTENT $c RETURN AFTER;`,
				{
					c: omitUndefined({
						session: link(req.sessionId),
						role,
						kind,
						seq,
						// m0038: stamp the server-RESOLVED origin as a FIRST-CLASS, immutable field —
						// the authority for downstream readers (it also stays in tool_call for the
						// existing render path). origin came from resolveOrigin (D-035a): operator IFF
						// authenticated control endpoint + valid token, else fail-closed agent. It is
						// NEVER read from req.body — a body that CLAIMS "I am the operator" lands here
						// with the resolved non-operator origin and remains non-steering.
						origin,
						content: deliverBody,
						tool_call: { kind: 'interject', origin, steer }
					})
				}
			);
			const messageId = String(created[0].id);

			// Republish onto the ONE events bus for live render (topic = session id, §2.11). The
			// payload carries the SERVER-STAMPED origin + the EXACT delivered body so the transcript
			// pages can append the interject as a communication turn the instant it streams (GA2),
			// identical to what a reload of the persisted row would show — never fabricated, never a
			// 2nd DB round-trip. `content` is `deliverBody` (raw for an operator steer, fenced-as-data
			// otherwise): the same body that was just persisted. origin is the authority (D-035a) — the
			// client only LABELS it, never re-derives.
			bus.publish({
				type: 'interject',
				topic: req.sessionId,
				key: messageId,
				data: { origin, steer, messageId, content: deliverBody }
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
			// TASK 14.6 (F-008) — fail-closed capability precheck BEFORE any state flip. The
			// old path flipped the row to 'running' and THEN hit the backend stub's throw,
			// stranding a phantom "running" session that never ran.
			if (!runtime.capabilities().resume) {
				throw new ControlNotSupportedError(
					'resume is not supported by this backend — the session was not restarted'
				);
			}
			// The CLI keys conversation transcripts by cwd: a resume MUST re-anchor at the
			// original project root or the conversation is unfindable (an honest error, but a
			// pointless spawn — refuse up front instead).
			if (!session.project) {
				throw new Error(
					`session ${req.sessionId} has no project link — no project root to resume in`
				);
			}
			const root = await readProjectRoot(db, session.project);
			if (!root) {
				throw new Error(
					`project ${session.project} has no root_path — cannot anchor the resumed session`
				);
			}
			// Honest pre-spawn check (F-016): a vanished root (e.g. a cleaned-up temp project)
			// is refused HERE — before any state flip, before a doomed spawn.
			if (!existsSync(root)) {
				throw new Error(`project root '${root}' no longer exists — cannot resume there`);
			}

			// Flip the record back to running so the fleet view shows it immediately. The
			// terminal status is reconciled on EVERY exit path below (incl. throws — 14.6).
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
			// Analytics first-class: the resume is a lifecycle step with its how/why recorded.
			await writeAgentEvent(db, {
				session: req.sessionId,
				project: session.project,
				type: 'spawn',
				model: req.model,
				detail: { reason: 'resume', cc_session_id: session.cc_session_id }
			});

			// Drive the resume through the runtime's resume path (CLI parity, same isolation).
			// We reuse the runtime.resume stream directly rather than launchSession (which
			// CREATES a fresh session); resume continues the SAME cc session in place — and
			// (14.6) persists the resumed turn's transcript exactly like a launched turn, so
			// the resumed work is visible/honest, not a status flip with an invisible run.
			let ok = true;
			let sawDone = false;
			let newCc: string | undefined;
			let streamError: Error | undefined;
			// m0037 replay order is PER-SESSION and monotonic. The launch path already filled
			// this session with seq 0,1,2,…; a resumed turn is APPENDED, so its seq MUST continue
			// from MAX(existing seq)+1 — NOT restart at 0 (which collided with a launch turn of the
			// same seq and let messages.ts `ORDER BY seq ASC, at ASC` interleave the resume INTO the
			// launch). Read the continuation offset ONCE here, before the stream — shared with the
			// interject path via nextSeq (same MAX+1, fail-open-to-0 rule, F-014).
			const baseSeq = await nextSeq(db, req.sessionId);
			try {
				let order = 0;
				for await (const ev of runtime.resume(session.cc_session_id, {
					agentId: req.agentId,
					projectId: session.project,
					// G-B (D-035a): a resumed session can also peer-send — pin its id into the spawn env.
					sessionId: req.sessionId,
					cwd: root,
					model: req.model,
					intent: req.intent,
					task: {
						id: req.sessionId,
						title: 'resume',
						description:
							req.message ?? 'Continue working on the task from where the session left off.'
					},
					context: req.context,
					budgets: req.budgets,
					toolPolicy: req.toolPolicy
				})) {
					// Live render via the ONE bus (§2.11), keyed like launchSession's transcript.
					bus.publish({
						type: 'transcript',
						topic: req.sessionId,
						key: `${req.sessionId}:resume:${order}`,
						data: { kind: ev.type, seq: order, event: ev }
					});
					order++;
					const msg = eventToMessage(ev);
					if (msg) {
						// m0037: stamp kind + the CONTINUED monotonic seq (baseSeq + this turn's local
						// index) so a resumed turn replays AFTER the original launch's turns instead of
						// colliding with them (its content/tool_call were already D-026-screened inside
						// eventToMessage). FAIL-OPEN (F-014): a transcript write error never breaks the
						// resumed session — log + swallow, the live bus already fired.
						const seq = baseSeq + (order - 1); // `order` was post-incremented after the bus publish
						try {
							await db.query(`CREATE message CONTENT $c;`, {
								c: omitUndefined({
									session: link(req.sessionId),
									role: msg.role,
									kind: msg.kind,
									// m0038: a resumed transcript turn is the driven agent's OWN output
									// (same self-turn class as the launch path) — origin='agent',
									// server-stamped, non-steering (D-035a), never derived from content.
									origin: 'agent',
									seq,
									content: msg.content,
									tool_call: msg.tool_call
								})
							});
						} catch (persistErr) {
							console.warn(
								`[channel] resume transcript persist failed for ${req.sessionId} (fail-open): ${(persistErr as Error).message}`
							);
						}
					}
					if (ev.type === 'done') {
						sawDone = true;
						ok = ev.result.ok;
						if (ev.result.ccSessionId) newCc = ev.result.ccSessionId;
					} else if (ev.type === 'error') {
						ok = false;
					}
				}
			} catch (err) {
				streamError = err instanceof Error ? err : new Error(String(err));
				ok = false;
			}

			// Reconcile the terminal status on EVERY path (14.6): a stream that ended without
			// `done` (CLI exit/`--resume` miss) or threw is an HONEST 'failed' — never a row
			// left 'running' forever. A resumed conversation may report a NEW cc session id
			// (the CLI forks on resume) — update the bridge so the NEXT control reaches it.
			const status: ResumeResult['status'] = sawDone && ok && !streamError ? 'done' : 'failed';
			await db.query(`UPDATE $sid MERGE $c;`, {
				sid: link(req.sessionId),
				c: omitUndefined({
					status,
					ended_at: new Date(),
					cc_session_id: newCc,
					note: streamError ? `resume failed: ${streamError.message}` : undefined
				})
			});
			bus.publish({
				type: 'session_status',
				topic: req.sessionId,
				key: req.sessionId,
				data: { status }
			});
			if (streamError) throw streamError;

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
