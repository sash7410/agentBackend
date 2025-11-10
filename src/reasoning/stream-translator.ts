// StreamTranslator: consumes OpenAI Responses SSE and emits legacy OpenAI chat.completion.chunk SSE

type LegacyChunk = {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: { role?: "assistant"; content?: string };
		finish_reason: "stop" | "length" | null;
	}>;
};

function generateChunkId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 10);
	return `chatcmpl_${ts}${rand}`;
}

function chunkEnvelope(model: string, id: string, created: number, delta?: { role?: "assistant"; content?: string }, finish?: "stop" | "length" | null): LegacyChunk {
	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [
			{
				index: 0,
				delta: delta ?? {},
				finish_reason: finish ?? null,
			},
		],
	};
}

type SSEEvent = {
	event: string;
	data: any;
};

function parseSSELines(frame: string): SSEEvent[] {
	const events: SSEEvent[] = [];
	let eventName: string | null = null;
	let dataLines: string[] = [];
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith("event:")) {
			eventName = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trim());
		} else if (line.trim() === "") {
			if (eventName) {
				const dataStr = dataLines.join("\n");
				let data: any = null;
				try {
					data = dataStr ? JSON.parse(dataStr) : null;
				} catch {
					data = null;
				}
				events.push({ event: eventName, data });
				// reset for potential next event within same frame
				eventName = null;
				dataLines = [];
			}
		}
	}
	return events;
}

export type UsageTotals = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
};

export function responsesSSEToLegacyChunks(model: string, upstream: ReadableStream<Uint8Array>, logPrefix?: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const id = generateChunkId();
	const created = Math.floor(Date.now() / 1000);
	let sentRole = false;
	let finished = false;
	let buffer = "";
	let accTextLen = 0;
	let usage: UsageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

	function encodeDataLine(objOrString: any): Uint8Array {
		if (typeof objOrString === "string") return encoder.encode(`data: ${objOrString}\n\n`);
		return encoder.encode(`data: ${JSON.stringify(objOrString)}\n\n`);
	}

	function pushAssistantRoleIfNeeded(controller: ReadableStreamDefaultController<Uint8Array>) {
		if (!sentRole) {
			sentRole = true;
			controller.enqueue(encodeDataLine(chunkEnvelope(model, id, created, { role: "assistant" }, null)));
		}
	}

	function emitDone(controller: ReadableStreamDefaultController<Uint8Array>) {
		if (finished) return;
		finished = true;
		controller.enqueue(encodeDataLine("[DONE]"));
		// Emit trailing usage summary line so client can pick totals, per spec
		controller.enqueue(encodeDataLine({ object: "usage.summary", usage }));
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const reader = upstream.getReader();

			function handleFrame(frame: string) {
				const events = parseSSELines(frame + "\n\n");
				for (const e of events) {
					if (logPrefix) {
						try {
							console.log(`${logPrefix} responses.sse event=${e.event}`);
						} catch {
							// ignore
						}
					}
					// Text deltas
					if (e.event === "response.output_text.delta") {
						const deltaText = e.data?.delta ?? "";
						if (typeof deltaText === "string" && deltaText.length > 0) {
							pushAssistantRoleIfNeeded(controller);
							accTextLen += deltaText.length;
							controller.enqueue(encodeDataLine(chunkEnvelope(model, id, created, { content: deltaText }, null)));
						}
					}
					// Finish signal
					else if (e.event === "response.completed") {
						// Usage update (if provided on completion)
						const u = e.data?.usage ?? e.data?.response?.usage ?? null;
						if (u && typeof u.total_tokens === "number") {
							usage = {
								prompt_tokens: Number(u.prompt_tokens ?? usage.prompt_tokens ?? 0),
								completion_tokens: Number(u.completion_tokens ?? usage.completion_tokens ?? 0),
								total_tokens: Number(u.total_tokens ?? 0),
							};
						}
						const stopReason = e.data?.finish_reason;
						let finish: "stop" | "length" | null = null;
						if (stopReason === "stop") finish = "stop";
						else if (stopReason === "length" || stopReason === "max_output_tokens") finish = "length";
						controller.enqueue(encodeDataLine(chunkEnvelope(model, id, created, {}, finish)));
					}
					// Usage updates
					else if (e.event === "rate_limits.updated") {
						const u = e.data?.usage ?? e.data?.response?.usage ?? null;
						if (u && typeof u.total_tokens === "number") {
							usage = {
								prompt_tokens: Number(u.prompt_tokens ?? usage.prompt_tokens ?? 0),
								completion_tokens: Number(u.completion_tokens ?? usage.completion_tokens ?? 0),
								total_tokens: Number(u.total_tokens ?? 0),
							};
						}
					}
					// Ignore tool call events for text emission; they are handled by the service
				}
			}

			reader.read().then(function pump(res): any {
				if (res.done) {
					try {
						emitDone(controller);
						controller.close();
					} catch {
						// ignore
					}
					return;
				}
				try {
					buffer += decoder.decode(res.value, { stream: true });
					let idx;
					while ((idx = buffer.indexOf("\n\n")) >= 0) {
						const frame = buffer.slice(0, idx);
						buffer = buffer.slice(idx + 2);
						handleFrame(frame);
					}
				} catch {
					// ignore decoding errors
				}
				return reader.read().then(pump);
			}).catch(() => {
				try {
					emitDone(controller);
					controller.close();
				} catch {
					// ignore
				}
			});
		},
		cancel() {
			// no-op
		},
	});
}


