import { describe, expect, it, vi } from 'vitest';
import { navGroups } from './nav';
import {
	actionCommands,
	buildCommands,
	navCommands,
	projectCommands,
	type PaletteProject
} from './commands';

describe('navCommands', () => {
	it('produces one navigate command per nav item (single source = navGroups)', () => {
		const total = navGroups.reduce((n, g) => n + g.items.length, 0);
		const cmds = navCommands();
		expect(cmds).toHaveLength(total);
		expect(cmds.every((c) => c.kind === 'navigate')).toBe(true);
		expect(cmds.every((c) => typeof c.href === 'string' && c.href.startsWith('/'))).toBe(true);
	});

	it('labels read "Go to <page>" and carry the page name as a keyword', () => {
		const home = navCommands().find((c) => c.href === '/');
		expect(home?.label).toBe('Go to Home');
		expect(home?.keywords).toContain('Home');
	});
});

describe('projectCommands', () => {
	const projects: PaletteProject[] = [
		{ id: 'project:abc', name: 'SWIP' },
		{ id: 'project:def', name: 'BG3 mod' }
	];

	it('builds an open command per project with an encoded href', () => {
		const cmds = projectCommands(projects);
		expect(cmds).toHaveLength(2);
		expect(cmds[0].href).toBe('/projects/project%3Aabc');
		expect(cmds[0].label).toBe('Open project SWIP');
		expect(cmds[0].kind).toBe('project');
	});

	it('is empty for no projects (honest empty, no fabrication)', () => {
		expect(projectCommands([])).toEqual([]);
	});
});

describe('actionCommands', () => {
	it('wires the start-manual-run callback', () => {
		const startManualRun = vi.fn();
		const cmds = actionCommands({ startManualRun });
		const run = cmds.find((c) => c.id === 'action:start-manual-run');
		expect(run).toBeDefined();
		run?.run?.();
		expect(startManualRun).toHaveBeenCalledOnce();
	});
});

describe('buildCommands', () => {
	it('assembles nav + project + action commands in section order', () => {
		const cmds = buildCommands([{ id: 'project:x', name: 'X' }], { startManualRun: () => {} });
		const sections = [...new Set(cmds.map((c) => c.section))];
		expect(sections).toEqual(['Go to', 'Projects', 'Actions']);
	});

	it('all commands have a unique id', () => {
		const cmds = buildCommands([{ id: 'project:x', name: 'X' }], { startManualRun: () => {} });
		const ids = cmds.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
