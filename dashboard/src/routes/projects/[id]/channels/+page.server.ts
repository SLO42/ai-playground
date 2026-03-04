import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		summary: { total: 3, connected: 2, messages: 1284, users: 8 },
		channels: [
			{ name: 'Twitch', type: 'twitch', status: 'connected', username: 'ai_playground', viewers: 3, messages: 847, uptime: '4h 12m' },
			{ name: 'Discord', type: 'discord', status: 'connected', server: 'AI Playground', members: 12, messages: 437, uptime: '2d 8h' },
			{ name: 'Telegram', type: 'telegram', status: 'disconnected', username: 'aipg_bot', members: 0, messages: 0, uptime: '-' }
		],
		dmPolicy: {
			mode: 'pairing',
			approvalRequired: true,
			pairingTimeout: '5m',
			maxSessions: 3
		},
		allowlist: [
			{ username: 'slo42', platform: 'twitch', role: 'admin', added: '2026-02-15' },
			{ username: 'family_member', platform: 'twitch', role: 'user', added: '2026-02-20' },
			{ username: 'dev_helper', platform: 'discord', role: 'moderator', added: '2026-03-01' }
		],
		recentMessages: [
			{ channel: 'Twitch', user: 'slo42', message: 'check the model routing stats', time: '2m ago' },
			{ channel: 'Discord', user: 'family_member', message: 'can you add eggs to the cart?', time: '8m ago' },
			{ channel: 'Twitch', user: 'slo42', message: 'spawn a coder agent for the auth fix', time: '15m ago' }
		]
	};
};
