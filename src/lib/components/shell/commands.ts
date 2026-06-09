/**
 * CommandPalette command registry (UI-SPEC §3 "jump to any page, project, task,
 * or action"; §148 CommandPalette). Pure, DOM-free model so the registry is
 * unit-testable (node env) and the palette component stays a thin renderer.
 *
 * A command is either a NAVIGATION (go to a route) or an ACTION (run a callback,
 * e.g. start a manual run, toggle reduced motion). Navigation commands are built
 * from the live `navGroups` (the same source the Sidebar uses — no second nav
 * truth) plus the dynamic per-project "open project" set passed in at runtime.
 */

import { navGroups } from './nav';

export type CommandKind = 'navigate' | 'action' | 'project';

export interface Command {
	/** Stable id (for keying + tests). */
	id: string;
	/** Primary label shown + fuzzy-matched. */
	label: string;
	/** Section grouping in the palette ("Go to", "Projects", "Actions"). */
	section: string;
	kind: CommandKind;
	/** Extra fuzzy-match aliases (synonyms) that never render. */
	keywords?: string[];
	/** For `navigate`/`project`: the href to go to. */
	href?: string;
	/** For `action`: the side-effect to run when chosen. */
	run?: () => void;
	/** Optional right-aligned hint (e.g. a route path or shortcut). */
	hint?: string;
}

/** A project the palette can jump to (minimal projection from the layout load). */
export interface PaletteProject {
	id: string;
	name: string;
}

/** Build the navigation commands from the shared nav model (single source). */
export function navCommands(): Command[] {
	return navGroups.flatMap((group) =>
		group.items.map((item) => ({
			id: `nav:${item.href}`,
			label: `Go to ${item.label}`,
			section: 'Go to',
			kind: 'navigate' as const,
			href: item.href,
			hint: item.href,
			keywords: [item.label, group.title]
		}))
	);
}

/** Build the per-project "open" commands from the live project list. */
export function projectCommands(projects: readonly PaletteProject[]): Command[] {
	return projects.map((p) => ({
		id: `project:${p.id}`,
		label: `Open project ${p.name}`,
		section: 'Projects',
		kind: 'project' as const,
		href: `/projects/${encodeURIComponent(p.id)}`,
		hint: p.name,
		keywords: [p.name, 'open', 'project']
	}));
}

/** Actions the palette can fire (callbacks wired by the host component). */
export interface ActionHandlers {
	startManualRun: () => void;
	toggleReducedMotionHint?: () => void;
}

export function actionCommands(handlers: ActionHandlers): Command[] {
	const cmds: Command[] = [
		{
			id: 'action:start-manual-run',
			label: 'Start manual run',
			section: 'Actions',
			kind: 'action',
			keywords: ['execute', 'spawn', 'agent', 'session', 'run'],
			run: handlers.startManualRun
		}
	];
	return cmds;
}

/**
 * Assemble the full command list in stable section order
 * (Go to → Projects → Actions). The palette ranks/filters this set.
 */
export function buildCommands(
	projects: readonly PaletteProject[],
	handlers: ActionHandlers
): Command[] {
	return [...navCommands(), ...projectCommands(projects), ...actionCommands(handlers)];
}
