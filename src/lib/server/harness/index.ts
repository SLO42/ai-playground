// server/harness — public barrel (TASK 6.7).
//
// The UI-action wiring seam: assembles the runtime + bus + per-boot control token the
// dashboard write surfaces (session launch/control, workflow/release run) all share, with
// honest availability when the Claude Code credential is absent (F-008).

export {
	getBus,
	getBootToken,
	getRuntime,
	getProviderHealth,
	getMemoryService,
	parseExtraction,
	resolveCapabilitiesForIntent,
	DEFAULT_MODEL,
	DEFAULT_AGENT,
	DEFAULT_BUDGETS,
	DEFAULT_TOOL_POLICY,
	DEFAULT_INTENT,
	EMBEDDING_MODEL,
	EXTRACTION_MODEL,
	type RuntimeAvailability,
	type MemoryAvailability
} from './wiring';
