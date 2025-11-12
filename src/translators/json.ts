export function anthropicJSONtoOAIChatCompletion(model: string, resp: any) {
	const id = `chatcmpl_${Math.random().toString(36).slice(2)}`;
	const created = Math.floor(Date.now() / 1000);
	let text = "";
	if (typeof resp?.content === "string") {
		text = resp.content;
	} else if (Array.isArray(resp?.content)) {
		for (const block of resp.content) {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				text += block.text;
			}
		}
	}
	const stop_reason = (resp?.stop_reason || "").toString();
	const finish_reason = stop_reason === "end_turn" ? "stop" : stop_reason === "max_tokens" ? "length" : null;
	const usage = resp?.usage || {};
	const prompt_tokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
	const completion_tokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
	const total_tokens = (prompt_tokens ?? 0) + (completion_tokens ?? 0);
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
	let reasoning = "";
	let summary = "";
	if (typeof resp?.output_text === "string") {
		text = resp.output_text;
	}
	if (!text && Array.isArray(resp?.output)) {
		for (const item of resp.output) {
			// Capture top-level reasoning summary blocks if present
			if (item?.type === "reasoning" && Array.isArray(item?.summary)) {
				const summaryParts = item.summary
					.filter(
						(s: any) =>
							s &&
							typeof s === "object" &&
							(typeof s.text === "string" || typeof s.summary_text === "string"),
					)
					.map((s: any) => (typeof s.summary_text === "string" ? s.summary_text : s.text))
					.filter((s: any) => typeof s === "string");
				if (summaryParts.length > 0) {
					summary = summaryParts.join("");
				}
			}
			if (item?.type === "message" && Array.isArray(item?.content)) {
				// Prefer reasoning/thinking content if present
				const reasoningParts = item.content
					.filter(
						(c: any) =>
							c &&
							typeof c === "object" &&
							(c.type === "reasoning" || c.type === "thought" || c.kind === "reasoning") &&
							typeof c.text === "string",
					)
					.map((c: any) => c.text)
					.filter((s: any) => typeof s === "string");
				if (reasoningParts.length > 0) {
					reasoning = reasoningParts.join("");
				}
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
	const total_tokens = (prompt_tokens ?? 0) + (completion_tokens ?? 0);
	const result: any = {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [
			{
				index: 0,
				// Default to reasoning content when available, otherwise normal text
				message: { role: "assistant", content: (reasoning || text || "") },
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
	// Surface sanitized reasoning summary when available without altering the expected shape
	if (summary) {
		result.reasoning_summary = summary;
	}
	return result;
}


