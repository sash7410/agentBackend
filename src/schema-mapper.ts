import { getModelsArray } from "./client_mapping";
// Minimal schema mapper and streaming translator for Firebender edge contract
// Functions:
// - mapOAItoAnthropic: maps Firebender ChatCompletionRequest to Anthropic Messages (+warning flag)
// - mapOAItoOpenAI: normalizes Firebender ChatCompletionRequest to OpenAI Chat Completions request
// - anthropicSSEtoOAIChunks: converts Anthropic SSE events into OpenAI-compatible SSE chunks

export type OAIRole = "system" | "user" | "assistant" | "tool";
// OpenAI Chat message in its simplest form for this proxy
export type OAIMessage = { role: OAIRole; content: string; name?: string };

export type ChatCompletionRequest = {
	// Temperature controls randomness: 0 is deterministic, higher is more diverse
	temperature?: number | null;
	messages: OAIMessage[];
	model: string;
	// If not provided, we default to stream=true (especially for Anthropic)
	stream?: boolean | null;
	// Some clients send max_tokens; gpt-5 expects max_completion_tokens instead
	max_tokens?: number | null;
	stop?: string[] | null;
	stream_options?: any | null;
	// Newer OpenAI models (e.g. gpt-5) prefer this name
	max_completion_tokens?: number | null;
	// Placeholder for OpenAI reasoning models; not used by this minimal proxy
	reasoning_effort?: string | null;
	// Optional OpenAI reasoning container used by newer APIs
	reasoning?: { effort?: "low" | "medium" | "high" } | null;
	// A single "system" string; if present, we ensure one system message is applied
	system?: string | null;
	// Tools are ignored for Anthropic in this v1; we forward them to OpenAI as-is
	tools?: any[] | null;
	// Arbitrary variables clients can pass; we only log the key count
	user_variables?: Record<string, any> | null;
	// Optional Anthropic extended thinking controls (pass-through only)
	thinking?: { type?: "enabled"; budget_tokens?: number } | null;
};

export type AnthropicMessage = {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
};

// Structured content blocks for Anthropic Messages API
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
	// Extended thinking (if provided by caller)
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
	// Reasoning settings supported by GPT-5 family
	reasoning?: { effort?: "low" | "medium" | "high" };
};

// OpenAI Responses API (for GPT-5/reasoning)
export type OpenAIResponsesRequest = {
	model: string;
	messages?: { role: "system" | "user" | "assistant" | "tool"; content: string; name?: string }[];
	// Some clients may send unified "input" instead of messages; we keep messages for compatibility
	input?: any;
	reasoning?: { effort?: "low" | "medium" | "high" };
	max_output_tokens?: number;
	temperature?: number;
	stream?: boolean;
	tools?: any[];
};

export function computeDefaultReasoningForClientModel(clientModelId: string): {
	provider: "openai" | "anthropic" | null;
	upstreamModel: string;
	sendToResponses: boolean;
	defaultEffort?: "low" | "high";
	enableAnthropicThinking: boolean;
} {
	const models = getModelsArray();
	const lcId = (clientModelId || "").toLowerCase();
	const record =
		models.find((m: any) => (m?.id || "").toLowerCase() === lcId) ||
		models.find((m: any) => (m?.model || "").toLowerCase() === lcId) ||
		null;
	const providerRaw = (record?.provider ?? null) as any;
	const provider: "openai" | "anthropic" | null =
		providerRaw === "anthropic" ? "anthropic" : "openai";
	const redactedThinking = Boolean(record?.redacted_thinking);
	let upstreamModel = (record?.model as string) || clientModelId;
	const resolvedId = ((record?.id as string) || clientModelId).toLowerCase();
	let defaultEffort: "low" | "high" | undefined;
	// Determine if this is an explicit low/high variant (the only ones we route to Responses)
	const isLow = /(^|-)low($|-)/.test(resolvedId);
	const isHigh = /(^|-)high($|-)/.test(resolvedId);
	const isLowOrHigh = isLow || isHigh;
	if (redactedThinking && provider === "openai") {
		// Normalize effort only for explicit low/high variants
		if (isLow) defaultEffort = "low";
		if (isHigh) defaultEffort = "high";
		// Normalize upstream naming for low/high families to base 'gpt-5'
		if ((upstreamModel || "").toLowerCase().startsWith("gpt-5-") && (defaultEffort === "low" || defaultEffort === "high")) {
			upstreamModel = "gpt-5";
		}
	}
	const enableAnthropicThinking = provider === "anthropic" && redactedThinking;
	// Only send to Responses for OpenAI models that are explicitly low/high variants and marked redacted_thinking
	const sendToResponses = provider === "openai" && redactedThinking && isLowOrHigh;
	console.log(`[computeDefaultReasoningForClientModel] clientModelId=${clientModelId} provider=${provider} upstreamModel=${upstreamModel} defaultEffort=${defaultEffort} enableAnthropicThinking=${enableAnthropicThinking} sendToResponses=${sendToResponses} isLowOrHigh=${isLowOrHigh}`);
	return { provider, upstreamModel, sendToResponses, defaultEffort, enableAnthropicThinking };
}

const MAX_TOKENS_CAP = 20000;
const DEFAULT_MAX_TOKENS = 20000;

function clamp(num: number, min: number, max: number): number {
	if (num === null || num === undefined) return min;
	if (Number.isNaN(num as number)) return min;
	if (num < min) return min;
	if (num > max) return max;
	return num;
}

function ensureHasUserMessage(messages: OAIMessage[]): boolean {
	return messages.some((m) => m.role === "user");
}

function normalizeContentToText(content: any): { text: string; changed: boolean } {
	// We only work with plain-text content in this minimal proxy.
	// If content is an array, extract only text parts.
	if (typeof content === "string") return { text: content, changed: false };
	if (Array.isArray(content)) {
		// Extract only supported "text" parts; ignore others like "thinking", images, audio, etc.
		const texts: string[] = [];
		for (const part of content) {
			if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
				texts.push(part.text);
			}
		}
		return { text: texts.join(""), changed: true };
	}
	// Fallback stringification
	return { text: String(content ?? ""), changed: true };
}

function stripAnthropicDateSuffix(model: string): string {
	// Normalize Anthropic models like "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5"
	return (model || "").replace(/-\d{8}$/, "");
}

function mapOpenAIToolsToAnthropic(tools: any[] | null | undefined): AnthropicToolDef[] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const out: AnthropicToolDef[] = [];
	for (const t of tools) {
		try {
			if (t && (t.type === "function" || t.function)) {
				const fn = t.function ?? {};
				const name = fn.name ?? t.name;
				if (typeof name !== "string" || name.length === 0) continue;
				const description = typeof fn.description === "string" ? fn.description : t.description;
				const input_schema = fn.parameters ?? { type: "object" };
				out.push({ name, description, input_schema });
			}
		} catch {
			// ignore malformed tool
		}
	}
	return out.length > 0 ? out : undefined;
}

function toAnthropicMessagesWithTools(req: ChatCompletionRequest): {
	system?: string;
	messages: AnthropicMessage[];
	hadAnyToolsSignal: boolean;
	anthropicTools?: AnthropicToolDef[];
} {
	let systemText: string | undefined = req.system ?? undefined;
	const messages: AnthropicMessage[] = [];
	const anthropicTools = mapOpenAIToolsToAnthropic(req.tools);
	let hadAnyToolsSignal = Array.isArray(req.tools) && req.tools.length > 0;

	for (const raw of req.messages || []) {
		const msg: any = raw as any;
		const role: string = msg.role;

		if (role === "system") {
			if (!systemText) {
				const norm = normalizeContentToText(msg.content);
				systemText = norm.text;
			}
			continue;
		}

		if (role === "assistant") {
			const toolCalls: any[] | undefined = Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined;
			if (toolCalls && toolCalls.length > 0) {
				hadAnyToolsSignal = true;
				const blocks: AnthropicContentBlock[] = [];
				const norm = normalizeContentToText(msg.content);
				if (norm.text && norm.text.trim().length > 0) {
					blocks.push({ type: "text", text: norm.text });
				}
				for (const tc of toolCalls) {
					const id: string =
						typeof tc.id === "string" && tc.id.length > 0 ? tc.id : `toolu_${Math.random().toString(36).slice(2, 10)}`;
					const name: string = tc.function?.name ?? tc.name;
					let input: any = {};
					const argStr = tc.function?.arguments ?? tc.arguments;
					if (typeof argStr === "string") {
						try {
							input = JSON.parse(argStr);
						} catch {
							input = { __raw: argStr };
						}
					} else if (argStr && typeof argStr === "object") {
						input = argStr;
					}
					if (typeof name === "string" && name.length > 0) {
						blocks.push({ type: "tool_use", id, name, input });
					}
				}
				messages.push({ role: "assistant", content: blocks });
				continue;
			}
			const norm = normalizeContentToText(msg.content);
			messages.push({ role: "assistant", content: norm.text });
			continue;
		}

		if (role === "tool") {
			hadAnyToolsSignal = true;
			const toolUseId: string | undefined = msg.tool_call_id || msg.tool_call_id?.toString?.();
			const norm = normalizeContentToText(msg.content);
			const block: AnthropicContentBlock = {
				type: "tool_result",
				tool_use_id: toolUseId ?? "",
				content: norm.text ? [{ type: "text", text: norm.text }] : undefined,
			};
			messages.push({ role: "user", content: [block] });
			continue;
		}

		if (role === "user") {
			const norm = normalizeContentToText(msg.content);
			messages.push({ role: "user", content: norm.text });
			continue;
		}
	}

	return { system: systemText, messages, hadAnyToolsSignal, anthropicTools };
}

function extractSystemAndFilterMessages(req: ChatCompletionRequest): {
	system?: string;
	filtered: AnthropicMessage[];
	hadTools: boolean;
} {
	// Move a single system instruction into Anthropic's "system" field and
	// filter the messages to only user/assistant (Anthropic does not accept system/tool roles in the array)
	const providedSystem = req.system ?? undefined;
	let systemText = providedSystem;
	const filtered: AnthropicMessage[] = [];
	const hadTools = Array.isArray(req.tools) && req.tools.length > 0;

	for (const msg of req.messages || []) {
		if (msg.role === "system") {
			if (!systemText) {
				const norm = normalizeContentToText((msg as any).content);
				systemText = norm.text;
			}
			continue; // system messages are removed from upstream array
		}
		if (msg.role === "tool") {
			// v1 ignores tool role content for Anthropic; do not forward it
			continue;
		}
		if (msg.role === "user" || msg.role === "assistant") {
			const norm = normalizeContentToText((msg as any).content);
			filtered.push({ role: msg.role, content: norm.text });
		}
	}
	return { system: systemText, filtered, hadTools };
}

function selectMaxTokens(req: ChatCompletionRequest, provider: "anthropic" | "openai"): number | undefined {
	// Provider-specific precedence
	const fromReqMax = req.max_tokens ?? undefined;
	const fromReqMaxCompletion = req.max_completion_tokens ?? undefined;
	let chosen: number | undefined;
	if (provider === "openai") {
		// For OpenAI we prefer max_tokens if given, otherwise fall back to max_completion_tokens
		chosen = fromReqMax ?? fromReqMaxCompletion;
	} else {
		// For Anthropic we choose whichever is given, otherwise default
		chosen = fromReqMax ?? fromReqMaxCompletion ?? DEFAULT_MAX_TOKENS;
	}
	if (chosen === undefined || chosen === null) return provider === "anthropic" ? DEFAULT_MAX_TOKENS : undefined;
	return clamp(chosen, 1, MAX_TOKENS_CAP);
}

function useMaxCompletionTokensField(model: string): boolean {
	const m = (model || "").toLowerCase();
	return m.startsWith("gpt-5");
}

export function mapOAItoAnthropic(req: ChatCompletionRequest): { request: AnthropicRequest; warnIgnoredTools: boolean } {
	if (!req || typeof req !== "object") {
		throw new Error("Invalid request body");
	}
	if (!Array.isArray(req.messages) || typeof req.model !== "string") {
		throw new Error("Missing required fields: model, messages");
	}

	const conv = toAnthropicMessagesWithTools(req);
	if (!ensureHasUserMessage(
		(conv.messages as any as OAIMessage[]).map((m: any) => {
			// Treat any user role message as satisfying the requirement
			return { role: m.role, content: typeof m.content === "string" ? m.content : "" } as OAIMessage;
		}),
	)) {
		throw new Error("At least one user message is required");
	}

	const temperature = req.temperature !== null && req.temperature !== undefined ? clamp(req.temperature, 0, 2) : undefined;
	const maxTokens = selectMaxTokens(req, "anthropic") ?? DEFAULT_MAX_TOKENS;
	const stop_sequences = Array.isArray(req.stop) && req.stop.length > 0 ? req.stop.slice(0) : undefined;

	const stream =
		req.stream === null || req.stream === undefined
			? true
			: Boolean(req.stream);

	// Debug logs for mapping details (visible in worker logs)
	// try {
	// 	console.log(
	// 		`[mapper->anthropic] system_present=${Boolean(conv.system)} msgs_in=${req.messages?.length ?? 0} msgs_out=${conv.messages.length} had_tools=${conv.hadAnyToolsSignal} temp=${temperature ?? "n/a"} max_tokens=${maxTokens} stop_seq=${stop_sequences?.length ?? 0} stream=${stream}`,
	// 	);
	// } catch {
	// 	// ignore logging errors
	// }

	// We return Anthropic's native request shape, but we also return a flag if tools were present
	// so the caller can attach a warning header for the client.
	const mappedModel = stripAnthropicDateSuffix(req.model);
	console.log(`[mapper->anthropic] mappedModel=${mappedModel}`);
	return {
		request: {
			model: mappedModel,
			system: conv.system,
			messages: conv.messages,
			max_tokens: maxTokens,
			temperature,
			stop_sequences,
			stream,
			tools: conv.anthropicTools,
			// Enable Anthropic extended thinking only for specific model(s)
			thinking: (req as any)?.thinking ? { type: "enabled", ...(req as any).thinking } : undefined,
		},
		// Tools supported in this mapping
		warnIgnoredTools: false,
	};
}

	// Variant that disables tools for Anthropic entirely (drops tools and tool_* content)
	export function mapOAItoAnthropicNoTools(req: ChatCompletionRequest): { request: AnthropicRequest; warnIgnoredTools: boolean } {
		if (!req || typeof req !== "object") {
			throw new Error("Invalid request body");
		}
		if (!Array.isArray(req.messages) || typeof req.model !== "string") {
			throw new Error("Missing required fields: model, messages");
		}
		// Strip tool roles and tool_calls by converting to plain user/assistant text messages
		const { system, filtered } = extractSystemAndFilterMessages({
			...req,
			tools: undefined, // ensure tools are considered absent
		} as ChatCompletionRequest);
		if (!ensureHasUserMessage(
			(filtered as any as OAIMessage[]).map((m: any) => {
				return { role: m.role, content: typeof m.content === "string" ? m.content : "" } as OAIMessage;
			}),
		)) {
			throw new Error("At least one user message is required");
		}
		const temperature = req.temperature !== null && req.temperature !== undefined ? clamp(req.temperature, 0, 2) : undefined;
		const maxTokens = selectMaxTokens(req, "anthropic") ?? DEFAULT_MAX_TOKENS;
		const stop_sequences = Array.isArray(req.stop) && req.stop.length > 0 ? req.stop.slice(0) : undefined;
		const stream = req.stream === null || req.stream === undefined ? true : Boolean(req.stream);

		const mappedModel = stripAnthropicDateSuffix(req.model);
		console.log(`[mapper->anthropic] mappedModel=${mappedModel}`);

		// If client sent tools, we ignored them here
		const ignored = Array.isArray((req as any).tools) && (req as any).tools.length > 0;

		return {
			request: {
				model: mappedModel,
				system,
				messages: filtered,
				max_tokens: maxTokens,
				temperature,
				stop_sequences,
				stream,
				tools: undefined,
				thinking: (req as any)?.thinking ? { type: "enabled", ...(req as any).thinking } : undefined,
			},
			warnIgnoredTools: ignored,
		};
	}

export function mapOAItoOpenAI(req: ChatCompletionRequest): OpenAIChatRequest {
	if (!req || typeof req !== "object") {
		throw new Error("Invalid request body");
	}
	if (!Array.isArray(req.messages) || typeof req.model !== "string") {
		throw new Error("Missing required fields: model, messages");
	}

	// For OpenAI passthrough, respect a single system rule by optionally inserting system field
	// If req.system exists and no system message exists, prepend it to messages
	let messages = req.messages.slice(0).map((m) => {
		const norm = normalizeContentToText((m as any).content);
		return { ...m, content: norm.text };
	});
	if (req.system) {
		const hasSystemMsg = messages.some((m) => m.role === "system");
		if (!hasSystemMsg) {
			messages = [{ role: "system", content: String(req.system) }, ...messages];
		}
	}
	if (!messages.some((m) => m.role === "user")) {
		throw new Error("At least one user message is required");
	}

	const temperature = req.temperature !== null && req.temperature !== undefined ? clamp(req.temperature, 0, 2) : undefined;
	const maxTokens = selectMaxTokens(req, "openai");
	const stop = Array.isArray(req.stop) && req.stop.length > 0 ? req.stop.slice(0) : undefined;
	const tools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools.slice(0) : undefined;
	const stream =
		req.stream === null || req.stream === undefined
			? true
			: Boolean(req.stream);

	const openaiReq: OpenAIChatRequest = {
		model: req.model,
		messages: messages as any,
		temperature,
		stop,
		stream,
	};
	if (maxTokens !== undefined) {
		if (useMaxCompletionTokensField(req.model)) {
			// gpt-5 models require "max_completion_tokens"
			openaiReq.max_completion_tokens = maxTokens;
		} else {
			// older OpenAI chat models accept "max_tokens"
			openaiReq.max_tokens = maxTokens;
		}
	}
	if (tools) openaiReq.tools = tools;

	// Debug logs for mapping details (visible in worker logs)
	// try {
	// 	const maxField = (openaiReq as any).max_completion_tokens ?? openaiReq.max_tokens ?? "n/a";
	// 	console.log(
	// 		`[mapper->openai] model=${req.model} msgs_in=${req.messages?.length ?? 0} msgs_out=${openaiReq.messages.length} system_included=${Boolean(req.system)} temp=${temperature ?? "n/a"} max=${maxField} stop=${stop?.length ?? 0} tools=${tools?.length ?? 0} stream=${stream}`,
	// 	);
	// } catch {
	// 	// ignore logging errors
	// }
	return openaiReq;
}

export function mapOAItoOpenAIResponses(req: ChatCompletionRequest): OpenAIResponsesRequest {
	if (!req || typeof req !== "object") {
		throw new Error("Invalid request body");
	}
	if (!Array.isArray(req.messages) || typeof req.model !== "string") {
		throw new Error("Missing required fields: model, messages");
	}

	const modelNormalized = (req.model || "").toLowerCase();
	// For gpt-5-low, upstream requires "gpt-5". We normalize and enforce reasoning low.

	// Normalize to Responses-compatible minimal shape: only role + content.
	// Strip unsupported fields like tool_calls/tool_call_id, and convert tool role to user.
	let messages = req.messages.slice(0).map((m) => {
		const norm = normalizeContentToText((m as any).content);
		const role = (m.role === "tool" ? "user" : m.role) as "system" | "user" | "assistant";
		return { role, content: norm.text };
	});
	if (req.system) {
		const hasSystemMsg = messages.some((m) => m.role === "system");
		if (!hasSystemMsg) {
			messages = [{ role: "system", content: String(req.system) }, ...messages];
		}
	}
	if (!messages.some((m) => m.role === "user")) {
		throw new Error("At least one user message is required");
	}

	const temperature = req.temperature !== null && req.temperature !== undefined ? clamp(req.temperature, 0, 2) : undefined;
	// Responses API uses max_output_tokens
	let chosenMax: number | undefined;
	if (req.max_tokens !== null && req.max_tokens !== undefined) {
		chosenMax = clamp(Number(req.max_tokens), 1, MAX_TOKENS_CAP);
	} else if (req.max_completion_tokens !== null && req.max_completion_tokens !== undefined) {
		chosenMax = clamp(Number(req.max_completion_tokens), 1, MAX_TOKENS_CAP);
	}
	const stream = req.stream === null || req.stream === undefined ? true : Boolean(req.stream);
	let effort: "low" | "medium" | "high" | undefined =
		((typeof req.reasoning_effort === "string" ? req.reasoning_effort : undefined) as any) ||
		((req as any).reasoning && (req as any).reasoning.effort) ||
		undefined;

	const out: OpenAIResponsesRequest = {
		model: modelNormalized,
		// Responses API expects conversation under "input", not "messages"
		input: messages as any,
		temperature,
		stream,
	};
	if (chosenMax !== undefined) out.max_output_tokens = chosenMax;
	if (effort) out.reasoning = { effort };
	if (Array.isArray(req.tools) && req.tools.length > 0) {
		// Normalize tools so Responses API receives a top-level "name" when using function tools
		out.tools = req.tools.map((t: any) => {
			try {
				if (t && (t.type === "function" || t.function)) {
					const name = t.name ?? t.function?.name;
					if (name && !t.name) {
						return { ...t, name };
					}
				}
			} catch {
				// fall through
			}
			return t;
		});
	}

	// Debug
	// try {
	// 	console.log(
	// 		`[mapper->openai-responses] model=${req.model} msgs_in=${req.messages?.length ?? 0} input_len=${Array.isArray(out.input) ? out.input.length : (out.input ? 1 : 0)} temp=${temperature ?? "n/a"} max_output_tokens=${out.max_output_tokens ?? "n/a"} effort=${effort ?? "n/a"} stream=${stream}`,
	// 	);
	// } catch {
	// 	// ignore
	// }
	return out;
}

function generateOpenAIChunkId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 10);
	return `chatcmpl_${ts}${rand}`;
}

function openAIChunkEnvelope(args: {
	id: string;
	created: number;
	model: string;
	delta?: { role?: "assistant"; content?: string };
	finish_reason?: "stop" | "length" | null;
	index?: number;
}) {
	const { id, created, model, delta, finish_reason, index = 0 } = args;
	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [
			{
				index,
				delta: delta ?? {},
				finish_reason: finish_reason ?? null,
			},
		],
	};
}

type SSEEvent = {
	event: string;
	data: any;
};

function parseSSELines(text: string): SSEEvent[] {
	const events: SSEEvent[] = [];
	let currentEvent: string | null = null;
	let currentData: string[] = [];
	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		if (line.startsWith("event:")) {
			currentEvent = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			currentData.push(line.slice(5).trim());
		} else if (line.trim() === "") {
			if (currentEvent) {
				const dataStr = currentData.join("\n");
				try {
					const dataJson = dataStr ? JSON.parse(dataStr) : null;
					events.push({ event: currentEvent, data: dataJson });
				} catch {
					events.push({ event: currentEvent, data: null });
				}
			}
			currentEvent = null;
			currentData = [];
		}
	}
	return events;
}

export function anthropicSSEtoOAIChunks(
	model: string,
	upstream: ReadableStream<Uint8Array>,
	debugPrefix?: string,
	debugEvents?: boolean,
	debugVerbose?: boolean,
): ReadableStream<Uint8Array> {
	// This function converts Anthropic's streaming events (SSE)
	// into OpenAI-style "chat.completion.chunk" SSE frames.
	// It introduces a synthetic "assistant role" chunk first,
	// then emits text deltas, and finally emits a finish chunk and [DONE].
	const id = generateOpenAIChunkId();
	const created = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	let buffered = "";
	let sentRole = false;
	let finished = false;
	let eventCount = 0;

	function encodeDataLine(objOrString: any): Uint8Array {
		if (typeof objOrString === "string") {
			return encoder.encode(`data: ${objOrString}\n\n`);
		}
		return encoder.encode(`data: ${JSON.stringify(objOrString)}\n\n`);
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const reader = upstream.getReader();

			function redactAnthropicData(input: any): any {
				try {
					if (input === null || input === undefined) return input;
					if (typeof input === "string") {
						return ""; // scrub direct strings
					}
					if (Array.isArray(input)) {
						return input.map((v) => redactAnthropicData(v));
					}
					if (typeof input === "object") {
						const out: Record<string, any> = {};
						for (const key of Object.keys(input)) {
							const val = (input as any)[key];
							if (typeof val === "string") {
								const lower = key.toLowerCase();
								if (lower === "thinking" || lower === "text" || lower === "signature") {
									out[`${key}_len`] = val.length;
									out[key] = "";
								} else {
									out[key] = "";
								}
							} else if (val && typeof val === "object") {
								out[key] = redactAnthropicData(val);
							} else {
								out[key] = val;
							}
						}
						return out;
					}
					return input;
				} catch {
					return { _redaction: "failed" };
				}
			}

			function pushAssistantRoleIfNeeded() {
				if (!sentRole) {
					if (debugPrefix) {
						console.log(`${debugPrefix} translator: emit role=assistant`);
					}
					const first = openAIChunkEnvelope({
						id,
						created,
						model,
						delta: { role: "assistant" },
						finish_reason: null,
					});
					controller.enqueue(encodeDataLine(first));
					sentRole = true;
				}
			}

			function emitDone() {
				if (!finished) {
					if (debugPrefix) {
						console.log(`${debugPrefix} translator: emit [DONE]`);
					}
					controller.enqueue(encodeDataLine("[DONE]"));
					finished = true;
				}
			}

			function processText(text: string) {
				buffered += text;
				const segments = buffered.split("\n\n");
				// Keep the last partial segment in buffer
				buffered = segments.pop() ?? "";
				for (const seg of segments) {
					const events = parseSSELines(seg + "\n\n");
					for (const e of events) {
						eventCount++;
						if (debugEvents) {
							try {
								const dataForLog = debugVerbose ? e.data : redactAnthropicData(e.data);
								// Prefixed line for correlation
								if (debugPrefix) console.log(`${debugPrefix} event: ${e.event}`);
								// Strict event/data lines to match docs
								console.log(`event: ${e.event}`);
								console.log(`data: ${JSON.stringify(dataForLog)}`);
								console.log("");
							} catch {
								// ignore logging errors
							}
						}
						if (e.event === "message_start") {
							if (debugPrefix) {
								console.log(`${debugPrefix} translator: event#${eventCount} message_start`);
							}
							pushAssistantRoleIfNeeded();
						} else if (e.event === "content_block_delta") {
							pushAssistantRoleIfNeeded();
							// If Anthropic emits non-text deltas (e.g., thinking), surface that fact in logs
							if (debugPrefix) {
								try {
									const deltaType = (e as any)?.data?.delta?.type || (e as any)?.data?.type;
									if (deltaType && deltaType !== "text") {
										console.log(`${debugPrefix} translator: event#${eventCount} non-text delta type=${deltaType}`);
									}
								} catch {
									// ignore logging errors
								}
							}
							const textDelta = e.data?.delta?.text ?? "";
							if (debugPrefix) {
								console.log(
									`${debugPrefix} translator: event#${eventCount} text_delta len=${(textDelta || "").length}`,
								);
							}
							if (textDelta) {
								const chunk = openAIChunkEnvelope({
									id,
									created,
									model,
									delta: { content: textDelta },
									finish_reason: null,
								});
								controller.enqueue(encodeDataLine(chunk));
							}
						} else if (e.event === "message_delta") {
							const stopReason: string | undefined =
								e.data?.delta?.stop_reason ?? e.data?.stop_reason;
							if (debugPrefix) {
								console.log(`${debugPrefix} translator: event#${eventCount} message_delta stop_reason=${stopReason}`);
							}
							if (stopReason === "end_turn" || stopReason === "max_tokens") {
								const finish_reason = stopReason === "end_turn" ? "stop" : "length";
								const finalChunk = openAIChunkEnvelope({
									id,
									created,
									model,
									delta: {},
									finish_reason,
								});
								controller.enqueue(encodeDataLine(finalChunk));
							}
						} else if (e.event === "message_stop") {
							// The upstream stream is ending; [DONE] will be sent in finally
							if (debugPrefix) {
								console.log(`${debugPrefix} translator: event#${eventCount} message_stop`);
							}
						}
					}
				}
			}

			reader.read().then(function handle(result): any {
				if (result.done) {
					try {
						emitDone();
						controller.close();
					} catch {
						// ignore
					}
					return;
				}
				try {
					const chunkText = decoder.decode(result.value, { stream: true });
					if (debugPrefix) {
						console.log(`${debugPrefix} translator: received upstream bytes=${result.value?.length ?? 0}`);
					}
					processText(chunkText);
				} catch {
					// ignore malformed chunks
				}
				return reader.read().then(handle);
			}).catch(() => {
				try {
					emitDone();
					controller.close();
				} catch {
					// ignore
				}
			});
		},
		cancel() {
			// no-op
		},
	});
}

export function responsesSSEtoOAIChunks(
	model: string,
	upstream: ReadableStream<Uint8Array>,
	debugPrefix?: string,
): ReadableStream<Uint8Array> {
	// Convert OpenAI Responses API SSE frames to OpenAI Chat Completions chunk frames
	// Heuristic: emit text for events carrying `delta` strings and finish on response.completed/incomplete
	const id = generateOpenAIChunkId();
	const created = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	let buffered = "";
	let sentRole = false;
	let finished = false;
	let eventCount = 0;

	function encodeDataLine(objOrString: any): Uint8Array {
		if (typeof objOrString === "string") {
			return encoder.encode(`data: ${objOrString}\n\n`);
		}
		return encoder.encode(`data: ${JSON.stringify(objOrString)}\n\n`);
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const reader = upstream.getReader();

			function pushAssistantRoleIfNeeded() {
				if (!sentRole) {
					if (debugPrefix) {
						console.log(`${debugPrefix} resp-translator: emit role=assistant`);
					}
					const first = openAIChunkEnvelope({
						id,
						created,
						model,
						delta: { role: "assistant" },
						finish_reason: null,
					});
					controller.enqueue(encodeDataLine(first));
					sentRole = true;
				}
			}

			function emitFinish(reason: "stop" | "length") {
				if (finished) return;
				const finalChunk = openAIChunkEnvelope({
					id,
					created,
					model,
					delta: {},
					finish_reason: reason,
				});
				controller.enqueue(encodeDataLine(finalChunk));
			}

			function emitDone() {
				if (!finished) {
					if (debugPrefix) {
						console.log(`${debugPrefix} resp-translator: emit [DONE]`);
					}
					controller.enqueue(encodeDataLine("[DONE]"));
					finished = true;
				}
			}

			function processText(text: string) {
				buffered += text;
				const segments = buffered.split("\n\n");
				buffered = segments.pop() ?? "";
				for (const seg of segments) {
					const events = parseSSELines(seg + "\n\n");
					for (const e of events) {
						eventCount++;
						const ev = e.event || "";
						const data = e.data || {};
						if (debugPrefix) {
							// Log only event names to avoid leaking content
							console.log(`${debugPrefix} resp-translator: event#${eventCount} ${ev}`);
							// Detect and surface reasoning-related signals without logging content
							try {
								const hasReasoningSignal =
									(ev && ev.toLowerCase().includes("reasoning")) ||
									(typeof data === "object" &&
										data !== null &&
										("reasoning" in data ||
											"thoughts" in (data as any) ||
											(data as any)?.type === "reasoning"));
								if (hasReasoningSignal) {
									console.log(`${debugPrefix} resp-translator: reasoning signal observed in event ${ev}`);
								}
							} catch {
								// ignore logging errors
							}
						}
						// Stream text deltas
						if (ev.includes("output_text.delta") || typeof data?.delta === "string") {
							const textDelta: string = typeof data?.delta === "string" ? data.delta : "";
							if (textDelta) {
								pushAssistantRoleIfNeeded();
								const chunk = openAIChunkEnvelope({
									id,
									created,
									model,
									delta: { content: textDelta },
									finish_reason: null,
								});
								controller.enqueue(encodeDataLine(chunk));
							}
							continue;
						}
						// Completion events
						if (ev.includes("response.completed")) {
							pushAssistantRoleIfNeeded();
							emitFinish("stop");
							continue;
						}
						if (ev.includes("response.incomplete")) {
							pushAssistantRoleIfNeeded();
							const reason = (data?.reason || "").toString();
							emitFinish(reason === "max_output_tokens" ? "length" : "stop");
							continue;
						}
					}
				}
			}

			reader.read().then(function handle(result): any {
				if (result.done) {
					try {
						emitDone();
						controller.close();
					} catch {
						// ignore
					}
					return;
				}
				try {
					const chunkText = decoder.decode(result.value, { stream: true });
					if (debugPrefix) {
						console.log(`${debugPrefix} resp-translator: received upstream bytes=${result.value?.length ?? 0}`);
					}
					processText(chunkText);
				} catch {
					// ignore
				}
				return reader.read().then(handle);
			}).catch(() => {
				try {
					emitDone();
					controller.close();
				} catch {
					// ignore
				}
			});
		},
		cancel() {
			// no-op
		},
	});
}

export function anthropicJSONtoOAIChatCompletion(model: string, resp: any) {
	const id = `chatcmpl_${Math.random().toString(36).slice(2)}`;
	const created = Math.floor(Date.now() / 1000);
	// Aggregate text from content blocks
	let text = "";
	if (typeof resp?.content === "string") {
		text = resp.content;
	} else if (Array.isArray(resp?.content)) {
		for (const block of resp.content) {
			if (block && typeof block === "object") {
				if (block.type === "text" && typeof block.text === "string") {
					text += block.text;
				} else if (block.type === "tool_result") {
					// ignore in minimal translator
				}
			}
		}
	}
	const stop_reason = (resp?.stop_reason || "").toString();
	const finish_reason = stop_reason === "end_turn" ? "stop" : stop_reason === "max_tokens" ? "length" : null;
	const usage = resp?.usage || {};
	const prompt_tokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
	const completion_tokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
	const total_tokens =
		(prompt_tokens ?? 0) + (completion_tokens ?? 0);
	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text || "" },
				finish_reason,
				logprobs: null,
			},
		],
		usage: {
			prompt_tokens,
			completion_tokens,
			total_tokens,
		},
	};
}

export function responsesJSONtoOAIChatCompletion(model: string, resp: any) {
	const id = `chatcmpl_${Math.random().toString(36).slice(2)}`;
	const created = Math.floor(Date.now() / 1000);
	let text = "";
	if (typeof resp?.output_text === "string") {
		text = resp.output_text;
	}
	// Fallback: scan output array for message content text
	if (!text && Array.isArray(resp?.output)) {
		for (const item of resp.output) {
			if (item?.type === "message" && Array.isArray(item?.content)) {
				const parts = item.content
					.filter((c: any) => c && typeof c === "object" && (c.type === "output_text" || c.type === "text"))
					.map((c: any) => c.text)
					.filter((s: any) => typeof s === "string");
				if (parts.length > 0) {
					text = parts.join("");
					break;
				}
			}
		}
	}
	const usage = resp?.usage || {};
	const prompt_tokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
	const completion_tokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
	const total_tokens =
		(prompt_tokens ?? 0) + (completion_tokens ?? 0);
	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text || "" },
				finish_reason: "stop",
				logprobs: null,
			},
		],
		usage: {
			prompt_tokens,
			completion_tokens,
			total_tokens,
		},
	};
}


