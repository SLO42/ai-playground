// SD-2 — autonomy boot-status barrel. The honest, persisted autonomy state (armed | manual |
// config-error) computed once at boot and surfaced on /services (F-008 — no silent disarm).
//
// COMPLETION-LEDGER Wave A EXTENDS the same row (never a second mechanism, F-055) with the
// per-subsystem BOOT-SKIP ledger, so /services also answers "what did not start, and why".
export {
	computeAutonomyStatus,
	persistAutonomyStatus,
	readAutonomyStatus,
	subsystemOk,
	subsystemOff,
	subsystemDegraded,
	type AutonomyState,
	type AutonomyAssessment,
	type AutonomyStatusRow,
	type SubsystemStatus,
	type SubsystemSeverity
} from './status';
