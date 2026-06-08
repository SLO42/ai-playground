// server/claude-code — public barrel (TASK 1.4 slice: agent_slot sync).
//
// The full Claude Code session orchestration (launch/stream/interject/stop/resume,
// session+message persistence) lands in 1.6 / 2.10. TASK 1.4 contributes the
// agent_slot config-mirror sync (DATA-MODEL §4.3) — populating the pool mirror from
// config/agent-pool.yaml.

export {
	syncAgentSlots,
	listAgentSlots,
	slotTierOf,
	SLOT_TIERS,
	type SlotTier,
	type AgentSlotRow
} from './slots';

// TASK 1.4a — PRIMARY safety guardrail (D-024/D-018): seed per-project
// .claude/settings.json deny rules + explicit cwd BEFORE any agent spawns, and the
// server-independent fail-closed path-confinement resolver.
export {
	buildGuardrailSettings,
	writeProjectGuardrails,
	resolveConfinedTarget,
	PathConfinementError,
	CONFIG_PROTECTION_DENY,
	DANGEROUS_BASH_DENY,
	GUARDRAIL_SETTINGS_VERSION,
	type GuardrailInput,
	type GuardrailSettings
} from './guardrails';

// TASK 2.10 — session control: the channel.pushToSession seam + interject/stop/resume
// + fleet view (D-011/D-035/D-025/D-026). Origin is server-stamped + immutable; only an
// authenticated operator (D-025 token on the loopback control endpoint) may steer.
export {
	createChannel,
	type Channel,
	type ChannelDeps,
	type Origin,
	type InterjectRequest,
	type InterjectResult,
	type StopRequest,
	type StopResult,
	type ResumeRequest,
	type ResumeResult,
	type FleetRow
} from './channel';
