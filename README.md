## Cloudflare Worker: Firebender Chat proxy (Anthropic Claude + OpenAI)

This minimal v1 service runs as a Cloudflare Worker and exposes a single OpenAI-compatible endpoint for Firebender. It routes `claude*` models to Anthropic Messages (with streaming translation) and all other models to OpenAI Chat Completions (pass-through).

### Reasoning Gateway (OpenAI Responses) - optional
- Disabled by default. Enable with environment variables:
  - `ENABLE_REASONING=true`
  - `REASONING_MODELS=o4*,o3*,gpt-4.1*` (comma-separated list; `*` means prefix match)
- Routing rule: if enabled and either `reasoning_effort` is present on the request OR `model` matches `REASONING_MODELS`, the request is handled by the Reasoning gateway using OpenAI Responses.
- Input contract: the same Chat Completions JSON you already use (no client change). Extra optional fields honored if present: `max_completion_tokens`, `reasoning_effort`, `system`, `tools`, `tool_choice`, `top_p`.
- Mapping to Responses:
  - `messages` → `input[]` with typed parts: user as `{type:"input_text"}`, assistant as `{type:"text"}`.
  - `system` → `instructions`.
  - `temperature`, `top_p` → forwarded.
  - `max_output_tokens` picked from `max_completion_tokens` then `max_tokens`.
  - `stop` → forwarded.
  - `tools` and `tool_choice` forwarded using function tool shape and JSON Schema as provided.
  - `reasoning_effort` → `reasoning.effort`.
  - `stream` → forwarded.
- Streaming contract:
  - Server emits legacy OpenAI chat-completion chunk SSE frames with incremental `choices[0].delta.content`.
  - Non-text events (e.g., tool calls) are not emitted as text.
  - Stream ends with a final chunk (with `finish_reason`) followed by `data: [DONE]`.
  - A trailing `data: {"object":"usage.summary","usage":{...}}` line is sent with usage totals.
- Non-stream contract:
  - Returns a single OpenAI-style chat completion JSON with `choices[0].message.content`, `finish_reason`, and `usage`.
- Tool turns:
  - Non-stream: executes tools server-side and issues follow-up `responses.create` with `previous_response_id` and a single `function_call_output` item; repeats until the assistant returns final text or a cap on rounds is reached.
  - Streaming: non-text tool events are ignored by the text translator; tool orchestration occurs server-side (non-text) when applicable.
- Errors:
  - 400 invalid request, 401/403 auth, 408 upstream timeout, 429 rate limit, 5xx provider/network. Streaming errors are sent as an SSE `event: error` with JSON message then the stream closes.
- Observability:
  - Logs include inbound request id, selected route, upstream response id where available, tool rounds, token usage, latency, and finish reason. Message content is not logged.

### Features
- Single endpoint: `/v1/chat/completions` (POST)
- Accepts Firebender’s OpenAI-shaped request (see Interface below)
- Routes models starting with `claude` to Anthropic; others to OpenAI
- Anthropic: maps to Messages API; streaming translated to OpenAI chunks (`data: {...}\n\n`), then `data: [DONE]\n\n`
- OpenAI: pass-through (streaming or non-streaming) with token field normalization
- Clamps temperature (0–2) and max_tokens (1–8192); validates at least one user message
- Ignores `tools` for Anthropic and sets `x-warn-ignored-tools: true`; forwards tools to OpenAI
- No third-party runtime dependencies; uses `fetch` and Web Streams API

### Repository Layout
- `src/worker.ts` - Entry point, routing, upstream calls, streaming
- `src/schema-mapper.ts` - `mapOAItoAnthropic`, `mapOAItoOpenAI`, `anthropicSSEtoOAIChunks`
- `tests/schema-mapper.test.ts` - Unit tests for mapping and streaming
- `wrangler.toml` - Configuration (set secrets via Wrangler)

### Requirements
- Node 18+ (for running tests)
- Cloudflare Wrangler

### Local Development
1. Install dev tools:
   ```bash
   npm install
   ```

2. Create `.dev.vars` with your secrets (root of repo):
   ```bash
   cat > .dev.vars << 'EOF'
   ANTHROPIC_API_KEY=your_anthropic_key
   OPENAI_API_KEY=your_openai_key
   EOF
   ```

3. Run the worker locally:
   ```bash
   npm run dev
   ```
   Wrangler serves on `http://localhost:8787`. The endpoint is `http://localhost:8787/v1/chat/completions`.

4. Test with curl (streams):
   ```bash
   curl -N http://localhost:8787/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{
       "model": "claude-3-5-sonnet-20241022",
       "messages": [
         { "role": "system", "content": "You are concise" },
         { "role": "user", "content": "Say hello" }
       ],
      "temperature": 0.2,
       "max_tokens": 256,
       "stream": true
     }'
   ```

5. Test OpenAI pass-through (non-claude, non-streaming):
   ```bash
   curl http://localhost:8787/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{
       "model": "gpt-4o-mini",
       "messages": [{ "role": "user", "content": "Say hello" }],
       "max_tokens": 64,
       "stream": false
     }'
   ```

### Error Envelope
When upstream fails to start or errors occur before streaming, responses follow OpenAI’s error envelope:
```json
{
  "error": {
    "message": "Upstream error (502). ...",
    "type": "server_error",
    "param": null,
    "code": 502
  }
}
```

### Testing
Run the unit tests (no Wrangler needed):
```bash
npm test
```
The tests validate:
- System extraction precedence (explicit `system` wins over first system role message)
- User/assistant order is preserved
- Temperature and token clamps
- Stop sequences mapped to `stop_sequences` for Anthropic
- Tools ignored without crash and a warning flag is set (header is added at runtime)
- SSE translation emits: assistant role announcement, text deltas, final chunk with `finish_reason`, and `[DONE]`
- OpenAI pass-through selects `max_tokens` correctly and forwards `stop`

### Testing with curl
You can run ready-to-use curl tests:
```bash
bash tests/curl-examples.sh
```
This covers:
- Anthropic streaming
- Anthropic streaming with `tools` (ignored) and header `x-warn-ignored-tools: true`
- Anthropic non-streaming (400 in v1)
- OpenAI streaming pass-through
- OpenAI non-stream JSON

### Deployment
1. Set your secrets in Cloudflare:
   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put OPENAI_API_KEY
   ```
2. Deploy:
   ```bash
   npm run deploy
   ```

### Operational Notes
- Logs include a request id and model; secrets and full prompts are not logged.
- The service always attempts to stream.

### Scope Notes
- Tools, images, audio, structured outputs, function calling, caching are out of scope for v1.


