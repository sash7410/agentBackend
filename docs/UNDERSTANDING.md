## What this service does (in plain English)

- You send a request that looks like an OpenAI chat request (the common JSON shape used by many clients).
- The service looks at the `model` name to decide which AI company to call:
  - If it starts with `claude`, we call Anthropic.
  - Otherwise, we call OpenAI.
- If we call Anthropic, we translate your OpenAI-shaped request into the shape Anthropic expects, then we translate the streaming response back into OpenAI-style streaming so your client code can stay the same.
- If we call OpenAI, we mostly pass your request through as-is.

The big idea: Your app only speaks one language (OpenAI’s), and this service acts as an interpreter when talking to different providers.


## Key concepts (for newcomers)

- HTTP endpoint: Your app sends JSON to `/v1/chat/completions`. We reply with either a streaming response (Server-Sent Events, SSE) or a regular JSON response.
- Streaming (SSE): Instead of waiting for the entire AI answer, we send little pieces (“chunks”) as they’re ready. This improves responsiveness.
- Mapping: Different providers name fields differently. For example, OpenAI uses `max_tokens` (older models) or `max_completion_tokens` (newer models like `gpt-5`), while Anthropic uses `max_tokens` but their request structure is different. We translate between these shapes.
- System messages: OpenAI allows `system` messages inside the `messages` array. Anthropic prefers a top-level `system` field instead. We extract and place it correctly.
- Tools: In this minimal v1, we ignore tools for Anthropic (but warn you via an HTTP header). We pass tools through to OpenAI as-is.


## High-level flow

1) Your client sends an OpenAI-style request to `/v1/chat/completions`.
2) We parse JSON and validate it (must have `model`, must include at least one `user` message).
3) If `model` starts with `claude`:
   - Convert your OpenAI-like request into Anthropic’s expected shape.
   - Call Anthropic with streaming.
   - Convert their streaming events to OpenAI-style streaming chunks.
   - Return the stream to your client.
4) Otherwise (OpenAI model):
   - Keep the request in OpenAI shape.
   - Special case for `gpt-5`: use `max_completion_tokens` instead of `max_tokens`.
   - Call OpenAI (streaming or non-stream, as requested).
   - Return the response (stream or JSON) directly to your client.


## Why `gpt-5` needed a change

OpenAI’s newer models (`gpt-5`) reject `max_tokens` and require `max_completion_tokens`. We detect `gpt-5` and switch to the new field so upstream doesn’t error. This is invisible to your client—you can still send `max_tokens`, and we translate.


## Error handling (simplified)

- If the request JSON is invalid, we return a 400 with an OpenAI-like error envelope.
- If the upstream provider fails or rejects the request, we wrap it in a 502 with a helpful message (and upstream status).


## Where the important code lives

- `src/worker.ts`: The “server” (Cloudflare Worker) that receives requests, validates, decides which provider to call, and returns the result.
- `src/schema-mapper.ts`: The translation layer that reshapes your input for Anthropic or OpenAI, and translates Anthropic streaming into OpenAI-style chunks.


## A gentle walkthrough of the code

- In `worker.ts`:
  - We log a short `requestId` so you can trace all logs for a single request.
  - We accept only `POST /v1/chat/completions` and a small `GET /v1/models` for discovery.
  - We parse JSON once, validate basics, and count how many messages by role for helpful logs.
  - If the model starts with `claude`:
    - We require streaming (simplifies the minimal proxy).
    - We map your request using `mapOAItoAnthropic`, then call Anthropic.
    - If Anthropic says “OK” and sends a stream, we convert it to OpenAI-style streaming using `anthropicSSEtoOAIChunks` and return it.
  - Else (OpenAI):
    - We map your request using `mapOAItoOpenAI` (this handles the `gpt-5` field name change).
    - We call OpenAI with stream or non-stream and pass the response back.

- In `schema-mapper.ts`:
  - `mapOAItoOpenAI`:
    - Normalizes content to plain text.
    - Ensures there’s a `system` rule at the start if you provided `system` but didn’t include a system message.
    - For `gpt-5`, uses `max_completion_tokens`; otherwise uses `max_tokens`.
  - `mapOAItoAnthropic`:
    - Extracts a `system` string into Anthropic’s top-level `system` field.
    - Removes `system` and `tool` messages from the message list (only user/assistant stay).
    - Selects a sensible `max_tokens` and sets `stream=true` by default.
    - Returns a `warnIgnoredTools` flag so the Worker can add a response header warning.
  - `anthropicSSEtoOAIChunks`:
    - Reads Anthropic’s event stream, emits an initial “assistant role” chunk, then text deltas as chunks, and finally emits a finish chunk and “[DONE]” so it looks like OpenAI streaming to your client.


## Mental model (non-coder friendly)

Think of this service like a multilingual translator on a phone call:

- You speak “OpenAI”. The translator listens and understands it.
- If the other person only speaks “Anthropic”, the translator rephrases your words so Anthropic understands.
- When Anthropic replies (in their own style), the translator converts it back into OpenAI-sounding words, so you don’t notice a difference.
- If you talk to OpenAI, the translator mostly just repeats your words with tiny adjustments for dialect changes (like `max_completion_tokens`).

You don’t have to learn both languages—just keep speaking OpenAI. The translator takes care of the rest.


## Practical tips when testing

- Use the curl examples in `tests/curl-examples.sh`.
- Watch the logs: we add a `requestId` to every log line so you can follow a request from start to finish.
- If you see a 400/502, read the log lines near it—there’s usually a specific hint (like “unsupported parameter”).



