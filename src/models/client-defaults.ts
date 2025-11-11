import { getModelsArray } from "../client_mapping";

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
	//TODO: lolol make this extensible to add more providers
	const provider: "openai" | "anthropic" | null = providerRaw === "anthropic" ? "anthropic" : "openai";
	//TODO: lolol we should have a better way to check against models that support reasoning 
	//instead of checking against the redacted thinking
	const redactedThinking = Boolean(record?.redacted_thinking);
	let upstreamModel = (record?.model as string) || clientModelId;
	const resolvedId = ((record?.id as string) || clientModelId).toLowerCase();
	//TODO: lolol make this extensible to add more efforts
	let defaultEffort: "low" | "high" | undefined;
	const isLow = /(^|-)low($|-)/.test(resolvedId);
	const isHigh = /(^|-)high($|-)/.test(resolvedId);
	const isLowOrHigh = isLow || isHigh;
	//TODO: lolol what about codex?
	if (redactedThinking && provider === "openai") {
		if (isLow) defaultEffort = "low";
		if (isHigh) defaultEffort = "high";
		if ((upstreamModel || "").toLowerCase().startsWith("gpt-5-") && (defaultEffort === "low" || defaultEffort === "high")) {
			upstreamModel = "gpt-5";
		}
	}
	const enableAnthropicThinking = provider === "anthropic" && redactedThinking;
	const sendToResponses = provider === "openai" && redactedThinking && isLowOrHigh;
	console.log(
		`[computeDefaultReasoningForClientModel] clientModelId=${clientModelId} provider=${provider} upstreamModel=${upstreamModel} defaultEffort=${defaultEffort} enableAnthropicThinking=${enableAnthropicThinking} sendToResponses=${sendToResponses} isLowOrHigh=${isLowOrHigh}`,
	);
	return { provider, upstreamModel, sendToResponses, defaultEffort, enableAnthropicThinking };
}


