/**
 * TASK BOARD — the DB-DOWN shadow path (the third of the four: nil · empty · upstream error).
 *
 * This file deliberately NEVER initialises the runtime DB singleton, so `tryGetDb()` really returns
 * null and the loader's disconnected branch runs for real (vitest isolates each file's module
 * registry, so a sibling suite's singleton cannot leak in here).
 *
 * What it pins: a database that is down must produce a NAMED state, not a plausible-looking empty
 * board. `connected:false` with `tasks: []` is the honest shape — and the page renders "Live data
 * unavailable · start SurrealDB" for it, which is a different sentence from "this project has no
 * tasks yet" (F-008). Conflating those two is precisely the fabricated-state class.
 *
 * The malformed-slug case is checked here too, because it must 404 BEFORE any DB is consulted —
 * an invalid record id is a boundary refusal (D-016), not a connectivity outcome.
 */

import { describe, it, expect } from 'vitest';
import * as devalue from 'devalue';
import { load, type TaskBoardData } from './+page.server';

async function runLoad(slug: string): Promise<TaskBoardData> {
	return (await load({
		params: { id: slug },
		depends: () => {},
		url: new URL(`http://localhost/projects/${slug}/tasks`)
	} as unknown as Parameters<typeof load>[0])) as TaskBoardData;
}

describe('task board loader — database down', () => {
	it('returns a NAMED disconnected state, never an empty board dressed as "no tasks"', async () => {
		const data = await runLoad('anyproject');
		expect(data.connected).toBe(false);
		expect(data.tasks).toEqual([]);
		expect(data.projectId).toBe('project:anyproject');
		expect(data.slug).toBe('anyproject');
		// Honest absence, not a fabricated name (F-008).
		expect(data.projectName).toBeNull();
	});

	it('still ships the vocabulary the page needs to render its columns', async () => {
		const data = await runLoad('anyproject');
		expect(data.taskStatuses).toContain('ready');
		expect(data.taskPriorities).toContain('critical');
	});

	it('reports sprint reality as zeroes — measured absence, never an invented figure', async () => {
		const data = await runLoad('anyproject');
		expect(data.sprintReality).toEqual({ total: 0, timeBoxed: 0, withTasks: 0 });
	});

	it('the disconnected payload is still POJOs only (devalue-safe)', async () => {
		const data = await runLoad('anyproject');
		expect(() => devalue.stringify(data)).not.toThrow();
	});

	it('a malformed slug 404s at the D-016 boundary, before any DB is consulted', async () => {
		await expect(runLoad('has spaces')).rejects.toMatchObject({ status: 404 });
		await expect(runLoad('')).rejects.toMatchObject({ status: 404 });
	});
});
