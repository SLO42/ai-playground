/**
 * OpenClaw Gateway WebSocket Client
 *
 * Connects Claw agents to the OpenClaw gateway (port 18789) instead of
 * calling Ollama directly. This gives agents access to OpenClaw's tools,
 * workspace, skills, and filesystem capabilities.
 *
 * Protocol: WS connect → challenge nonce → Ed25519 sign → connect → chat
 */
import { sign, createPrivateKey } from 'crypto';
import { pathToFileURL } from 'url';
import { APIS, PATHS } from '../constants.js';

// ── SDK imports (bypass package.json exports restriction) ────────────

interface DeviceIdentity {
	deviceId: string;
	publicKeyPem: string;
	privateKeyPem: string;
}

// Lazy-loaded SDK functions
let _sdkLoaded = false;
let loadOrCreateDeviceIdentity: (path: string) => Promise<DeviceIdentity>;
let buildDeviceAuthPayload: (params: {
	deviceId: string; clientId: string; clientMode: string;
	role: string; scopes: string[]; signedAtMs: number;
	token: string; nonce: string;
}) => string;
let normalizeDevicePublicKeyBase64Url: (pem: string) => string;

async function ensureSDK(): Promise<void> {
	if (_sdkLoaded) return;
	const clientPath = `${PATHS.root}/node_modules/openclaw/dist/client-CuIxivDk.js`;
	const mod = await import(pathToFileURL(clientPath).href);
	loadOrCreateDeviceIdentity = mod.nn;
	buildDeviceAuthPayload = mod.Lt;
	normalizeDevicePublicKeyBase64Url = mod.rn;
	_sdkLoaded = true;
}

// ── Types ────────────────────────────────────────────────────────────

interface GatewayMessage {
	type: string;
	id?: string;
	event?: string;
	method?: string;
	params?: unknown;
	ok?: boolean;
	result?: unknown;
	error?: { code: string; message: string };
	payload?: Record<string, unknown>;
}

interface ChatEvent {
	runId: string;
	sessionKey: string;
	seq: number;
	state: 'delta' | 'final';
	message: {
		role: string;
		content: Array<{ type: string; text?: string }>;
		timestamp: number;
	};
}

export interface GatewayClientOptions {
	token?: string;
	identityPath?: string;
	timeout?: number;
}

// ── Gateway Client ───────────────────────────────────────────────────

export class OpenClawGatewayClient {
	private ws: WebSocket | null = null;
	private identity: DeviceIdentity | null = null;
	private token: string;
	private identityPath: string;
	private timeout: number;
	private reqId = 0;
	private pending = new Map<string, {
		resolve: (v: unknown) => void;
		reject: (e: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private connected = false;
	private connectPromise: Promise<void> | null = null;
	private eventHandlers = new Map<string, (payload: unknown) => void>();

	constructor(opts: GatewayClientOptions = {}) {
		this.token = opts.token ?? process.env.OPENCLAW_TOKEN ?? '';
		this.identityPath = opts.identityPath ?? `${PATHS.root}/.playground/claw-device-identity.json`;
		this.timeout = opts.timeout ?? 30000;
	}

	/** Connect to the gateway. Resolves when authenticated. */
	async connect(): Promise<void> {
		if (this.connected) return;
		if (this.connectPromise) return this.connectPromise;

		this.connectPromise = this._doConnect();
		try {
			await this.connectPromise;
		} finally {
			this.connectPromise = null;
		}
	}

	private async _doConnect(): Promise<void> {
		await ensureSDK();
		this.identity = await loadOrCreateDeviceIdentity(this.identityPath);

		// Dynamic import ws for Node.js
		const { default: WebSocket } = await import('ws');

		return new Promise<void>((resolveConnect, rejectConnect) => {
			const wsUrl = APIS.gateway;
			this.ws = new WebSocket(wsUrl, {
				headers: { Origin: 'http://127.0.0.1:18789' }
			}) as unknown as WebSocket;

			const connectTimeout = setTimeout(() => {
				rejectConnect(new Error('Gateway connection timeout'));
				this.disconnect();
			}, this.timeout);

			(this.ws as any).on('open', () => {
				// Wait for challenge
			});

			(this.ws as any).on('error', (e: Error) => {
				clearTimeout(connectTimeout);
				rejectConnect(new Error(`Gateway WS error: ${e.message}`));
			});

			(this.ws as any).on('close', () => {
				this.connected = false;
				// Reject all pending requests
				for (const [id, p] of this.pending) {
					p.reject(new Error('Gateway connection closed'));
					clearTimeout(p.timer);
					this.pending.delete(id);
				}
			});

			(this.ws as any).on('message', async (data: Buffer) => {
				const msg = JSON.parse(data.toString()) as GatewayMessage;

				// Handle challenge → authenticate
				if (msg.type === 'event' && msg.event === 'connect.challenge') {
					try {
						const nonce = msg.payload!.nonce as string;
						await this._authenticate(nonce);
						clearTimeout(connectTimeout);
						this.connected = true;
						resolveConnect();
					} catch (e) {
						clearTimeout(connectTimeout);
						rejectConnect(e instanceof Error ? e : new Error(String(e)));
					}
					return;
				}

				// Handle response to a request
				if (msg.type === 'res' && msg.id) {
					const p = this.pending.get(msg.id);
					if (p) {
						this.pending.delete(msg.id);
						clearTimeout(p.timer);
						if (msg.ok === false) {
							p.reject(new Error(JSON.stringify(msg.error)));
						} else {
							p.resolve(msg.result);
						}
					}
					return;
				}

				// Handle events (chat streaming, etc.)
				if (msg.type === 'event' && msg.event) {
					const handler = this.eventHandlers.get(msg.event);
					if (handler) handler(msg.payload);
				}
			});
		});
	}

	private async _authenticate(nonce: string): Promise<void> {
		const identity = this.identity!;
		const signedAt = Date.now();
		const role = 'operator';
		const scopes = ['operator.admin'];

		const payloadStr = buildDeviceAuthPayload({
			deviceId: identity.deviceId,
			clientId: 'webchat',
			clientMode: 'webchat',
			role, scopes,
			signedAtMs: signedAt,
			token: this.token,
			nonce
		});

		const privKey = createPrivateKey(identity.privateKeyPem);
		const sigBuf = sign(null, Buffer.from(payloadStr), privKey);
		const signature = sigBuf.toString('base64url');

		await this.request('connect', {
			minProtocol: 3, maxProtocol: 3,
			client: {
				id: 'webchat', version: 'dev', platform: 'node',
				mode: 'webchat', instanceId: 'claw-' + process.pid
			},
			role, scopes,
			device: {
				id: identity.deviceId,
				publicKey: normalizeDevicePublicKeyBase64Url(identity.publicKeyPem),
				signature, signedAt, nonce
			},
			auth: { token: this.token },
			caps: []
		});
	}

	/** Send a request to the gateway and wait for a response. */
	request(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.ws || (this.ws as any).readyState !== 1) {
				// During connect, ws might be open but not yet 'connected'
				// Allow requests during auth phase
			}

			const id = 'r' + (++this.reqId);
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Gateway request timeout: ${method}`));
			}, this.timeout);

			this.pending.set(id, { resolve, reject, timer });
			(this.ws as any).send(JSON.stringify({ type: 'req', id, method, params }));
		});
	}

	/**
	 * Send a chat message and collect the full response.
	 * Waits for the final chat event and returns the text.
	 */
	async chat(message: string, sessionKey?: string): Promise<string> {
		if (!this.connected) await this.connect();

		const key = sessionKey ?? `claw-${Date.now()}`;
		const idempotencyKey = `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.eventHandlers.delete('chat');
				reject(new Error('Chat response timeout'));
			}, this.timeout);

			// Listen for chat events
			this.eventHandlers.set('chat', (payload: unknown) => {
				const event = payload as ChatEvent;
				if (event.state === 'final') {
					clearTimeout(timeout);
					this.eventHandlers.delete('chat');
					const text = event.message.content
						?.filter(c => c.type === 'text')
						.map(c => c.text ?? '')
						.join('') ?? '';
					resolve(text);
				}
			});

			// Send the chat request
			this.request('chat.send', {
				sessionKey: key,
				message,
				idempotencyKey
			}).catch((err) => {
				clearTimeout(timeout);
				this.eventHandlers.delete('chat');
				reject(err);
			});
		});
	}

	/** Register an event handler. */
	on(event: string, handler: (payload: unknown) => void): void {
		this.eventHandlers.set(event, handler);
	}

	/** Disconnect from the gateway. */
	disconnect(): void {
		this.connected = false;
		if (this.ws) {
			try { (this.ws as any).close(); } catch { /* ignore */ }
			this.ws = null;
		}
		for (const [, p] of this.pending) {
			p.reject(new Error('Client disconnected'));
			clearTimeout(p.timer);
		}
		this.pending.clear();
		this.eventHandlers.clear();
	}

	get isConnected(): boolean {
		return this.connected;
	}
}

// ── Singleton ────────────────────────────────────────────────────────

let _client: OpenClawGatewayClient | null = null;

/**
 * Get a shared gateway client instance.
 * Creates and connects on first call; reuses on subsequent calls.
 */
export async function getGatewayClient(): Promise<OpenClawGatewayClient> {
	if (_client?.isConnected) return _client;

	_client?.disconnect();
	_client = new OpenClawGatewayClient();
	await _client.connect();
	return _client;
}

/**
 * Query the gateway with a simple message. Handles connection lifecycle.
 * Returns the assistant's text response.
 */
export async function queryGateway(message: string, sessionKey?: string): Promise<string> {
	const client = await getGatewayClient();
	return client.chat(message, sessionKey);
}
