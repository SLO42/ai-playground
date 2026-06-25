// PROJECT-PULSE — pure derivations for the AGENCY pulse strip of the live activity panel.
//
// The ACTIVITY panel used to show almost ONLY dev/session rows; the operator could not tell, at a
// glance, what the PM and the HR/recruiter agents were doing. This module folds the three NON-dev
// agency signals the project loader ALREADY fetches into one compact, kind-TAGGED, newest-first
// list that renders ABOVE the session list — visually distinct from dev sessions:
//
//   • PM proposals + decisions  — from the proposals queue (proposeTask provenance: "PM proposed N
//                                 tasks") + each task's panel_verdict[] ("PM approved" / "PM pushed
//                                 back", with the validator reasons).
//   • PM autonomous tick state  — the live loop's honest last-state (re-ticking / blocked /
//                                 dod-reached / cap-reached / awaiting-release / published / idle).
//   • HR / role activity        — recent role_event rows (hire/cert/swap/staff/retire), when present.
//
// NOTHING here fabricates a thought, a count, or a label (F-008). Every entry is derived from a REAL
// loaded row; an absent signal yields an HONEST empty ("PM idle" / no HR activity), never a blank or
// an invented entry. This is a plain .ts module — NO runes (F-009). All datetimes arrive ALREADY as
// ISO strings (the server normalizers did the F-013 coercion); absent → null → the UI renders '—'.

/** Which agency stream a pulse entry came from — drives its tag + token color (PM vs HR vs loop). */
export type PulseKind = 'pm-proposal' | 'pm-verdict' | 'pm-loop' | 'hr-role';

/** The visual tone of a pulse entry's tag/pill — maps to a design token, never a raw hex. */
export type PulseTone = 'pm' | 'hr' | 'approve' | 'pushback' | 'running' | 'blocked' | 'neutral';

/** One row in the agency pulse list. Every field is plain-serializable (already ISO datetimes). */
export interface PulseEntry {
	/** Stable key (the source row id, or a synthesized stable id for the singleton loop entry). */
	id: string;
	kind: PulseKind;
	/** The short TAG the operator scans ("PM", "HR", "PM · panel"). */
	tag: string;
	tone: PulseTone;
	/** The one-line headline ("PM proposed: <title>", "PM approved", "hire — recruiter"). */
	headline: string;
	/** Optional supporting detail (verdict reasons joined, loop reason, role op detail). null → omit. */
	detail: string | null;
	/** ISO-8601 timestamp for ordering (newest-first), or null when the source row had none. */
	at: string | null;
}

/** The agency pulse model the strip renders. */
export interface PulseModel {
	entries: PulseEntry[];
	/** Count of PM-sourced entries (proposals + verdicts) — drives the PM section header. */
	pmCount: number;
	/** Count of HR/role entries — drives the HR section header. */
	hrCount: number;
	/** The autonomous-loop singleton (always present so the operator sees the tick state), or null
	 *  when no loop state is known for this project (honest 'unknown' rather than a fabricated idle). */
	loop: PulseLoopState | null;
	/** True when there is NO PM proposal/verdict AND no HR activity AND no live (non-idle) loop —
	 *  the honest "agency idle" state (the PM/HR strip shows "PM idle · no HR activity"). */
	idle: boolean;
}

/** The folded autonomous-loop tick state (honest — mirrors pm-autonomous's vocabulary). */
export interface PulseLoopState {
	state: string;
	label: string;
	reason: string;
	tone: PulseTone;
	ticksUsed: number;
}

// ── Inputs (the loader's already-fetched shapes, minimized to what the fold reads) ──────────

/** A panel verdict as the proposals queue carries it (workforce PanelVerdictRow subset). */
export interface PulseVerdictLike {
	id: string;
	verdict: string; // 'approve' | 'pushback' (shown verbatim if neither — never coerced)
	reasons?: string[];
	confidence?: string | null;
	at?: string | null;
}

/** A proposal queue entry as the loader carries it (pm-panel ProposalQueueEntry subset). */
export interface PulseProposalLike {
	task: { id: string; title?: string | null; created_at?: string | null };
	verdicts: readonly PulseVerdictLike[];
}

/** The autonomous-loop last-state the loader surfaces (pm-autonomous outcome subset), or null. */
export interface PulseLoopLike {
	state: string;
	reason: string;
	ticksUsed: number;
}

/** A recent role_event as the loader carries it (workforce RecentRoleEventRow subset). */
export interface PulseRoleEventLike {
	id: string;
	op: string;
	role_slug?: string | null;
	role?: string | null;
	detail?: Record<string, unknown> | null;
	at?: string | null;
}

// ── Loop-state mapping (honest; mirrors +page.svelte's loopStateLabel + pm-autonomous states) ───

/** Map an autonomous-loop state to its operator label. Unknown state → shown verbatim (never hidden). */
function loopLabel(state: string): string {
	switch (state) {
		case 'running':
			return 'Driving — working the next batch';
		case 'blocked':
			return 'Stopped — blocked';
		case 'cap-reached':
			return 'Stopped — re-tick cap reached';
		case 'dod-reached':
			return 'Stopped — definition of done reached';
		case 'awaiting-release-confirm':
			return 'Awaiting release confirmation';
		case 'published':
			return 'v1 shipped — autonomous complete';
		case 'idle':
			return 'Idle';
		default:
			// Unmodelled state — surface it verbatim (EVERY ERROR HAS A NAME), never a fabricated label.
			return state || 'unknown';
	}
}

/** Map a loop state to a pulse tone for its pill. */
function loopTone(state: string): PulseTone {
	switch (state) {
		case 'running':
			return 'running';
		case 'blocked':
		case 'cap-reached':
			return 'blocked';
		case 'dod-reached':
		case 'published':
		case 'awaiting-release-confirm':
			return 'pm';
		default:
			return 'neutral';
	}
}

/** A loop state counts as LIVE (worth surfacing as activity vs idle) when it is not the resting idle. */
function loopIsLive(state: string): boolean {
	return state !== 'idle' && state !== '';
}

// ── Verdict / op helpers ───────────────────────────────────────────────────────────────────

function verdictTone(verdict: string): PulseTone {
	if (verdict === 'approve') return 'approve';
	if (verdict === 'pushback') return 'pushback';
	return 'neutral';
}

function verdictHeadline(verdict: string): string {
	if (verdict === 'approve') return 'PM approved';
	if (verdict === 'pushback') return 'PM pushed back';
	// Unmodelled verdict value — surface it verbatim rather than coercing.
	return `PM verdict: ${verdict}`;
}

/** A friendly headline for an HR/role op. Unknown op → shown verbatim (never coerced/hidden). */
function roleOpHeadline(op: string, who: string): string {
	switch (op) {
		case 'created':
			return `Role created — ${who}`;
		case 'interviewed':
			return `Cert interview — ${who}`;
		case 'swap':
			return `Role swapped — ${who}`;
		case 'retired':
			return `Role retired — ${who}`;
		case 'archived':
			return `Role archived — ${who}`;
		case 'tier_changed':
			return `Tier changed — ${who}`;
		case 'staffed':
			return `Staffed — ${who}`;
		case 'unstaffed':
			return `Unstaffed — ${who}`;
		case 'fixture_activated':
			return `Fixture activated — ${who}`;
		case 'stale_marked':
			return `Marked stale — ${who}`;
		default:
			return `${op} — ${who}`;
	}
}

/** Short id for display ('table:abc' → 'abc'); empty → '—' (honest, never fabricated). */
function shortId(v: string | null | undefined): string {
	if (!v) return '—';
	const i = v.indexOf(':');
	return i >= 0 ? v.slice(i + 1) : v;
}

function trimOrNull(s: string | null | undefined): string | null {
	const t = (s ?? '').trim();
	return t.length > 0 ? t : null;
}

// ── The fold ─────────────────────────────────────────────────────────────────────────────

export interface BuildPulseInput {
	proposals?: readonly PulseProposalLike[] | null;
	loop?: PulseLoopLike | null;
	roleEvents?: readonly PulseRoleEventLike[] | null;
}

/**
 * Fold the loader's PM proposals/verdicts, autonomous-loop state, and recent role_events into the
 * agency pulse model (newest-first), tagged PM vs HR and distinct from dev sessions.
 *
 * SHADOW PATHS, all four data flows:
 *   • nil input        — `{}`/all-null ⇒ honest empty model (idle:true, loop:null, no entries).
 *   • empty input      — [] proposals / [] roleEvents / loop omitted ⇒ idle:true, "PM idle".
 *   • upstream error   — the SERVER read already degrades to [] / null on a failed source (the load
 *                        is best-effort), so a failed read arrives here as an empty list → honest idle
 *                        (this module never throws; a malformed entry is shown verbatim, not dropped).
 *   • happy path       — real rows ⇒ a PM proposal entry per proposal, a PM verdict entry per verdict,
 *                        the live loop singleton, and an HR entry per role_event.
 *
 * @param limit caps the PM + HR entry list (the loop singleton is always kept on top); clamped ≥1.
 */
export function buildPulse(input: BuildPulseInput, limit = 12): PulseModel {
	const proposals = input.proposals ?? [];
	const roleEvents = input.roleEvents ?? [];
	const cap = Math.max(1, Math.floor(limit));

	const entries: PulseEntry[] = [];

	// PM — one entry per proposal (the proposeTask provenance: "PM proposed: <title>"), plus one
	// entry per recorded panel_verdict on that proposal ("PM approved" / "PM pushed back" + reasons).
	for (const p of proposals) {
		const taskId = p?.task?.id ?? '';
		const title = trimOrNull(p?.task?.title) ?? `task ${shortId(taskId)}`;
		entries.push({
			id: `proposal:${taskId}`,
			kind: 'pm-proposal',
			tag: 'PM',
			tone: 'pm',
			headline: `PM proposed: ${title}`,
			detail: null,
			at: trimOrNull(p?.task?.created_at)
		});
		for (const v of p?.verdicts ?? []) {
			const verdict = (v?.verdict ?? '').trim();
			const reasons = Array.isArray(v?.reasons) ? v.reasons.map((r) => String(r).trim()).filter(Boolean) : [];
			const conf = trimOrNull(v?.confidence);
			const detailParts: string[] = [];
			if (reasons.length > 0) detailParts.push(reasons.join(' · '));
			if (conf) detailParts.push(`confidence: ${conf}`);
			entries.push({
				id: `verdict:${v?.id ?? ''}`,
				kind: 'pm-verdict',
				tag: 'PM · panel',
				tone: verdictTone(verdict),
				headline: `${verdictHeadline(verdict)} — ${title}`,
				detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
				at: trimOrNull(v?.at)
			});
		}
	}

	// HR / role — one entry per recent role_event (hire/cert/swap/staff/retire), when present.
	for (const e of roleEvents) {
		const who = e?.role_slug ? shortId(e.role_slug) : shortId(e?.role);
		const op = (e?.op ?? '').trim();
		let detail: string | null = null;
		if (e?.detail && typeof e.detail === 'object') {
			try {
				const s = JSON.stringify(e.detail);
				detail = s === '{}' ? null : s;
			} catch {
				detail = null;
			}
		}
		entries.push({
			id: `role:${e?.id ?? ''}`,
			kind: 'hr-role',
			tag: 'HR',
			tone: 'hr',
			headline: roleOpHeadline(op, who),
			detail,
			at: trimOrNull(e?.at)
		});
	}

	// Newest-first; entries with no timestamp sort LAST (an absent `at` is the weakest order signal).
	entries.sort((a, b) => {
		if (a.at && b.at) return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
		if (a.at) return -1;
		if (b.at) return 1;
		return 0;
	});

	const pmCount = entries.filter((e) => e.kind === 'pm-proposal' || e.kind === 'pm-verdict').length;
	const hrCount = entries.filter((e) => e.kind === 'hr-role').length;
	const bounded = entries.slice(0, cap);

	// The autonomous-loop singleton — always rendered (so the tick state is visible) when a state is
	// known; null when the loader surfaced no loop (honest 'unknown', never a fabricated 'idle').
	let loop: PulseLoopState | null = null;
	if (input.loop) {
		const state = (input.loop.state ?? '').trim() || 'unknown';
		loop = {
			state,
			label: loopLabel(state),
			reason: trimOrNull(input.loop.reason) ?? '',
			tone: loopTone(state),
			ticksUsed: Number.isFinite(input.loop.ticksUsed) ? input.loop.ticksUsed : 0
		};
	}

	const loopLive = !!loop && loopIsLive(loop.state);
	const idle = pmCount === 0 && hrCount === 0 && !loopLive;

	return { entries: bounded, pmCount, hrCount, loop, idle };
}
