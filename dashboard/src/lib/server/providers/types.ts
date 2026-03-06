export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface StreamChunk {
	type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
	content?: string;
	tool_call?: ToolCall;
}

export interface ProviderMessage {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ProviderAdapter {
	stream(
		messages: ProviderMessage[],
		model: string,
		tools?: ToolDef[]
	): AsyncGenerator<StreamChunk>;
}
