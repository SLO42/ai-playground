import { EventEmitter } from 'events';

export interface BusEvent {
	channel: 'tasks' | 'services' | 'sessions' | 'heartbeat' | 'analytics';
	type: string; // e.g. 'created', 'updated', 'started', 'completed'
	data?: unknown;
	timestamp: string;
}

// Singleton — survives HMR via globalThis
const _g = globalThis as Record<string, unknown>;
if (!_g.__claw_event_bus) _g.__claw_event_bus = new EventEmitter();
const bus = _g.__claw_event_bus as EventEmitter;
bus.setMaxListeners(50); // allow many SSE clients

export function emit(event: BusEvent): void {
	bus.emit('update', event);
}

export function subscribe(listener: (event: BusEvent) => void): () => void {
	bus.on('update', listener);
	return () => bus.off('update', listener);
}
