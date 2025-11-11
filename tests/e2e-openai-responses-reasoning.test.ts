import { expect, test } from "./test-helpers";
import { collectSSE, postJson } from "./e2e-helpers";
import { waitForLogIncludes } from "./log-helpers";

test("E2E: OpenAI gpt-5-low (reasoning) routes to responses and streams translated chunks", async () => {
	const body = {
		model: "gpt-5-low",
		stream: true,
		max_tokens: 256,
		messages: [{ role: "user", content: "Refactor this function" }],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.ok, true);
	expect.toBe(resp.headers.get("content-type"), "text/event-stream; charset=utf-8");
	const lines = await collectSSE(resp.body as any);
	expect.toBe(lines.length > 1, true);
	const first = JSON.parse(lines[0]);
	expect.toBe(first.object, "chat.completion.chunk");
	expect.toBe(first.choices[0].delta.role, "assistant");
	expect.toBe(lines[lines.length - 1], "[DONE]");
	// Verify it routed to Responses and streamed output_text deltas from upstream (via server logs)
	await waitForLogIncludes(["downStreamResponse->openai POST /v1/responses"]);
	await waitForLogIncludes(["resp-translator: event#", "response.output_text.delta"]);
});

test("E2E JSON: OpenAI gpt-5-low (reasoning) returns chat.completion JSON mapped from Responses", async () => {
	const body = {
		model: "gpt-5-low",
		stream: false,
		max_tokens: 128,
		messages: [{ role: "user", content: "Refactor this small function" }],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.ok, true);
	expect.toBe(resp.headers.get("content-type"), "application/json");
	const json = await resp.json();
	expect.toBe(json.object, "chat.completion");
	expect.toBeTruthy(Array.isArray(json.choices));
	expect.toBe(json.choices[0].message.role, "assistant");
	// Non-stream path still confirms Responses routing in logs
	await waitForLogIncludes(["downStreamResponse->openai POST /v1/responses"]);
});


