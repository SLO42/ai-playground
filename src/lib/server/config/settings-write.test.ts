// TASK 10.3 — unit tests for the orchestration.yaml write contract (D-004 / D-010).
//
// Covers the validate → diff → CONFIRM shape: a valid mode flip diffs + applies; an
// out-of-enum mode / bad interval is rejected at the boundary BEFORE any write; the confirm
// guard refuses a stale token (a hand-edit landing between plan and confirm); and a mode flip
// PRESERVES the tuned bundles (never drops the operator's routing config).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
	planOrchestrationWrite,
	applyOrchestrationWrite,
	StaleConfirmError,
	OrchestrationWriteError
} from './settings-write';
import { loadOrchestration } from './load';

const SEED = `# Orchestration config.
mode: event
triggers: [task_created, task_unblocked]
intervalMs: 60000
concurrency:
  maxAgents: 8
  perProject: 3
bundles:
  code-write:
    thinking: medium
    toolCalls: 40
`;

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'orch-write-'));
	file = join(dir, 'orchestration.yaml');
	writeFileSync(file, SEED, 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('planOrchestrationWrite', () => {
	it('produces a diff + a confirm token for a valid mode flip', () => {
		const plan = planOrchestrationWrite({ filePath: file, change: { mode: 'manual' } });
		expect(plan.mode).toBe('manual');
		expect(plan.diff.unchanged).toBe(false);
		expect(plan.confirmToken).toMatch(/^[0-9a-f]{64}$/);
		// The proposed YAML must carry the new mode and STILL pass the loader boundary.
		expect(plan.proposed).toMatch(/mode:\s*manual/);
		const reparsed = loadOrchestration(file, {
			_inject: yaml.load(plan.proposed) as Record<string, unknown>
		});
		expect(reparsed.mode).toBe('manual');
	});

	it('marks a re-plan against already-rendered bytes as unchanged (no-op write)', () => {
		// A YAML re-render normalizes (drops the SEED's comments + flow style), so the FIRST
		// plan vs the hand-written SEED is legitimately a change. Persisting it, then re-planning
		// the SAME mode against the now-normalized file, is a true no-op — unchanged.
		const first = planOrchestrationWrite({ filePath: file, change: { mode: 'event' } });
		writeFileSync(file, first.proposed, 'utf8');
		const second = planOrchestrationWrite({ filePath: file, change: { mode: 'event' } });
		expect(second.diff.unchanged).toBe(true);
	});

	it('PRESERVES the tuned bundles across a mode flip', () => {
		const plan = planOrchestrationWrite({ filePath: file, change: { mode: 'periodic' } });
		expect(plan.proposed).toMatch(/code-write/);
		expect(plan.proposed).toMatch(/thinking:\s*medium/);
		expect(plan.proposed).toMatch(/toolCalls:\s*40/);
	});

	it('rejects an out-of-enum mode at the boundary (no write happens)', () => {
		expect(() =>
			planOrchestrationWrite({ filePath: file, change: { mode: 'turbo' as never } })
		).toThrow(OrchestrationWriteError);
		// File untouched.
		expect(readFileSync(file, 'utf8')).toBe(SEED);
	});

	it('rejects a non-positive interval', () => {
		expect(() =>
			planOrchestrationWrite({ filePath: file, change: { intervalMs: 0 } })
		).toThrow(OrchestrationWriteError);
	});

	// MODEL-BENCHMARK-SPEC step 1 — the global default-provider toggle rides the SAME write contract.
	it('diffs + validates + persists a defaultProvider change (validate → confirm → read-back)', () => {
		const plan = planOrchestrationWrite({ filePath: file, change: { defaultProvider: 'local' } });
		expect(plan.diff.unchanged).toBe(false);
		expect(plan.proposed).toMatch(/defaultProvider:\s*local/);
		const res = applyOrchestrationWrite({
			filePath: file,
			proposed: plan.proposed,
			confirmToken: plan.confirmToken
		});
		expect(res.bytesWritten).toBeGreaterThan(0);
		// Round-trip through the REAL loader off disk — the persisted provider is the new one.
		expect(loadOrchestration(file).defaultProvider).toBe('local');
	});

	it('rejects an out-of-enum defaultProvider at the boundary (no write)', () => {
		expect(() =>
			planOrchestrationWrite({ filePath: file, change: { defaultProvider: 'gpu' as never } })
		).toThrow(OrchestrationWriteError);
		expect(readFileSync(file, 'utf8')).toBe(SEED);
	});

	it('a defaultProvider change PRESERVES mode + tuned bundles', () => {
		const plan = planOrchestrationWrite({ filePath: file, change: { defaultProvider: 'cloud' } });
		expect(plan.proposed).toMatch(/mode:\s*event/);
		expect(plan.proposed).toMatch(/code-write/);
		expect(plan.proposed).toMatch(/thinking:\s*medium/);
	});
});

describe('applyOrchestrationWrite', () => {
	it('writes the file on a clean confirm and the loader reads the new mode', () => {
		const plan = planOrchestrationWrite({ filePath: file, change: { mode: 'manual' } });
		const res = applyOrchestrationWrite({
			filePath: file,
			proposed: plan.proposed,
			confirmToken: plan.confirmToken
		});
		expect(res.mode).toBe('manual');
		expect(res.bytesWritten).toBeGreaterThan(0);
		// Round-trip through the REAL loader off disk — the persisted mode is the new one.
		expect(loadOrchestration(file).mode).toBe('manual');
		// And the bundles survived.
		expect(loadOrchestration(file).bundles?.['code-write']?.toolCalls).toBe(40);
	});

	it('refuses a stale confirm token (file changed since the diff — D-010)', () => {
		const plan = planOrchestrationWrite({ filePath: file, change: { mode: 'manual' } });
		// A hand-edit lands between plan and confirm.
		writeFileSync(file, SEED.replace('maxAgents: 8', 'maxAgents: 6'), 'utf8');
		expect(() =>
			applyOrchestrationWrite({
				filePath: file,
				proposed: plan.proposed,
				confirmToken: plan.confirmToken
			})
		).toThrow(StaleConfirmError);
		// The hand-edit is NOT clobbered.
		expect(readFileSync(file, 'utf8')).toMatch(/maxAgents:\s*6/);
	});

	it('refuses an empty confirm token', () => {
		const plan = planOrchestrationWrite({ filePath: file, change: { mode: 'manual' } });
		expect(() =>
			applyOrchestrationWrite({ filePath: file, proposed: plan.proposed, confirmToken: '' })
		).toThrow(OrchestrationWriteError);
	});

	it('re-validates the proposed bytes (defense in depth) and refuses invalid YAML content', () => {
		const plan = planOrchestrationWrite({ filePath: file, change: { mode: 'manual' } });
		expect(() =>
			applyOrchestrationWrite({
				filePath: file,
				proposed: 'mode: not_a_mode\nconcurrency: {maxAgents: 1, perProject: 1}\n',
				confirmToken: plan.confirmToken
			})
		).toThrow();
		// File untouched by the rejected apply.
		expect(loadOrchestration(file).mode).toBe('event');
	});
});
