import { ChatCompletionRequest } from "../types";

export const MAX_TOKENS_CAP = 20000;
export const DEFAULT_MAX_TOKENS = 20000;

export function clamp(num: number, min: number, max: number): number {
	if (num === null || num === undefined) return min;
	if (Number.isNaN(num as number)) return min;
	if (num < min) return min;
	if (num > max) return max;
	return num;
}

export function selectMaxTokens(req: ChatCompletionRequest, provider: "anthropic" | "openai"): number | undefined {
	const fromReqMax = req.max_tokens ?? undefined;
	const fromReqMaxCompletion = req.max_completion_tokens ?? undefined;
	let chosen: number | undefined;
	if (provider === "openai") {
		chosen = fromReqMax ?? fromReqMaxCompletion;
	} else {
		chosen = fromReqMax ?? fromReqMaxCompletion ?? DEFAULT_MAX_TOKENS;
	}
	if (chosen === undefined || chosen === null) return provider === "anthropic" ? DEFAULT_MAX_TOKENS : undefined;
	return clamp(chosen, 1, MAX_TOKENS_CAP);
}


