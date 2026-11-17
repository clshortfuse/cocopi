import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CODEX_ORIGINATOR } from "../lib/auth/oauth.js";
import { buildTextResponseBody, codexResponseBodyForWire } from "../lib/codex-api/response-body.js";
import { SseParseError, sseEventStream } from "../lib/codex-api/sse.js";
import { decodeWorkerError, encodeWorkerError } from "../lib/codex-api/worker-protocol.js";
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

test("buildTextResponseBody supplies required reasoning summaries without mutating replay state", () => {
  const opaque = { type: /** @type {const} */ ("reasoning"), id: "rs-opaque", encrypted_content: "synthetic-ciphertext" };
  const summarized = { ...opaque, id: "rs-summary", summary: [{ type: /** @type {const} */ ("summary_text"), text: "Existing summary." }] };
  const input = [opaque, summarized];
  const body = buildTextResponseBody({ model: "gpt-test", input });
  assert.deepEqual(body.input, [{ ...opaque, summary: [] }, summarized]);
  assert.equal(Object.hasOwn(opaque, "summary"), false);
  assert.equal(input[0], opaque);
  assert.match(JSON.stringify(body), /"summary":\[\]/u);
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

test("buildTextResponseBody serializes safe decimal custom efforts as JSON numbers", () => {
  const reasoning = { effort: "42", summary: /** @type {const} */ ("concise") };
  const body = buildTextResponseBody({ model: "custom", input: "say hi", reasoning });
  assert.deepEqual(body.reasoning, { effort: 42, summary: "concise" });
  assert.match(JSON.stringify(body), /"effort":42/u);
  assert.equal(reasoning.effort, "42");

  for (const effort of ["ultra", "max", "1.5", "-1", "18446744073709551615"]) {
    assert.equal(buildTextResponseBody({ model: "custom", input: "say hi", reasoning: { effort } }).reasoning?.effort, effort);
  }
});

test("buildTextResponseBody omits instructions unless explicitly configured", () => {
  assert.equal("instructions" in buildTextResponseBody({ model: "gpt-5-codex", input: "say hi" }), false);
});

test("wire instructions lead input without mutating logical replay or losing tool output", () => {
  const input = [{ type: /** @type {const} */ ("function_call_output"), call_id: "call-one", output: "result" }];
  const body = buildTextResponseBody({ model: "test", input, instructions: "Follow host instructions." });
  const wire = codexResponseBodyForWire(body);
  assert.equal(Object.hasOwn(wire, "instructions"), false);
  assert.deepEqual(wire.input, [
    { role: "developer", content: [{ type: "input_text", text: "Follow host instructions." }] },
    ...input
  ]);
  assert.deepEqual(body.input, input);
  assert.equal(body.instructions, "Follow host instructions.");
  assert.deepEqual(codexResponseBodyForWire(wire), wire);
  assert.deepEqual(codexResponseBodyForWire(body, false).input, input);
  assert.deepEqual(codexResponseBodyForWire({ model: "test", input: "hello", instructions: "Base" }).input, [
    { role: "developer", content: [{ type: "input_text", text: "Base" }] },
    { role: "user", content: [{ type: "input_text", text: "hello" }] }
  ]);
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
      input: "Tell me the current datetime in ISO 8601 format. Return only the datetime string.",
      instructions: "Follow the host.",
      serviceTier: "priority"
    })
  }));

  assert.deepEqual(response, { id: "resp-test", status: "completed", output_text: "2026-04-25T12:34:56Z" });
  assert.equal(calls[0].url, "https://chatgpt.example.test/backend-api/codex/responses");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0].options.headers.Accept, "text/event-stream");
  assert.equal(calls[0].options.headers.originator, CODEX_ORIGINATOR);
  assert.equal(calls[0].options.headers["x-codex-routing-hint"], "model=gpt-5-codex;tier=priority");
  assert.equal(typeof calls[0].options.headers["session-id"], "string");
  assert.equal(calls[0].options.headers["thread-id"], calls[0].options.headers["session-id"]);
  assert.equal(calls[0].options.headers.session_id, undefined);
  assert.equal(calls[0].options.headers.conversation_id, undefined);
  const body = JSON.parse(String(calls[0].options.body));
  assert.ok(String(calls[0].options.body).startsWith('{"model":"gpt-5-codex","stream":true,"service_tier":"priority",'));
  assert.equal(body.model, "gpt-5-codex");
  assert.equal(Object.hasOwn(body, "instructions"), false);
  assert.deepEqual(body.input[0], { role: "developer", content: [{ type: "input_text", text: "Follow the host." }] });
  assert.equal(body.input[1].content[0].text, "Tell me the current datetime in ISO 8601 format. Return only the datetime string.");
});

test("HTTP routing fields precede input regardless of logical field insertion order", async () => {
  const body = { input: [{ role: "user", content: "synthetic" }], service_tier: /** @type {const} */ ("priority"), stream: true, model: "test" };
  let serialized = "";
  const events = await fetchCodexResponseStream({
    apiBaseUrl: "https://example.invalid", accessToken: "synthetic", body,
    fetch: async (_url, options) => {
      serialized = String(options?.body);
      return Response.json({ id: "complete", status: "completed" });
    }
  });
  await collectCodexResponseFromEvents(events);
  assert.deepEqual(Object.keys(JSON.parse(serialized)).slice(0, 3), ["model", "stream", "service_tier"]);
  assert.deepEqual(JSON.parse(serialized), body);
  assert.deepEqual(Object.keys(body), ["input", "service_tier", "stream", "model"]);
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

  assert.equal(calls[0].options.headers["session-id"], "cocopi-language-model");
  assert.equal(calls[0].options.headers["thread-id"], "cocopi-language-model");
  assert.equal(calls[0].options.headers["x-client-request-id"], "cocopi-language-model");
  assert.equal(calls[0].options.headers["x-codex-routing-hint"], "model=gpt-5-codex");
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
      type: "response.output_item.added",
      response_id: "resp-json",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }]
      }
    },
    {
      type: "response.output_text.delta",
      response_id: "resp-json",
      item_id: "output-0",
      output_index: 0,
      content_index: 0,
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

test("terminal stream errors retain provider codes and structured retry advice through worker delivery", async () => {
  for (const code of ["rate_limit_exceeded", "slow_down"]) {
    await assert.rejects(collectCodexResponseFromEvents(readableEventsFromArray([{
      type: "response.failed",
      response: { error: { code, message: "Try again.", headers: { "Retry-After": "7" } } }
    }])), (error) => {
      assert.ok(error instanceof CodexResponseStreamError);
      const restored = decodeWorkerError(encodeWorkerError(error));
      assert.ok(restored instanceof CodexResponseStreamError);
      assert.equal(restored.providerCode, code);
      assert.equal(restored.failureKind, "rate-limit");
      assert.equal(restored.retryAfter, 7000);
      return true;
    });

  }
});

test("stream retry advice prefers headers and only rate limits parse delay text", (context) => {
  const now = 1_700_000_000_000;
  context.mock.method(Date, "now", () => now);
  /** @type {[string, string, Record<string, string | number> | undefined, number | undefined][]} */
  const scenarios = [
    ["slow_down", "Try again in 1.25 seconds", undefined, 1250],
    ["rate_limit_exceeded", "Try again in 250 ms", undefined, 250],
    ["rate_limit_exceeded", "Try again in 1.9ms", undefined, 1],
    ["rate_limit_exceeded", "Try again in 1s", { "Retry-After": " 7 " }, 7000],
    ["slow_down", "Try again in 1s", { "retry-after": 3 }, 3000],
    ["slow_down", "Try again in 1s", { "retry-after": new Date(now + 6000).toUTCString() }, 6000],
    ["slow_down", "Try again in 1s", { "retry-after": "invalid" }, 1000],
    ["slow_down", "Try again in 1s", { "retry-after": "0" }, 0],
    ["slow_down", "Try again in -5s", undefined, undefined],
    ["insufficient_quota", "Try again in 2 seconds", undefined, undefined],
    ["content_policy_violation", "Try again in 2 seconds", undefined, undefined],
    ["server_is_overloaded", "Try again in 2 seconds", undefined, undefined]
  ];
  for (const [code, message, headers, expected] of scenarios) {
    const error = new CodexResponseStreamError("fixture", { event: {
      type: "response.failed", error: { code, message, ...(headers ? { headers } : {}) }
    } });
    assert.equal(error.retryAfter, expected, String(code));
  }
});

test("capacity failures retain structured advice without becoming quota denials", () => {
  for (const code of ["policy_capacity_unavailable", "server_is_overloaded"]) {
    const error = new CodexResponseStreamError("fixture", {
      event: { type: "response.failed", error: { code, headers: { "retry-after": "4" } } }
    });
    const restored = decodeWorkerError(encodeWorkerError(error));
    assert.ok(restored instanceof CodexResponseStreamError);
    assert.equal(restored.failureKind, "capacity");
    assert.equal(restored.retryAfter, 4000);
  }
});

test("incomplete errors retain reason, partial output, and usage instead of promoting partial text", async () => {
  const response = { id: "partial", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", status: "incomplete" }], usage: { output_tokens: 50 } };
  await assert.rejects(collectCodexResponseFromEvents(readableEventsFromArray([
    { type: "response.output_text.delta", delta: "unfinished" },
    { type: "response.incomplete", response }
  ])), (error) => {
    assert.ok(error instanceof CodexResponseStreamError);
    assert.equal(error.failureKind, "terminal");
    assert.match(error.message, /reason=max_output_tokens/u);
    assert.deepEqual(error.event, { type: "response.incomplete", response });
    return true;
  });
});

test("a stream ending after text without terminal confirmation is not successful", async () => {
  await assert.rejects(collectCodexResponseFromEvents(readableEventsFromArray([
    { type: "response.output_text.delta", delta: "unfinished" }
  ])), /without a terminal response/u);
});

test("top-level provider error events stop the stream before any later completion", async () => {
  for (const event of [
    { type: /** @type {const} */ ("error"), error: { code: "budget_reached", message: "Session budget reached." } },
    { type: /** @type {const} */ ("error"), code: "budget_reached", message: "Session budget reached." }
  ]) {
    await assert.rejects(collectCodexResponseFromEvents(readableEventsFromArray([
      event, { type: "response.completed", response: { id: "must-not-succeed" } }
    ])), (error) => {
      assert.ok(error instanceof CodexResponseStreamError);
      assert.equal(error.providerCode, "budget_reached");
      assert.equal(error.failureKind, "terminal");
      assert.match(error.message, /Session budget reached/u);
      return true;
    });
  }
});

test("failed and incomplete JSON responses are not converted into successful completion", async () => {
  for (const status of [/** @type {const} */ ("failed"), /** @type {const} */ ("incomplete")]) {
    const events = await fetchCodexResponseStream({
      apiBaseUrl: "https://example.invalid", accessToken: "synthetic", body: { model: "test", input: "test" },
      fetch: async () => Response.json({ status, error: { code: "budget_reached" } })
    });

    await assert.rejects(collectCodexResponseFromEvents(events), CodexResponseStreamError);
  }
});

test("cancelled and unfinished JSON responses cannot become successful completion", async () => {
  for (const status of ["cancelled", "queued", "in_progress"]) {
    const events = await fetchCodexResponseStream({
      apiBaseUrl: "https://example.invalid", accessToken: "synthetic", body: { model: "test", input: "test" },
      fetch: async () => Response.json({ status, output_text: "not a completed answer" })
    });
    await assert.rejects(collectCodexResponseFromEvents(events), new RegExp(`non-completed status: ${status}`, "u"));
  }
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

test("fetchCodexResponseStream clears its idle watchdog when consumption is cancelled", async (context) => {
  const timers = context.mock.method(globalThis, "setTimeout");
  const cleared = context.mock.method(globalThis, "clearTimeout");
  context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "hello" })
  ], { close: false })));
  const events = await fetchCodexResponseStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "fixture" }),
    idleTimeoutMs: 1000
  });
  const reader = events.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  const watchdogs = timers.mock.calls.filter((call) => call.arguments[1] === 1000);
  assert.ok(watchdogs.length > 0);
  for (const watchdog of watchdogs) {
    assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === watchdog.result), "cancel must clear every armed idle watchdog");
  }
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

for (const idleTimeoutMs of [120_000, 0]) {
  test(`SSE comment bytes update transport telemetry independently of decoded output with idle timeout ${idleTimeoutMs}`, async (context) => {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    context.mock.method(performance, "now", Date.now);
    /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
    let source;
    context.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "content-type": "text/event-stream" } })));
    /** @type {import('../lib/codex-api/websocket-heartbeat.js').CodexTransportStatus[]} */
    const statuses = [];
    const events = await fetchCodexResponseStream({ apiBaseUrl: "https://fixture.invalid", accessToken: "fixture", body: buildTextResponseBody({ model: "fixture", input: "fixture" }), idleTimeoutMs, onTransportStatus: (status) => statuses.push(status) });
    const reader = events.getReader();
    const pending = reader.read();
    context.mock.method(Date, "now", () => -9_000_000);
    context.mock.timers.tick(60_000);
    source?.enqueue(new TextEncoder().encode(": server keepalive\n\n"));
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    assert.equal(statuses.at(-1)?.transport, "sse");
    assert.equal(statuses.at(-1)?.heartbeat, "unsupported");
    assert.equal(statuses.at(-1)?.lastDataAt, 61_000);
    assert.equal(statuses.at(-1)?.responseIdleDeadlineAt, idleTimeoutMs ? 181_000 : undefined);
    assert.equal(statuses.at(-1)?.lastPongAt, undefined);
    await reader.cancel();
    await pending;
    assert.equal(statuses.at(-1)?.responseIdleDeadlineAt, undefined);
  });
}

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
