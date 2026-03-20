import { invalidateAll } from '$app/navigation';
import { browser } from '$app/environment';

let eventSource: EventSource | null = null;
let connected = $state(false);
let lastEvent = $state<{ channel: string; type: string; timestamp: string } | null>(null);

export function startLiveUpdates(): void {
	if (!browser || eventSource) return;

	eventSource = new EventSource('/api/events');

	eventSource.onopen = () => {
		connected = true;
	};

	eventSource.onmessage = (e) => {
		try {
			const event = JSON.parse(e.data);
			lastEvent = { channel: event.channel, type: event.type, timestamp: event.timestamp };
			// Invalidate SvelteKit load functions to refresh page data
			invalidateAll();
		} catch {
			/* ignore parse errors */
		}
	};

	eventSource.onerror = () => {
		connected = false;
		eventSource?.close();
		eventSource = null;
		// Auto-reconnect after 5s
		setTimeout(startLiveUpdates, 5000);
	};
}

export function stopLiveUpdates(): void {
	eventSource?.close();
	eventSource = null;
	connected = false;
}

export function isConnected(): boolean {
	return connected;
}

export function getLastEvent() {
	return lastEvent;
}
