import { expect, test } from "./test-helpers";
import { collectSSE, postJson } from "./e2e-helpers";

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
});


