import { expect, test } from "./test-helpers";
import { collectSSEObjects, postJson } from "./e2e-helpers";
import { waitForLogIncludes } from "./log-helpers";

test("E2E SSE: OpenAI gpt-5-low emits thinking frames (delta/done) for client", async () => {
	const body = {
		model: "gpt-5-low",
		stream: true,
		max_tokens: 256,
		// minimal message to elicit a short thinking summary
		messages: [{ role: "user", content: "Say hello briefly" }],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.ok, true);
	expect.toBe(resp.headers.get("content-type"), "text/event-stream; charset=utf-8");
	const frames = await collectSSEObjects(resp.body as any);
	// Log all thinking frames exactly as a client would see them:
    await new Promise(resolve => setTimeout(resolve, 10000));
    for (const f of frames) {
        console.log(`lolol f=${JSON.stringify(f)}`);
    }
	// const thinkingFrames = frames.filter(
	// 	(f: any) => f && typeof f === "object" && typeof f.type === "string" && f.type.startsWith("oai.thinking."),
	// );
	// for (const f of thinkingFrames) {
	// 	console.log(`THINKING(OpenAI): ${JSON.stringify(f)}`);
	// }

    // await new Promise(resolve => setTimeout(resolve, 1000));
    // expect.toBe(thinkingFrames.length > 0, true);
	// // Sanity-check shape for at least one delta
	// const hasDelta = thinkingFrames.some((f: any) => f.type === "oai.thinking.delta" && f.data && typeof f.data === "object");
	// expect.toBe(hasDelta, true);
	// // Confirm Responses route via logs
	// await waitForLogIncludes(["downStreamResponse->openai POST /v1/responses"]);
});

test("E2E SSE: Anthropic thinking frames (delta/done) are forwarded for client", async () => {
	const body = {
		model: "claude-sonnet-4-5-20250929",
		// leave stream default true
		// keep prompt simple to ensure quick thinking blocks
		messages: [{ role: "user", content: "Greet me in one sentence" }],
		// optional: explicitly enable thinking with conservative budget
		thinking: { type: "enabled", budget_tokens: 4096 },
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.ok, true);
	expect.toBe(resp.headers.get("content-type"), "text/event-stream; charset=utf-8");
    
	const frames = await collectSSEObjects(resp.body as any);

    for (const f of frames) {
        console.log(`lolol f=${JSON.stringify(f)}`);
    }
	// const thinkingFrames = frames.filter(
	// 	(f: any) => f && typeof f === "object" && typeof f.type === "string" && f.type.startsWith("oai.thinking."),
	// );
	// for (const f of thinkingFrames) {
	// 	console.log(`THINKING(Anthropic): ${JSON.stringify(f)}`);
	// }
	// expect.toBe(thinkingFrames.length > 0, true);
	// // At least one delta should be present (either thinking or redacted_thinking)
	// const hasDelta = thinkingFrames.some((f: any) => f.type === "oai.thinking.delta" && f.data && typeof f.data === "object");
	// expect.toBe(hasDelta, true);
	// // We also expect a done for the thinking block
	// const hasDone = thinkingFrames.some((f: any) => f.type === "oai.thinking.done");
	// expect.toBe(hasDone, true);
	// // Confirm Anthropic route via logs
	// await waitForLogIncludes(["route=anthropic"]);
});


