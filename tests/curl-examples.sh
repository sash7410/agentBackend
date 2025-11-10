#!/usr/bin/env bash
set -euo pipefail

# Endpoint for local dev
URL="${URL:-http://localhost:8787/v1/chat/completions}"

echo "== Anthropic (Claude) streaming =="
curl -sS -N -i "$URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      { "role": "system", "content": "You are concise" },
      { "role": "user", "content": "Say hello" }
    ],
    "temperature": 0.2,
    "max_tokens": 128,
    "stream": true
  }'
echo -e "\n"

echo "== Anthropic (Claude) streaming with tools present (ignored, expect x-warn-ignored-tools header) =="
curl -sS -N -i "$URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      { "role": "user", "content": "Say hello" }
    ],
    "tools": [
      { "type": "function", "function": { "name": "noop", "parameters": { "type": "object" } } }
    ],
    "stream": true
  }'
echo -e "\n"

echo "== Anthropic (Claude) non-streaming (expect 400 as not supported in v1) =="
curl -sS -i "$URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{ "role": "user", "content": "Say hello" }],
    "stream": false
  }'
echo -e "\n"

echo "== OpenAI pass-through streaming =="
curl -sS -N -i "$URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Stream please" }],
    "max_tokens": 64,
    "stream": true
  }'
echo -e "\n"

echo "== OpenAI pass-through non-streaming (JSON) =="
curl -sS -i "$URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Say hello" }],
    "max_tokens": 64,
    "stream": false
  }'
echo -e "\n"

echo "== OpenAI gpt-5 uses max_completion_tokens (streaming) =="
curl -sS -N -i "$URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "messages": [{ "role": "user", "content": "Stream using gpt-5" }],
    "max_tokens": 32,
    "stream": true
  }'
echo -e "\n"


