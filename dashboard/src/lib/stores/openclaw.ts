import { writable, derived, get } from 'svelte/store';

export interface GatewayFrame {
	type: 'req' | 'res' | 'event';
	method?: string;
	id?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: string;
	event?: string;
	data?: unknown;
}

interface GatewayState {
	connected: boolean;
	url: string;
	sessions: unknown[];
	channels: unknown[];
	agents: unknown[];
	models: unknown[];
	tools: unknown[];
	lastEvent: GatewayFrame | null;
	error: string | null;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_MS = 5000;
const WS_URL = 'ws://127.0.0.1:18789';

function createOpenClawStore() {
	let ws: WebSocket | null = null;
	let reconnectAttempts = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	let reqCounter = 0;

	const store = writable<GatewayState>({
		connected: false,
		url: WS_URL,
		sessions: [],
		channels: [],
		agents: [],
		models: [],
		tools: [],
		lastEvent: null,
		error: null
	});

	function nextId(): string {
		return `req-${++reqCounter}-${Date.now()}`;
	}

	function clearTimers() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	}

	function scheduleReconnect() {
		const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
		reconnectAttempts++;
		reconnectTimer = setTimeout(() => connect(), delay);
	}

	function startHeartbeat() {
		heartbeatTimer = setInterval(() => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				send('ping', {}).catch(() => {});
			}
		}, HEARTBEAT_MS);
	}

	function handleMessage(raw: string) {
		try {
			const frame: GatewayFrame = JSON.parse(raw);

			if (frame.type === 'res' && frame.id) {
				const pending = pendingRequests.get(frame.id);
				if (pending) {
					pendingRequests.delete(frame.id);
					if (frame.error) {
						pending.reject(new Error(frame.error));
					} else {
						pending.resolve(frame.result);
					}
				}
			}

			if (frame.type === 'event') {
				store.update((s) => ({ ...s, lastEvent: frame }));
				handleEvent(frame);
			}
		} catch {
			// ignore malformed frames
		}
	}

	function handleEvent(frame: GatewayFrame) {
		switch (frame.event) {
			case 'channel.connected':
			case 'channel.disconnected':
				refreshChannels();
				break;
			case 'chat':
			case 'exec.approval.requested':
			case 'tick':
				// consumers can subscribe to lastEvent for these
				break;
		}
	}

	async function refreshChannels() {
		try {
			const result = await send('channels.status', {});
			store.update((s) => ({ ...s, channels: result as unknown[] }));
		} catch {
			// ignore
		}
	}

	function connect() {
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			return;
		}

		try {
			ws = new WebSocket(WS_URL);
		} catch {
			store.update((s) => ({ ...s, connected: false, error: 'Failed to create WebSocket' }));
			scheduleReconnect();
			return;
		}

		ws.onopen = () => {
			reconnectAttempts = 0;
			store.update((s) => ({ ...s, connected: true, error: null }));
			startHeartbeat();
		};

		ws.onmessage = (ev) => {
			if (typeof ev.data === 'string') {
				handleMessage(ev.data);
			}
		};

		ws.onclose = () => {
			clearTimers();
			store.update((s) => ({ ...s, connected: false }));
			// reject all pending requests
			for (const [, pending] of pendingRequests) {
				pending.reject(new Error('Connection closed'));
			}
			pendingRequests.clear();
			scheduleReconnect();
		};

		ws.onerror = () => {
			store.update((s) => ({ ...s, error: 'WebSocket error' }));
		};
	}

	function send(method: string, params: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				reject(new Error('Not connected'));
				return;
			}

			const id = nextId();
			const frame: GatewayFrame = { type: 'req', method, id, params };

			pendingRequests.set(id, { resolve, reject });
			setTimeout(() => {
				if (pendingRequests.has(id)) {
					pendingRequests.delete(id);
					reject(new Error('Request timeout'));
				}
			}, 10000);

			ws.send(JSON.stringify(frame));
		});
	}

	function start() {
		connect();
	}

	function stop() {
		clearTimers();
		pendingRequests.clear();
		if (ws) {
			ws.onclose = null;
			ws.close();
			ws = null;
		}
		store.update((s) => ({ ...s, connected: false }));
	}

	const connected = derived(store, ($s) => $s.connected);

	return {
		subscribe: store.subscribe,
		connected,
		send,
		start,
		stop,
		refresh: {
			async sessions() {
				try {
					const r = await send('sessions.list', {});
					store.update((s) => ({ ...s, sessions: r as unknown[] }));
				} catch { /* ignore */ }
			},
			async channels() {
				await refreshChannels();
			},
			async agents() {
				try {
					const r = await send('agents.list', {});
					store.update((s) => ({ ...s, agents: r as unknown[] }));
				} catch { /* ignore */ }
			},
			async models() {
				try {
					const r = await send('models.list', {});
					store.update((s) => ({ ...s, models: r as unknown[] }));
				} catch { /* ignore */ }
			},
			async tools() {
				try {
					const r = await send('tools.catalog', {});
					store.update((s) => ({ ...s, tools: r as unknown[] }));
				} catch { /* ignore */ }
			}
		}
	};
}

export const openClaw = createOpenClawStore();
