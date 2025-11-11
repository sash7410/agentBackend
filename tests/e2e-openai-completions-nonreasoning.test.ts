import { expect, test } from "./test-helpers";
import { collectSSE, postJson } from "./e2e-helpers";

test("E2E: OpenAI gpt-5 (non-reasoning) streams via chat/completions", async () => {
	const body = {
		model: "gpt-5",
		stream: true,
		max_tokens: 256,
		messages: [{ role: "user", content: "Say hello" }],
		tools: [],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.ok, true);
	expect.toBe(resp.headers.get("content-type"), "text/event-stream; charset=utf-8");
	const lines = await collectSSE(resp.body as any);
	// Should produce valid OpenAI-style chunks ending with [DONE]
	expect.toBe(lines.length > 1, true);
	// Final should be [DONE]
	expect.toBe(lines[lines.length - 1], "[DONE]");
	// First chunk should be valid JSON
	const first = JSON.parse(lines[0]);
	expect.toBe(first.object, "chat.completion.chunk");
});


