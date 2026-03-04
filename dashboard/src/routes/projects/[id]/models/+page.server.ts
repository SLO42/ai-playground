import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		summary: { total: 4, active: 1, vramUsed: 14.2, vramTotal: 24.0 },
		routingChain: [
			{ name: 'GPT-OSS 20B', tier: 'Primary', provider: 'Ollama (local)', latency: '~80ms', cost: '$0', status: 'active' },
			{ name: 'Claude Sonnet 4.6', tier: 'Escalation', provider: 'Anthropic API', latency: '~2s', cost: '$0.003/1K', status: 'standby' },
			{ name: 'Claude Haiku 4.5', tier: 'Fallback', provider: 'Anthropic API', latency: '~500ms', cost: '$0.0002/1K', status: 'standby' }
		],
		models: [
			{
				name: 'gpt-oss:20b',
				size: '12.4 GB',
				quantization: 'Q4_K_M',
				params: '20B (3.6B active)',
				context: 8192,
				modified: '2026-02-28',
				status: 'loaded',
				vram: 14.2,
				tokensPerSec: 42.8
			},
			{
				name: 'nomic-embed-text:latest',
				size: '274 MB',
				quantization: 'F16',
				params: '137M',
				context: 8192,
				modified: '2026-03-01',
				status: 'available',
				vram: 0,
				tokensPerSec: 0
			},
			{
				name: 'codellama:7b',
				size: '3.8 GB',
				quantization: 'Q4_0',
				params: '7B',
				context: 16384,
				modified: '2026-02-15',
				status: 'available',
				vram: 0,
				tokensPerSec: 0
			},
			{
				name: 'llama3.2:3b',
				size: '2.0 GB',
				quantization: 'Q4_K_M',
				params: '3B',
				context: 131072,
				modified: '2026-02-20',
				status: 'available',
				vram: 0,
				tokensPerSec: 0
			}
		],
		routingIntelligence: {
			accuracy: 94.2,
			localHandled: 87,
			escalated: 11,
			fallback: 2
		}
	};
};
