import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CODEX_ORIGINATOR } from "../lib/auth/oauth.js";
import { buildTextResponseBody } from "../lib/codex-api/response-body.js";
import { SseParseError, sseEventStream } from "../lib/codex-api/sse.js";
import {
  CodexResponseStreamError,
  collectCodexResponseFromEvents,
  fetchCodexResponseStream
} from "../lib/codex-api/responses.js";

const reasoningStreamEventsFixture = /** @type {CodexResponseStreamEvent[]} */ (JSON.parse(await readFile(new URL("fixtures/codex-responses/reasoning-stream-events.json", import.meta.url), "utf8")));

/** @typedef {import("../data/Codex.js").CodexResponse} CodexResponse */
/** @typedef {import("../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */

test("buildTextResponseBody creates a reusable streaming text request", () => {
  assert.deepEqual(buildTextResponseBody({
    model: "gpt-5-codex",
    input: "say hi",
    instructions: "Be terse.",
    tools: [{ type: "function", name: "now", parameters: { type: "object" } }],
    toolChoice: "required",
    parallelToolCalls: true,
    serviceTier: "priority",
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "medium" },
    previousResponseId: "resp-prev",
    promptCacheKey: "cache-key",
    clientMetadata: { source: "test" }
  }), {
    model: "gpt-5-codex",
    instructions: "Be terse.",
    input: [{ role: "user", content: [{ type: "input_text", text: "say hi" }] }],
    tools: [{ type: "function", name: "now", parameters: { type: "object" } }],
    tool_choice: "required",
    parallel_tool_calls: true,
    reasoning: { effort: "medium" },
    service_tier: "priority",
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    previous_response_id: "resp-prev",
    prompt_cache_key: "cache-key",
    client_metadata: { source: "test" }
  });
});

test("buildTextResponseBody omits automatic service tier", () => {
  assert.equal("service_tier" in buildTextResponseBody({ model: "gpt-5-codex", input: "say hi", serviceTier: "auto" }), false);
});

test("buildTextResponseBody can disable streaming for required tool calls", () => {
  assert.equal(buildTextResponseBody({
    model: "gpt-5-codex",
    input: "read README",
    tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }],
    toolChoice: "required",
    stream: false
  }).stream, false);
});

test("buildTextResponseBody omits reasoning unless explicitly configured", () => {
  assert.equal("reasoning" in buildTextResponseBody({ model: "gpt-5-codex", input: "say hi" }), false);
});

test("buildTextResponseBody omits instructions unless explicitly configured", () => {
  assert.equal("instructions" in buildTextResponseBody({ model: "gpt-5-codex", input: "say hi" }), false);
});

test("fetchCodexResponseStream posts to Codex Responses endpoint", async (context) => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({
      url: String(url),
      options: /** @type {RequestInit & { headers: Record<string, string>, body?: string | null }} */ (options)
    });
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "2026-04-25T12:34:56Z" }),
      sseData({ type: "response.completed", response: { id: "resp-test" } })
    ]);
  }));

  const response = await collectCodexResponseFromEvents(await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "Tell me the current datetime in ISO 8601 format. Return only the datetime string."
    })
  }));

  assert.deepEqual(response, { id: "resp-test", status: "completed", output_text: "2026-04-25T12:34:56Z" });
  assert.equal(calls[0].url, "https://chatgpt.example.test/backend-api/codex/responses");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0].options.headers.Accept, "text/event-stream");
  assert.equal(calls[0].options.headers.originator, CODEX_ORIGINATOR);
  assert.equal(typeof calls[0].options.headers.session_id, "string");
  const body = JSON.parse(String(calls[0].options.body));
  assert.equal(body.model, "gpt-5-codex");
  assert.equal(body.input[0].content[0].text, "Tell me the current datetime in ISO 8601 format. Return only the datetime string.");
});

test("fetchCodexResponseStream uses prompt cache key as stable request identity", async (context) => {
  /** @type {Array<{ options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    calls.push({
      options: /** @type {RequestInit & { headers: Record<string, string>, body?: string | null }} */ (options)
    });
    return eventStreamResponse([sseData({ type: "response.completed", response: { id: "resp-test" } })]);
  }));

  await collectCodexResponseFromEvents(await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "current datetime",
      promptCacheKey: "cocopi-language-model",
      clientMetadata: {
        "x-codex-turn-metadata": '{"turn_id":"turn-1"}'
      }
    })
  }));

  assert.equal(calls[0].options.headers.session_id, "cocopi-language-model");
  assert.equal(calls[0].options.headers.conversation_id, "cocopi-language-model");
  assert.equal(calls[0].options.headers["x-client-request-id"], "cocopi-language-model");
  assert.equal(calls[0].options.headers["x-codex-turn-metadata"], '{"turn_id":"turn-1"}');
  const body = JSON.parse(String(calls[0].options.body));
  assert.equal(body.prompt_cache_key, "cocopi-language-model");
  assert.equal(body.client_metadata, undefined);
});

test("fetchCodexResponseStream adapts completed JSON responses into events", async (context) => {
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => Response.json({
    id: "resp-json",
    output_text: "fallback text",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }]
      },
      {
        id: "fc_1",
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: JSON.stringify({ path: "README.md" })
      }
    ]
  })));

  assert.deepEqual(await collectEvents(await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "read README",
      tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }],
      toolChoice: "required",
      stream: false
    })
  })), [
    {
      type: "response.output_text.delta",
      response_id: "resp-json",
      output_index: 0,
      delta: "hello"
    },
    {
      type: "response.output_item.done",
      response_id: "resp-json",
      item_id: "fc_1",
      output_index: 1,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: JSON.stringify({ path: "README.md" })
      }
    },
    {
      type: "response.completed",
      response: {
        id: "resp-json",
        output_text: "fallback text",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }]
          },
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call-1",
            name: "read_file",
            arguments: JSON.stringify({ path: "README.md" })
          }
        ]
      }
    }
  ]);
});

test("fetchCodexResponseStream serializes request bodies canonically", async (context) => {
  /** @type {string[]} */
  const bodies = [];
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    bodies.push(String(options.body));
    return eventStreamResponse([sseData({ type: "response.completed", response: { id: "resp-test" } })]);
  }));

  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [{
      type: "function",
      name: "write_file",
      parameters: { type: "object", properties: { z: { type: "boolean" }, a: { type: "string" } } }
    }],
    clientMetadata: { z: true, a: 1 }
  });
  const secondBody = buildTextResponseBody({
    clientMetadata: { a: 1, z: true },
    tools: [{
      parameters: { properties: { a: { type: "string" }, z: { type: "boolean" } }, type: "object" },
      name: "write_file",
      type: "function"
    }],
    input: [{ content: [{ text: "hello", type: "input_text" }], role: "user" }],
    model: "gpt-5-codex"
  });

  await collectCodexResponseFromEvents(await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: firstBody
  }));
  await collectCodexResponseFromEvents(await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: secondBody
  }));

  assert.equal(bodies[0], bodies[1]);
});

test("fetchCodexResponseStream can include ChatGPT account header", async (context) => {
  /** @type {Array<{ options: RequestInit & { headers: Record<string, string> } }>} */
  const calls = [];
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    calls.push({ options: /** @type {RequestInit & { headers: Record<string, string> }} */ (options) });
    return eventStreamResponse([sseData({ type: "response.completed", response: { id: "resp-test" } })]);
  }));

  await collectCodexResponseFromEvents(await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    chatgptAccountId: "account-id",
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "current datetime" })
  }));

  assert.equal(calls[0].options.headers["ChatGPT-Account-ID"], "account-id");
});

test("fetchCodexResponseStream passes cancellation signal to fetch", async (context) => {
  const controller = new AbortController();
  /** @type {AbortSignal | undefined} */
  let fetchSignal;

  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    fetchSignal = options.signal ?? undefined;
    return eventStreamResponse([sseData({ type: "response.completed", response: { id: "resp-test" } })]);
  }));

  await collectCodexResponseFromEvents(await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "current datetime" }),
    signal: controller.signal
  }));

  assert.equal(fetchSignal, controller.signal);
});

test("collectCodexResponseFromEvents reports failed terminal events", async () => {
  await assert.rejects(
    collectCodexResponseFromEvents(readableEventsFromArray([
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.failed", error: { message: "tool failed" } }
    ])),
    /Codex response failed\. tool failed/u
  );
});

test("collectCodexResponseFromEvents reports incomplete terminal events", async () => {
  await assert.rejects(
    collectCodexResponseFromEvents(readableEventsFromArray([{ type: "response.incomplete", response: { id: "resp-test" } }])),
    CodexResponseStreamError
  );
});

test("collectCodexResponseFromEvents rejects multiple completed responses", async () => {
  await assert.rejects(
    collectCodexResponseFromEvents(readableEventsFromArray([
      { type: "response.completed", response: { id: "resp-one" } },
      { type: "response.completed", response: { id: "resp-two" } }
    ])),
    /multiple completed response events/u
  );
});

test("collectCodexResponseFromEvents accepts sanitized live reasoning stream fixture", async () => {
  const response = await collectCodexResponseFromEvents(readableEventsFromArray(reasoningStreamEventsFixture));
  const reasoningEvent = reasoningStreamEventsFixture.find((event) => event.type === "response.output_item.done" && "item" in event && event.item?.type === "reasoning");
  const reasoningItem = reasoningEvent && "item" in reasoningEvent
    ? /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (reasoningEvent.item)
    : undefined;

  assert.equal(response.output_text, "fixture-ok");
  assert.equal(response.status, "completed");
  assert.equal(reasoningItem?.encrypted_content, "<redacted-encrypted-content>");
});

test("fetchCodexResponseStream aborts during stream consumption", async (context) => {
  const controller = new AbortController();
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "hello" })
  ], { close: false })));

  const events = await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "current datetime" }),
    signal: controller.signal
  });
  const reader = events.getReader();
  const firstRead = await reader.read();
  assert.deepEqual(firstRead.value, { type: "response.output_text.delta", delta: "hello" });

  controller.abort(new Error("stop stream"));
  await assert.rejects(reader.read(), /stop stream/u);
});

test("fetchCodexResponseStream reports idle streams", async (context) => {
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([], { close: false })));

  await assert.rejects(
    collectEvents(await fetchCodexResponseStream({
      apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      accessToken: "access-token",
      body: buildTextResponseBody({ model: "gpt-5-codex", input: "current datetime" }),
      idleTimeoutMs: 1
    })),
    /idle for 1ms/u
  );
});

test("fetchCodexResponseStream treats SSE comments as heartbeat activity", async (context) => {
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => new Response(heartbeatThenDataStream(), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })));

  assert.deepEqual(await collectEvents(await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "current datetime" }),
    idleTimeoutMs: 20
  })), [
    { type: "response.output_text.delta", delta: "hello" }
  ]);
});

test("sseEventStream transforms chunks as records complete", async () => {
  assert.deepEqual(await collectEvents(readableStreamFromChunks([
    `data: {"type":"response.output_text.delta",`,
    `"delta":"he"}\n\n`,
    sseData({ type: "response.output_text.delta", delta: "llo" })
  ]).pipeThrough(sseEventStream())), [
    { type: "response.output_text.delta", delta: "he" },
    { type: "response.output_text.delta", delta: "llo" }
  ]);
});

test("sseEventStream reads JSON data events and ignores done chunks", async () => {
  assert.deepEqual(await collectEvents(readableStreamFromChunks([[
    ": keep-alive",
    `data: {"type":"response.output_text.delta","delta":"hello"}`,
    "",
    "data: [DONE]",
    ""
  ].join("\n")]).pipeThrough(sseEventStream())), [
    { type: "response.output_text.delta", delta: "hello" }
  ]);
});

test("sseEventStream reports malformed JSON events", async () => {
  await assert.rejects(
    collectEvents(readableStreamFromChunks(["data: not json\n\n"]).pipeThrough(sseEventStream())),
    /** @param {Error} error */
    (error) => error instanceof SseParseError && Reflect.get(error, "eventData") === "not json"
  );
});

test("sseEventStream reports non-object JSON events", async () => {
  await assert.rejects(
    collectEvents(readableStreamFromChunks(["data: 42\n\n"]).pipeThrough(sseEventStream())),
    /must be an object/u
  );
});

/**
 * @param {string[]} chunks
 * @param {{ close?: boolean }} [options]
 */
function eventStreamResponse(chunks, options = {}) {
  return new Response(readableStreamFromChunks(chunks, options), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

/**
 * @param {CodexResponseStreamEvent} event
 */
function sseData(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * @param {AsyncIterable<CodexResponseStreamEvent>} events
 */
async function collectEvents(events) {
  /** @type {CodexResponseStreamEvent[]} */
  const output = [];
  for await (const event of events) {
    output.push(event);
  }
  return output;
}

/**
 * @param {CodexResponseStreamEvent[]} events
 */
function readableEventsFromArray(events) {
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    }
  });
}

/**
 * @param {string[]} chunks
 * @param {{ close?: boolean }} [options]
 */
function readableStreamFromChunks(chunks, options = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (options.close !== false) {
        controller.close();
      }
    }
  });
}

function heartbeatThenDataStream() {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": keep-alive\n\n"));
      setTimeout(() => {
        controller.enqueue(encoder.encode(sseData({ type: "response.output_text.delta", delta: "hello" })));
        controller.close();
      }, 5);
    }
  });
}
