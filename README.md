## Cloudflare Worker: Firebender Chat proxy (Anthropic Claude + OpenAI)

This minimal v1 service runs as a Cloudflare Worker and exposes a single OpenAI-compatible endpoint for Firebender. It routes `claude*` models to Anthropic Messages (with streaming translation) and all other models to OpenAI Chat Completions (pass-through).

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


