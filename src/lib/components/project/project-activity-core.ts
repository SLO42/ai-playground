// PROJECT-ACTIVITY — pure derivations for the live ACTIVITY panel (ProjectActivity.svelte).
//
// The ACTIVITY panel is the operator's "what's happening now?" for ONE project, so they never
// hunt across /projects/[id] · /claude-code · /atelier to watch the PM/HR/dev agents think + act.
// It folds the project's running + recent `session` rows into a compact, kind-labelled list that
// expands inline to the SHARED <SessionTranscript> for the active one.
//
// All logic that turns LIVE session rows into the panel's visual model lives here as pure
// functions so it is unit-testable without rendering Svelte (the transcript-core / project-status-
// core pattern). NOTHING here fabricates a number or a label (F-008): every row comes from a real
// `session` row the loader fetched, and an unknown kind/role is shown HONESTLY (verbatim/neutral),
// never coerced into a friendlier label it is not. This is a plain .ts module — NO runes (F-009).

/** A minimal session shape the activity panel reads — the loader's per-project FleetSession.
 *  `kind` is the session.kind discriminator (chat/task/review/release/discussion/interview);
 *  `roleSlug`/`roleName` are the optional workforce role the session ran AS (pm / hr-recruiter /
 *  …), null for a session with no role link. All optional so a legacy/partial row still maps. */
export interface ActivitySessionLike {
	id: string;
	status: string;
	/** session.kind (m0026/m0033 enum). Absent/unknown → an honest neutral label, never invented. */
	kind?: string | null;
	/** The workforce role slug the session ran as (role.slug), or null (no role link). */
	roleSlug?: string | null;
	/** The workforce role display name (role.name), or null. */
	roleName?: string | null;
	provider?: string;
	modelId?: string;
	tier?: string | null;
	/** The honest MC-4 terminal note (session.note) — WHY a failed session failed (D-026-screened). */
	note?: string | null;
	startedAt?: string;
	endedAt?: string | null;
}

/** The visual tone for a session's status pill — drives a token color (no raw hex). */
export type ActivityTone = 'running' | 'done' | 'failed' | 'blocked' | 'neutral';

/** Map a session.status to a pill tone. Unknown status → 'neutral' (shown verbatim, never dropped). */
export function statusTone(status: string | null | undefined): ActivityTone {
	switch (status) {
		case 'running':
			return 'running';
		case 'done':
		case 'shipped':
			return 'done';
		case 'failed':
			return 'failed';
		case 'cancelled':
		case 'blocked':
			return 'blocked';
		default:
			return 'neutral';
	}
}

/**
 * The human-readable "what kind of work is this session?" label, combining session.kind with the
 * workforce role it ran as. This is what the operator scans to tell a PM lifecycle proposal from a
 * validation panel from a plain dev task from an HR/recruiter run.
 *
 * The mapping is HONEST (F-008): a role we recognise (pm / hr / recruiter) names itself; an
 * unrecognised role is shown verbatim (its name/slug) joined to the kind, never coerced; an
 * UNKNOWN/absent kind falls through to a neutral "session" rather than a fabricated label. EVERY
 * branch yields a concrete string — there is no silent empty.
 *
 * SHADOW PATHS: nil row → 'session'; empty kind + no role → 'session'; unknown kind + no role →
 * the kind verbatim; a role present but unknown → "<roleName> · <kindLabel>".
 */
export function activityLabel(s: ActivitySessionLike | null | undefined): string {
	if (!s) return 'session';
	const kind = (s.kind ?? '').trim();
	const roleSlug = (s.roleSlug ?? '').trim().toLowerCase();
	const roleName = (s.roleName ?? '').trim();

	// A recognised workforce role names the activity directly (the operator's mental model).
	const isPm = roleSlug === 'pm' || roleSlug === 'project-manager' || roleSlug.startsWith('pm-');
	const isHr =
		roleSlug === 'hr' ||
		roleSlug === 'hr-recruiter' ||
		roleSlug === 'recruiter' ||
		roleSlug.startsWith('hr-');

	if (isPm) {
		if (kind === 'review') return 'PM validation panel';
		if (kind === 'discussion') return 'PM discussion';
		if (kind === 'release') return 'PM release';
		// chat/task/interview/unknown under the PM role → the PM lifecycle drive.
		return 'PM lifecycle';
	}
	if (isHr) {
		if (kind === 'interview') return 'HR interview';
		if (kind === 'review') return 'HR review';
		return 'HR recruiter';
	}

	// No (or unrecognised) role — label by kind, the honest neutral vocabulary.
	const kindLabel = kindToLabel(kind);
	// A present-but-unrecognised role is shown verbatim so the operator still sees WHO ran it.
	if (roleName) return `${roleName} · ${kindLabel}`;
	return kindLabel;
}

/** Map a bare session.kind to a friendly label. Unknown/absent → 'session' (honest, never invented). */
function kindToLabel(kind: string): string {
	switch (kind) {
		case 'task':
			return 'dev task';
		case 'review':
			return 'validation panel';
		case 'release':
			return 'release';
		case 'discussion':
			return 'discussion';
		case 'interview':
			return 'interview';
		case 'chat':
			return 'chat';
		case '':
			return 'session';
		default:
			// Unmodelled kind — surface it verbatim rather than hiding it (EVERY ERROR HAS A NAME).
			return kind;
	}
}

/** One row in the compact activity list, with its derived label + tone for rendering. */
export interface ActivityEntry {
	id: string;
	status: string;
	tone: ActivityTone;
	/** The "what kind of work" label (PM lifecycle / validation panel / dev task / HR …). */
	label: string;
	running: boolean;
	provider: string;
	modelId: string;
	tier: string | null;
	note: string | null;
	startedAt: string;
	endedAt: string | null;
}

/** The full activity model the panel renders. */
export interface ActivityModel {
	/** Running sessions first (the live "happening now"), then the most recent finished ones. */
	entries: ActivityEntry[];
	/** Count of sessions currently running for this project. */
	runningCount: number;
	/** True when NOTHING is running AND there are no recent sessions — the honest idle state. */
	idle: boolean;
	/** True when nothing is running but there ARE recent sessions (so the panel shows history, not idle). */
	nothingRunning: boolean;
}

/**
 * Build the activity model from the live per-project session rows. Running sessions float to the
 * top (the active "what's happening now"); the most recent finished ones follow for context,
 * bounded by `limit` AFTER the running set so a storm of finished rows can never push the running
 * ones off the list.
 *
 * SHADOW PATHS: a nil/empty list ⇒ an honest idle model (`idle:true`, no entries — the panel shows
 * "idle — nothing running"); a row with an unknown status is still listed (its tone is 'neutral',
 * never dropped); a row missing kind/role gets the honest neutral label. NO fabricated rows.
 */
export function buildActivity(
	sessions: readonly ActivitySessionLike[] | null | undefined,
	limit = 12
): ActivityModel {
	const rows = sessions ?? [];
	const entries: ActivityEntry[] = rows.map((s) => {
		const running = s.status === 'running';
		return {
			id: s.id,
			status: s.status ?? 'unknown',
			tone: statusTone(s.status),
			label: activityLabel(s),
			running,
			provider: s.provider ?? 'unknown',
			modelId: s.modelId ?? 'unknown',
			tier: s.tier ?? null,
			note: s.note ?? null,
			startedAt: s.startedAt ?? '',
			endedAt: s.endedAt ?? null
		};
	});
	// Stable order: running first, then most-recent-started. localeCompare on the ISO string is a
	// correct lexical sort for ISO-8601 timestamps; an empty startedAt sorts last within its band.
	entries.sort((a, b) => {
		if (a.running !== b.running) return a.running ? -1 : 1;
		return b.startedAt.localeCompare(a.startedAt);
	});
	const runningCount = entries.filter((e) => e.running).length;
	// Keep ALL running rows; bound the finished tail so the list stays compact.
	const runningEntries = entries.filter((e) => e.running);
	const finishedEntries = entries.filter((e) => !e.running).slice(0, Math.max(0, limit));
	const bounded = [...runningEntries, ...finishedEntries];
	return {
		entries: bounded,
		runningCount,
		idle: bounded.length === 0,
		nothingRunning: runningCount === 0 && bounded.length > 0
	};
}
