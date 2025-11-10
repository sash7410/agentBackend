import { ChatCompletionRequest } from "../schema-mapper";
import { buildResponsesPayload, buildToolOutputFollowUp, ResponsesCreatePayload } from "./mapper";
import { responsesSSEToLegacyChunks } from "./stream-translator";
import { ToolTurn } from "./tool-turn";

export type EnvLike = {
	OPENAI_API_KEY: string;
	REASONING_MODELS?: string; // comma-separated patterns, e.g. "o4*,gpt-4.1*"
	ENABLE_REASONING?: string; // "true" to enable globally
};

type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export type ToolExecutor = (name: string, argsJson: string) => Promise<string>;

function matchesAnyPattern(model: string, csvPatterns: string | undefined): boolean {
	if (!csvPatterns) return false;
	const list = csvPatterns.split(",").map((s) => s.trim()).filter(Boolean);
	const m = (model || "").toLowerCase();
	return list.some((p) => {
		const pat = p.toLowerCase();
		if (pat.endsWith("*")) {
			return m.startsWith(pat.slice(0, -1));
		}
		return m === pat;
	});
}

export function shouldUseReasoning(req: ChatCompletionRequest, env: EnvLike): boolean {
	// Enabled only when config allows AND either reasoning_effort present or model matches patterns
	const enabled = String(env.ENABLE_REASONING || "").toLowerCase() === "true";
	if (!enabled) return false;
	if (typeof req.reasoning_effort === "string" && req.reasoning_effort) return true;
	return matchesAnyPattern(req.model || "", env.REASONING_MODELS);
}

export class ReasoningService {
	private fetchImpl: FetchLike;
	private baseUrl: string;
	private toolExecutor: ToolExecutor | null;
	private maxToolRounds: number;
	private static redactPayloadForLog(payload: any): any {
		try {
			const clone = JSON.parse(JSON.stringify(payload));
			if (Array.isArray(clone?.input)) {
				for (const msg of clone.input) {
					if (Array.isArray(msg?.content)) {
						for (const part of msg.content) {
							if (typeof part?.text === "string") {
								const len = part.text.length;
								part.text = `<redacted ${len} chars>`;
							}
						}
					}
				}
			}
			// If function_call_output present, redact output but keep length
			if (Array.isArray(clone?.input)) {
				for (const item of clone.input) {
					if (item?.type === "function_call_output" && typeof item?.output === "string") {
						item.output = `<tool_output redacted ${item.output.length} chars>`;
					}
				}
			}
			return clone;
		} catch {
			return { note: "redaction_failed" };
		}
	}

	constructor(opts: { fetchImpl?: FetchLike; baseUrl?: string; toolExecutor?: ToolExecutor | null; maxToolRounds?: number } = {}) {
		this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
		this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1/responses";
		this.toolExecutor = opts.toolExecutor ?? null;
		this.maxToolRounds = Math.max(1, opts.maxToolRounds ?? 4);
	}

	private authHeaders(env: EnvLike): Record<string, string> {
		return {
			"content-type": "application/json",
			authorization: `Bearer ${env.OPENAI_API_KEY}`,
		};
	}

	async createStream(req: ChatCompletionRequest, env: EnvLike): Promise<ReadableStream<Uint8Array>> {
		// For streaming, ignore tools so the model doesn't emit tool calls (client unchanged).
		const reqNoTools: any = { ...req, tools: undefined };
		reqNoTools.tool_choice = "none";
		const payload = buildResponsesPayload(reqNoTools);
		try {
			console.log(
				`[reasoning] mapped->responses stream payload=${JSON.stringify(
					ReasoningService.redactPayloadForLog(payload),
				)} (tools_ignored=true)`,
			);
		} catch {
			// ignore log errors
		}
		const headers = this.authHeaders(env);
		headers["accept"] = "text/event-stream";
		let upstream: Response;
		try {
			upstream = await this.fetchImpl(this.baseUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
			});
		} catch {
			// Create a tiny error SSE (legacy contract: an SSE "error" line then close)
			const encoder = new TextEncoder();
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(`event: error\ndata: {"message":"Upstream request failed to start"}\n\n`));
					controller.close();
				},
			});
		}
		if (!upstream.ok || !upstream.body) {
			const text = await upstream.text().catch(() => "");
			const encoder = new TextEncoder();
			return new ReadableStream<Uint8Array>({
				start(controller) {
					const msg = text || `HTTP ${upstream.status}`;
					controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`));
					controller.close();
				},
			});
		}
		// Translate Responses SSE to legacy chat chunks
		return responsesSSEToLegacyChunks(req.model, upstream.body, "[reasoning.stream]");
	}

	async create(req: ChatCompletionRequest, env: EnvLike): Promise<any> {
		// Non-streaming flow with tool turns
		const headers = this.authHeaders(env);
		let payload: ResponsesCreatePayload = buildResponsesPayload({ ...req, stream: false });
		try {
			console.log(`[reasoning] mapped->responses json payload=${JSON.stringify(ReasoningService.redactPayloadForLog(payload))}`);
		} catch {
			// ignore
		}
		let lastResponseId: string | null = null;
		const toolTurn = new ToolTurn(this.maxToolRounds);
		let outputText = "";
		let finish_reason: "stop" | "length" | null = null;
		let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

		for (;;) {
			let upstream: Response;
			try {
				upstream = await this.fetchImpl(this.baseUrl, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
				});
			} catch {
				throw new Error("Upstream request failed to start");
			}
			if (!upstream.ok) {
				const text = await upstream.text().catch(() => "");
				throw new Error(text || `Upstream error (${upstream.status})`);
			}
			const json = await upstream.json();
			// Extract core fields
			lastResponseId = json?.id ?? lastResponseId;
			if (typeof json?.usage?.total_tokens === "number") {
				usage = {
					prompt_tokens: Number(json.usage.prompt_tokens ?? usage.prompt_tokens ?? 0),
					completion_tokens: Number(json.usage.completion_tokens ?? usage.completion_tokens ?? 0),
					total_tokens: Number(json.usage.total_tokens ?? 0),
				};
			}
			// Look for tool calls first
			const toolCalls = extractToolCallsFromResponse(json);
			if (toolCalls.length > 0) {
				if (!this.toolExecutor) {
					throw new Error("Tool call requested but no ToolExecutor is configured");
				}
				toolTurn.incrementRoundOrThrow();
				toolTurn.setPreviousResponseId(String(lastResponseId || ""));
				const call = toolCalls[0];
				const toolOutput = await this.toolExecutor(call.name, call.arguments_json);
				const follow = buildToolOutputFollowUp({
					previous_response_id: toolTurn.previous_response_id || "",
					model: req.model,
					callId: call.call_id,
					toolOutputJson: toolOutput,
				});
				try {
					console.log(
						`[reasoning] follow-up function_call_output prev_id=${toolTurn.previous_response_id} call_id=${call.call_id} payload=${JSON.stringify(
							ReasoningService.redactPayloadForLog(follow),
						)}`,
					);
				} catch {
					// ignore
				}
				payload = follow;
				// Loop again for the model's follow-up message
				continue;
			}
			// No tool calls: gather text outputs
			const { fullText, finish } = collectTextFromResponse(json);
			outputText += fullText;
			finish_reason = finish ?? finish_reason ?? null;
			break;
		}

		// Return legacy ChatCompletion response object
		const created = Math.floor(Date.now() / 1000);
		return {
			id: `chatcmpl_${created.toString(36)}${Math.random().toString(36).slice(2, 10)}`,
			object: "chat.completion",
			created,
			model: req.model,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: outputText,
					},
					finish_reason,
				},
			],
			usage,
		};
	}
}

function extractToolCallsFromResponse(json: any): Array<{ call_id: string; name: string; arguments_json: string }> {
	const out: Array<{ call_id: string; name: string; arguments_json: string }> = [];
	try {
		const output = json?.output ?? json?.response?.output ?? [];
		for (const item of output) {
			if (item?.type === "tool_call" || item?.type === "function_call") {
				const call = item?.tool_call ?? item?.function_call ?? item;
				const call_id = call?.id ?? item?.id ?? "";
				const name = call?.function?.name ?? call?.name;
				let argsJson = "";
				const directArgs = call?.arguments;
				const nestedArgs = call?.function?.arguments;
				const pickedArgs = directArgs !== undefined ? directArgs : nestedArgs;
				if (typeof pickedArgs === "string") {
					argsJson = pickedArgs;
				} else if (pickedArgs) {
					try {
						argsJson = JSON.stringify(pickedArgs);
					} catch {
						argsJson = String(pickedArgs);
					}
				}
				if (name && call_id) {
					out.push({ call_id, name, arguments_json: argsJson });
				}
			}
		}
	} catch {
		// ignore
	}
	return out;
}

function collectTextFromResponse(json: any): { fullText: string; finish: "stop" | "length" | null } {
	let text = "";
	try {
		const items = json?.output ?? json?.response?.output ?? [];
		for (const it of items) {
			if (it?.type === "output_text" || it?.type === "message" || it?.type === "text") {
				const t = it?.content?.[0]?.text ?? it?.text ?? it?.content ?? "";
				if (typeof t === "string") text += t;
			}
		}
	} catch {
		// ignore
	}
	let finish: "stop" | "length" | null = null;
	const fr = json?.finish_reason ?? json?.response?.finish_reason;
	if (fr === "stop") finish = "stop";
	else if (fr === "length" || fr === "max_output_tokens") finish = "length";
	return { fullText: text, finish };
}


