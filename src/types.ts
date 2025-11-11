export type OAIRole = "system" | "user" | "assistant" | "tool";

export type OAIMessage = { role: OAIRole; content: string; name?: string };

export type ChatCompletionRequest = {
	temperature?: number | null;
	messages: OAIMessage[];
	model: string;
	stream?: boolean | null;
	max_tokens?: number | null;
	stop?: string[] | null;
	stream_options?: any | null;
	max_completion_tokens?: number | null;
	reasoning_effort?: string | null;
	reasoning?: { effort?: "low" | "medium" | "high" } | null;
	system?: string | null;
	tools?: any[] | null;
	user_variables?: Record<string, any> | null;
	thinking?: { type?: "enabled"; budget_tokens?: number } | null;
};

export type AnthropicMessage = {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
};

export type AnthropicContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: any }
	| {
			type: "tool_result";
			tool_use_id: string;
			content?: string | { type: "text"; text: string }[];
			is_error?: boolean;
	  };

export type AnthropicToolDef = {
	name: string;
	description?: string;
	input_schema: any;
};

export type AnthropicRequest = {
	model: string;
	system?: string;
	messages: AnthropicMessage[];
	max_tokens: number;
	temperature?: number;
	stop_sequences?: string[];
	stream: boolean;
	tools?: AnthropicToolDef[];
	thinking?: { type: "enabled"; budget_tokens?: number };
};

export type OpenAIChatRequest = {
	model: string;
	messages: { role: "system" | "user" | "assistant" | "tool"; content: string; name?: string }[];
	temperature?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	stop?: string[];
	tools?: any[];
	stream?: boolean;
	reasoning?: { effort?: "low" | "medium" | "high" };
};

export type OpenAIResponsesRequest = {
	model: string;
	messages?: { role: "system" | "user" | "assistant" | "tool"; content: string; name?: string }[];
	input?: any;
	reasoning?: { effort?: "low" | "medium" | "high" };
	max_output_tokens?: number;
	temperature?: number;
	stream?: boolean;
	tools?: any[];
};


