import { normalizeError, sseErrorFrame } from "../error-normalizer";

function generateOpenAIChunkId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 10);
	return `chatcmpl_${ts}${rand}`;
}

function openAIChunkEnvelope(args: {
	id: string;
	created: number;
	model: string;
	delta?: { role?: "assistant"; content?: string };
	finish_reason?: "stop" | "length" | null;
	index?: number;
}) {
	const { id, created, model, delta, finish_reason, index = 0 } = args;
	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [
			{
				index,
				delta: delta ?? {},
				finish_reason: finish_reason ?? null,
			},
		],
	};
}

type SSEEvent = {
	event: string;
	data: any;
};

function parseSSELines(text: string): SSEEvent[] {
	const events: SSEEvent[] = [];
	let currentEvent: string | null = null;
	let currentData: string[] = [];
	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		if (line.startsWith("event:")) {
			currentEvent = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			currentData.push(line.slice(5).trim());
		} else if (line.trim() === "") {
			if (currentEvent) {
				const dataStr = currentData.join("\n");
				try {
					const dataJson = dataStr ? JSON.parse(dataStr) : null;
					events.push({ event: currentEvent, data: dataJson });
				} catch {
					events.push({ event: currentEvent, data: null });
				}
			}
			currentEvent = null;
			currentData = [];
		}
	}
	return events;
}

export function anthropicSSEtoOAIChunks(
	model: string,
	downStreamResponse: ReadableStream<Uint8Array>,
	debugPrefix?: string,
	debugEvents?: boolean,
	debugVerbose?: boolean,
	downstream?: "openai" | "anthropic",
): ReadableStream<Uint8Array> {
	const id = generateOpenAIChunkId();
	const created = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	let buffered = "";
	let sentRole = false;
	let finished = false;
	let eventCount = 0;

	function encodeDataLine(objOrString: any): Uint8Array {
		if (typeof objOrString === "string") {
			return encoder.encode(`data: ${objOrString}\n\n`);
		}
		return encoder.encode(`data: ${JSON.stringify(objOrString)}\n\n`);
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const reader = downStreamResponse.getReader();

			function redactAnthropicData(input: any): any {
				try {
					if (input === null || input === undefined) return input;
					if (typeof input === "string") {
						return "";
					}
					if (Array.isArray(input)) {
						return input.map((v) => redactAnthropicData(v));
					}
					if (typeof input === "object") {
						const out: Record<string, any> = {};
						for (const key of Object.keys(input)) {
							const val = (input as any)[key];
							if (typeof val === "string") {
								const lower = key.toLowerCase();
								if (lower === "thinking" || lower === "text" || lower === "signature") {
									out[`${key}_len`] = val.length;
									out[key] = "";
								} else {
									out[key] = "";
								}
							} else if (val && typeof val === "object") {
								out[key] = redactAnthropicData(val);
							} else {
								out[key] = val;
							}
						}
						return out;
					}
					return input;
				} catch {
					return { _redaction: "failed" };
				}
			}

			function pushAssistantRoleIfNeeded() {
				if (!sentRole) {
					if (debugPrefix) {
						console.log(`${debugPrefix} translator: emit role=assistant`);
					}
					const first = openAIChunkEnvelope({
						id,
						created,
						model,
						delta: { role: "assistant" },
						finish_reason: null,
					});
					controller.enqueue(encodeDataLine(first));
					sentRole = true;
				}
			}

			function emitDone() {
				if (!finished) {
					if (debugPrefix) {
						console.log(`${debugPrefix} translator: emit [DONE]`);
					}
					controller.enqueue(encodeDataLine("[DONE]"));
					finished = true;
				}
			}

			function processText(text: string) {
				buffered += text;
				const segments = buffered.split("\n\n");
				buffered = segments.pop() ?? "";
				for (const seg of segments) {
					const events = parseSSELines(seg + "\n\n");
					for (const e of events) {
						eventCount++;
						if (debugEvents) {
							try {
								const dataForLog = debugVerbose ? e.data : redactAnthropicData(e.data);
								if (debugPrefix) console.log(`${debugPrefix} event: ${e.event}`);
								console.log(`event: ${e.event}`);
								console.log(`data: ${JSON.stringify(dataForLog)}`);
								console.log("");
							} catch {
								// ignore
							}
						}
						if (e.event === "message_start") {
							if (debugPrefix) {
								console.log(`${debugPrefix} translator: event#${eventCount} message_start`);
							}
							pushAssistantRoleIfNeeded();
						} else if (e.event === "content_block_delta") {
							pushAssistantRoleIfNeeded();
							if (debugPrefix) {
								try {
									const deltaType = (e as any)?.data?.delta?.type || (e as any)?.data?.type;
									if (deltaType && deltaType !== "text") {
										console.log(`${debugPrefix} translator: event#${eventCount} non-text delta type=${deltaType}`);
									}
								} catch {}
							}
							const textDelta = e.data?.delta?.text ?? "";
							if (debugPrefix) {
								console.log(`${debugPrefix} translator: event#${eventCount} text_delta len=${(textDelta || "").length}`);
							}
							if (textDelta) {
								const chunk = openAIChunkEnvelope({
									id,
									created,
									model,
									delta: { content: textDelta },
									finish_reason: null,
								});
								controller.enqueue(encodeDataLine(chunk));
							}
						} else if (e.event === "message_delta") {
							const stopReason: string | undefined = e.data?.delta?.stop_reason ?? e.data?.stop_reason;
							if (debugPrefix) {
								console.log(`${debugPrefix} translator: event#${eventCount} message_delta stop_reason=${stopReason}`);
							}
							if (stopReason === "end_turn" || stopReason === "max_tokens") {
								const finish_reason = stopReason === "end_turn" ? "stop" : "length";
								const finalChunk = openAIChunkEnvelope({
									id,
									created,
									model,
									delta: {},
									finish_reason,
								});
								controller.enqueue(encodeDataLine(finalChunk));
							}
						} else if (e.event === "message_stop") {
							if (debugPrefix) {
								console.log(`${debugPrefix} translator: event#${eventCount} message_stop`);
							}
						}
					}
				}
			}

			reader.read().then(function handle(result): any {
				if (result.done) {
					try {
						emitDone();
						controller.close();
					} catch {}
					return;
				}
				try {
					const chunkText = decoder.decode(result.value, { stream: true });
					if (debugPrefix) {
						console.log(`${debugPrefix} translator: received downStreamResponse bytes=${result.value?.length ?? 0}`);
					}
					processText(chunkText);
				} catch {}
				return reader.read().then(handle);
			}).catch(() => {
				try {
					const norm = normalizeError({
						downstream: downstream || "anthropic",
						downstreamStatus: 502,
						downstreamBody: "stream terminated",
					});
					controller.enqueue(encoder.encode(sseErrorFrame(norm.body)));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					finished = true;
					controller.close();
				} catch {}
			});
		},
		cancel() {
			// no-op
		},
	});
}

export function responsesSSEtoOAIChunks(
	model: string,
	downStreamResponse: ReadableStream<Uint8Array>,
	debugPrefix?: string,
	downstream?: "openai" | "anthropic",
): ReadableStream<Uint8Array> {
	const id = generateOpenAIChunkId();
	const created = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	let buffered = "";
	let sentRole = false;
	let finished = false;
	let eventCount = 0;

	function encodeDataLine(objOrString: any): Uint8Array {
		if (typeof objOrString === "string") {
			return encoder.encode(`data: ${objOrString}\n\n`);
		}
		return encoder.encode(`data: ${JSON.stringify(objOrString)}\n\n`);
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const reader = downStreamResponse.getReader();

			function pushAssistantRoleIfNeeded() {
				if (!sentRole) {
					if (debugPrefix) {
						console.log(`${debugPrefix} resp-translator: emit role=assistant`);
					}
					const first = openAIChunkEnvelope({
						id,
						created,
						model,
						delta: { role: "assistant" },
						finish_reason: null,
					});
					controller.enqueue(encodeDataLine(first));
					sentRole = true;
				}
			}

			function emitFinish(reason: "stop" | "length") {
				if (finished) return;
				const finalChunk = openAIChunkEnvelope({
					id,
					created,
					model,
					delta: {},
					finish_reason: reason,
				});
				controller.enqueue(encodeDataLine(finalChunk));
			}

			function emitDone() {
				if (!finished) {
					if (debugPrefix) {
						console.log(`${debugPrefix} resp-translator: emit [DONE]`);
					}
					controller.enqueue(encodeDataLine("[DONE]"));
					finished = true;
				}
			}

			function processText(text: string) {
				buffered += text;
				const segments = buffered.split("\n\n");
				buffered = segments.pop() ?? "";
				for (const seg of segments) {
					const events = parseSSELines(seg + "\n\n");
					for (const e of events) {
						eventCount++;
						const ev = e.event || "";
						const data = e.data || {};
						if (debugPrefix) {
							console.log(`${debugPrefix} resp-translator: event#${eventCount} ${ev}`);
						}
						if (ev.includes("output_text.delta") || typeof data?.delta === "string") {
							const textDelta: string = typeof data?.delta === "string" ? data.delta : "";
							if (textDelta) {
								pushAssistantRoleIfNeeded();
								const chunk = openAIChunkEnvelope({
									id,
									created,
									model,
									delta: { content: textDelta },
									finish_reason: null,
								});
								controller.enqueue(encodeDataLine(chunk));
							}
							continue;
						}
						if (ev.includes("response.completed")) {
							pushAssistantRoleIfNeeded();
							emitFinish("stop");
							continue;
						}
						if (ev.includes("response.incomplete")) {
							pushAssistantRoleIfNeeded();
							const reason = (data?.reason || "").toString();
							emitFinish(reason === "max_output_tokens" ? "length" : "stop");
							continue;
						}
					}
				}
			}

			reader.read().then(function handle(result): any {
				if (result.done) {
					try {
						emitDone();
						controller.close();
					} catch {}
					return;
				}
				try {
					const chunkText = decoder.decode(result.value, { stream: true });
					if (debugPrefix) {
						console.log(`${debugPrefix} resp-translator: received downStreamResponse bytes=${result.value?.length ?? 0}`);
					}
					processText(chunkText);
				} catch {}
				return reader.read().then(handle);
			}).catch(() => {
				try {
					const norm = normalizeError({
						downstream: downstream || "openai",
						downstreamStatus: 502,
						downstreamBody: "stream terminated",
					});
					controller.enqueue(encoder.encode(sseErrorFrame(norm.body)));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					finished = true;
					controller.close();
				} catch {}
			});
		},
		cancel() {
			// no-op
		},
	});
}


