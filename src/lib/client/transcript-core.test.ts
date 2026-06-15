/**
 * Unit tests for transcript-core — the SHARED kind→turn mapping both Sessions transcript
 * views use. The regression this drains: projects/[id] rendered the `thinking` kind by ROLE
 * (assistant styling) instead of as a distinct turn. These assert that BOTH the persisted-row
 * path and the live-event path map every kind to the right Turn — including a live `thinking`
 * event the old projects/[id] handler dropped, plus the three shadow paths per data flow
 * (nil input · empty/zero-length input · upstream-error-shaped input).
 */
import { describe, it, expect } from 'vitest';
import {
	rowTurnKind,
	rowToTurn,
	liveEventToTurn,
	toolName,
	toolOk,
	compactToolInput,
	parseBriefing
} from './transcript-core';

describe('rowTurnKind — persisted row → render kind', () => {
	it('maps each explicit discriminator kind', () => {
		expect(rowTurnKind({ role: 'assistant', kind: 'assistant_text' })).toBe('assistant');
		expect(rowTurnKind({ role: 'assistant', kind: 'thinking' })).toBe('thinking');
		expect(rowTurnKind({ role: 'tool', kind: 'tool_use' })).toBe('tool_use');
		expect(rowTurnKind({ role: 'tool', kind: 'tool_result' })).toBe('tool_result');
		expect(rowTurnKind({ role: 'system', kind: 'briefing' })).toBe('briefing');
	});

	it('collapses non-framed persisted kinds (result/system/user) to assistant prose', () => {
		expect(rowTurnKind({ role: 'assistant', kind: 'result' })).toBe('assistant');
		expect(rowTurnKind({ role: 'system', kind: 'system' })).toBe('assistant');
		expect(rowTurnKind({ role: 'user', kind: 'user' })).toBe('assistant');
	});

	it('clamps an UNKNOWN persisted kind to prose (honest — text still shows)', () => {
		expect(rowTurnKind({ role: 'assistant', kind: 'totally_new_kind' })).toBe('assistant');
	});

	it('SHADOW: legacy row with NO kind falls back by role', () => {
		// pre-discriminator rows: a tool row is a tool result, everything else is prose.
		expect(rowTurnKind({ role: 'tool' })).toBe('tool_result');
		expect(rowTurnKind({ role: 'assistant' })).toBe('assistant');
		expect(rowTurnKind({ role: 'user' })).toBe('assistant');
	});

	it('SHADOW: legacy briefing carried only on toolCall.kind is detected without a kind', () => {
		expect(rowTurnKind({ role: 'system', toolCall: { kind: 'briefing' } })).toBe('briefing');
	});
});

describe('rowToTurn — persisted row → normalized Turn', () => {
	it('carries id, kind, content and toolCall through', () => {
		const t = rowToTurn(
			{ id: 'message:abc', role: 'tool', kind: 'tool_use', content: '→ Read', toolCall: { name: 'Read' } },
			0
		);
		expect(t).toEqual({
			id: 'message:abc',
			kind: 'tool_use',
			content: '→ Read',
			toolCall: { name: 'Read' }
		});
	});

	it('SHADOW: a row missing id is keyed by index; missing content → empty string (never undefined)', () => {
		const t = rowToTurn({ role: 'assistant', kind: 'assistant_text' }, 3);
		expect(t.id).toBe('row-3');
		expect(t.content).toBe('');
		expect('toolCall' in t).toBe(false);
	});

	it('SHADOW: empty thinking row stays empty (F-008 — never fabricated)', () => {
		const t = rowToTurn({ id: 'm:1', role: 'assistant', kind: 'thinking', content: '' }, 0);
		expect(t.kind).toBe('thinking');
		expect(t.content).toBe('');
	});
});

describe('liveEventToTurn — one streamed runtime event → Turn (live append)', () => {
	it('maps log → assistant prose', () => {
		expect(liveEventToTurn({ type: 'log', message: 'hello' }, 0)).toEqual({
			id: 'live-0',
			kind: 'assistant',
			content: 'hello'
		});
	});

	it('maps a live THINKING event → a thinking turn (the dropped-event regression)', () => {
		const t = liveEventToTurn({ type: 'thinking', text: 'let me reason' }, 2);
		expect(t).toEqual({ id: 'live-2', kind: 'thinking', content: 'let me reason' });
	});

	it('SHADOW: a live EMPTY thinking event stays empty (honest, not coerced to prose)', () => {
		const t = liveEventToTurn({ type: 'thinking', text: '' }, 5);
		expect(t).toEqual({ id: 'live-5', kind: 'thinking', content: '' });
	});

	it('maps tool_call → tool_use with name/args; tool_result → tool_result with ok', () => {
		expect(liveEventToTurn({ type: 'tool_call', name: 'Read', args: { file: 'a.ts' } }, 1)).toEqual({
			id: 'live-1',
			kind: 'tool_use',
			content: '→ Read',
			toolCall: { name: 'Read', args: { file: 'a.ts' }, needs_confirm: undefined }
		});
		expect(liveEventToTurn({ type: 'tool_result', name: 'Read', ok: true, output: 'ok' }, 4)).toEqual({
			id: 'live-4',
			kind: 'tool_result',
			content: 'ok',
			toolCall: { name: 'Read', ok: true, phase: 'result' }
		});
	});

	it('maps briefing → briefing turn carrying the fenced text', () => {
		const t = liveEventToTurn({ type: 'briefing', text: 'fenced…' }, 0);
		expect(t).toEqual({ id: 'live-0', kind: 'briefing', content: 'fenced…' });
	});

	it('SHADOW: lifecycle events (token_usage/done/error) are NOT turns → null', () => {
		expect(liveEventToTurn({ type: 'token_usage', tokensIn: 1, tokensOut: 2 }, 0)).toBeNull();
		expect(liveEventToTurn({ type: 'done' }, 0)).toBeNull();
		expect(liveEventToTurn({ type: 'error', message: 'boom' }, 0)).toBeNull();
	});

	it('SHADOW: nil / shapeless event → null (no throw)', () => {
		expect(liveEventToTurn(undefined, 0)).toBeNull();
		expect(liveEventToTurn({}, 0)).toBeNull();
		expect(liveEventToTurn({ notype: 1 } as Record<string, unknown>, 0)).toBeNull();
	});
});

describe('tool helpers', () => {
	it('toolName falls back to "tool" when absent/non-string', () => {
		expect(toolName({ name: 'Bash' })).toBe('Bash');
		expect(toolName(undefined)).toBe('tool');
		expect(toolName({ name: 42 } as Record<string, unknown>)).toBe('tool');
	});

	it('toolOk is three-valued: true / false / null(unknown)', () => {
		expect(toolOk({ ok: true })).toBe(true);
		expect(toolOk({ ok: false })).toBe(false);
		expect(toolOk({})).toBeNull();
		expect(toolOk(undefined)).toBeNull();
	});

	it('compactToolInput renders one line; SHADOW: absent/empty args → "" (never "{}")', () => {
		expect(compactToolInput({ args: { file: 'a.ts', n: 3 } })).toBe('file: a.ts  ·  n: 3');
		expect(compactToolInput({ args: {} })).toBe('');
		expect(compactToolInput(undefined)).toBe('');
		expect(compactToolInput({ args: null } as Record<string, unknown>)).toBe('');
	});

	it('compactToolInput clips a very long value with an ellipsis', () => {
		const long = 'x'.repeat(200);
		const out = compactToolInput({ args: { blob: long } });
		expect(out.length).toBeLessThan(140);
		expect(out.endsWith('…')).toBe(true);
	});

	it('compactToolInput stringifies nested objects', () => {
		expect(compactToolInput({ args: { opts: { a: 1 } } })).toBe('opts: {"a":1}');
	});
});

describe('parseBriefing — fenced recall → items', () => {
	const FENCE_OPEN = '⎆BEGIN_REFERENCE⎆';
	const FENCE_CLOSE = '⎆END_REFERENCE⎆';

	it('parses source + citation + body from one fenced block', () => {
		const text = `${FENCE_OPEN}[fails.md] [#F-013] a note\n---\nthe body text${FENCE_CLOSE}`;
		expect(parseBriefing(text)).toEqual([
			{ source: 'fails.md', citation: 'F-013', body: 'the body text' }
		]);
	});

	it('parses multiple blocks; missing citation → null; head-only block → head as body', () => {
		const text =
			`${FENCE_OPEN}[memory] just a head${FENCE_CLOSE}` +
			`${FENCE_OPEN}[decisions] [#D-010] x\n---\nbody2${FENCE_CLOSE}`;
		const items = parseBriefing(text);
		expect(items).toHaveLength(2);
		// Head-only block (no `---` body separator): source is extracted from the [tag], but the
		// body falls back to the whole head line (the existing, preserved parse behaviour).
		expect(items[0]).toEqual({ source: 'memory', citation: null, body: '[memory] just a head' });
		expect(items[1]).toEqual({ source: 'decisions', citation: 'D-010', body: 'body2' });
	});

	it('defaults source to "memory" when the head has no [source] tag', () => {
		const text = `${FENCE_OPEN}no tag here\n---\nbody${FENCE_CLOSE}`;
		expect(parseBriefing(text)[0]).toEqual({ source: 'memory', citation: null, body: 'body' });
	});

	it('SHADOW: empty string → [] (honest empty, renders "0 recalled")', () => {
		expect(parseBriefing('')).toEqual([]);
	});

	it('SHADOW: unfenced text → [] (no throw)', () => {
		expect(parseBriefing('plain text with no fences')).toEqual([]);
	});
});
