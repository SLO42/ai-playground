export interface ChatToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ChatToolResult {
	call_id: string;
	name: string;
	content: string;
}

export interface ChatSender {
	id: string;
	label: string;
	color: string;
}

export interface ChatMessage {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	tool_calls?: ChatToolCall[];
	tool_call_id?: string;
	tool_name?: string;
	sender?: ChatSender;
}

export interface ChatProvider {
	id: string;
	name: string;
	endpoint: string;
}

export type SessionSource = 'user' | 'claw';
export type SessionStatus = 'idle' | 'streaming' | 'paused' | 'waiting';

export interface ChatSession {
	id: string;
	model: string;
	provider: string;
	createdAt: string;
	updatedAt: string;
	messages: ChatMessage[];
	source?: SessionSource;
	status?: SessionStatus;
}

export interface ChatSessionMeta {
	id: string;
	title: string;
	model: string;
	provider: string;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
	source?: SessionSource;
	status?: SessionStatus;
}

export interface ChatRequest {
	messages: ChatMessage[];
	model?: string;
	provider?: string;
	tools?: boolean;
	complexity?: number;
}

export interface OllamaChatChunk {
	model: string;
	created_at: string;
	message: {
		role: string;
		content: string;
		tool_calls?: Array<{
			function: { name: string; arguments: Record<string, unknown> | string };
		}>;
	};
	done: boolean;
	total_duration?: number;
	load_duration?: number;
	prompt_eval_count?: number;
	eval_count?: number;
	eval_duration?: number;
}
