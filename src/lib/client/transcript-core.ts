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
 *  framed (the session's final status is a separate header badge, not a transcript turn). */
export type TurnKind = 'briefing' | 'thinking' | 'tool_use' | 'tool_result' | 'assistant';

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
	/** Tool metadata for tool_use / tool_result turns (name/args/ok). */
	toolCall?: Record<string, unknown>;
}

/** A persisted row as it arrives from listSessionMessages (TranscriptMessage) — only the
 *  fields the mapping reads. `kind` is absent on pre-discriminator rows. */
export interface PersistedRowLike {
	id?: string;
	role: string;
	kind?: string;
	content?: string;
	toolCall?: Record<string, unknown>;
}

/**
 * Resolve a persisted row's render kind. Explicit `kind` wins (clamped to a known turn
 * kind — an unrecognised persisted kind renders as prose, honest). With NO kind (legacy
 * rows) fall back by role: a 'tool' row is a tool result, a briefing-tagged toolCall is a
 * briefing, otherwise prose.
 */
export function rowTurnKind(row: PersistedRowLike): TurnKind {
	const k = row.kind;
	if (k) {
		if (k === 'briefing') return 'briefing';
		if (k === 'thinking') return 'thinking';
		if (k === 'tool_use') return 'tool_use';
		if (k === 'tool_result') return 'tool_result';
		return 'assistant'; // assistant_text / result / system / user → prose
	}
	// Legacy (pre-discriminator) fallback.
	if (row.toolCall && (row.toolCall as { kind?: unknown }).kind === 'briefing') return 'briefing';
	return row.role === 'tool' ? 'tool_result' : 'assistant';
}

/** Map a persisted transcript row → a normalized Turn. A prose ('assistant') turn carries a
 *  `tag` derived from the row role so a user/system row is labelled honestly. */
export function rowToTurn(row: PersistedRowLike, index: number): Turn {
	const kind = rowTurnKind(row);
	return {
		id: row.id ?? `row-${index}`,
		kind,
		content: typeof row.content === 'string' ? row.content : '',
		...(kind === 'assistant'
			? { tag: row.role === 'user' ? 'user' : row.role === 'system' ? 'system' : 'assistant' }
			: {}),
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
