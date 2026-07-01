// G-B — PEER_MESSAGE FLEET BUS: address resolution + recipient policy (PEER-MESSAGE-SPEC
// §2/§11; D-035a locked invariants).
//
// WHAT THIS IS. The PURE routing brain of the fleet bus: given an envelope (sender + a
// 4-class destination) and a snapshot of the running fleet, resolve WHICH concrete
// recipient session(s) a peer message reaches — and decide whether the policy even
// PERMITS that reach. It owns NO db I/O of its own; the caller (peer/repo.ts ingress)
// hands it a `FleetSnapshot` (the live session rows it already queried) and this module
// applies the §11 identity hierarchy + the in-project-mesh / cross-project-isolation
// policy as PURE functions. That makes every routing + policy ruling unit-testable
// without a DB and keeps the security decision in ONE auditable place.
//
// D-035a (LOCKED — do NOT weaken). A peer message is origin=agent → DATA, NON-STEERING.
// This module never grants steering: it only computes DELIVERY targets. Origin is stamped
// server-side at ingress and is NEVER derived from content or from anything here. No agent
// commands another agent — not even the atelier/platform identity, which coordinates via
// DATA (its orchestration is the gated CONTROL plane, a separate surface, never a peer
// message). Nothing in this resolver can elevate a peer message to a command.
//
// §11 IDENTITY HIERARCHY (steering authority, top→bottom):
//   operator        — the ONLY identity that steers (control endpoint + valid D-025 token);
//                     NOT a peer_message participant — out of scope for this resolver.
//   atelier         — the platform agent on the global memory/brain. The ONE cross-project
//                     identity: any project may message it, and it may reach across projects.
//                     D-040 self-hosting is NOT YET composed, so its concrete resolution is a
//                     DOCUMENTED PLACEHOLDER (resolveAtelier below) — honest, not fabricated.
//   project PM      — per-project, event-triggered → usually OFFLINE. A 'pm' address that has
//                     no running PM session resolves to ZERO live sessions → the message stays
//                     `pending` as an inbox item (NOT an error, NOT a fabricated session).
//   roles/sessions  — the running workers. 'role'@project → that role's running session(s) in
//                     that project; 'session' → one named session directly.
//
// CROSS-PROJECT ISOLATION (§spec): project↔project DIRECT messaging is FORBIDDEN — a NAMED
// error (CrossProjectError), not merely "no match". The ONLY permitted cross-project flow is
// to the 'atelier' identity. In-project mesh (a sender reaching peers + the PM in its OWN
// project) is permitted. The PM is the in-project hub.

import { assertRecordId } from '../db/validate';

// ── Named errors — every error has a name (what triggers it is in the message) ──

/** Bad routing input at the resolver boundary: a malformed/missing target coordinate for
 *  the given to_kind, or a malformed sender. Fail loud + named (never a silent drop, F-005). */
export class PeerAddressError extends Error {
	override readonly name = 'PeerAddressError';
}

/** The §spec isolation invariant tripped: a sender in project A addressed a recipient bound to
 *  project B (directly, or via a role/pm in B). FORBIDDEN — surfaced as its own named error so
 *  the ingress fails CLOSED and the caller can audit the attempt (not merely "0 recipients"). */
export class CrossProjectError extends Error {
	override readonly name = 'CrossProjectError';
}

// ── The 4 address classes (mirror the m0039 to_kind ASSERT) ─────────────────────

export type ToKind = 'session' | 'role' | 'pm' | 'atelier';

/** A peer-message destination. Exactly which coordinates are required depends on `kind`:
 *   session  → to_session (a concrete session id)
 *   role     → to_role + project (the role's running session(s) in that project)
 *   pm       → project (that project's PM identity)
 *   atelier  → (no coordinates — the singular platform identity)
 * Unused coordinates MUST be omitted; supplying a mismatched one is a PeerAddressError. */
export interface PeerAddress {
	kind: ToKind;
	toSession?: string;
	toRole?: string;
	project?: string;
}

/** The authenticated sender context — stamped server-side at ingress (D-035a), passed here as
 *  already-trusted facts. `project` is the sender's OWN project scope (null/undefined for a
 *  project-less session — e.g. a global/atelier session); it gates cross-project isolation. */
export interface PeerSender {
	session: string;
	role?: string | null;
	project?: string | null;
}

/** One running session as the resolver needs to see it — a minimal projection of the live
 *  `session` rows the caller queried. PURE input: the resolver does no I/O. */
export interface LiveSession {
	id: string;
	/** session.role (option<record<role>>) — null when the session has no role identity. */
	role: string | null;
	/** session.project (option<record<project>>) — null for a project-less session. */
	project: string | null;
	/** session.kind — chat/task/review/release/discussion/interview (DATA-MODEL §4.3). */
	kind: string;
	/**
	 * The `pm` identity this session is acting AS, when it is a PM session (option). There is no
	 * `session.pm` column TODAY (PM sessions are launched via projects/pm-session.ts but not yet
	 * stamped with a pm link), so the loader leaves this null until that seam exists — a 'pm'
	 * address then honestly resolves to ZERO live sessions (the PM is event-triggered, usually
	 * OFFLINE) and the message inboxes as pending. Documented placeholder, never fabricated.
	 */
	pm: string | null;
}

/** The live-fleet snapshot the resolver fans an address out against. The caller assembles this
 *  from a single scoped `SELECT … FROM session WHERE status='running'` query (peer/repo.ts). */
export interface FleetSnapshot {
	/** All currently-running sessions (status='running'). */
	running: LiveSession[];
	/**
	 * The PM identity id for a project, when one exists (pm table, PM-SPEC — one per project). The
	 * caller maps project→pmId; the resolver matches a 'pm' address to a running session whose
	 * `pm` link equals that id. Absent project ⇒ the project has no PM identity (→ inbox/pending).
	 * The global/project-less platform PM (atelier_self's) is keyed under ATELIER_PROJECT_KEY for
	 * the §11 atelier placeholder.
	 */
	pmByProject?: Record<string, string | null>;
}

/** The resolution outcome. `sessions` is the (possibly EMPTY) set of concrete recipient session
 *  ids; an EMPTY set is an HONEST "no live recipient → stays pending as an inbox item" (F-008),
 *  NEVER an error. `note` records WHY it is empty (offline pm / no running role session) for the
 *  audit/explain surface. A policy violation throws (CrossProjectError) rather than returning. */
export interface Resolution {
	kind: ToKind;
	/** Concrete recipient session ids (deduped). Empty ⇒ inbox-only (pending), honestly. */
	sessions: string[];
	/** Honest reason the set is empty, or null when it has recipients. */
	note: string | null;
}

// ── Atelier placeholder (§11 — D-040 self-hosting not yet composed) ─────────────

/**
 * DOCUMENTED PLACEHOLDER (§11). The atelier identity is the platform agent on the global
 * memory/brain — conceptually atelier_self's PM + the brain. D-040 (the atelier self-hosting
 * its own composed identity) is NOT yet built, so there is no dedicated atelier *session* to
 * resolve to. Until D-040 lands, an 'atelier' address resolves to the running session(s) tagged
 * with the platform PM role on the global (project-less) scope, if any are up; otherwise it
 * inboxes as pending (the platform agent is event-triggered, usually offline — same shape as a
 * project PM). This is the HONEST resolution given the current composition — it fabricates no
 * session. When D-040 composes a real atelier identity, replace this lookup; the call site and
 * the policy (atelier is the one cross-project identity) do not change.
 *
 * `ATELIER_PROJECT_KEY` is the sentinel key under which `pmByProject` may carry the platform PM
 * identity for the project-less/global scope (the caller populates it from atelier_self's PM).
 */
export const ATELIER_PROJECT_KEY = '__atelier__';

/**
 * The atelier self-identity SENTINEL (D-040 self-hosting, Stage-1 concierge). The concierge's
 * project-LESS `atelier_self` session stamps this on `session.pm` (m0074) at CREATE, and
 * loadFleetSnapshot keys it under {@link ATELIER_PROJECT_KEY} in `pmByProject`, so `resolveAtelier`
 * resolves an 'atelier' address to that live session (and it inboxes as pending when none is up —
 * the concierge is EVENT-TRIGGERED, usually offline). It is a plain string (NOT a `record<pm>`)
 * because the `pm` table requires a `project` (m0029) — a project-less atelier PM cannot be a `pm`
 * row, so this sentinel names the singular global platform identity honestly instead.
 */
export const ATELIER_SELF_PM = 'pm:atelier_self';

function resolveAtelier(fleet: FleetSnapshot): Resolution {
	const atelierPm = fleet.pmByProject?.[ATELIER_PROJECT_KEY] ?? null;
	if (!atelierPm) {
		return {
			kind: 'atelier',
			sessions: [],
			note: 'atelier identity offline (D-040 self-hosting not yet composed — placeholder); message inboxes as pending'
		};
	}
	const sessions = fleet.running.filter((s) => s.pm === atelierPm).map((s) => s.id);
	return {
		kind: 'atelier',
		sessions: dedupe(sessions),
		note: sessions.length ? null : 'atelier identity has no running session; message inboxes as pending'
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function dedupe(ids: string[]): string[] {
	return [...new Set(ids)];
}

/** Validate a coordinate id at the D-016 chokepoint, re-surfaced as a PeerAddressError so a
 *  malformed target is a NAMED routing error (not a raw IdentifierError leaking the chokepoint). */
function reqId(label: string, id: unknown): string {
	if (typeof id !== 'string' || !id.trim()) {
		throw new PeerAddressError(`peer address: ${label} is required for this to_kind`);
	}
	try {
		return assertRecordId(id);
	} catch {
		throw new PeerAddressError(`peer address: ${label} is not a valid record id: ${JSON.stringify(id)}`);
	}
}

// ── Recipient policy (server-enforced, §spec) ───────────────────────────────────

/**
 * Enforce the §spec recipient policy for a resolved DESTINATION project against the SENDER's
 * project. Throws CrossProjectError when the flow crosses a project boundary illegally:
 *   • in-project (sender.project === destProject)        → PERMITTED.
 *   • sender project-less / dest project-less, non-atelier→ treated per the rules below.
 *   • cross-project DIRECT (session/role/pm in another project) → FORBIDDEN.
 * The 'atelier' class is exempt (its own resolver path; it is the one cross-project identity)
 * and never calls this. `destProject` may be null when the destination has no project scope.
 */
function assertInProject(sender: PeerSender, destProject: string | null, kindLabel: string): void {
	const senderProject = sender.project ?? null;
	// In-project mesh: identical scope (including both project-less, e.g. two global sessions).
	if (senderProject === destProject) return;
	// Any mismatch across project boundaries is the forbidden cross-project direct flow.
	throw new CrossProjectError(
		`cross-project peer message FORBIDDEN: sender project ${senderProject ?? '(none)'} → ` +
			`${kindLabel} in project ${destProject ?? '(none)'} (only the 'atelier' identity may cross projects)`
	);
}

// ── The resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve a peer-message address to concrete recipient session(s), enforcing the §spec recipient
 * policy server-side. PURE: no I/O — it reads only the passed snapshot. Behaviour by class:
 *
 *   'session' — direct. The named session must be running; cross-project is FORBIDDEN (its
 *               project must match the sender's, unless atelier — sessions are not atelier).
 *   'role'    — role@project: the role's RUNNING session(s) in that project. In-project only.
 *               Zero running → empty set + note (inbox/pending), NOT an error.
 *   'pm'      — project PM identity: the running session carrying that project's PM role. In-
 *               project only. Usually OFFLINE → empty set + note (inbox/pending), NOT an error.
 *   'atelier' — the platform identity (placeholder, §11). The ONE cross-project-permitted class;
 *               any sender may reach it. Offline → empty set + note (pending).
 *
 * SHADOW PATHS: nil/empty coordinate → PeerAddressError (named); empty fleet → empty set + note;
 * cross-project → CrossProjectError (named, fail-closed). Unknown to_kind → PeerAddressError.
 */
export function resolveAddress(
	address: PeerAddress,
	sender: PeerSender,
	fleet: FleetSnapshot
): Resolution {
	if (!address || typeof address !== 'object') {
		throw new PeerAddressError('peer address: missing address');
	}
	if (!sender || typeof sender.session !== 'string' || !sender.session.trim()) {
		throw new PeerAddressError('peer address: missing authenticated sender session');
	}

	switch (address.kind) {
		case 'session': {
			const target = reqId('to_session', address.toSession);
			const match = fleet.running.find((s) => s.id === target);
			// A direct address to a non-running (or unknown) session: honest empty inbox item, not a
			// crash — the recipient may simply not be up. We still cannot policy-check a session we
			// cannot see, so when present we enforce in-project; when absent it inboxes as pending.
			if (!match) {
				return {
					kind: 'session',
					sessions: [],
					note: 'target session is not running; message inboxes as pending'
				};
			}
			assertInProject(sender, match.project, 'session');
			return { kind: 'session', sessions: [match.id], note: null };
		}

		case 'role': {
			const role = reqId('to_role', address.toRole);
			const project = reqId('project', address.project);
			assertInProject(sender, project, 'role');
			const sessions = fleet.running
				.filter((s) => s.role === role && s.project === project)
				.map((s) => s.id);
			return {
				kind: 'role',
				sessions: dedupe(sessions),
				note: sessions.length ? null : 'no running session for that role in the project; message inboxes as pending'
			};
		}

		case 'pm': {
			const project = reqId('project', address.project);
			assertInProject(sender, project, 'pm');
			const pmId = fleet.pmByProject?.[project] ?? null;
			if (!pmId) {
				// The project has no PM identity at all → honest pending inbox (the hub may be unhired).
				return {
					kind: 'pm',
					sessions: [],
					note: 'project has no PM identity (or PM offline); message inboxes as pending'
				};
			}
			const sessions = fleet.running
				.filter((s) => s.pm === pmId && s.project === project)
				.map((s) => s.id);
			return {
				kind: 'pm',
				sessions: dedupe(sessions),
				note: sessions.length ? null : 'project PM is offline; message inboxes as pending'
			};
		}

		case 'atelier':
			// The one cross-project-permitted identity (§11) — NO assertInProject. Placeholder
			// resolution until D-040 composes a real atelier session.
			return resolveAtelier(fleet);

		default:
			// Unknown class — fail loud + named (F-005: routing always ends in an explicit branch).
			throw new PeerAddressError(`peer address: unknown to_kind ${JSON.stringify((address as PeerAddress).kind)}`);
	}
}
