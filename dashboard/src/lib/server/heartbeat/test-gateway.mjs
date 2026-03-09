import { pathToFileURL } from 'url';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..', '..', '..', '..', '..');

const clientPath = resolve(projectRoot, 'node_modules/openclaw/dist/client-CuIxivDk.js');
const mod = await import(pathToFileURL(clientPath).href);

const loadOrCreateDeviceIdentity = mod.nn;
const buildDeviceAuthPayloadV3 = mod.Rt;
const buildDeviceAuthPayload = mod.Lt; // v2
const normalizeDevicePublicKeyBase64Url = mod.rn;

// Load persistent device identity
const identity = await loadOrCreateDeviceIdentity(
  resolve(projectRoot, '.playground/claw-device-identity.json')
);
console.log('Device ID:', identity.deviceId.substring(0, 16) + '...');
console.log('Identity keys:', Object.keys(identity));

// Connect with Origin header
const ws = new WebSocket('ws://127.0.0.1:18789', {
  headers: { Origin: 'http://127.0.0.1:18789' }
});

let reqId = 0;
const pending = new Map();

function request(method, params) {
  const id = 'r' + (++reqId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

ws.on('open', () => console.log('ws connected'));
ws.on('error', e => console.log('ws error:', e.message));

ws.on('message', async (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    const nonce = msg.payload.nonce;
    console.log('challenge nonce:', nonce);

    // Build & sign connect payload using SDK
    try {
      const signedAt = Date.now();
      const role = 'operator';
      const scopes = ['operator.admin'];
      const token = process.env.OPENCLAW_TOKEN || '';

      // buildDeviceAuthPayloadV3 builds the v2|... string
      // Try both v2 and v3 — server decides based on minProtocol
      const payloadStr = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: 'webchat',
        clientMode: 'webchat',
        role,
        scopes,
        signedAtMs: signedAt,
        token: process.env.OPENCLAW_TOKEN || '',
        nonce
      });
      console.log('payload:', payloadStr.substring(0, 80) + '...');

      // Sign with Ed25519 private key
      const crypto = await import('crypto');
      const privKey = crypto.createPrivateKey(identity.privateKeyPem);
      // Ed25519 signs directly (no hash algorithm parameter)
      const sigBuf = crypto.sign(null, Buffer.from(payloadStr), privKey);
      // Base64url encode (no padding) — matching OpenClaw's Qi function
      const signature = sigBuf.toString('base64url');

      const hello = await request('connect', {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'webchat', version: 'dev', platform: 'node', mode: 'webchat', instanceId: 'claw-' + process.pid },
        role, scopes,
        device: {
          id: identity.deviceId,
          publicKey: normalizeDevicePublicKeyBase64Url(identity.publicKeyPem),
          signature,
          signedAt,
          nonce
        },
        auth: { token },
        caps: []
      });
      console.log('\n=== CONNECTED ===');
      console.log('Hello:', JSON.stringify(hello, null, 2)?.substring(0, 600));

      // Now send a chat message
      console.log('\nSending chat...');
      const sessionKey = 'test-' + Date.now();
      const chatRes = await request('chat.send', {
        sessionKey,
        message: 'Say hello in one word',
        idempotencyKey: 'idem-' + Date.now()
      });
      console.log('Chat response:', JSON.stringify(chatRes, null, 2)?.substring(0, 800));
    } catch (e) {
      console.log('Connect failed:', e.message);
    }
  }

  if (msg.type === 'res') {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.ok === false) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  if (msg.type === 'event' && msg.event !== 'connect.challenge') {
    const e = msg.event || '';
    if (e.includes('chat') || e.includes('message') || e.includes('assistant')) {
      console.log('EVENT:', e, JSON.stringify(msg.payload ?? '').substring(0, 300));
    }
  }
});

setTimeout(() => { ws.close(); process.exit(); }, 30000);
