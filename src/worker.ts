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
		// Assign a short random request id for easy log correlation
		function headersToObject(h: Headers): Record<string, string> {
			const obj: Record<string, string> = {};
			h.forEach((value, key) => {
				obj[key] = value;
			});
			return obj;
		}
		const url = new URL(req.url);
		const requestId = Math.random().toString(36).slice(2, 10);
			const normalizedPath = url.pathname.replace(/\/{2,}/g, "/");
			const method = req.method.toUpperCase();
			console.log(`[${requestId}] ingress method=${method} path=${url.pathname} normalized=${normalizedPath}`);

			// Route detection:
			// - We implement only /v1/chat/completions (OpenAI-compatible path)
			// - We also reply to /v1/models (or /models) with a tiny discovery list
			const isChatCompletions = normalizedPath.endsWith("/chat/completions");
			const isModels = normalizedPath.endsWith("/models");

			// Optional convenience: respond to GET /v1/models or /models for simple discovery
			if (method === "GET" && isModels) {
				// We don't hard-code models; clients should supply the exact model id.
				// Returning an empty list with a hint avoids misleading the caller.
				const data: any[] = [];
				console.log(`[${requestId}] models discovery requested; returning empty list (support is dynamic by model id)`);
				const resp = jsonResponse({ object: "list", data }, 200);
				resp.headers.set("x-info", "This proxy supports any OpenAI (e.g., gpt-*) or Anthropic (e.g., claude-*) model id.");
				return resp;
			}

			// Contract endpoint
			if (!(method === "POST" && isChatCompletions)) {
				console.log(`[${requestId}] 404 not found for method=${method} path=${normalizedPath}`);
				return new Response("Not found", { status: 404 });
		}

		// Authorization placeholder (not enforced in this minimal proxy)
		// e.g., check Authorization header exists; do not enforce in v1


		// STEP 1: Parse the JSON body once.
		let body: ChatCompletionRequest;
		try {
			body = await req.json();
		} catch {
			console.log(`[${requestId}] invalid JSON body`);
			return oaiErrorEnvelope("Request body must be valid JSON", null, 400);
		}

		// STEP 2: Basic request introspection for logs
		// BEFORE: Log complete incoming request (method, URL, headers, parsed JSON body)
		try {
			const beforeLog = {
				method,
				url: req.url,
				path: normalizedPath,
				headers: headersToObject(req.headers),
				body,
			};
			console.log(`[${requestId}] BEFORE request ${JSON.stringify(beforeLog)}`);
		} catch (e) {
			console.log(`[${requestId}] BEFORE request log error`);
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

		// STEP 3: Validate core fields
		if (typeof model !== "string" || model.length === 0) {
			return oaiErrorEnvelope("Field 'model' is required", null, 400);
		}

		// Require at least one user message
		if (!Array.isArray(body.messages) || !body.messages.some((m) => m.role === "user")) {
			return oaiErrorEnvelope("Request must include at least one user message", null, 400);
		}

		// STEP 4: Decide provider by model prefix
		const isClaude = model.toLowerCase().startsWith("claude");

		if (isClaude) {
			// Anthropic route:
			// - We only support streaming for Anthropic in this minimal proxy
			if (!stream) {
				return oaiErrorEnvelope("Anthropic non-streaming is not supported in v1. Please set stream=true.", null, 400);
			}

			// STEP A: Map incoming OpenAI-style request to Anthropic Messages API
			let mapped;
			try {
				mapped = mapOAItoAnthropic(body);
			} catch (err: any) {
				return oaiErrorEnvelope(err?.message ?? "Invalid request", null, 400);
			}
			console.log(
				`[${requestId}] mapped->anthropic system=${mapped.request.system ? true : false} msgs=${mapped.request.messages.length} max_tokens=${mapped.request.max_tokens} stop=${mapped.request.stop_sequences?.length ?? 0} temp=${mapped.request.temperature ?? "n/a"} warnTools=${mapped.warnIgnoredTools}`,
			);

			// STEP B: Call Anthropic with streaming enabled
			const headers: Record<string, string> = {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"x-api-key": env.ANTHROPIC_API_KEY,
				accept: "text/event-stream",
			};
			// AFTER: Log full outbound request to Anthropic (method, URL, headers, mapped body)
			try {
				const afterAnthropic = {
					upstream: "anthropic",
					method: "POST",
					url: "https://api.anthropic.com/v1/messages",
					headers,
					body: mapped.request,
				};
				console.log(`[${requestId}] AFTER request ${JSON.stringify(afterAnthropic)}`);
			} catch (e) {
				console.log(`[${requestId}] AFTER request log error (anthropic)`);
			}

			let upstream: Response;
			try {
                console.log(`[${requestId}] mapped.request=${JSON.stringify(mapped.request)}`);
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

			// STEP C: Handle non-OK upstream response
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

			// STEP D: Translate Anthropic SSE into OpenAI-style streaming chunks
			const translated = anthropicSSEtoOAIChunks(model, upstream.body, `[${requestId}] provider=anthropic model=${model}`);

			// Prepare OpenAI-style SSE response headers
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
			// STEP E: Return the translated stream to the client
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

		// OpenAI pass-through route:
		// - We keep OpenAI schema, only normalizing a few fields (e.g., gpt-5 uses max_completion_tokens)
		let openaiReq;
		try {
			openaiReq = mapOAItoOpenAI(body);
		} catch (err: any) {
			return oaiErrorEnvelope(err?.message ?? "Invalid request", null, 400);
		}
		console.log(
			`[${requestId}] mapped->openai msgs=${openaiReq.messages.length} max=${openaiReq.max_tokens ?? (openaiReq as any).max_completion_tokens ?? "n/a"} stop=${openaiReq.stop?.length ?? 0} tools=${openaiReq.tools ? openaiReq.tools.length : 0} stream=${openaiReq.stream}`,
		);

		// STEP F: Call OpenAI with either streaming or non-stream JSON
		const oaiHeaders: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${env.OPENAI_API_KEY}`,
		};
		// AFTER: Log full outbound request to OpenAI (method, URL, headers, mapped body)
		try {
			const afterOpenAI = {
				upstream: "openai",
				method: "POST",
				url: "https://api.openai.com/v1/chat/completions",
				headers: oaiHeaders,
				body: openaiReq,
			};
			console.log(`[${requestId}] AFTER request ${JSON.stringify(afterOpenAI)}`);
		} catch (e) {
			console.log(`[${requestId}] AFTER request log error (openai)`);
		}

		if (openaiReq.stream) {
			// Streaming passthrough
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
				console.log(`[${requestId}] openaiReq=${JSON.stringify(openaiReq)}`);
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
			// We return the JSON exactly as received so client sees OpenAI-standard response
			const json = await upstream.text();
			console.log(`[${requestId}] upstream<-openai json_len=${json.length}`);
			return new Response(json, { status: 200, headers: { "content-type": "application/json" } });
		}
	},
};


