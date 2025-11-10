import { expect, test } from "./test-helpers";
import { ReasoningService } from "../src/reasoning/service";
import { ChatCompletionRequest } from "../src/schema-mapper";

test("ReasoningService non-stream: single tool round then final text", async () => {
	const calls: any[] = [];
	const mockFetch = async (input: RequestInfo, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		calls.push({ url, body });
		// First call returns a tool request
		if (!body.previous_response_id) {
			return new Response(
				JSON.stringify({
					id: "resp_1",
					output: [
						{
							type: "function_call",
							id: "call_1",
							function: { name: "get_weather", arguments: '{"city":"SF"}' },
						},
					],
					usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		// Follow-up call should include function_call_output
		if (body.previous_response_id === "resp_1") {
			if (!Array.isArray(body.input) || body.input[0]?.type !== "function_call_output") {
				return new Response(JSON.stringify({ error: "expected function_call_output" }), { status: 400 });
			}
			return new Response(
				JSON.stringify({
					id: "resp_2",
					output: [{ type: "text", text: "It is sunny." }],
					usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
					finish_reason: "stop",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(JSON.stringify({ error: "unexpected" }), { status: 400 });
	};

	const svc = new ReasoningService({
		fetchImpl: mockFetch as any,
		toolExecutor: async (name: string, argsJson: string) => {
			// Validate executor called with expected data
			expect.toBe(name, "get_weather");
			expect.toBe(argsJson, '{"city":"SF"}');
			return '{"tempF":72}';
		},
	});
	const req: ChatCompletionRequest = {
		model: "o4-mini",
		messages: [{ role: "user", content: "Weather?" }],
		stream: false,
	} as any;
	const env = { OPENAI_API_KEY: "sk-test", ENABLE_REASONING: "true", REASONING_MODELS: "o4*" } as any;

	const out = await svc.create(req, env);
	expect.toBe(out.object, "chat.completion");
	expect.toBe(out.choices[0].message.role, "assistant");
	expect.toBe(out.choices[0].message.content, "It is sunny.");
	expect.toEqual(out.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
});


