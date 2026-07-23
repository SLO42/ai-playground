// TASK 3.5 — services manager + incidents/notifications barrel.
export {
	ServicesManager,
	SERVICE_NAMES,
	type ServiceName,
	type ServiceStatus,
	type ServiceAction,
	type OperateResult,
	type ServiceAdapter,
	type ServiceRow,
	type TickResult,
	type ServicesManagerOptions
} from './manager';
export { SurrealServiceAdapter } from './surreal-adapter';
export { OllamaServiceAdapter, type OllamaAdapterOptions } from './ollama-adapter';
export {
	getServicesManager,
	readServices,
	operateService,
	ServiceControlError,
	__resetServicesRuntime,
	type ServiceView,
	type ServicesData
} from './runtime';
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
export { ServicesTicker, DEFAULT_SERVICES_TICK_MS, type ServicesTickerOptions } from './ticker';
