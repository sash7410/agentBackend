import { expect, test } from "./test-helpers";
import { collectSSE, postJson } from "./e2e-helpers";

test("E2E: Anthropic non-reasoning streams via messages translated to OpenAI chunks", async () => {
	const body = {
		model: "claude-sonnet-4-20250514",
		// no stream flag → defaults true in worker
		messages: [{ role: "system", content: "You are concise" }, { role: "user", content: "Say hello" }],
		max_tokens: 512,
		tools: [],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.ok, true);
	expect.toBe(resp.headers.get("content-type"), "text/event-stream; charset=utf-8");
	const lines = await collectSSE(resp.body as any);
	expect.toBe(lines.length > 1, true);
	// First event: role announcement
	const first = JSON.parse(lines[0]);
	expect.toBe(first.object, "chat.completion.chunk");
	expect.toBe(first.choices[0].delta.role, "assistant");
	// Ends with [DONE]
	expect.toBe(lines[lines.length - 1], "[DONE]");
});


