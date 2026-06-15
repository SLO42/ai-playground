// G-B — the loopback /api/peer/send endpoint contract (src/routes/api/peer/send/+server.ts).
//
// The endpoint is a thin AUTH + SENDER-RESOLUTION + DISPATCH shell over sendPeer (the engine,
// red-teamed against a real SurrealDB in src/lib/server/peer/send.test.ts). This suite proves the
// SHELL's contract with the engine + runtime mocked:
//   • D-025 auth (real authorizeHookRequest): unauthorized → 401, engine NEVER called;
//   • D-035a: the SENDER is the x-atelier-session HEADER, NEVER the body — a sender-less request
//     is a 400 (we will not stamp an unverifiable sender); the body's `from`/identity claims are
//     dropped by coerceAddress (only `to`/`body`/`hops` survive);
//   • DISPATCH: an authorized request reaches sendPeer with the header sender + coerced address;
//   • NAMED errors map to honest statuses (cross-project→403, budget→429, hops/address→400);
//   • SHADOW PATHS: malformed body → atelier-or-400; no DB → honest ok:false.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendPeerMock = vi.fn();
const tryGetDbMock = vi.fn();
const getRuntimeMock = vi.fn();

vi.mock('$lib/server/db/runtime-init', () => ({ tryGetDb: () => tryGetDbMock() }));
vi.mock('$lib/server/harness', () => ({
	getBus: () => ({ publish: () => {} }),
	getBootToken: () => 'boot-token-xyz',
	getRuntime: (...a: unknown[]) => getRuntimeMock(...a)
}));
vi.mock('$lib/server/claude-code', () => ({
	createChannel: () => ({ interject: async () => ({ origin: 'agent', steered: false, messageId: 'message:x' }) })
}));
// Mock the engine but keep the REAL named-error classes so `instanceof` mapping works.
vi.mock('$lib/server/peer/send', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, sendPeer: (...a: unknown[]) => sendPeerMock(...a) };
});

import { POST } from './+server';
import {
	CrossProjectError,
	SendBudgetError,
	HopsExhaustedError,
	SenderResolutionError,
	PeerAddressError
} from '$lib/server/peer/send';

const TOKEN = 'boot-token-xyz';
const SENDER = 'session:sender1';

function req(
	body: unknown,
	over: { token?: string | null; host?: string; origin?: string; sender?: string | null } = {}
): Request {
	const headers: Record<string, string> = { 'content-type': 'application/json', host: over.host ?? '127.0.0.1:5099' };
	if (over.token !== null) headers['x-hook-token'] = over.token ?? TOKEN;
	if (over.sender !== null) headers['x-atelier-session'] = over.sender ?? SENDER;
	if (over.origin !== undefined) headers.origin = over.origin;
	return new Request('http://127.0.0.1:5099/api/peer/send', {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

async function invoke(request: Request) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const res = await POST({ request } as any);
	return { status: res.status, body: await res.json() };
}

const SEND_OK = {
	messageId: 'peer_message:1',
	from: { session: SENDER, role: null, project: 'project:a' },
	toKind: 'session',
	recipients: ['session:r1'],
	deliveredTo: ['session:r1'],
	quarantined: false,
	note: null
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.HOOK_TOKEN = TOKEN;
	tryGetDbMock.mockReturnValue({ __db: true });
	getRuntimeMock.mockResolvedValue({ available: false, reason: 'no credential' }); // default: no live deliver
	sendPeerMock.mockResolvedValue(SEND_OK);
});

describe('POST /api/peer/send — D-025 auth (fail closed)', () => {
	it('no token → 401, engine NEVER called', async () => {
		const { status } = await invoke(req({ to: { kind: 'atelier' }, body: 'x' }, { token: null }));
		expect(status).toBe(401);
		expect(sendPeerMock).not.toHaveBeenCalled();
	});
	it('bad token → 401', async () => {
		const { status } = await invoke(req({ to: { kind: 'atelier' }, body: 'x' }, { token: 'wrong' }));
		expect(status).toBe(401);
	});
	it('non-loopback Host → 401', async () => {
		const { status } = await invoke(req({ to: { kind: 'atelier' }, body: 'x' }, { host: '10.0.0.5:5099' }));
		expect(status).toBe(401);
	});
});

describe('POST /api/peer/send — D-035a sender from HEADER (never body)', () => {
	it('missing x-atelier-session → 400, engine NEVER called (no unverifiable sender stamped)', async () => {
		const { status, body } = await invoke(req({ to: { kind: 'atelier' }, body: 'x' }, { sender: null }));
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/no authenticated sender/i);
		expect(sendPeerMock).not.toHaveBeenCalled();
	});

	it('the SENDER passed to the engine is the HEADER, never the body claim', async () => {
		await invoke(
			req(
				{ to: { kind: 'atelier' }, body: 'hi', from_session: 'session:evil', sender: 'session:evil' },
				{ sender: SENDER }
			)
		);
		const [arg] = sendPeerMock.mock.calls[0];
		expect(arg.senderSessionId).toBe(SENDER); // the header, not the body's `from_session`/`sender`
	});

	it('coerces the address — only to/body/hops survive; identity-claim fields are dropped', async () => {
		await invoke(
			req({ to: { kind: 'session', ref: 'session:r1', from: 'forged' }, body: 'b', hops: 2, evil: 'rm -rf' }, {})
		);
		const [arg] = sendPeerMock.mock.calls[0];
		expect(arg.address).toEqual({ kind: 'session', toSession: 'session:r1' });
		expect(arg.body).toBe('b');
		expect(arg.hops).toBe(2);
		expect('evil' in arg).toBe(false);
	});
});

describe('POST /api/peer/send — dispatch + happy result', () => {
	it('an authorized request reaches sendPeer and returns ok:true + the result', async () => {
		const { status, body } = await invoke(req({ to: { kind: 'session', ref: 'session:r1' }, body: 'hi' }));
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.messageId).toBe('peer_message:1');
		expect(sendPeerMock).toHaveBeenCalledTimes(1);
	});

	it('maps a role address (ref=role, project) to the resolver coordinates', async () => {
		await invoke(req({ to: { kind: 'role', ref: 'role:reviewer', project: 'project:a' }, body: 'hi' }));
		const [arg] = sendPeerMock.mock.calls[0];
		expect(arg.address).toEqual({ kind: 'role', toRole: 'role:reviewer', project: 'project:a' });
	});
});

describe('POST /api/peer/send — named errors map to honest statuses', () => {
	const cases: [Error, number][] = [
		[new CrossProjectError('cross'), 403],
		[new SendBudgetError('budget'), 429],
		[new HopsExhaustedError('hops'), 400],
		[new SenderResolutionError('sender'), 400],
		[new PeerAddressError('addr'), 400]
	];
	for (const [err, expected] of cases) {
		it(`${err.name} → ${expected}`, async () => {
			sendPeerMock.mockRejectedValue(err);
			const { status, body } = await invoke(req({ to: { kind: 'session', ref: 'session:r1' }, body: 'x' }));
			expect(status).toBe(expected);
			expect(body.ok).toBe(false);
		});
	}

	it('a generic engine fault → ok:false (200) the agent can retry/abandon', async () => {
		sendPeerMock.mockRejectedValue(new Error('boom'));
		const { status, body } = await invoke(req({ to: { kind: 'session', ref: 'session:r1' }, body: 'x' }));
		expect(status).toBe(200);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/boom/);
	});
});

describe('POST /api/peer/send — shadow paths (honest, F-008)', () => {
	it('an unknown to.kind → honest ok:false, engine NEVER called', async () => {
		const { status, body } = await invoke(req({ to: { kind: 'broadcast' }, body: 'x' }));
		expect(status).toBe(200);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/to\.kind/);
		expect(sendPeerMock).not.toHaveBeenCalled();
	});

	it('malformed JSON body → coerces to atelier-or-400 (no crash); here a missing to → ok:false', async () => {
		const { status, body } = await invoke(req('{ not json'));
		expect(status).toBe(200);
		expect(body.ok).toBe(false); // no `to` ⇒ unknown kind ⇒ honest deny
	});

	it('no DB bound → honest ok:false, engine NEVER called', async () => {
		tryGetDbMock.mockReturnValue(null);
		const { status, body } = await invoke(req({ to: { kind: 'atelier' }, body: 'x' }));
		expect(status).toBe(200);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/no database connection/i);
		expect(sendPeerMock).not.toHaveBeenCalled();
	});
});
