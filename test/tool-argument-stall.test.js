import assert from "node:assert/strict";
import test from "node:test";
import { CodexTransport } from "../lib/codex-api/transport.js";
import { guardCodexToolArguments } from "../lib/codex-api/tool-argument-guard.js";

/** @param {object[]} events */
function fixture(events) {
  const transport = new CodexTransport();
  let requests = 0;
  let cancelled = 0;
  const fetch = async () => {
    requests += 1;
    const encoder = new TextEncoder();
    let index = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (index < events.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
        else controller.close();
      },
      cancel() { cancelled += 1; }
    }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } });
  };
  return { transport, fetch, counts: () => ({ requests, cancelled }) };
}

test("transport rejects a whitespace-only tool argument run without replay", async () => {
  const events = [
    { type: "response.function_call_arguments.delta", item_id: "call-a", delta: '{"path":' },
    ...Array.from({ length: 20 }, () => ({ type: "response.function_call_arguments.delta", item_id: "call-a", delta: " \n\t\r".repeat(256) })),
    { type: "response.completed", response: { id: "synthetic", output: [] } }
  ];
  const { transport, fetch, counts } = fixture(events);
  const stream = await transport.request({ apiBaseUrl: "https://example.invalid", accessToken: "synthetic", fetch,
    body: { model: "synthetic", stream: true, input: [] } });
  await assert.rejects(async () => { for await (const event of stream) assert.ok(event.type); }, /tool arguments stalled.*16384.*whitespace/iu);
  assert.deepEqual(counts(), { requests: 1, cancelled: 1 });
  transport.dispose();
});

test("tool argument guard preserves large string whitespace and escaped quotes across fragments", async () => {
  const text = JSON.stringify({ code: String.raw`quoted " value \ ` + " ".repeat(40_000) + '\n"end' });
  const events = Array.from(text, (delta) => ({ type: "response.function_call_arguments.delta", item_id: "call-a", delta }));
  const { transport, fetch } = fixture(events);
  const stream = await transport.request({ apiBaseUrl: "https://example.invalid", accessToken: "synthetic", fetch,
    body: { model: "synthetic", stream: true, input: [] } });
  let actual = "";
  for await (const event of stream) if (event.type === "response.function_call_arguments.delta") actual += event.delta;
  assert.equal(actual, text);
  transport.dispose();
});

test("tool argument whitespace counts are per item and reset on JSON progress", async () => {
  const events = [
    { type: "response.function_call_arguments.delta", item_id: "a", delta: "[" + " ".repeat(16_384) },
    { type: "response.function_call_arguments.delta", item_id: "b", delta: "[" + " ".repeat(16_384) },
    { type: "response.function_call_arguments.delta", item_id: "a", delta: "0," + " ".repeat(16_384) + "1]" },
    { type: "response.function_call_arguments.delta", item_id: "b", delta: "0]" }
  ];
  const { transport, fetch } = fixture(events);
  const stream = await transport.request({ apiBaseUrl: "https://example.invalid", accessToken: "synthetic", fetch,
    body: { model: "synthetic", stream: true, input: [] } });
  let count = 0;
  for await (const event of stream) { assert.ok(event.type); count += 1; }
  assert.equal(count, events.length);
  transport.dispose();
});

test("WebSocket transport cancels runaway arguments without selecting fallback or replay", async () => {
  const transport = new CodexTransport();
  let opens = 0;
  let cancelled = 0;
  let fallback = 0;
  transport.websocket = async () => {
    opens += 1;
    return new ReadableStream({
      pull(controller) { controller.enqueue({ type: "response.function_call_arguments.delta", item_id: "a", output_index: 0, delta: " ".repeat(16_385) }); },
      cancel() { cancelled += 1; }
    }, { highWaterMark: 0 });
  };
  const stream = await transport.request({ apiBaseUrl: "https://example.invalid", accessToken: "synthetic", transport: "websocket",
    onWebSocketFallbackToSse() { fallback += 1; }, body: { model: "synthetic", stream: true, input: [] } });
  await assert.rejects(async () => { for await (const event of stream) assert.ok(event.type); }, /tool arguments stalled/iu);
  assert.equal(opens, 1);
  assert.equal(cancelled, 1);
  assert.equal(fallback, 0);
});

test("tool argument guard drops completed item state and handles downstream cancellation", async () => {
  let cancelled = 0;
  const events = [
    { type: "response.function_call_arguments.delta", item_id: "a", output_index: 0, delta: " ".repeat(16_384) },
    { type: "response.function_call_arguments.done", item_id: "a", output_index: 0, arguments: "{}" },
    { type: "response.function_call_arguments.delta", item_id: "a", output_index: 0, delta: " " }
  ];
  const source = new ReadableStream({
    pull(controller) {
      const event = events.shift();
      if (event) controller.enqueue(/** @type {import('../data/Codex.js').CodexResponseStreamEvent} */ (event));
    },
    cancel() { cancelled += 1; }
  }, { highWaterMark: 0 });
  const reader = guardCodexToolArguments(source).getReader();
  for (let index = 0; index < 3; index += 1) {
    const result = await reader.read();
    assert.equal(result.done, false);
  }
  await reader.cancel();
  assert.equal(cancelled, 1);
  assert.equal(source.locked, false);
});

test("initial tool argument prefixes preserve quoted whitespace in following deltas", async () => {
  const { transport, fetch } = fixture([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "a", call_id: "a", name: "synthetic", arguments: '{"text":"' } },
    { type: "response.function_call_arguments.delta", item_id: "a", output_index: 0, delta: " ".repeat(20_000) + '"}' }
  ]);
  const stream = await transport.request({ apiBaseUrl: "https://example.invalid", accessToken: "synthetic", fetch,
    body: { model: "synthetic", stream: true, input: [] } });
  let count = 0;
  for await (const event of stream) { assert.ok(event.type); count += 1; }
  assert.equal(count, 2);
});