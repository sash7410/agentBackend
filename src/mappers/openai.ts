import { ChatCompletionRequest, OpenAIChatRequest, OpenAIResponsesRequest } from "../types";
import { clamp, selectMaxTokens } from "../utils/tokens";

function normalizeContentToText(content: any): { text: string; changed: boolean } {
	if (typeof content === "string") return { text: content, changed: false };
	if (Array.isArray(content)) {
		const texts: string[] = [];
		for (const part of content) {
			if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
				texts.push(part.text);
			}
		}
		return { text: texts.join(""), changed: true };
	}
	return { text: String(content ?? ""), changed: true };
}

export function useMaxCompletionTokensField(model: string): boolean {
	const m = (model || "").toLowerCase();
	return m.startsWith("gpt-5");
}

export function mapOAItoOpenAI(req: ChatCompletionRequest): OpenAIChatRequest {
	if (!req || typeof req !== "object") {
		throw new Error("Invalid request body");
	}
	if (!Array.isArray(req.messages) || typeof req.model !== "string") {
		throw new Error("Missing required fields: model, messages");
	}
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
	const stream = req.stream === null || req.stream === undefined ? true : Boolean(req.stream);
	const out: OpenAIChatRequest = {
		model: req.model,
		messages: messages as any,
		temperature,
		stop,
		stream,
	};
	if (maxTokens !== undefined) {
		if (useMaxCompletionTokensField(req.model)) {
			out.max_completion_tokens = maxTokens;
		} else {
			out.max_tokens = maxTokens;
		}
	}
	if (tools) out.tools = tools;
	return out;
}

export function mapOAItoOpenAIResponses(req: ChatCompletionRequest): OpenAIResponsesRequest {
	if (!req || typeof req !== "object") {
		throw new Error("Invalid request body");
	}
	if (!Array.isArray(req.messages) || typeof req.model !== "string") {
		throw new Error("Missing required fields: model, messages");
	}
	const modelNormalized = (req.model || "").toLowerCase();
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
	let chosenMax: number | undefined;
	if (req.max_tokens !== null && req.max_tokens !== undefined) {
		chosenMax = clamp(Number(req.max_tokens), 1, 20000);
	} else if (req.max_completion_tokens !== null && req.max_completion_tokens !== undefined) {
		chosenMax = clamp(Number(req.max_completion_tokens), 1, 20000);
	}
	const stream = req.stream === null || req.stream === undefined ? true : Boolean(req.stream);
	let effort: "low" | "medium" | "high" | undefined =
		((typeof req.reasoning_effort === "string" ? req.reasoning_effort : undefined) as any) ||
		((req as any).reasoning && (req as any).reasoning.effort) ||
		undefined;
	const out: OpenAIResponsesRequest = {
		model: modelNormalized,
		input: messages as any,
		temperature,
		stream,
	};
	if (chosenMax !== undefined) out.max_output_tokens = chosenMax;
	const requestedSummary: "auto" | "extended" | undefined =
		((req as any).reasoning && (req as any).reasoning.summary) || undefined;
	if (effort || requestedSummary) {
		out.reasoning = {
			...(effort ? { effort } : {}),
			// Default to 'auto' when effort is used but summary not explicitly provided
			...(requestedSummary ? { summary: requestedSummary } : effort ? { summary: "auto" } : {}),
		};
	}
	if (Array.isArray(req.tools) && req.tools.length > 0) {
		out.tools = req.tools.map((t: any) => {
			try {
				if (t && (t.type === "function" || t.function)) {
					const name = t.name ?? t.function?.name;
					if (name && !t.name) {
						return { ...t, name };
					}
				}
			} catch {
				// ignore
			}
			return t;
		});
	}
	return out;
}


