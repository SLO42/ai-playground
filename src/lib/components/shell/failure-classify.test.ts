/* ============================================================================
   MC-4 — failure-note classifier (pure). Each case below uses a REAL note shape
   produced in the codebase (producer cited), maps to its category + short label;
   an unrecognized note → honest 'unknown' fallback + the raw note as detail; and
   the classifier never throws on odd/nil/empty input (shadow paths).
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { classifyFailureNote, type FailureCategory } from './failure-classify';

describe('classifyFailureNote — real observed note shapes → category + short label', () => {
	const cases: Array<{ name: string; note: string; category: FailureCategory }> = [
		{
			name: 'reaper REAPED_NOTE (reaper.ts:25)',
			note: 'reaped: server restarted mid-run',
			category: 'crashed-mid-run'
		},
		{
			name: 'merge-back preserve-incomplete (merge-back.ts:280)',
			note: 'work preserved on branch session/abc-123; session failed — merge needed',
			category: 'merge-needed'
		},
		{
			name: 'merge-back diverged FF-not-possible (merge-back.ts:350)',
			note: 'work preserved on branch session/abc; merge needed (project branch diverged — fast-forward not possible)',
			category: 'merge-needed'
		},
		{
			name: 'D-036 capability denied (capabilities.ts:190)',
			note: 'unknown skill capability id "svelte5-patterns" — not in the cc-config catalog (fail closed, D-036)',
			category: 'capability-denied'
		},
		{
			name: 'worktree acquisition failed (launch.ts:541)',
			note: 'worktree acquisition failed (reason unavailable after secret screening)',
			category: 'worktree-failed'
		},
		{
			name: 'instant pre-init death, cc_session_id=null (launch test fixture)',
			note: 'spawn failed: cc_session_id=null',
			category: 'auth-token'
		},
		{
			name: 'explicit stale token (F-029)',
			note: 'claude CLI failed to start: OPENCLAW_TOKEN unset (stale token)',
			category: 'auth-token'
		},
		{
			name: 'a spawn timeout',
			note: 'proposal session ended timeout (not done)',
			category: 'spawn-timeout'
		},
		{
			name: 'an agent refusal',
			note: 'completed with a failure result: I cannot help with that request.',
			category: 'agent-refusal'
		},
		{
			name: 'tests failed in a failure result',
			note: 'completed with a failure result: 3 failed, build failed',
			category: 'tests-failed'
		},
		{
			name: 'claude CLI exited N with streamed JSON tail (cli-backend.ts:709)',
			note: 'claude CLI exited 1: {"type":"result","subtype":"error","error":"boom"}',
			category: 'stream-exit'
		},
		{
			name: 'claude CLI failed to start (cli-backend.ts:699)',
			note: 'claude CLI failed to start: spawn claude ENOENT',
			category: 'stream-exit'
		},
		{
			name: 'failed mid-stream (launch.ts:998)',
			note: 'failed mid-stream: db connection lost',
			category: 'stream-exit'
		},
		{
			name: 'no output (launch.ts:1005)',
			note: 'failed before producing any output (no done/error event, no exit reason)',
			category: 'no-output'
		}
	];

	for (const c of cases) {
		it(`${c.name} → ${c.category}`, () => {
			const out = classifyFailureNote(c.note);
			expect(out.category).toBe(c.category);
			// short label is human + short, never the raw wall of text
			expect(out.shortLabel.length).toBeGreaterThan(0);
			expect(out.shortLabel.length).toBeLessThanOrEqual(40);
			expect(out.shortLabel).not.toBe(c.note);
			// detail is ALWAYS the input verbatim (D-026 unchanged — no widen/narrow)
			expect(out.detail).toBe(c.note);
			expect(out.empty).toBe(false);
			expect(out.icon.length).toBeGreaterThan(0);
		});
	}
});

describe('classifyFailureNote — honest fallback + shadow paths', () => {
	it('an UNRECOGNIZED note → honest unknown fallback + the raw note as detail (NEVER fabricated)', () => {
		const note = 'some entirely novel failure phrasing the classifier has never seen';
		const out = classifyFailureNote(note);
		expect(out.category).toBe('unknown');
		expect(out.shortLabel).toBe('session failed');
		expect(out.detail).toBe(note); // full raw note preserved
		expect(out.empty).toBe(false);
	});

	it('null → empty honest result (no fabricated reason, caller shows "no reason recorded")', () => {
		const out = classifyFailureNote(null);
		expect(out.category).toBe('unknown');
		expect(out.shortLabel).toBe('session failed');
		expect(out.detail).toBe('');
		expect(out.empty).toBe(true);
	});

	it('undefined → empty honest result', () => {
		const out = classifyFailureNote(undefined);
		expect(out.empty).toBe(true);
		expect(out.detail).toBe('');
	});

	it('empty string → empty honest result', () => {
		expect(classifyFailureNote('').empty).toBe(true);
	});

	it('whitespace-only string → empty honest result (a blank must not read like a real reason)', () => {
		const out = classifyFailureNote('   \n\t  ');
		expect(out.empty).toBe(true);
		expect(out.category).toBe('unknown');
	});

	it('never throws on odd input (numbers/objects coerced via the typeof guard)', () => {
		// @ts-expect-error — deliberately wrong type to prove the typeof guard holds (no throw)
		expect(() => classifyFailureNote(42)).not.toThrow();
		// @ts-expect-error — object input
		expect(classifyFailureNote({}).empty).toBe(true);
	});

	it('classification is case-insensitive (uppercased note still matches its marker)', () => {
		expect(classifyFailureNote('REAPED: SERVER RESTARTED MID-RUN').category).toBe('crashed-mid-run');
		expect(classifyFailureNote('Work Preserved On Branch X; Merge Needed').category).toBe('merge-needed');
	});

	it('priority: a capability-denied note that also rides a CLI-exit wall resolves to capability-denied', () => {
		const note =
			'claude CLI exited 1: unknown skill capability id "x" — not in the cc-config catalog (fail closed, D-036)';
		expect(classifyFailureNote(note).category).toBe('capability-denied');
	});
});

/* ============================================================================
   CC-1 fix gap #1 — FOREIGN-MARKER COLLISION (regression). A real
   cli-backend.ts:705-709 `claude CLI exited N: <detail>` wraps the agent's OWN
   stream-json result tail (up to 800 chars) as foreign text. A generic content
   marker (401 / credential / timeout / refusal / "N failed") quoted INSIDE that
   tail must NOT mislabel the cause — the wrapper classifies as stream-exit. Only
   a REAL spawn-layer cause (capability-denied, the F-029 stale-token signals)
   legitimately overrides the wrapper. These notes are shaped exactly like the
   real producer (cli-backend.ts:705-709 / launch.ts:998).
   ============================================================================ */
describe('classifyFailureNote — embedded foreign text in a stream-exit wrapper must NOT mislabel the cause', () => {
	const wrapped: Array<{ name: string; note: string }> = [
		{
			name: "agent's own result says 'I cannot help' (refusal token, NOT a refusal cause)",
			note: 'claude CLI exited 1: {"type":"result","subtype":"error","result":"I cannot help with that request"}'
		},
		{
			name: "agent's result mentions 'timed out' (timeout token, NOT a spawn timeout)",
			note: 'claude CLI exited 1: {"type":"result","result":"the build timed out after 600s; investigating"}'
		},
		{
			name: "agent's result mentions a 401 (auth token, NOT an auth-token cause)",
			note: 'claude CLI exited 1: {"type":"result","result":"got a 401 from the upstream API mid-run"}'
		},
		{
			name: "agent's result says 'invalid credential' (credential token, NOT an auth cause)",
			note: 'claude CLI exited 1: {"type":"result","result":"the tool returned an invalid credential error"}'
		},
		{
			name: "embedded 'completed with a failure result: 3 failed; I will not retry' (tests/refusal tokens)",
			note: 'claude CLI exited 2: completed with a failure result: 3 failed; I will not retry'
		}
	];
	for (const c of wrapped) {
		it(`${c.name} → stream-exit (the wrapper IS the cause, not its quoted tail)`, () => {
			const out = classifyFailureNote(c.note);
			expect(out.category).toBe('stream-exit');
			// detail stays the FULL verbatim note (D-026 unchanged) — nothing is hidden, only labeled honestly.
			expect(out.detail).toBe(c.note);
		});
	}

	it('a REAL capability-denial nested in the wrapper STILL wins (legitimate cause overrides)', () => {
		const note =
			'claude CLI exited 1: unknown skill capability id "svelte5-patterns" — not in the cc-config catalog (fail closed, D-036)';
		expect(classifyFailureNote(note).category).toBe('capability-denied');
	});

	it('a REAL F-029 stale-token cause on a failed-to-start wrapper STILL wins (auth-token)', () => {
		const note = 'claude CLI failed to start: OPENCLAW_TOKEN unset (stale token)';
		expect(classifyFailureNote(note).category).toBe('auth-token');
	});

	it('a NON-wrapper note carrying a generic marker still classifies by content (scope unchanged)', () => {
		// Not a wrapper → the whole note is scannable → the generic timeout/refusal markers still fire.
		expect(classifyFailureNote('proposal session ended timeout (not done)').category).toBe('spawn-timeout');
		expect(
			classifyFailureNote('completed with a failure result: I cannot help with that request.').category
		).toBe('agent-refusal');
	});
});
