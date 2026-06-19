/* ============================================================================
   ai-playground v2 — CREATE PAGE LIVE GENERATION TRANSCRIPT WIRING (LT-2)
   Wiring the /projects/create generating state to the read-only agent's LIVE
   transcript — the /claude-code?session= precedent. The DURABLE source is the
   persisted `message` rows (so the transcript survives a reload mid-generation),
   re-read on a scoped dep via the `message` onDbChange SSE; a `subscribeTopic`
   overlay fills the live tail before persistence catches up.

   Regression gate (source-parse — mirrors run-nav.test.ts / page-tokens.test.ts;
   the component is not unit-rendered here). Two surfaces are checked:
     - the LOADER (+page.server.ts): a scoped `app:create-transcript` dep + the
       persisted transcript load from the run's session (listSessionMessages).
     - the CLIENT (+page.svelte): rowToTurn over data.transcript (the durable
       /claude-code mapping) + a `message` onDbChange re-read, and the rendered
       turns drive <SessionTranscript>.
   A revert to a live-only (subscribeTopic-only, non-durable) feed fails here.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, '+page.svelte'), 'utf8');
const SERVER = readFileSync(join(HERE, '+page.server.ts'), 'utf8');

describe('LT-2 — durable live transcript wiring (loader)', () => {
  it('declares the scoped app:create-transcript dep (no invalidate storm)', () => {
    expect(SERVER).toMatch(/depends\(\s*['"]app:create-transcript['"]\s*\)/);
  });

  it('loads the persisted transcript from the run session via listSessionMessages', () => {
    expect(SERVER).toMatch(/import\b[^;]*\blistSessionMessages\b[^;]*from\s*['"]\$lib\/server\/sessions['"]/);
    expect(SERVER).toMatch(/listSessionMessages\(\s*db\s*,\s*run\.session\s*\)/);
  });

  it('only loads the transcript when the run carries a session id (honest empty otherwise)', () => {
    expect(SERVER).toMatch(/if\s*\(\s*run\?\.session\s*\)/);
  });

  it('returns transcript on every branch (connected + both disconnected returns)', () => {
    const transcriptReturns = SERVER.match(/transcript[:,]/g) ?? [];
    // connected return + 2 disconnected returns = at least 3 references to the field.
    expect(transcriptReturns.length).toBeGreaterThanOrEqual(3);
  });
});

describe('LT-2 — durable live transcript wiring (client)', () => {
  it('maps the persisted rows with rowToTurn (the /claude-code durable mapping)', () => {
    expect(PAGE).toMatch(/import\b[^;]*\browToTurn\b[^;]*from\s*['"]\$lib\/client\/transcript-core['"]/);
    expect(PAGE).toMatch(/data\.transcript\.map\(\s*\(m,\s*i\)\s*=>\s*rowToTurn\(m,\s*i\)\s*\)/);
  });

  it('re-reads the transcript live on a `message` row change (scoped dep)', () => {
    expect(PAGE).toMatch(/onDbChange\(\s*['"]message['"]/);
    expect(PAGE).toMatch(/invalidate\(\s*['"]app:create-transcript['"]\s*\)/);
  });

  it('keeps the instant-paint subscribeTopic overlay (live tail before persistence)', () => {
    expect(PAGE).toMatch(/subscribeTopic<[^>]*>\(\s*['"]transcript['"]/);
  });

  it('renders the merged transcriptTurns through <SessionTranscript> (honest empty guard)', () => {
    expect(PAGE).toMatch(/transcriptTurns\.length\s*===\s*0/);
    expect(PAGE).toMatch(/<SessionTranscript\s+turns=\{transcriptTurns\}/);
  });
});
