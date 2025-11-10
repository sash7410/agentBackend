// ReasoningMapper: translate legacy ChatCompletionRequest to OpenAI Responses API payloads
import { ChatCompletionRequest } from "../schema-mapper";

export type ResponsesInputMessage = {
	role: "user" | "assistant";
	// For Responses API, each content is an array of typed parts
	content: Array<
		| { type: "input_text"; text: string }
		| { type: "text"; text: string }
	>;
};

export type ResponsesFunctionTool = {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: any;
	};
};

export type ResponsesCreatePayload = {
	model: string;
	instructions?: string;
	temperature?: number;
	top_p?: number;
	max_output_tokens?: number;
	stop?: string[];
	tools?: ResponsesFunctionTool[];
	tool_choice?: any;
	reasoning?: { effort?: string };
	stream?: boolean;
	// For follow-up tool outputs
	previous_response_id?: string;
	// When sending tool outputs as a single item instead of messages
	input_image?: never;
};

export type ResponsesCreateMessagesPayload = ResponsesCreatePayload & {
	input: ResponsesInputMessage[];
};

export type ToolCallDescriptor = {
	name: string;
	argumentsJson: string;
	callId?: string;
};

function asText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			if (part && typeof part === "object") {
				if (typeof part.text === "string") out += part.text;
				else if (typeof part.content === "string") out += part.content;
			}
		}
		return out;
	}
	if (content && typeof content === "object" && typeof content.text === "string") return content.text;
	return String(content ?? "");
}

function clamp(num: number | undefined | null, min: number, max: number): number | undefined {
	if (num === null || num === undefined) return undefined;
	const n = Number(num);
	if (Number.isNaN(n)) return undefined;
	if (n < min) return min;
	if (n > max) return max;
	return n;
}

export function buildResponsesPayload(req: ChatCompletionRequest): ResponsesCreateMessagesPayload {
	if (!req || typeof req !== "object") throw new Error("Invalid request body");
	if (!Array.isArray(req.messages) || typeof req.model !== "string") {
		throw new Error("Missing required fields: model, messages");
	}
	// Map messages
	const input: ResponsesInputMessage[] = [];
	for (const m of req.messages) {
		if (m.role === "user") {
			const text = asText((m as any).content);
			input.push({ role: "user", content: [{ type: "input_text", text }] });
		} else if (m.role === "assistant") {
			const text = asText((m as any).content);
			input.push({ role: "assistant", content: [{ type: "text", text }] });
		}
		// Ignore tool/system here; system handled as instructions; tool role is not forwarded in initial turn
	}
	// Compute fields
	const temperature = clamp(req.temperature as any, 0, 2);
	const top_p = clamp((req as any).top_p, 0, 1);
	const max_output_tokens =
		(typeof req.max_completion_tokens === "number" && req.max_completion_tokens) ||
		(typeof req.max_tokens === "number" && req.max_tokens) ||
		undefined;
	const stop = Array.isArray(req.stop) && req.stop.length > 0 ? req.stop.slice(0) : undefined;
	// Tools: keep function tools and schemas as-is
	let tools: ResponsesFunctionTool[] | undefined = undefined;
	if (Array.isArray(req.tools) && req.tools.length > 0) {
		tools = [];
		for (const t of req.tools) {
			try {
				if (t && (t.type === "function" || t.function)) {
					const fn = t.function ?? {};
					const name = fn.name ?? t.name;
					if (typeof name !== "string" || name.length === 0) continue;
					tools.push({
						type: "function",
						function: {
							name,
							description: typeof fn.description === "string" ? fn.description : t.description,
							parameters: fn.parameters,
						},
					});
				}
			} catch {
				// ignore malformed
			}
		}
		if (tools.length === 0) tools = undefined;
	}
	const tool_choice = (req as any).tool_choice ?? undefined;
	const instructions = typeof req.system === "string" && req.system ? req.system : undefined;
	const stream =
		req.stream === null || req.stream === undefined ? true : Boolean(req.stream);
	const reasoning =
		typeof req.reasoning_effort === "string" && req.reasoning_effort
			? { effort: req.reasoning_effort }
			: undefined;
	return {
		model: req.model,
		instructions,
		input,
		temperature,
		top_p,
		max_output_tokens,
		stop,
		tools,
		tool_choice,
		reasoning,
		stream,
	};
}

export function buildToolOutputFollowUp(args: {
	previous_response_id: string;
	model: string;
	callId: string;
	toolOutputJson: string;
}): ResponsesCreatePayload & { input: any[] } {
	// Create a follow-up Responses.create payload with only function_call_output item.
	// We serialize tool output as a JSON string as required.
	return {
		model: args.model,
		previous_response_id: args.previous_response_id,
		// Using a single-item "input" with a typed function_call_output shape
		// OpenAI Responses recognizes this to advance the turn.
		input: [
			{
				type: "function_call_output",
				call_id: args.callId,
				output: args.toolOutputJson,
			},
		],
	};
}


