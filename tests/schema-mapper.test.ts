import { expect, test } from "./test-helpers";
import { mapOAItoAnthropic, mapOAItoOpenAI, anthropicSSEtoOAIChunks, ChatCompletionRequest } from "../src/schema-mapper";

const decoder = new TextDecoder();

test("maps system precedence and preserves user/assistant order (Anthropic)", () => {
	const body: ChatCompletionRequest = {
		model: "claude-3-5-sonnet-20241022",
		messages: [
			{ role: "system", content: "You are concise" },
			{ role: "user", content: "Say hello" },
			{ role: "assistant", content: "Hello!" },
		],
	};
	const mapped = mapOAItoAnthropic(body);
	expect.toBe(mapped.request.system, "You are concise");
	expect.toEqual(mapped.request.messages, [
		{ role: "user", content: "Say hello" },
		{ role: "assistant", content: "Hello!" },
	]);
});

test("clamps temperature and token ceilings (Anthropic) and defaults when absent", () => {
	const body: ChatCompletionRequest = {
		model: "claude-3-5-sonnet-20241022",
		messages: [{ role: "user", content: "Hi" }],
		temperature: 5,
		max_tokens: 900000,
	};
	const mapped = mapOAItoAnthropic(body);
	expect.toBe(mapped.request.temperature, 2);
	expect.toBe(mapped.request.max_tokens, 8192);

	const body2: ChatCompletionRequest = {
		model: "claude",
		messages: [{ role: "user", content: "Hi" }],
	};
	const mapped2 = mapOAItoAnthropic(body2);
	expect.toBe(mapped2.request.max_tokens, 1024);
});

test("maps stop sequences to stop_sequences (Anthropic)", () => {
	const body: ChatCompletionRequest = {
		model: "claude",
		messages: [{ role: "user", content: "Go" }],
		stop: ["END"],
	};
	const mapped = mapOAItoAnthropic(body);
	expect.toEqual(mapped.request.stop_sequences, ["END"]);
});

test("tools ignored for Anthropic but do not crash; warning flag set", () => {
	const body: ChatCompletionRequest = {
		model: "claude",
		messages: [{ role: "user", content: "Go" }],
		tools: [{ type: "function", function: { name: "x", parameters: {} } }],
	};
	const mapped = mapOAItoAnthropic(body);
	expect.toBe(mapped.warnIgnoredTools, true);
});

test("OpenAI pass-through picks max_tokens over max_completion_tokens and forwards stop", () => {
	const body: ChatCompletionRequest = {
		model: "gpt-4o-mini",
		messages: [{ role: "user", content: "Go" }],
		max_tokens: 20,
		max_completion_tokens: 30,
		stop: ["DONE"],
		stream: false,
	};
	const mapped = mapOAItoOpenAI(body);
	expect.toBe(mapped.max_tokens, 20);
	expect.toEqual(mapped.stop, ["DONE"]);
	expect.toBe(mapped.stream, false);
});

function sseFromString(str: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(str));
			controller.close();
		},
	});
}

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	let acc = "";
	const out: string[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		acc += decoder.decode(value);
		let idx;
		while ((idx = acc.indexOf("\n\n")) >= 0) {
			const frame = acc.slice(0, idx);
			acc = acc.slice(idx + 2);
			const lines = frame.split("\n");
			for (const l of lines) {
				if (l.startsWith("data: ")) {
					out.push(l.slice(6));
				}
			}
		}
	}
	return out;
}

test("translates Anthropic SSE to OpenAI chunks with role, deltas, finish and [DONE]", async () => {
	const anthropicSSE = [
		"event: message_start",
		'data: {"type":"message_start","message":{"id":"msg_1"}}',
		"",
		"event: content_block_delta",
		'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
		"",
		"event: content_block_delta",
		'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world!"}}',
		"",
		"event: message_delta",
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
		"",
	].join("\n");

	const upstream = sseFromString(anthropicSSE + "\n\n");
	const translated = anthropicSSEtoOAIChunks("claude-3-5-sonnet-20241022", upstream);
	const dataLines = await collectSSE(translated);

	// We expect first is a role announcement
	const first = JSON.parse(dataLines[0]);
	expect.toBe(first.object, "chat.completion.chunk");
	expect.toBe(first.choices[0].delta.role, "assistant");

	// Next two are text deltas
	const second = JSON.parse(dataLines[1]);
	expect.toBe(second.choices[0].delta.content, "Hello");
	const third = JSON.parse(dataLines[2]);
	expect.toBe(third.choices[0].delta.content, " world!");

	// Final chunk has finish_reason stop
	const fourth = JSON.parse(dataLines[3]);
	expect.toBe(fourth.choices[0].finish_reason, "stop");

	// Then [DONE]
	expect.toBe(dataLines[4], "[DONE]");
});


