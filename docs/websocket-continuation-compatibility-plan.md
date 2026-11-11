# WebSocket continuation compatibility

Follow Codex `rust-v0.153.3` request-property matching: model, instructions,
tools, tool_choice, parallel_tool_calls, reasoning, store, stream, include,
service_tier, prompt_cache_key, and text must match before automatic continuation.
Input prefix matching remains a separate requirement. Client metadata and delivery
options do not determine context compatibility.

Keep healthy sockets across model/settings changes, sending full current input
without an automatic previous_response_id. Preserve explicit caller continuation.
Keep one active response per socket and the existing queue; independent conversation
keys retain independent reusable sockets. Do not introduce multiplexing lanes.

Validation: demonstrate compatibility regressions failing before the fix, then run
WebSocket/transport tests, checkJs, lint, and offline tests. No live API calls.