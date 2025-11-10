import { expect, test } from "./test-helpers";
import { responsesSSEToLegacyChunks } from "../src/reasoning/stream-translator";

const decoder = new TextDecoder();

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
				if (l.startsWith("data: ")) out.push(l.slice(6));
			}
		}
	}
	return out;
}

test("translates Responses SSE deltas, emits finish, [DONE], and trailing usage summary", async () => {
	const sse = [
		"event: response.created",
		'data: {"id":"resp_1"}',
		"",
		"event: response.output_text.delta",
		'data: {"delta":"Hello"}',
		"",
		"event: response.output_text.delta",
		'data: {"delta":" world!"}',
		"",
		"event: response.completed",
		'data: {"finish_reason":"stop","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
		"",
	].join("\n");
	const upstream = sseFromString(sse + "\n\n");
	const translated = responsesSSEToLegacyChunks("o4-mini", upstream);
	const dataLines = await collectSSE(translated);
	const first = JSON.parse(dataLines[0]);
	expect.toBe(first.object, "chat.completion.chunk");
	expect.toBe(first.choices[0].delta.role, "assistant");
	// Find the first two text delta chunks in order
	const deltas = dataLines
		.slice(1)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((o) => o && o.object === "chat.completion.chunk" && typeof o.choices?.[0]?.delta?.content === "string")
	.map((o) => o.choices[0].delta.content);
expect.toBe(deltas.join(""), "Hello world!");
	const fourth = JSON.parse(dataLines.find((l) => {
		try {
			const o = JSON.parse(l);
			return o && o.object === "chat.completion.chunk" && o.choices?.[0]?.finish_reason;
		} catch {
			return false;
		}
	})!);
	expect.toBe(fourth.choices[0].finish_reason, "stop");
	expect.toBe(dataLines[dataLines.length - 2], "[DONE]");
	const usageSummary = JSON.parse(dataLines[dataLines.length - 1]);
	expect.toBe(usageSummary.object, "usage.summary");
	expect.toEqual(usageSummary.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});


