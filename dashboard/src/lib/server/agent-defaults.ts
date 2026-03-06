import { readFile } from 'fs/promises';
import { PATHS } from './constants.js';

export interface AgentDefaultsSettings {
	defaultModel: string;
	maxConcurrentAgents: number;
	defaultTopology: string;
}

export const AGENT_DEFAULTS: AgentDefaultsSettings = {
	defaultModel: 'gpt-oss-20b',
	maxConcurrentAgents: 5,
	defaultTopology: 'hierarchical'
};

export async function loadAgentDefaults(filePath?: string): Promise<AgentDefaultsSettings> {
	try {
		const raw = await readFile(filePath ?? PATHS.agentDefaultsSettings, 'utf-8');
		return { ...AGENT_DEFAULTS, ...JSON.parse(raw) };
	} catch {
		return { ...AGENT_DEFAULTS };
	}
}
