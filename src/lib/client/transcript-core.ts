/**
 * Transcript-render core — pure (no Svelte runes), unit-testable in the node vitest
 * env. This is the SINGLE kind→turn mapping both transcript views share (the
 * /claude-code Sessions replay and the projects/[id] Sessions transcript), so the two
 * surfaces can never diverge on how a persisted turn is shown (DEFECT: projects/[id]
 * rendered the new `thinking` kind by ROLE → assistant styling instead of a distinct turn).
 *
 * The persisted `message` rows carry a `kind` discriminator (LT1/m0037):
 *   assistant_text · thinking · tool_use · tool_result · briefing · result · system · user.
 * Rows written before the discriminator existed have NO `kind`; we fall back by role
 * (a 'tool' row is a tool turn, else prose) so legacy transcripts still render honestly.
 *
 * The LIVE transcript stream (projects/[id]) appends raw runtime events as plain lines;
 * `liveEventToTurn` maps one streamed `transcript` event to the SAME turn shape so a
 * live `thinking` event renders as a thinking turn the instant it streams — not dropped
 * (the old live handler had no `thinking` branch) and not mislabelled as assistant prose.
 *
 * F-008 honesty is baked in: empty thinking → an empty/elided thinking turn (never
 * blank-as-assistant, never fabricated); an absent tool-arg object → no input string
 * (never a fake "{}"); an unknown tool-ok → null (the badge is simply omitted).
 */

/** The kinds the renderer distinguishes. Any other persisted kind (result/system/user)
 *  collapses to 'assistant' prose — honest: the row's text is shown, just not specially
 *  framed (the session's final status is a separate header badge, not a transcript turn).
 *
 *  'communication' is a PUSHED-IN channel turn (an operator interject; the future peer-agent
 *  bus) — distinct from the agent's OWN prose so a reader can never confuse "something was
 *  pushed into the session" with "the agent said this". The agent's own assistant_text /
 *  thinking / tool_use / tool_result turns KEEP their kinds (assistant/thinking/…), never
 *  'communication'. See `rowTurnKind` for the binding-rule-safe classification. */
export type TurnKind =
	| 'briefing'
	| 'thinking'
	| 'tool_use'
	| 'tool_result'
	| 'assistant'
	| 'communication';

/** The server-stamped, immutable message origin (D-035a / m0038): the AUTHORITY for whether a
 *  turn is the agent's own output or a pushed-in communication, and how it is labelled. NEVER
 *  derived from content. 'agent' is also the honest read-time default for legacy rows that
 *  predate the field — a pushed row that reads back 'agent' is an HONEST 'unknown' communication,
 *  never falsely promoted to 'operator'. */
export type MessageOrigin = 'operator' | 'agent' | 'system' | 'hook';

/** A normalized transcript turn — the shape the shared <SessionTranscript> renders. Both
 *  pages map their data (persisted rows OR live-streamed lines) to this. */
export interface Turn {
	/** Stable per-turn key for the {#each} (row id, or `live-<n>` for streamed lines). */
	id: string;
	kind: TurnKind;
	/** The turn's text — prose, thinking text, briefing fenced text, or tool result output. */
	content: string;
	/** Display tag for an 'assistant'(prose) turn — 'assistant' | 'user' | 'system', derived
	 *  from the row role so a user/system prose row is labelled honestly, not as "assistant".
	 *  Absent for non-prose kinds (they have fixed tags). */
	tag?: 'assistant' | 'user' | 'system';
	/** The server-stamped origin, carried through for a 'communication' turn so the renderer
	 *  can label it (operator/agent/system/hook). Present on EVERY turn read from a persisted
	 *  row (the read side coalesces legacy NONE → 'agent'); absent for live-event turns that
	 *  carry no origin (they render as the agent's own turns, which is what they are). */
	origin?: MessageOrigin;
	/** Tool metadata for tool_use / tool_result turns (name/args/ok). */
	toolCall?: Record<string, unknown>;
}

/** A persisted row as it arrives from listSessionMessages (TranscriptMessage) — only the
 *  fields the mapping reads. `kind` is absent on pre-discriminator rows. */
export interface PersistedRowLike {
	id?: string;
	role: string;
	kind?: string;
	/** Server-authoritative origin (m0038/D-035a). Absent on rows read by a caller that
	 *  predates the field; treated as the honest 'agent' default (NEVER promoted to operator). */
	origin?: string;
	content?: string;
	toolCall?: Record<string, unknown>;
}

/** The pushed-in roles. A `message` row whose role is one of these did NOT come from the
 *  driven agent's own runtime stream (which lands as role 'assistant' or 'tool'): it was
 *  PUSHED into the session via the channel seam (an operator interject; the future peer bus).
 *  This is a structural property of the row (its server-set role), NOT anything derived from
 *  content — so classifying by it can never let content claim a communication treatment. */
function isPushedRole(role: string): boolean {
	return role === 'user' || role === 'system';
}

/** Coalesce a possibly-absent origin string to the honest default (legacy rows → 'agent'),
 *  clamped to the known enum. NEVER promotes to operator — an unrecognised/absent origin on a
 *  pushed row is an HONEST 'agent' (renders as 'unknown' communication), never steering. */
export function normOrigin(origin: string | undefined): MessageOrigin {
	if (origin === 'operator' || origin === 'agent' || origin === 'system' || origin === 'hook') {
		return origin;
	}
	return 'agent';
}

/**
 * Resolve a persisted row's render kind. Explicit `kind` wins (clamped to a known turn
 * kind — an unrecognised persisted kind renders as prose, honest). With NO kind (legacy
 * rows) fall back by role: a 'tool' row is a tool result, a briefing-tagged toolCall is a
 * briefing, otherwise prose.
 *
 * COMMUNICATION classification (D-035a-safe): a prose turn (one that would otherwise be
 * 'assistant') on a PUSHED role (user/system) is a pushed-in CHANNEL communication — an
 * operator interject lands as role 'user', a fenced non-operator/peer push as role 'system'.
 * The driven agent's OWN turns arrive as role 'assistant' (prose/thinking) or 'tool', and the
 * wake-up `briefing` keeps its own framed kind — none of those become 'communication'. The
 * classifier reads ONLY the server-set role + kind, NEVER content, so content can never claim
 * the communication treatment (and 'communication' carries no steering power — origin does,
 * and that is the server stamp the renderer only LABELS).
 */
export function rowTurnKind(row: PersistedRowLike): TurnKind {
	const k = row.kind;
	if (k) {
		if (k === 'briefing') return 'briefing';
		if (k === 'thinking') return 'thinking';
		if (k === 'tool_use') return 'tool_use';
		if (k === 'tool_result') return 'tool_result';
		// assistant_text / result / system / user → prose; a pushed-role prose turn is a
		// pushed-in channel communication, not the agent's own prose.
		return isPushedRole(row.role) ? 'communication' : 'assistant';
	}
	// Legacy (pre-discriminator) fallback.
	if (row.toolCall && (row.toolCall as { kind?: unknown }).kind === 'briefing') return 'briefing';
	if (row.role === 'tool') return 'tool_result';
	return isPushedRole(row.role) ? 'communication' : 'assistant';
}

/**
 * The operator-facing label + screen-reader description for a communication turn's origin.
 * HONEST: a pushed row that reads back 'agent' (the legacy/coalesce default, or a future
 * fenced peer push not yet carrying a peer id) is shown as an UNLABELLED 'unknown' source —
 * never invented as an operator. 'operator' is the only steering origin and reads "operator
 * interjected"; a future peer-agent push reads "agent" (peer id, when one is carried, appends
 * to `content`/`tag` upstream — this stays origin-driven, never content-derived).
 */
export function communicationLabel(origin: MessageOrigin): { tag: string; aria: string } {
	switch (origin) {
		case 'operator':
			return { tag: 'operator interjected', aria: 'operator interjected into the session' };
		case 'system':
			return { tag: 'system message', aria: 'system message pushed into the session' };
		case 'hook':
			return { tag: 'hook message', aria: 'hook message pushed into the session' };
		case 'agent':
		default:
			// 'agent' on a PUSHED row = an honest unknown source (legacy default, or a fenced
			// non-operator/peer push). NEVER labelled operator. The future peer bus that stamps
			// a distinct origin will get its own arm above.
			return { tag: 'communication', aria: 'communication pushed into the session (origin unknown)' };
	}
}

/** Map a persisted transcript row → a normalized Turn. A prose ('assistant') turn carries a
 *  `tag` derived from the row role so a user/system row is labelled honestly. */
export function rowToTurn(row: PersistedRowLike, index: number): Turn {
	const kind = rowTurnKind(row);
	const origin = normOrigin(row.origin);
	return {
		id: row.id ?? `row-${index}`,
		kind,
		content: typeof row.content === 'string' ? row.content : '',
		...(kind === 'assistant'
			? { tag: row.role === 'user' ? 'user' : row.role === 'system' ? 'system' : 'assistant' }
			: {}),
		// A communication turn carries the server-stamped origin so the renderer labels it
		// honestly (operator interjected / system / hook / unknown). origin is the AUTHORITY —
		// never re-derived from content downstream.
		...(kind === 'communication' ? { origin } : {}),
		...(row.toolCall ? { toolCall: row.toolCall } : {})
	};
}

/**
 * Map ONE live runtime `transcript` event (`ev`, the inner RuntimeEvent) → a Turn, or
 * null when the event is not a transcript turn (token_usage / done / error are lifecycle,
 * not turns — they update the header badge, not the log). `seq` keys the turn so live
 * appends stay stably ordered. Mirrors eventToMessage (launch.ts) on the render side so
 * the live view matches the persisted replay exactly — including a live `thinking` event,
 * which the old projects/[id] handler silently dropped.
 */
export function liveEventToTurn(ev: Record<string, unknown> | undefined, seq: number): Turn | null {
	if (!ev || typeof ev.type !== 'string') return null;
	const id = `live-${seq}`;
	switch (ev.type) {
		case 'briefing':
			return { id, kind: 'briefing', content: String(ev.text ?? '') };
		case 'log':
			return { id, kind: 'assistant', content: String(ev.message ?? '') };
		case 'thinking':
			// HONEST empty (F-008): an empty thinking event stays empty — rendered as an
			// elided thinking turn, never coerced to prose or fabricated.
			return { id, kind: 'thinking', content: String(ev.text ?? '') };
		case 'tool_call':
			return {
				id,
				kind: 'tool_use',
				content: `→ ${String(ev.name ?? 'tool')}`,
				toolCall: { name: ev.name, args: ev.args, needs_confirm: ev.needsConfirm }
			};
		case 'tool_result':
			return {
				id,
				kind: 'tool_result',
				content: String(ev.output ?? ''),
				toolCall: { name: ev.name, ok: ev.ok, phase: 'result' }
			};
		default:
			return null;
	}
}

/** The tool's display name. Honest default 'tool' when the name is absent/non-string. */
export function toolName(tc: Record<string, unknown> | undefined): string {
	return typeof tc?.name === 'string' ? tc.name : 'tool';
}

/** Three-valued tool outcome: true (ok) / false (error) / null (unknown → badge omitted). */
export function toolOk(tc: Record<string, unknown> | undefined): boolean | null {
	return typeof tc?.ok === 'boolean' ? (tc.ok as boolean) : null;
}

/**
 * Compact one-line view of a tool call's input object (the name is shown separately).
 * Honest — an empty/absent args object renders nothing, NEVER a fabricated "{}". Long
 * values are clipped with an ellipsis so one tool turn cannot blow out the log.
 */
export function compactToolInput(tc: Record<string, unknown> | undefined): string {
	const args = (tc?.args ?? null) as Record<string, unknown> | null;
	if (!args || typeof args !== 'object') return '';
	const parts: string[] = [];
	for (const [k, v] of Object.entries(args)) {
		const sv =
			v == null
				? ''
				: typeof v === 'string'
					? v
					: typeof v === 'object'
						? JSON.stringify(v)
						: String(v);
		const trimmed = sv.length > 120 ? sv.slice(0, 117) + '…' : sv;
		parts.push(`${k}: ${trimmed}`);
	}
	return parts.join('  ·  ');
}

// ── Wake-up briefing parse (TASK 8.3) ──────────────────────────────────────────────────
// A briefing turn carries the raw fenced recalled-context text (§10 sentinels). We PARSE it
// into its distinct items so the operator SEES the past context as an unmistakable "woke up
// with" block — not one giant log line.
const FENCE_OPEN = '⎆BEGIN_REFERENCE⎆';
const FENCE_CLOSE = '⎆END_REFERENCE⎆';

export interface BriefingRecallItem {
	source: string;
	citation: string | null;
	body: string;
}

/** Split a fenced briefing string into its recalled items (source · citation · body).
 *  An empty / unfenced string yields [] (honest empty — the renderer shows "0 recalled"). */
export function parseBriefing(text: string): BriefingRecallItem[] {
	const items: BriefingRecallItem[] = [];
	if (!text) return items;
	const blocks = text.split(FENCE_OPEN).slice(1);
	for (const raw of blocks) {
		const block = raw.split(FENCE_CLOSE)[0] ?? '';
		// First line: `[source] [#N] <note>`; body follows the `---` separator.
		const sepIdx = block.indexOf('\n---\n');
		const head = (sepIdx >= 0 ? block.slice(0, sepIdx) : block).trim();
		const body = (sepIdx >= 0 ? block.slice(sepIdx + 5) : '').trim();
		const sourceMatch = head.match(/^\[([^\]]+)\]/);
		const citationMatch = head.match(/\[#([^\]]+)\]/);
		items.push({
			source: sourceMatch?.[1] ?? 'memory',
			citation: citationMatch?.[1] ?? null,
			body: body || head
		});
	}
	return items;
}
