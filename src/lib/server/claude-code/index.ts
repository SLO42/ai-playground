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
