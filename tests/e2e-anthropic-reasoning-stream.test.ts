import { expect, test } from "./test-helpers";
import { collectSSE, postJson } from "./e2e-helpers";

test("E2E: Anthropic reasoning (claude-sonnet-4-5-20250929) streams with translated chunks", async () => {
	const body = {
		model: "claude-sonnet-4-5-20250929",
		// default stream true
		messages: [{ role: "user", content: "Think step by step about this prompt" }],
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


