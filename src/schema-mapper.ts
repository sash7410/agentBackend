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
	// A single "system" string; if present, we ensure one system message is applied
	system?: string | null;
	// Tools are ignored for Anthropic in this v1; we forward them to OpenAI as-is
	tools?: any[] | null;
	// Arbitrary variables clients can pass; we only log the key count
	user_variables?: Record<string, any> | null;
};

export type AnthropicMessage = {
	role: "user" | "assistant";
	content: string;
};

export type AnthropicRequest = {
	model: string;
	system?: string;
	messages: AnthropicMessage[];
	max_tokens: number;
	temperature?: number;
	stop_sequences?: string[];
	stream: boolean;
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
};

const MAX_TOKENS_CAP = 8192;
const DEFAULT_MAX_TOKENS = 1024;

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

	const { system, filtered, hadTools } = extractSystemAndFilterMessages(req);
	if (!ensureHasUserMessage(filtered)) {
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
	try {
		console.log(
			`[mapper->anthropic] system_present=${Boolean(system)} msgs_in=${req.messages?.length ?? 0} msgs_out=${filtered.length} had_tools=${hadTools} temp=${temperature ?? "n/a"} max_tokens=${maxTokens} stop_seq=${stop_sequences?.length ?? 0} stream=${stream}`,
		);
	} catch {
		// ignore logging errors
	}

	// We return Anthropic's native request shape, but we also return a flag if tools were present
	// so the caller can attach a warning header for the client.
	return {
		request: {
			model: req.model,
			system: system,
			messages: filtered,
			max_tokens: maxTokens,
			temperature,
			stop_sequences,
			stream,
		},
		warnIgnoredTools: hadTools, // v1 ignores tools for Anthropic
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
	try {
		const maxField = (openaiReq as any).max_completion_tokens ?? openaiReq.max_tokens ?? "n/a";
		console.log(
			`[mapper->openai] model=${req.model} msgs_in=${req.messages?.length ?? 0} msgs_out=${openaiReq.messages.length} system_included=${Boolean(req.system)} temp=${temperature ?? "n/a"} max=${maxField} stop=${stop?.length ?? 0} tools=${tools?.length ?? 0} stream=${stream}`,
		);
	} catch {
		// ignore logging errors
	}
	return openaiReq;
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
						if (e.event === "message_start") {
							if (debugPrefix) {
								console.log(`${debugPrefix} translator: event#${eventCount} message_start`);
							}
							pushAssistantRoleIfNeeded();
						} else if (e.event === "content_block_delta") {
							pushAssistantRoleIfNeeded();
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


