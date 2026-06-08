// TASK 3.5 — services manager + incidents/notifications barrel.
export {
	ServicesManager,
	SERVICE_NAMES,
	type ServiceName,
	type ServiceStatus,
	type ServiceAdapter,
	type ServiceRow,
	type TickResult,
	type ServicesManagerOptions
} from './manager';
export { SurrealServiceAdapter } from './surreal-adapter';
export {
	recordIncident,
	recordNotification,
	listIncidents,
	listUnreadNotifications,
	type IncidentRow,
	type NotificationRow,
	type IncidentInput,
	type IncidentSeverity
} from './incidents';
export { isPidAlive, killPid } from './proc';
