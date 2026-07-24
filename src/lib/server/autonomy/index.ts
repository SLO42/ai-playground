// SD-2 — autonomy boot-status barrel. The honest, persisted autonomy state (armed | manual |
// config-error) computed once at boot and surfaced on /services (F-008 — no silent disarm).
export {
	computeAutonomyStatus,
	persistAutonomyStatus,
	readAutonomyStatus,
	type AutonomyState,
	type AutonomyAssessment,
	type AutonomyStatusRow
} from './status';
