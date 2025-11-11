import { expect, test } from "./test-helpers";
import { collectSSE, postJson } from "./e2e-helpers";
import { waitForLogIncludes } from "./log-helpers";

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
	// Verify upstream Anthropic thinking deltas were seen by the translator (from server logs)
	// Requires running server with logs redirected to a file, e.g.: `wrangler dev | tee logs.txt`
	await waitForLogIncludes(["provider=anthropic", "non-text delta type=thinking_delta"]);
});

test("E2E JSON: Anthropic reasoning returns chat.completion JSON with thinking enabled", async () => {
	const body = {
		model: "claude-sonnet-4-5-20250929",
		stream: false,
		messages: [{ role: "user", content: "Summarize this in one sentence" }],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.ok, true);
	expect.toBe(resp.headers.get("content-type"), "application/json");
	const json = await resp.json();
	expect.toBe(json.object, "chat.completion");
	expect.toBeTruthy(Array.isArray(json.choices));
	expect.toBe(json.choices[0].message.role, "assistant");
	// Non-stream flow: still ensure upstream thinking was injected and processed (from logs)
	await waitForLogIncludes(["route=anthropic injectThinking=true"]);
});


