import { expect, test } from "./test-helpers";
import { buildResponsesPayload } from "../src/reasoning/mapper";
import { ChatCompletionRequest } from "../src/schema-mapper";

test("maps legacy chat request to Responses.create payload (plain text, no tools)", () => {
	const body: ChatCompletionRequest = {
		model: "o4-mini",
		system: "You are terse",
		messages: [
			{ role: "user", content: "Say hi" },
			{ role: "assistant", content: "Ok." },
		],
		temperature: 0.7,
		stop: ["END"],
		max_completion_tokens: 256,
		stream: true,
		reasoning_effort: "medium",
	} as any;
	(body as any).top_p = 0.9;

	const payload = buildResponsesPayload(body);
	expect.toBe(payload.model, "o4-mini");
	expect.toBe(payload.instructions, "You are terse");
	expect.toBe(payload.temperature, 0.7);
	expect.toBe(payload.top_p, 0.9);
	expect.toEqual(payload.stop, ["END"]);
	expect.toBe(payload.max_output_tokens, 256);
	expect.toBe(payload.stream, true);
	expect.toEqual(payload.reasoning, { effort: "medium" });
	expect.toEqual(payload.input, [
		{ role: "user", content: [{ type: "input_text", text: "Say hi" }] },
		{ role: "assistant", content: [{ type: "text", text: "Ok." }] },
	]);
});

test("maps tools and tool_choice through unchanged for Responses", () => {
	const body: ChatCompletionRequest = {
		model: "o4",
		messages: [{ role: "user", content: "What's the weather in SF?" }],
		tools: [
			{
				type: "function",
				function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
			},
		],
	} as any;
	(body as any).tool_choice = { type: "function", function: { name: "get_weather" } };
	const payload = buildResponsesPayload(body);
	expect.toBe(payload.tools?.[0].type, "function");
	expect.toBe(payload.tools?.[0].function.name, "get_weather");
	expect.toBe((payload as any).tool_choice.function.name, "get_weather");
});


