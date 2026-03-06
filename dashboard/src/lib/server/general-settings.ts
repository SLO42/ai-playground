import { readFile } from 'fs/promises';
import { PATHS } from './constants.js';

export interface GeneralSettings {
	requireConfirmation: boolean;
	autoApproveLowRisk: boolean;
	showCommandsInInputBar: boolean;
	defaultTimeout: string;
	projectOverride: boolean;
}

export const GENERAL_DEFAULTS: GeneralSettings = {
	requireConfirmation: true,
	autoApproveLowRisk: false,
	showCommandsInInputBar: true,
	defaultTimeout: '30 minutes',
	projectOverride: true
};

export async function loadGeneralSettings(filePath?: string): Promise<GeneralSettings> {
	try {
		const raw = await readFile(filePath ?? PATHS.generalSettings, 'utf-8');
		return { ...GENERAL_DEFAULTS, ...JSON.parse(raw) };
	} catch {
		return { ...GENERAL_DEFAULTS };
	}
}

/** Tools that are read-only or have no side effects */
const LOW_RISK_TOOLS = new Set([
	'ls_projects',
	'exec_task',
	'scan_memory',
	'trace_sessions',
	'probe_service'
]);

/** Returns true if a tool call is considered low-risk (read-only, no mutations) */
export function isLowRiskTool(toolName: string): boolean {
	return LOW_RISK_TOOLS.has(toolName);
}

/** Returns true if the tool should auto-execute given the current settings */
export function shouldAutoExecute(toolName: string, settings: GeneralSettings): boolean {
	if (!settings.requireConfirmation) return true;
	if (settings.autoApproveLowRisk && isLowRiskTool(toolName)) return true;
	return false;
}

/** Parse the defaultTimeout string into milliseconds. Returns 0 for "No timeout". */
export function parseTimeoutMs(timeout: string): number {
	if (timeout === 'No timeout') return 0;
	const match = timeout.match(/^(\d+)\s*minutes?$/i);
	if (match) return parseInt(match[1], 10) * 60 * 1000;
	return 30 * 60 * 1000; // fallback 30 min
}
