// server/agent-library — public barrel.
//
// The operator "brain" Available-Agents view: a read-only disk index of every specialist
// agent definition (.claude/agents/**/*.md from the platform repo's main worktree) plus a
// best-effort usage bridge (name === role.slug ⋈ session). Authoritative from disk + live DB
// rows (F-008); honest empties when the library is unconfigured or an agent has no runs.

export {
	agentLibraryAgentsDir,
	listLibraryAgents,
	readLibraryAgentContent,
	type LibraryAgent,
	type LibraryAgentContent
} from './library';

export { agentUsageBySlug, type AgentUsage } from './usage';
