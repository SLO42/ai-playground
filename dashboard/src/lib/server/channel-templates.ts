/** Default YAML scaffold templates for each OpenClaw channel type. */

export interface ChannelTemplate {
	header: string;
	data: Record<string, unknown>;
}

const sharedUsers = {
	mode: 'allowlist',
	allowlist: [],
	ignoreUnknown: true,
	logDenied: true
};

export const CHANNEL_TEMPLATES: Record<string, ChannelTemplate> = {
	twitch: {
		header: `# OpenClaw - Twitch Channel Configuration\n# Twitch chat via IRC connection (plugin-based)\n\n`,
		data: {
			channel: 'twitch',
			enabled: false,
			auth: {
				username: '',
				oauthToken: '',
				clientId: ''
			},
			join: [],
			activation: 'always',
			requireMention: false,
			commandPrefix: '!',
			users: { ...sharedUsers },
			rateLimit: {
				messagesPerSecond: 1,
				maxMessageLength: 500,
				whisperEnabled: false
			},
			formatting: {
				splitLongMessages: true,
				maxSplits: 3,
				stripMarkdown: true
			},
			groups: {
				allowlist: ['*'],
				moderatorsOnly: false
			}
		}
	},

	telegram: {
		header: `# OpenClaw - Telegram Channel Configuration\n# Telegram Bot API integration\n\n`,
		data: {
			channel: 'telegram',
			enabled: false,
			auth: {
				botToken: ''
			},
			activation: 'mention',
			requireMention: true,
			commandPrefix: '/',
			users: { ...sharedUsers },
			rateLimit: {
				messagesPerSecond: 1,
				maxMessageLength: 4096
			},
			formatting: {
				parseMode: 'MarkdownV2',
				splitLongMessages: true,
				maxSplits: 5
			},
			webhook: {
				enabled: false,
				url: '',
				secretToken: ''
			}
		}
	},

	discord: {
		header: `# OpenClaw - Discord Channel Configuration\n# Discord bot with slash commands\n\n`,
		data: {
			channel: 'discord',
			enabled: false,
			auth: {
				botToken: '',
				applicationId: ''
			},
			guildIds: [],
			activation: 'slash',
			requireMention: false,
			commandPrefix: '/',
			users: { ...sharedUsers },
			rateLimit: {
				messagesPerSecond: 5,
				maxMessageLength: 2000
			},
			formatting: {
				useEmbeds: true,
				splitLongMessages: true,
				maxSplits: 3
			},
			intents: ['Guilds', 'GuildMessages', 'MessageContent']
		}
	},

	whatsapp: {
		header: `# OpenClaw - WhatsApp Channel Configuration\n# WhatsApp Business API integration\n\n`,
		data: {
			channel: 'whatsapp',
			enabled: false,
			auth: {
				phoneNumberId: '',
				accessToken: '',
				verifyToken: ''
			},
			activation: 'always',
			requireMention: false,
			commandPrefix: '!',
			users: { ...sharedUsers },
			rateLimit: {
				messagesPerSecond: 1,
				maxMessageLength: 4096
			},
			formatting: {
				splitLongMessages: true,
				maxSplits: 5,
				stripMarkdown: false
			},
			webhook: {
				enabled: false,
				url: '',
				verifyToken: ''
			}
		}
	},

	imessage: {
		header: `# OpenClaw - iMessage Channel Configuration\n# iMessage via BlueBubbles (requires Mac server)\n\n`,
		data: {
			channel: 'imessage',
			enabled: false,
			auth: {
				serverUrl: 'http://localhost:1234',
				password: ''
			},
			activation: 'always',
			requireMention: false,
			commandPrefix: '!',
			users: { ...sharedUsers },
			rateLimit: {
				messagesPerSecond: 1,
				maxMessageLength: 20000
			},
			formatting: {
				splitLongMessages: true,
				maxSplits: 5,
				stripMarkdown: false
			}
		}
	},

	dashboard: {
		header: `# OpenClaw - Dashboard Channel Configuration\n# Custom channel: connects via gateway WS from the Claw dashboard\n\n`,
		data: {
			channel: 'dashboard',
			enabled: true,
			type: 'custom',
			description: 'Claw dashboard chat — routes through OpenClaw gateway WS',
			auth: {
				mode: 'device',
				identityPath: '.playground/claw-device-identity.json'
			},
			activation: 'always',
			requireMention: false,
			commandPrefix: '/',
			users: {
				mode: 'allowlist',
				allowlist: [],
				ignoreUnknown: false,
				logDenied: true
			},
			rateLimit: {
				messagesPerSecond: 10,
				maxMessageLength: 32768
			},
			formatting: {
				splitLongMessages: false,
				stripMarkdown: false,
				renderMarkdown: true
			},
			gateway: {
				clientId: 'webchat',
				clientMode: 'webchat',
				role: 'operator',
				scopes: ['operator.admin']
			},
			tools: {
				exec: true,
				read: true,
				write: true
			}
		}
	}
};

/** Map display names to template keys */
export const CHANNEL_NAME_MAP: Record<string, string> = {
	Twitch: 'twitch',
	Telegram: 'telegram',
	Discord: 'discord',
	WhatsApp: 'whatsapp',
	iMessage: 'imessage',
	Dashboard: 'dashboard'
};
