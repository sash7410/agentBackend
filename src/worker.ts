import { mapOAItoAnthropic, mapOAItoOpenAI, anthropicSSEtoOAIChunks, ChatCompletionRequest } from "./schema-mapper";

export interface Env {
	ANTHROPIC_API_KEY: string;
	OPENAI_API_KEY: string;
}

type WorkerExecutionContext = {
	waitUntil(promise: Promise<any>): void;
};

function jsonResponse(obj: any, status = 200): Response {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function oaiErrorEnvelope(message: string, code: string | number | null = null, status = 400): Response {
	return jsonResponse(
		{
			error: {
				message,
				type: status >= 500 ? "server_error" : "invalid_request_error",
				param: null,
				code,
			},
		},
		status,
	);
}

export default {
	async fetch(req: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
		const url = new URL(req.url);
		const requestId = Math.random().toString(36).slice(2, 10);
			const normalizedPath = url.pathname.replace(/\/{2,}/g, "/");
			const method = req.method.toUpperCase();
			console.log(`[${requestId}] ingress method=${method} path=${url.pathname} normalized=${normalizedPath}`);

			// Minimal compatibility: accept paths that end with /chat/completions (with or without /v1 prefix)
			const isChatCompletions = normalizedPath.endsWith("/chat/completions");
			const isModels = normalizedPath.endsWith("/models");

			// Optional convenience: respond to GET /v1/models or /models for simple discovery
			if (method === "GET" && isModels) {
				const data = [
					{ id: "claude-3-5-sonnet-20241022", object: "model" },
					{ id: "gpt-4o-mini", object: "model" },
				];
				return jsonResponse({ object: "list", data }, 200);
			}

			// Contract endpoint
			if (!(method === "POST" && isChatCompletions)) {
				return new Response("Not found", { status: 404 });
		}

		// Trivial authorization placeholder (replace later as needed)
		// e.g., check Authorization header exists; do not enforce in v1


		let body: ChatCompletionRequest;
		try {
			body = await req.json();
		} catch {
			return oaiErrorEnvelope("Request body must be valid JSON", null, 400);
		}

		const model = body?.model ?? "";
		const stream = body?.stream === null || body?.stream === undefined ? true : Boolean(body?.stream);
		const userVars = body?.user_variables ? Object.keys(body.user_variables).length : 0;
		const roles = Array.isArray(body.messages) ? body.messages.reduce<Record<string, number>>((acc, m) => {
			acc[m.role] = (acc[m.role] ?? 0) + 1;
			return acc;
		}, {}) : {};
		console.log(
			`[${requestId}] incoming model=${model} stream=${stream} roles=${JSON.stringify(roles)} uv_keys=${userVars}`,
		);

		if (typeof model !== "string" || model.length === 0) {
			return oaiErrorEnvelope("Field 'model' is required", null, 400);
		}

		// Validate messages contain at least one user message
		if (!Array.isArray(body.messages) || !body.messages.some((m) => m.role === "user")) {
			return oaiErrorEnvelope("Request must include at least one user message", null, 400);
		}

		const isClaude = model.toLowerCase().startsWith("claude");

		if (isClaude) {
			// Anthropic route
			// Non-stream mode for Anthropic is not supported in v1 per spec
			if (!stream) {
				return oaiErrorEnvelope("Anthropic non-streaming is not supported in v1. Please set stream=true.", null, 400);
			}

			let mapped;
			try {
				mapped = mapOAItoAnthropic(body);
			} catch (err: any) {
				return oaiErrorEnvelope(err?.message ?? "Invalid request", null, 400);
			}
			console.log(
				`[${requestId}] mapped->anthropic system=${mapped.request.system ? true : false} msgs=${mapped.request.messages.length} max_tokens=${mapped.request.max_tokens} stop=${mapped.request.stop_sequences?.length ?? 0} temp=${mapped.request.temperature ?? "n/a"} warnTools=${mapped.warnIgnoredTools}`,
			);

			const headers: Record<string, string> = {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"x-api-key": env.ANTHROPIC_API_KEY,
				accept: "text/event-stream",
			};

			let upstream: Response;
			try {
				console.log(`[${requestId}] upstream->anthropic POST /v1/messages stream=true`);
				upstream = await fetch("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers,
					body: JSON.stringify(mapped.request),
				});
			} catch (e: any) {
				console.log(`[${requestId}] upstream fetch error provider=anthropic model=${model}`);
				return oaiErrorEnvelope("Upstream request failed to start", 502, 502);
			}

			if (!upstream.ok || !upstream.body) {
				const text = await upstream.text().catch(() => "");
				console.log(
					`[${requestId}] upstream non-ok provider=anthropic status=${upstream.status} model=${model} body_len=${text.length}`,
				);
				return oaiErrorEnvelope(
					`Upstream error (${upstream.status}). ${text || "Anthropic did not provide additional details."}`,
					upstream.status,
					502,
				);
			}

			// Translate SSE stream to OpenAI-style chunks
			const translated = anthropicSSEtoOAIChunks(model, upstream.body, `[${requestId}] provider=anthropic model=${model}`);

			const sseHeaders = new Headers();
			sseHeaders.set("content-type", "text/event-stream; charset=utf-8");
			sseHeaders.set("cache-control", "no-cache, no-transform");
			sseHeaders.set("connection", "keep-alive");
			if (mapped.warnIgnoredTools) {
				sseHeaders.set("x-warn-ignored-tools", "true");
			}

			{
				const hdrObj: Record<string, string> = {};
				sseHeaders.forEach((value, key) => {
					hdrObj[key] = value;
				});
				console.log(
					`[${requestId}] streaming start provider=anthropic model=${model} hdrs=${JSON.stringify(hdrObj)}`,
				);
			}
			const response = new Response(translated, {
				status: 200,
				headers: sseHeaders,
			});
			// Keep the worker alive while streaming; midstream errors are tolerated by clients
			ctx.waitUntil(
				(upstream.body as any)?.cancel?.().catch(() => {
					// ignore
				}),
			);
			return response;
		}

		// OpenAI pass-through route
		let openaiReq;
		try {
			openaiReq = mapOAItoOpenAI(body);
		} catch (err: any) {
			return oaiErrorEnvelope(err?.message ?? "Invalid request", null, 400);
		}
		console.log(
			`[${requestId}] mapped->openai msgs=${openaiReq.messages.length} max_tokens=${openaiReq.max_tokens ?? "n/a"} stop=${openaiReq.stop?.length ?? 0} tools=${openaiReq.tools ? openaiReq.tools.length : 0} stream=${openaiReq.stream}`,
		);

		const oaiHeaders: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${env.OPENAI_API_KEY}`,
		};

		if (openaiReq.stream) {
			let upstream: Response;
			try {
				console.log(`[${requestId}] upstream->openai POST /v1/chat/completions stream=true`);
				upstream = await fetch("https://api.openai.com/v1/chat/completions", {
					method: "POST",
					headers: oaiHeaders,
					body: JSON.stringify(openaiReq),
				});
			} catch (e: any) {
				console.log(`[${requestId}] upstream fetch error provider=openai model=${model}`);
				return oaiErrorEnvelope("Upstream request failed to start", 502, 502);
			}
			if (!upstream.ok || !upstream.body) {
				const text = await upstream.text().catch(() => "");
				console.log(
					`[${requestId}] upstream non-ok provider=openai status=${upstream.status} model=${model} body_len=${text.length}`,
				);
				return oaiErrorEnvelope(
					`Upstream error (${upstream.status}). ${text || "OpenAI did not provide additional details."}`,
					upstream.status,
					502,
				);
			}
			const sseHeaders = new Headers();
			sseHeaders.set("content-type", "text/event-stream; charset=utf-8");
			sseHeaders.set("cache-control", "no-cache, no-transform");
			sseHeaders.set("connection", "keep-alive");
			{
				const hdrObj: Record<string, string> = {};
				sseHeaders.forEach((value, key) => {
					hdrObj[key] = value;
				});
				console.log(
					`[${requestId}] streaming start provider=openai model=${model} hdrs=${JSON.stringify(hdrObj)}`,
				);
			}
			return new Response(upstream.body, { status: 200, headers: sseHeaders });
		} else {
			// Non-streaming JSON
			let upstream: Response;
			try {
				console.log(`[${requestId}] upstream->openai POST /v1/chat/completions stream=false`);
				upstream = await fetch("https://api.openai.com/v1/chat/completions", {
					method: "POST",
					headers: oaiHeaders,
					body: JSON.stringify(openaiReq),
				});
			} catch (e: any) {
				console.log(`[${requestId}] upstream fetch error provider=openai model=${model}`);
				return oaiErrorEnvelope("Upstream request failed to start", 502, 502);
			}
			if (!upstream.ok) {
				const text = await upstream.text().catch(() => "");
				console.log(
					`[${requestId}] upstream non-ok provider=openai status=${upstream.status} model=${model} body_len=${text.length}`,
				);
				return oaiErrorEnvelope(
					`Upstream error (${upstream.status}). ${text || "OpenAI did not provide additional details."}`,
					upstream.status,
					502,
				);
			}
			const json = await upstream.text();
			console.log(`[${requestId}] upstream<-openai json_len=${json.length}`);
			return new Response(json, { status: 200, headers: { "content-type": "application/json" } });
		}
	},
};


