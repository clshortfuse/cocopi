import test from "node:test";
import assert from "node:assert/strict";

import { canonicalCodexJsonString } from "../lib/codex-api/json.js";
import { buildTextResponseBody } from "../lib/codex-api/response-body.js";
import {
  CODEX_RESPONSES_WEBSOCKET_BETA_HEADER,
  CodexResponsesWebSocketSession,
  codexResponsesWebSocketUrl,
  fetchCodexResponseWebSocketStream,
  responseCancelWebSocketMessage,
  responseCreateWebSocketMessage
} from "../lib/codex-api/websocket.js";
import { closeCodexResponseWebSocketSessions, fetchCodexResponseStreamWithAuthRefresh } from "../lib/vscode/codex-request.js";

/** @typedef {import("../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */

test("codexResponsesWebSocketUrl converts Responses endpoint URLs", () => {
  assert.equal(codexResponsesWebSocketUrl("https://chatgpt.example.test/backend-api/codex"), "wss://chatgpt.example.test/backend-api/codex/responses");
  assert.equal(codexResponsesWebSocketUrl("http://localhost:8787/backend-api/codex/"), "ws://localhost:8787/backend-api/codex/responses");
  assert.throws(() => codexResponsesWebSocketUrl("file:///tmp/codex"), /Unsupported Codex WebSocket API URL protocol/u);
});

test("responseCreateWebSocketMessage sends a flattened response.create request", () => {
  const body = buildTextResponseBody({ model: "gpt-5-codex", input: "hello" });
  const { stream: _stream, ...webSocketBody } = body;
  void _stream;
  assert.deepEqual(responseCreateWebSocketMessage(body), {
    type: "response.create",
    ...webSocketBody,
    instructions: "You are a helpful coding assistant.",
    generate: true
  });
});

test("responseCreateWebSocketMessage preserves explicit instructions", () => {
  const body = buildTextResponseBody({
    model: "gpt-5-codex",
    input: "hello",
    instructions: "Follow the user's requirements carefully."
  });

  assert.equal(responseCreateWebSocketMessage(body).instructions, "Follow the user's requirements carefully.");
});

test("fetchCodexResponseWebSocketStream connects with Codex headers and streams events", async () => {
  FakeWebSocket.reset();
  const body = buildTextResponseBody({
    model: "gpt-5-codex",
    input: "say hi",
    promptCacheKey: "cocopi-language-model",
    clientMetadata: {
      "x-codex-turn-metadata": '{"turn_id":"turn-1"}'
    }
  });

  const streamPromise = fetchCodexResponseWebSocketStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    chatgptAccountId: "account-id",
    body,
    WebSocketConstructor: fakeWebSocketConstructor()
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  assert.equal(socket.url, "wss://chatgpt.example.test/backend-api/codex/responses");
  assert.equal(socket.init?.headers?.Authorization, "Bearer access-token");
  assert.equal(socket.init?.headers?.["ChatGPT-Account-ID"], "account-id");
  assert.equal(socket.init?.headers?.["OpenAI-Beta"], CODEX_RESPONSES_WEBSOCKET_BETA_HEADER);
  assert.equal(socket.init?.headers?.session_id, "cocopi-language-model");
  assert.equal(socket.init?.headers?.conversation_id, "cocopi-language-model");
  assert.equal(socket.init?.headers?.["x-client-request-id"], "cocopi-language-model");
  assert.equal(socket.init?.headers?.["x-codex-turn-metadata"], '{"turn_id":"turn-1"}');

  socket.open();
  const stream = await streamPromise;
  assert.deepEqual(JSON.parse(socket.sent[0]), responseCreateWebSocketMessage(body));

  const eventsPromise = collectEvents(stream);
  socket.message(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-test" } }));

  assert.deepEqual(await eventsPromise, [
    { type: "response.output_text.delta", delta: "hi" },
    { type: "response.completed", response: { id: "resp-test" } }
  ]);
  assert.equal(socket.closeCalls.length, 1);
});

test("fetchCodexResponseWebSocketStream reports malformed messages", async () => {
  FakeWebSocket.reset();
  const streamPromise = fetchCodexResponseWebSocketStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "say hi" }),
    WebSocketConstructor: fakeWebSocketConstructor()
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const stream = await streamPromise;
  const eventsPromise = collectEvents(stream);
  socket.message("not json");

  await assert.rejects(
    eventsPromise,
    /** @param {Error} error */
    (error) => /malformed JSON/u.test(error.message) && Reflect.get(error, "eventData") === "not json"
  );
});

test("fetchCodexResponseWebSocketStream aborts and closes the socket", async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const streamPromise = fetchCodexResponseWebSocketStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "say hi" }),
    signal: controller.signal,
    WebSocketConstructor: fakeWebSocketConstructor()
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const stream = await streamPromise;
  const reader = stream.getReader();
  controller.abort(new Error("stop websocket"));

  await assert.rejects(reader.read(), /stop websocket/u);
  assert.equal(socket.sent[1], JSON.stringify(responseCancelWebSocketMessage()));
  assert.equal(socket.closeCalls.length, 1);
});

test("CodexResponsesWebSocketSession does not send queued requests cancelled before start", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstStreamPromise = session.request({
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "first", promptCacheKey: "cocopi-language-model" })
  });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstStream = await firstStreamPromise;
  const firstEventsPromise = collectEvents(firstStream);

  const controller = new AbortController();
  const secondStreamPromise = session.request({
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "second", promptCacheKey: "cocopi-language-model" }),
    signal: controller.signal
  });
  controller.abort(new Error("stop queued websocket"));
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-one" } }));

  assert.deepEqual(await firstEventsPromise, [{ type: "response.completed", response: { id: "resp-one" } }]);
  await assert.rejects(secondStreamPromise, /stop queued websocket/u);
  assert.equal(socket.sent.length, 1);

  session.dispose();
});

test("fetchCodexResponseWebSocketStream reports close before terminal event", async () => {
  FakeWebSocket.reset();
  const streamPromise = fetchCodexResponseWebSocketStream({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "say hi" }),
    WebSocketConstructor: fakeWebSocketConstructor()
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const stream = await streamPromise;
  const reader = stream.getReader();
  socket.serverClose(1006, "lost");

  await assert.rejects(reader.read(), /closed before a terminal response event/u);
});

test("fetchCodexResponseStreamWithAuthRefresh uses the configured WebSocket transport", async (testContext) => {
  FakeWebSocket.reset();
  closeCodexResponseWebSocketSessions();
  replaceGlobalWebSocket(testContext, fakeWebSocketConstructor());

  const streamPromise = fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "say hi",
      promptCacheKey: "cocopi-language-model"
    })
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const stream = await streamPromise;
  const eventsPromise = collectEvents(stream);
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-ws" } }));

  assert.equal(socket.url, "wss://chatgpt.example.test/backend-api/codex/responses");
  assert.equal(socket.init?.headers?.Authorization, "Bearer access-token");
  assert.deepEqual(await eventsPromise, [{ type: "response.completed", response: { id: "resp-ws" } }]);
  closeCodexResponseWebSocketSessions();
});

test("fetchCodexResponseStreamWithAuthRefresh uses HTTP JSON for non-stream requests", async (testContext) => {
  FakeWebSocket.reset();
  closeCodexResponseWebSocketSessions();
  replaceGlobalWebSocket(testContext, fakeWebSocketConstructor());
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return Response.json({ id: "resp-json", output: [] });
  }));

  assert.deepEqual(await collectEvents(await fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "read README",
      tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }],
      toolChoice: "required",
      stream: false
    })
  })), [{ type: "response.completed", response: { id: "resp-json", output: [] } }]);

  assert.equal(FakeWebSocket.instances.length, 0);
  assert.ok(requestOptions);
  assert.equal(/** @type {Record<string, string>} */ (requestOptions.headers).Accept, "application/json");
});

test("closeCodexResponseWebSocketSessions closes reusable WebSocket sessions", async (testContext) => {
  FakeWebSocket.reset();
  closeCodexResponseWebSocketSessions();
  replaceGlobalWebSocket(testContext, fakeWebSocketConstructor());

  const streamPromise = fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "say hi",
      promptCacheKey: "cocopi-language-model-cleanup"
    })
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const stream = await streamPromise;
  const eventsPromise = collectEvents(stream);
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-cleanup" } }));
  assert.deepEqual(await eventsPromise, [{ type: "response.completed", response: { id: "resp-cleanup" } }]);

  closeCodexResponseWebSocketSessions();
  assert.equal(socket.closeCalls.length, 1);
});

test("fetchCodexResponseStreamWithAuthRefresh retries clean early WebSocket closes with SSE", async (testContext) => {
  FakeWebSocket.reset();
  closeCodexResponseWebSocketSessions();
  replaceGlobalWebSocket(testContext, fakeWebSocketConstructor());
  /** @type {Error[]} */
  const fallbackErrors = [];
  const fetchMock = testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "fallback" }),
    sseData({ type: "response.completed", response: { id: "resp-sse" } })
  ])));

  const streamPromise = fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "say hi",
      promptCacheKey: "cocopi-language-model-fallback"
    }),
    onWebSocketFallbackToSse(error) {
      fallbackErrors.push(error);
    }
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const eventsPromise = collectEvents(await streamPromise);
  socket.message(JSON.stringify({ type: "response.created", response: { id: "resp-started" } }));
  socket.message(JSON.stringify({ type: "response.in_progress", response: { id: "resp-started" } }));
  socket.serverClose(1000, "");

  assert.deepEqual(await eventsPromise, [
    { type: "response.output_text.delta", delta: "fallback" },
    { type: "response.completed", response: { id: "resp-sse" } }
  ]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fallbackErrors.length, 1);
  assert.match(fallbackErrors[0].message, /closed before a terminal response event/u);
});

test("fetchCodexResponseStreamWithAuthRefresh reports WebSocket open transport errors without SSE retry", async (testContext) => {
  FakeWebSocket.reset();
  closeCodexResponseWebSocketSessions();
  replaceGlobalWebSocket(testContext, fakeWebSocketConstructor());
  const fetchMock = testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "fallback" }),
    sseData({ type: "response.completed", response: { id: "resp-sse" } })
  ])));

  const streamPromise = fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "say hi",
      promptCacheKey: "cocopi-language-model-open-error"
    })
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.error();

  await assert.rejects(streamPromise, /transport error while opening/u);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("fetchCodexResponseStreamWithAuthRefresh retries WebSocket connection limits with a fresh WebSocket", async (testContext) => {
  FakeWebSocket.reset();
  closeCodexResponseWebSocketSessions();
  replaceGlobalWebSocket(testContext, fakeWebSocketConstructor());
  const fetchMock = testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("unexpected SSE fallback");
  }));
  /** @type {Error[]} */
  const reconnectErrors = [];
  const body = buildTextResponseBody({
    model: "gpt-5-codex",
    input: "say hi",
    promptCacheKey: "cocopi-language-model-connection-limit"
  });

  const streamPromise = fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body,
    onWebSocketReconnect(error) {
      reconnectErrors.push(error);
    }
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const eventsPromise = collectEvents(await streamPromise);
  socket.message(JSON.stringify({
    type: "error",
    error: {
      message: "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue."
    }
  }));

  await waitForFakeWebSocketCount(2);
  const retrySocket = FakeWebSocket.instances[1];
  retrySocket.open();
  await nextMicrotask();
  assert.equal(retrySocket.sent[0], canonicalCodexJsonString(responseCreateWebSocketMessage(body)));
  retrySocket.message(JSON.stringify({ type: "response.output_text.delta", delta: "retried" }));
  retrySocket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-retried" } }));

  assert.deepEqual(await eventsPromise, [
    { type: "response.output_text.delta", delta: "retried" },
    { type: "response.completed", response: { id: "resp-retried" } }
  ]);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(reconnectErrors.length, 1);
  assert.match(reconnectErrors[0].message, /connection limit reached/u);

  closeCodexResponseWebSocketSessions();
});

test("fetchCodexResponseStreamWithAuthRefresh retries stale previous response ids with full SSE", async (testContext) => {
  FakeWebSocket.reset();
  closeCodexResponseWebSocketSessions();
  replaceGlobalWebSocket(testContext, fakeWebSocketConstructor());
  /** @type {Error[]} */
  const fallbackErrors = [];
  /** @type {import("../data/Codex.js").CodexResponseCreateRequest | undefined} */
  let fallbackBody;
  const fetchMock = testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    fallbackBody = /** @type {import("../data/Codex.js").CodexResponseCreateRequest} */ (JSON.parse(String(options.body)));
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "replayed" }),
      sseData({ type: "response.completed", response: { id: "resp-sse" } })
    ]);
  }));
  const firstUserItem = { role: "user", content: [{ type: "input_text", text: "first" }] };
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem],
    promptCacheKey: "cocopi-language-model-stale-previous"
  });
  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem, assistantItem, secondUserItem],
    promptCacheKey: "cocopi-language-model-stale-previous"
  });

  const firstStreamPromise = fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body: firstBody
  });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-missing",
      output: [assistantItem]
    }
  }));
  await firstEventsPromise;

  const streamPromise = fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body: secondBody,
    onWebSocketFallbackToSse(error) {
      fallbackErrors.push(error);
    }
  });

  const eventsPromise = collectEvents(await streamPromise);
  const wireMessage = JSON.parse(socket.sent[1]);
  assert.equal(wireMessage.previous_response_id, "resp-missing");
  assert.deepEqual(wireMessage.input, [secondUserItem]);
  socket.message(JSON.stringify({
    type: "error",
    status: 400,
    error: {
      code: "previous_response_not_found",
      message: "Previous response with id 'resp-missing' not found."
    }
  }));

  assert.deepEqual(await eventsPromise, [
    { type: "response.output_text.delta", delta: "replayed" },
    { type: "response.completed", response: { id: "resp-sse" } }
  ]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fallbackErrors.length, 1);
  assert.match(fallbackErrors[0].message, /previous_response_not_found/u);
  assert.equal(fallbackBody?.previous_response_id, undefined);
  assert.deepEqual(fallbackBody?.input, secondBody.input);

  closeCodexResponseWebSocketSessions();
});

test("fetchCodexResponseStreamWithAuthRefresh does not retry WebSocket closes after output", async (testContext) => {
  FakeWebSocket.reset();
  closeCodexResponseWebSocketSessions();
  replaceGlobalWebSocket(testContext, fakeWebSocketConstructor());
  const fetchMock = testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.completed", response: { id: "resp-sse" } })
  ])));

  const streamPromise = fetchCodexResponseStreamWithAuthRefresh(fakeSecretContext(), fakeRuntime({ transport: "websocket" }), {
    body: buildTextResponseBody({
      model: "gpt-5-codex",
      input: "say hi",
      promptCacheKey: "cocopi-language-model-output-started"
    })
  });

  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const stream = await streamPromise;
  const reader = stream.getReader();
  socket.message(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
  assert.deepEqual(await reader.read(), { done: false, value: { type: "response.output_text.delta", delta: "partial" } });
  socket.serverClose(1000, "");

  await assert.rejects(reader.read(), /closed before a terminal response event/u);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("CodexResponsesWebSocketSession reuses one socket for sequential requests", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });

  const firstStreamPromise = session.request({
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "first", promptCacheKey: "cocopi-language-model" })
  });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-one" } }));
  assert.deepEqual(await firstEventsPromise, [{ type: "response.completed", response: { id: "resp-one" } }]);

  const secondStreamPromise = session.request({
    body: buildTextResponseBody({ model: "gpt-5-codex", input: "second", promptCacheKey: "cocopi-language-model" })
  });
  const secondEventsPromise = collectEvents(await secondStreamPromise);
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(socket.closeCalls.length, 0);
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(await secondEventsPromise, [{ type: "response.completed", response: { id: "resp-two" } }]);

  session.dispose();
  assert.equal(socket.closeCalls.length, 1);
});

test("CodexResponsesWebSocketSession sends incremental input with previous response id", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [{ role: "user", content: [{ type: "input_text", text: "first" }] }],
    promptCacheKey: "cocopi-language-model",
    clientMetadata: {
      "x-codex-installation-id": "cocopi-test",
      "x-cocopi-session-id": "cocopi-language-model",
      "x-cocopi-source": "language-model",
      "x-cocopi-host-request-index": "1",
      "x-cocopi-turn-id": "cocopi-language-model:1",
      "x-codex-turn-metadata": '{"turn_id":"cocopi-language-model:1"}',
      ws_request_header_traceparent: "traceparent-one",
      ws_request_header_tracestate: "tracestate-one"
    }
  });
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];
  /** @type {import("../data/Codex.js").CodexResponseCreateRequest[]} */
  const preparedBodies = [];

  const firstStreamPromise = session.request({
    body: firstBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    },
    onWebSocketRequestPrepared(body) {
      preparedBodies.push(body);
    }
  });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-one",
      output: [assistantItem]
    }
  }));
  await firstEventsPromise;

  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [.../** @type {import("../data/Codex.js").CodexResponseInputItem[]} */ (firstBody.input), assistantItem, secondUserItem],
    promptCacheKey: "cocopi-language-model",
    clientMetadata: {
      "x-codex-installation-id": "cocopi-test",
      "x-cocopi-session-id": "cocopi-language-model",
      "x-cocopi-source": "language-model",
      "x-cocopi-host-request-index": "2",
      "x-cocopi-turn-id": "cocopi-language-model:2",
      "x-codex-turn-metadata": '{"turn_id":"cocopi-language-model:2"}',
      ws_request_header_traceparent: "traceparent-two",
      ws_request_header_tracestate: "tracestate-two"
    }
  });
  const secondStreamPromise = session.request({
    body: secondBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    },
    onWebSocketRequestPrepared(body) {
      preparedBodies.push(body);
    }
  });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));
  await collectEvents(secondStream);

  const secondWireMessage = JSON.parse(socket.sent[1]);
  assert.equal(secondWireMessage.type, "response.create");
  assert.equal(secondWireMessage.model, "gpt-5-codex");
  assert.equal(secondWireMessage.previous_response_id, "resp-one");
  assert.deepEqual(secondWireMessage.client_metadata, {
    "x-codex-installation-id": "cocopi-test",
    "x-cocopi-session-id": "cocopi-language-model",
    "x-cocopi-source": "language-model",
    "x-cocopi-host-request-index": "2",
    "x-cocopi-turn-id": "cocopi-language-model:2",
    "x-codex-turn-metadata": '{"turn_id":"cocopi-language-model:2"}',
    ws_request_header_traceparent: "traceparent-two",
    ws_request_header_tracestate: "tracestate-two"
  });
  assert.deepEqual(secondWireMessage.input, [secondUserItem]);
  assert.equal(preparedBodies.length, 2);
  assert.equal(preparedBodies[0]?.previous_response_id, undefined);
  assert.deepEqual(preparedBodies[0]?.input, firstBody.input);
  assert.equal(preparedBodies[1]?.previous_response_id, "resp-one");
  assert.deepEqual(preparedBodies[1]?.input, [secondUserItem]);
  assert.deepEqual(decisions, [
    { action: "skipped", reason: "no-prior-request", inputItems: 1, baselineItems: undefined, deltaItems: undefined },
    { action: "used", reason: "matched-prefix", inputItems: 3, baselineItems: 2, deltaItems: 1 }
  ]);
  assert.equal(FakeWebSocket.instances.length, 1);
  session.dispose();
});

test("CodexResponsesWebSocketSession can continue from an older matching anchor", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstUserItem = { role: "user", content: [{ type: "input_text", text: "first" }] };
  const firstAssistantItem = { role: "assistant", content: [{ type: "output_text", text: "first done" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "second branch" }] };
  const secondAssistantItem = { role: "assistant", content: [{ type: "output_text", text: "second done" }] };
  const rewoundUserItem = { role: "user", content: [{ type: "input_text", text: "rewound branch" }] };
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const firstStreamPromise = session.request({ body: firstBody });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-one",
      output: [firstAssistantItem]
    }
  }));
  await firstEventsPromise;

  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem, firstAssistantItem, secondUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const secondStreamPromise = session.request({ body: secondBody });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-two",
      output: [secondAssistantItem]
    }
  }));
  await collectEvents(secondStream);

  const rewoundBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem, firstAssistantItem, rewoundUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const rewoundStreamPromise = session.request({
    body: rewoundBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  const rewoundStream = await rewoundStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-three" } }));
  await collectEvents(rewoundStream);

  const rewoundWireMessage = JSON.parse(socket.sent[2]);
  assert.equal(rewoundWireMessage.previous_response_id, "resp-one");
  assert.deepEqual(rewoundWireMessage.input, [rewoundUserItem]);
  assert.deepEqual(decisions, [
    { action: "used", reason: "matched-prefix", inputItems: 3, baselineItems: 2, deltaItems: 1 }
  ]);

  session.dispose();
});

test("CodexResponsesWebSocketSession keeps restored anchors behind live anchors", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstUserItem = { role: "user", content: [{ type: "input_text", text: "first" }] };
  const firstAssistantItem = { role: "assistant", content: [{ type: "output_text", text: "first done" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
  const secondAssistantItem = { role: "assistant", content: [{ type: "output_text", text: "second done" }] };
  const thirdUserItem = { role: "user", content: [{ type: "input_text", text: "third" }] };
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const firstStreamPromise = session.request({ body: firstBody });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-one",
      output: [firstAssistantItem]
    }
  }));
  await firstEventsPromise;

  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem, firstAssistantItem, secondUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const secondStreamPromise = session.request({ body: secondBody });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-two",
      output: [secondAssistantItem]
    }
  }));
  await collectEvents(secondStream);

  const thirdBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem, firstAssistantItem, secondUserItem, secondAssistantItem, thirdUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const thirdStreamPromise = session.request({
    body: thirdBody,
    continuationAnchors: [{
      request: firstBody,
      responseId: "resp-one",
      itemsAdded: [firstAssistantItem]
    }],
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  const thirdStream = await thirdStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-three" } }));
  await collectEvents(thirdStream);

  const thirdWireMessage = JSON.parse(socket.sent[2]);
  assert.equal(thirdWireMessage.previous_response_id, "resp-two");
  assert.deepEqual(thirdWireMessage.input, [thirdUserItem]);
  assert.deepEqual(decisions, [
    { action: "used", reason: "matched-prefix", inputItems: 5, baselineItems: 4, deltaItems: 1 }
  ]);

  session.dispose();
});

test("CodexResponsesWebSocketSession does not seed cold sessions from restored continuation anchors", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstUserItem = { role: "user", content: [{ type: "input_text", text: "first" }] };
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem, assistantItem, secondUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const streamPromise = session.request({
    body: secondBody,
    continuationAnchors: [{
      request: firstBody,
      responseId: "resp-restored",
      itemsAdded: [assistantItem]
    }],
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const stream = await streamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));
  await collectEvents(stream);

  const wireMessage = JSON.parse(socket.sent[0]);
  assert.equal(wireMessage.previous_response_id, undefined);
  assert.deepEqual(wireMessage.input, secondBody.input);
  assert.deepEqual(decisions, [
    { action: "skipped", reason: "no-prior-request", inputItems: 3, baselineItems: undefined, deltaItems: undefined }
  ]);

  session.dispose();
});

test("CodexResponsesWebSocketSession matches replayed tool calls against raw output items", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstUserItem = { role: "user", content: [{ type: "input_text", text: "inspect" }] };
  const rawToolCallItem = {
    type: "function_call",
    id: "fc-1",
    status: "completed",
    call_id: "call-1",
    name: "read_file",
    arguments: "{\"path\":\"README.md\"}"
  };
  const replayedToolCallItem = {
    type: "function_call",
    call_id: "call-1",
    name: "read_file",
    arguments: "{\"path\":\"README.md\"}"
  };
  const toolOutputItem = { type: "function_call_output", call_id: "call-1", output: "contents" };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "continue" }] };
  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const firstStreamPromise = session.request({
    body: firstBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.output_item.done",
    item_id: "fc-1",
    output_index: 0,
    item: rawToolCallItem
  }));
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-one", output: [] } }));
  await firstEventsPromise;

  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem, replayedToolCallItem, toolOutputItem, secondUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const secondStreamPromise = session.request({
    body: secondBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));
  await collectEvents(secondStream);

  const secondWireMessage = JSON.parse(socket.sent[1]);
  assert.equal(secondWireMessage.previous_response_id, "resp-one");
  assert.deepEqual(secondWireMessage.input, [toolOutputItem, secondUserItem]);
  assert.deepEqual(decisions, [
    { action: "skipped", reason: "no-prior-request", inputItems: 1, baselineItems: undefined, deltaItems: undefined },
    { action: "used", reason: "matched-prefix", inputItems: 4, baselineItems: 2, deltaItems: 2 }
  ]);
  assert.equal(FakeWebSocket.instances.length, 1);
  session.dispose();
});

test("CodexResponsesWebSocketSession continues when client metadata changes", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [{ role: "user", content: [{ type: "input_text", text: "first" }] }],
    promptCacheKey: "cocopi-language-model",
    clientMetadata: {
      "x-codex-installation-id": "cocopi-test",
      route: "one"
    }
  });
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const firstStreamPromise = session.request({ body: firstBody });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-one",
      output: [assistantItem]
    }
  }));
  await firstEventsPromise;

  const fullInput = [.../** @type {import("../data/Codex.js").CodexResponseInputItem[]} */ (firstBody.input), assistantItem, secondUserItem];
  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: fullInput,
    promptCacheKey: "cocopi-language-model",
    clientMetadata: {
      "x-codex-installation-id": "cocopi-test",
      route: "two"
    }
  });
  const secondStreamPromise = session.request({
    body: secondBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));
  await collectEvents(secondStream);

  const secondWireMessage = JSON.parse(socket.sent[1]);
  assert.equal(secondWireMessage.type, "response.create");
  assert.equal(secondWireMessage.previous_response_id, "resp-one");
  assert.deepEqual(secondWireMessage.client_metadata, {
    "x-codex-installation-id": "cocopi-test",
    route: "two"
  });
  assert.deepEqual(secondWireMessage.input, [secondUserItem]);
  assert.deepEqual(decisions, [
    {
      action: "used",
      reason: "matched-prefix",
      inputItems: 3,
      baselineItems: 2,
      deltaItems: 1,
      requestStateChanges: ["client_metadata.changed"]
    }
  ]);
  assert.equal(FakeWebSocket.instances.length, 1);
  session.dispose();
});

test("CodexResponsesWebSocketSession sends full input when replay is shorter than the previous baseline", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [
      { role: "user", content: [{ type: "input_text", text: "first" }] },
      { role: "assistant", content: [{ type: "output_text", text: "kept" }] },
      { role: "user", content: [{ type: "input_text", text: "second" }] }
    ],
    promptCacheKey: "cocopi-language-model"
  });
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const compactedInput = [{ role: "user", content: [{ type: "input_text", text: "compacted" }] }];
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const firstStreamPromise = session.request({ body: firstBody });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-one",
      output: [assistantItem]
    }
  }));
  await firstEventsPromise;

  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: compactedInput,
    promptCacheKey: "cocopi-language-model"
  });
  const secondStreamPromise = session.request({
    body: secondBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));
  await collectEvents(secondStream);

  const secondWireMessage = JSON.parse(socket.sent[1]);
  assert.equal(secondWireMessage.previous_response_id, undefined);
  assert.deepEqual(secondWireMessage.input, compactedInput);
  assert.deepEqual(decisions, [
    { action: "skipped", reason: "input-shorter-than-baseline", inputItems: 1, baselineItems: 4, deltaItems: undefined }
  ]);
  assert.equal(FakeWebSocket.instances.length, 1);
  session.dispose();
});

test("CodexResponsesWebSocketSession diagnoses input prefix mismatches without payload text", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstUserItem = { role: "user", content: [{ type: "input_text", text: "original secret prompt" }] };
  const changedUserItem = { role: "user", content: [{ type: "input_text", text: "changed secret prompt" }] };
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done with secret output" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "continue" }] };
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [firstUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const firstStreamPromise = session.request({ body: firstBody });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-one",
      output: [assistantItem]
    }
  }));
  await firstEventsPromise;

  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [changedUserItem, assistantItem, secondUserItem],
    promptCacheKey: "cocopi-language-model"
  });
  const secondStreamPromise = session.request({
    body: secondBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));
  await collectEvents(secondStream);

  const secondWireMessage = JSON.parse(socket.sent[1]);
  assert.equal(secondWireMessage.previous_response_id, undefined);
  assert.deepEqual(secondWireMessage.input, secondBody.input);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.action, "skipped");
  assert.equal(decisions[0]?.reason, "input-prefix-mismatch");
  assert.equal(decisions[0]?.inputPrefixMatchingItems, 0);
  assert.equal(decisions[0]?.inputPrefixMismatchIndex, 0);
  assert.match(decisions[0]?.inputPrefixExpected ?? "", /message:user:content=1:input_text:text:22ch\/sha256:/u);
  assert.match(decisions[0]?.inputPrefixActual ?? "", /message:user:content=1:input_text:text:21ch\/sha256:/u);
  assert.match(decisions[0]?.inputPrefixExpectedDigest ?? "", /^sha256:[0-9a-f]{12}$/u);
  assert.match(decisions[0]?.inputPrefixActualDigest ?? "", /^sha256:[0-9a-f]{12}$/u);
  assert.doesNotMatch(JSON.stringify(decisions[0]), /original secret prompt|changed secret prompt|secret output/u);

  session.dispose();
});

test("CodexResponsesWebSocketSession continues when instructions change", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [{ role: "user", content: [{ type: "input_text", text: "first" }] }],
    instructions: "Initial instructions.",
    promptCacheKey: "cocopi-language-model"
  });
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const firstStreamPromise = session.request({ body: firstBody });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-one",
      output: [assistantItem]
    }
  }));
  await firstEventsPromise;

  const fullInput = [.../** @type {import("../data/Codex.js").CodexResponseInputItem[]} */ (firstBody.input), assistantItem, secondUserItem];
  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: fullInput,
    instructions: "Changed instructions.",
    promptCacheKey: "cocopi-language-model"
  });
  const secondStreamPromise = session.request({
    body: secondBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));
  await collectEvents(secondStream);

  const secondWireMessage = JSON.parse(socket.sent[1]);
  assert.equal(secondWireMessage.type, "response.create");
  assert.equal(secondWireMessage.previous_response_id, "resp-one");
  assert.equal(secondWireMessage.instructions, "Changed instructions.");
  assert.deepEqual(secondWireMessage.input, [secondUserItem]);
  assert.deepEqual(decisions, [
    {
      action: "used",
      reason: "matched-prefix",
      inputItems: 3,
      baselineItems: 2,
      deltaItems: 1,
      requestStateChanges: ["instructions.changed"]
    }
  ]);
  assert.equal(FakeWebSocket.instances.length, 1);
  session.dispose();
});

test("CodexResponsesWebSocketSession continues through tool request state changes", async () => {
  FakeWebSocket.reset();
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    conversationId: "cocopi-language-model",
    WebSocketConstructor: fakeWebSocketConstructor()
  });
  const firstBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [{ role: "user", content: [{ type: "input_text", text: "first" }] }],
    tools: [{ type: "function", name: "activate_cmake_project_management_tools", parameters: { type: "object", properties: {} } }],
    promptCacheKey: "cocopi-language-model"
  });
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const secondUserItem = { role: "user", content: [{ type: "input_text", text: "second" }] };
  /** @type {import("../data/Codex.js").CodexPreviousResponseDecision[]} */
  const decisions = [];

  const firstStreamPromise = session.request({ body: firstBody });
  await nextMicrotask();
  const socket = FakeWebSocket.single();
  socket.open();
  const firstEventsPromise = collectEvents(await firstStreamPromise);
  socket.message(JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-one",
      output: [assistantItem]
    }
  }));
  await firstEventsPromise;

  const secondBody = buildTextResponseBody({
    model: "gpt-5-codex",
    input: [.../** @type {import("../data/Codex.js").CodexResponseInputItem[]} */ (firstBody.input), assistantItem, secondUserItem],
    tools: [{ type: "function", name: "Build_CMakeTools", parameters: { type: "object", properties: {} } }],
    promptCacheKey: "cocopi-language-model"
  });
  const secondStreamPromise = session.request({
    body: secondBody,
    onWebSocketContinuationDecision(decision) {
      decisions.push(decision);
    }
  });
  const secondStream = await secondStreamPromise;
  socket.message(JSON.stringify({ type: "response.completed", response: { id: "resp-two" } }));
  await collectEvents(secondStream);

  const secondWireMessage = JSON.parse(socket.sent[1]);
  assert.equal(secondWireMessage.previous_response_id, "resp-one");
  assert.deepEqual(secondWireMessage.input, [secondUserItem]);
  assert.deepEqual(secondWireMessage.tools, secondBody.tools);
  assert.deepEqual(decisions, [
    {
      action: "used",
      reason: "matched-prefix",
      inputItems: 3,
      baselineItems: 2,
      deltaItems: 1,
      requestStateChanges: [
        "tools.added:Build_CMakeTools",
        "tools.removed:activate_cmake_project_management_tools"
      ]
    }
  ]);
  session.dispose();
});

/**
 * @param {ReadableStream<CodexResponseStreamEvent>} stream
 */
async function collectEvents(stream) {
  /** @type {CodexResponseStreamEvent[]} */
  const output = [];
  for await (const event of stream) {
    output.push(event);
  }
  return output;
}

async function nextMicrotask() {
  await Promise.resolve();
}

/** @param {number} count */
async function waitForFakeWebSocketCount(count) {
  for (let index = 0; index < 20 && FakeWebSocket.instances.length < count; index += 1) {
    await nextMicrotask();
  }

  assert.equal(FakeWebSocket.instances.length, count);
}

/**
 * @param {string[]} chunks
 */
function eventStreamResponse(chunks) {
  return new Response(readableStreamFromChunks(chunks), {
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
 * @param {string[]} chunks
 */
function readableStreamFromChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

/**
 * @returns {typeof WebSocket}
 */
function fakeWebSocketConstructor() {
  // eslint-disable-next-line jsdoc/check-types -- The test double intentionally implements only the WebSocket members this module uses.
  return /** @type {typeof WebSocket} */ (/** @type {unknown} */ (FakeWebSocket));
}

/**
 * @param {import("node:test").TestContext} testContext
 * @param {typeof WebSocket} WebSocketConstructor
 */
function replaceGlobalWebSocket(testContext, WebSocketConstructor) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: WebSocketConstructor
  });
  testContext.after(() => {
    if (descriptor) {
      Object.defineProperty(globalThis, "WebSocket", descriptor);
    }
  });
}

function fakeSecretContext() {
  return {
    secrets: {
      /** @returns {Promise<string | undefined>} */
      async get() {
        return process.env.__COCOPI_TEST_MISSING_SECRET;
      },
      /** @returns {Promise<void>} */
      async store() {},
      /** @returns {Promise<void>} */
      async delete() {}
    }
  };
}

/**
 * @param {{ transport: "sse" | "websocket" }} options
 * @returns {import("../lib/vscode/runtime.js").CocopiRuntime}
 */
function fakeRuntime(options) {
  return {
    configuration: {
      apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      model: "gpt-5-codex",
      authMode: "secretStorage",
      serviceTier: "auto",
      reasoningEffort: "default",
      reasoningSummary: "auto",
      chatParticipantModelSource: "selected",
      transport: options.transport,
      debugLevel: "off",
      issueTracking: true,
      tokenTracking: true,
      showTokenTrackerTimeline: true,
      tokenTrackerTimelineDays: 7,
      tokenTrackerTimelineMode: "both",
      toolStrict: true,
      chatInstructions: "",
      chatInstructionsMode: "optional",
      chatInstructionsRegexPattern: "",
      chatInstructionsRegexReplacement: "",
      chatInstructionsRegexFlags: "g",
      editProgressIntervalMs: 30_000,
      streamIdleTimeoutMs: 120_000,
      useModelDefaultCompactionLimit: true,
      compactionFallbackStrategy: "ninety-percent"
    },
    auth: {
      accessToken: "access-token",
      chatgptAccountId: "account-id",
      chatgptPlanType: "plus"
    },
    clientVersion: "test"
  };
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  /** @type {FakeWebSocket[]} */
  static instances = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  static single() {
    assert.equal(FakeWebSocket.instances.length, 1);
    return FakeWebSocket.instances[0];
  }

  /** @type {string} */
  url;

  /** @type {{ headers?: Record<string, string> } | undefined} */
  init;

  /** @type {number} */
  readyState = FakeWebSocket.CONNECTING;

  /** @type {string[]} */
  sent = [];

  /** @type {Array<{ code?: number, reason?: string }>} */
  closeCalls = [];

  /**
   * @param {string | URL} url
   * @param {{ headers?: Record<string, string> }} [init]
   */
  constructor(url, init) {
    super();
    this.url = String(url);
    this.init = init;
    FakeWebSocket.instances.push(this);
  }

  get CONNECTING() {
    return FakeWebSocket.CONNECTING;
  }

  get OPEN() {
    return FakeWebSocket.OPEN;
  }

  get CLOSING() {
    return FakeWebSocket.CLOSING;
  }

  get CLOSED() {
    return FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** @param {string} data */
  send(data) {
    this.sent.push(data);
  }

  /**
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeCalls.push({ code, reason });
  }

  /** @param {string} data */
  message(data) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }

  error() {
    this.dispatchEvent(new Event("error"));
  }

  /**
   * @param {number} code
   * @param {string} reason
   */
  serverClose(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    Object.defineProperty(event, "reason", { value: reason });
    this.dispatchEvent(event);
  }
}
