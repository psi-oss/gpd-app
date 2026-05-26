"""SSE keepalive injector for the GPD LiteLLM proxy.

Wraps every `StreamingResponse` with `media_type=text/event-stream` so that
when the upstream LLM (Anthropic / OpenAI / Gemini via LiteLLM) goes silent
for longer than KEEPALIVE_INTERVAL_SECONDS, the proxy still emits a
`: keepalive\\n\\n` SSE comment line to the client. Clients ignore the
comment per the EventSource spec, but it resets any client-side
chunk-timeout watchdog (e.g. opencode's `wrapSSE` at provider.ts:1737).

Without this hook, legitimate long Anthropic silences during tool_use
payload preparation (60-120s for a large `write` block after a heavy-
context turn) caused subagents to die with `SSE read timed out` on
2026-05-26. See provider.ts comment + db evidence in the fix(provider)
commit dropping the client default to 0.
"""
