import test from "node:test";
import assert from "node:assert/strict";

import { COCOPI_RESPONSE_ITEMS_METADATA_KEY, COCOPI_SESSION_ID_METADATA_KEY } from "../lib/vscode/chat-history.js";
import { COCOPI_CHAT_PARTICIPANT_ID, chatParticipantModelForRequest, createCocopiChatRequestHandler, registerCocopiChatParticipant } from "../lib/vscode/chat-participant.js";
import { clearCocopiIssues, readCocopiIssues } from "../lib/vscode/issues.js";
import { CODEX_SECRET_KEYS } from "../lib/vscode/secret-storage.js";
import { clearCocopiTokenCacheDebugSummaries, readCocopiTokenCacheDebugSummaries } from "../lib/vscode/token-cache-debug.js";

class ChatResponseThinkingProgressPart {
  /**
   * @param {string | string[]} value
   * @param {string} [id]
   * @param {Record<string, unknown>} [metadata]
   */
  constructor(value, id, metadata) {
    this.value = value;
    this.id = id;
    this.metadata = metadata;
  }
}

test("registerCocopiChatParticipant registers the Cocopi chat participant", () => {
  const context = fakeContext();
  const vscode = fakeVscode();

  registerCocopiChatParticipant(context, vscode);

  assert.equal(vscode.chatParticipantId, COCOPI_CHAT_PARTICIPANT_ID);
  assert.equal(vscode.outputChannelName, "Cocopi");
  assert.equal(context.subscriptions.length, 2);
});

test("Cocopi chat handler sends slash-prefixed fast text as a regular prompt", async (testContext) => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const prompt = `/${"fast"}`;
  const response = fakeChatResponseStream();
  const configuration = configurationValues({ serviceTier: "auto" });
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({
      url: String(url),
      options: /** @type {RequestInit & { headers: Record<string, string>, body?: string | null }} */ (options)
    });
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "handled" }),
      sseData({ type: "response.completed", response: { id: "resp-test" } })
    ]);
  }));
  const handler = createCocopiChatRequestHandler(context, fakeVscode(configuration));

  await Promise.resolve(handler(fakeChatRequest(prompt), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, ["handled"]);
  assert.equal(calls.length, 1);
  assert.equal(configuration.get("serviceTier"), "auto");
  const body = JSON.parse(String(calls[0].options.body));
  assert.equal(body.input[0].content[0].text, prompt);
  assert.equal(body.service_tier, undefined);
});

test("Cocopi chat handler streams Codex text deltas", async (testContext) => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
  ]));
  const response = fakeChatResponseStream();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({
      url: String(url),
      options: /** @type {RequestInit & { headers: Record<string, string>, body?: string | null }} */ (options)
    });
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "hel" }),
      sseData({ type: "response.output_text.delta", delta: "lo" }),
      sseData({ type: "response.completed", response: { id: "resp-test" } })
    ]);
  }));
  const handler = createCocopiChatRequestHandler(context, fakeVscode(configurationValues({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex/",
    model: "gpt-test",
    serviceTier: "priority",
    streamIdleTimeoutMs: 5000
  })));

  await Promise.resolve(handler(fakeChatRequest(" say hello ", { model: { id: "gpt-selected", vendor: "cocopi" } }), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, ["hel", "lo"]);
  assert.equal(calls[0].url, "https://chatgpt.example.test/backend-api/codex/responses");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0].options.headers["ChatGPT-Account-ID"], "account-id");
  assert.equal(calls[0].options.signal?.aborted, false);
  const body = JSON.parse(String(calls[0].options.body));
  assert.equal(body.model, "gpt-selected");
  assert.equal(body.instructions, undefined);
  assert.equal(body.service_tier, "priority");
  assert.equal(body.reasoning, undefined);
  assert.equal(body.input[0].content[0].text, "say hello");
  assert.equal(body.client_metadata["x-cocopi-source"], "chat");
  assert.equal(body.client_metadata["x-cocopi-host-request-index"], "1");
  assert.equal(body.client_metadata["x-cocopi-turn-id"], `${body.prompt_cache_key}:1`);
  assert.equal(body.client_metadata["x-codex-turn-metadata"], undefined);
  assert.deepEqual(JSON.parse(calls[0].options.headers["x-codex-turn-metadata"]), {
    turn_id: `${body.prompt_cache_key}:1`,
    thread_source: "vscode",
    client: "cocopi",
    source: "chat"
  });
});

test("Cocopi chat handler streams reasoning summary deltas", async (testContext) => {
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const response = fakeChatResponseStream();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Looking up context." }),
    sseData({ type: "response.completed", response: { id: "resp-test" } })
  ])));
  const handler = createCocopiChatRequestHandler(context, fakeVscode(configurationValues({ model: "gpt-test" })));

  await Promise.resolve(handler(fakeChatRequest("inspect"), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, ["Looking up context."]);
});

test("Cocopi chat handler streams reasoning summary deltas as thinking parts when supported", async (testContext) => {
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const response = fakeChatResponseStream();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, sequence_number: 7, delta: "Looking up context." }),
    sseData({ type: "response.completed", response: { id: "resp-test" } })
  ])));
  const handler = createCocopiChatRequestHandler(context, fakeVscode(configurationValues({ model: "gpt-test" }), { chatThinkingPart: true }));

  await Promise.resolve(handler(fakeChatRequest("inspect"), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, []);
  const [part] = response.pushedParts;
  assert.ok(part instanceof ChatResponseThinkingProgressPart);
  assert.equal(part.value, "Looking up context.");
  assert.equal(part.id, "rs-1:0");
  assert.deepEqual(part.metadata, {
    openai_event_type: "response.reasoning_summary_text.delta",
    openai_item_id: "rs-1",
    openai_output_index: 0,
    openai_summary_index: 0,
    openai_sequence_number: 7
  });
});

test("Cocopi chat handler streams follow-up reasoning as thinking parts when supported", async (testContext) => {
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }), { chatThinkingPart: true });
  vscode.lm.tools = [{
    name: "read_file",
    description: "Read a workspace file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    tags: []
  }];
  const response = fakeChatResponseStream();
  let requestCount = 0;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    requestCount += 1;
    return requestCount === 1
      ? eventStreamResponse([
        sseData({ type: "response.function_call_arguments.done", item_id: "item-1", output_index: 0, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) }),
        sseData({ type: "response.completed", response: {} })
      ])
      : eventStreamResponse([
        sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-2", output_index: 0, summary_index: 0, delta: "Reviewing tool output." }),
        sseData({ type: "response.completed", response: {} })
      ]);
  }));
  const handler = createCocopiChatRequestHandler(context, vscode);

  await Promise.resolve(handler(fakeChatRequest("read package", { toolReferences: [{ name: "read_file" }] }), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, []);
  assert.deepEqual(response.pushedParts.filter((part) => part instanceof ChatResponseThinkingProgressPart).map((part) => part.value), ["Reviewing tool output."]);
});

test("Cocopi chat handler logs token/cache summaries for successful responses", async (testContext) => {
  const calls = [];
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const response = fakeChatResponseStream();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    calls.push(options);
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "hello" }),
      sseData({ type: "response.completed", response: { id: "resp-summary", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 2, total_tokens: 102 } } })
    ]);
  }));
  const handler = createCocopiChatRequestHandler(context, fakeVscode(configurationValues({ debugLevel: "metadata" })), { logger });

  await handler(
    fakeChatRequest(" say hello ", { model: { id: "gpt-selected", vendor: "cocopi" } }),
    fakeChatContext(),
    response,
    fakeCancellationToken()
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(response.markdownValues, ["hello"]);
  assert.ok(logger.debugMessages.some((message) => /Codex token\/cache summary\./u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /source=chat/u.test(message) && /hostRequest=1/u.test(message) && /cacheHitRatio=40.0/u.test(message)));
});

test("Cocopi chat handler includes conversation metadata in token/cache summary logs", async (testContext) => {
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const response = fakeChatResponseStream();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "hello" }),
    sseData({ type: "response.completed", response: { id: "resp-summary", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 2, total_tokens: 102 } } })
  ])));
  const handler = createCocopiChatRequestHandler(context, fakeVscode(configurationValues({ debugLevel: "metadata" })), { logger });

  await handler(
    fakeChatRequest(" say hello ", { model: { id: "gpt-selected", vendor: "cocopi" } }),
    fakeChatContext(),
    response,
    fakeCancellationToken()
  );

  assert.ok(
    logger.debugMessages.some((message) => /conversationSummary=102_tokens.*in=100/u.test(message) && /conversationDescription=say_hello/u.test(message) && /out=2/u.test(message)),
    "Expected billed token summary with input/output breakdown and prompt as conversation summary and description in token/cache summary logs"
  );
});

test("chatParticipantModelForRequest defaults to VS Code's selected Cocopi model", () => {
  assert.equal(chatParticipantModelForRequest(fakeChatRequest("hello", { model: { id: "gpt-selected", vendor: "cocopi" } }), fakeConfiguration()), "gpt-selected");
});

test("chatParticipantModelForRequest can force the configured Cocopi model", () => {
  assert.equal(chatParticipantModelForRequest(fakeChatRequest("hello", { model: { id: "gpt-selected", vendor: "cocopi" } }), fakeConfiguration({ chatParticipantModelSource: "configured" })), "gpt-configured");
});

test("chatParticipantModelForRequest ignores non-Cocopi selected models", () => {
  assert.equal(chatParticipantModelForRequest(fakeChatRequest("hello", { model: { id: "gpt-other", vendor: "copilot" } }), fakeConfiguration()), "gpt-configured");
});

test("Cocopi chat handler refreshes and retries after 401", async (testContext) => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, "old-access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "old-refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "old-id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
  ]);
  const context = fakeContext(secrets);
  const response = fakeChatResponseStream();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({
      url: String(url),
      options: /** @type {RequestInit & { headers: Record<string, string>, body?: string | null }} */ (options)
    });

    if (String(url).endsWith("/oauth/token")) {
      return Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        id_token: "new-id-token"
      });
    }

    return calls.filter((call) => call.url.endsWith("/responses")).length === 1
      ? Response.json({ error: { message: "expired" } }, { status: 401 })
      : eventStreamResponse([
        sseData({ type: "response.output_text.delta", delta: "retried" }),
        sseData({ type: "response.completed", response: {} })
      ]);
  }));
  const handler = createCocopiChatRequestHandler(context, fakeVscode(configurationValues({ model: "gpt-test" })));

  await Promise.resolve(handler(fakeChatRequest("hello"), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, ["retried"]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer old-access-token");
  assert.equal(calls[2].options.headers.Authorization, "Bearer new-access-token");
  assert.equal(secrets.get(CODEX_SECRET_KEYS.accessToken), "new-access-token");
  assert.equal(secrets.get(CODEX_SECRET_KEYS.refreshToken), "new-refresh-token");
});

test("Cocopi chat handler includes prior chat history in Codex input", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([sseData({ type: "response.completed", response: {} })]);
  }));
  const handler = createCocopiChatRequestHandler(context, fakeVscode());

  await Promise.resolve(handler(
    fakeChatRequest("follow up"),
    fakeChatContext([
      fakeRequestTurn("what happened first?"),
      fakeResponseTurn("it worked")
    ]),
    fakeChatResponseStream(),
    fakeCancellationToken()
  ));

  assert.deepEqual(JSON.parse(String(requestOptions?.body)).input, [
    { role: "user", content: [{ type: "input_text", text: "what happened first?" }] },
    { role: "assistant", content: [{ type: "output_text", text: "it worked" }] },
    { role: "user", content: [{ type: "input_text", text: "follow up" }] }
  ]);
});

test("Cocopi chat handler reuses persisted conversation metadata from history", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const sessionId = "cocopi-chat-11111111-1111-4111-8111-111111111111";
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.completed", response: { id: "resp-metadata", usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } })
    ]);
  }));
  const handler = createCocopiChatRequestHandler(
    context,
    fakeVscode(configurationValues({ model: "gpt-test", debugLevel: "metadata" })),
    { logger }
  );

  await Promise.resolve(handler(
    fakeChatRequest("follow-up test"),
    fakeChatContext([
      fakeResponseTurn("previous answer", {
        metadata: {
          [COCOPI_SESSION_ID_METADATA_KEY]: sessionId,
          [COCOPI_RESPONSE_ITEMS_METADATA_KEY]: [{
            type: "reasoning",
            id: "rs-1",
            summary: [],
            encrypted_content: "encrypted-thinking",
            phase: "tool_use"
          }]
        }
      })
    ]),
    fakeChatResponseStream(),
    fakeCancellationToken()
  ));

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.prompt_cache_key, sessionId);
  assert.deepEqual(body.input, [
    { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "encrypted-thinking", phase: "tool_use" },
    { role: "assistant", content: [{ type: "output_text", text: "previous answer" }] },
    { role: "user", content: [{ type: "input_text", text: "follow-up test" }] }
  ]);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
});

test("Cocopi chat handler replays prior hidden response items from chat metadata", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const sessionId = "cocopi-chat-00000000-0000-4000-8000-000000000001";
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "Still Cocopi." }),
      sseData({ type: "response.completed", response: {} })
    ]);
  }));
  const handler = createCocopiChatRequestHandler(context, fakeVscode(configurationValues({ model: "gpt-test" })));

  await Promise.resolve(handler(
    fakeChatRequest("what did it say?"),
    fakeChatContext([
      fakeRequestTurn("read package"),
      fakeResponseTurn("Cocopi package.", {
        metadata: {
          [COCOPI_SESSION_ID_METADATA_KEY]: sessionId,
          [COCOPI_RESPONSE_ITEMS_METADATA_KEY]: [
            { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "encrypted-thinking" },
            { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
            { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) }
          ]
        }
      })
    ]),
    fakeChatResponseStream(),
    fakeCancellationToken()
  ));

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.prompt_cache_key, sessionId);
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "read package" }] },
    { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "encrypted-thinking" },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
    { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) },
    { role: "assistant", content: [{ type: "output_text", text: "Cocopi package." }] },
    { role: "user", content: [{ type: "input_text", text: "what did it say?" }] }
  ]);
});

test("Cocopi chat handler replays reasoning through consecutive tool calls", async (testContext) => {
  /** @type {RequestInit[]} */
  const requestOptions = [];
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }));
  vscode.lm.tools = [{
    name: "read_file",
    description: "Read a workspace file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    tags: []
  }];
  const response = fakeChatResponseStream();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions.push(options);
    if (requestOptions.length === 1) {
      return eventStreamResponse([
        sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "encrypted-one" } }),
        sseData({ type: "response.function_call_arguments.done", item_id: "item-1", output_index: 1, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) }),
        sseData({ type: "response.completed", response: {} })
      ]);
    }

    if (requestOptions.length === 2) {
      return eventStreamResponse([
        sseData({ type: "response.output_item.done", item_id: "rs-2", output_index: 0, item: { type: "reasoning", id: "rs-2", summary: [], encrypted_content: "encrypted-two" } }),
        sseData({ type: "response.function_call_arguments.done", item_id: "item-2", output_index: 1, call_id: "call-2", name: "read_file", arguments: jsonString({ path: "README.md" }) }),
        sseData({ type: "response.completed", response: {} })
      ]);
    }

    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "Done." }),
      sseData({ type: "response.completed", response: {} })
    ]);
  }));
  const handler = createCocopiChatRequestHandler(context, vscode);

  await Promise.resolve(handler(
    fakeChatRequest("read two files", { toolReferences: [{ name: "read_file" }], toolInvocationToken: "tool-token" }),
    fakeChatContext(),
    response,
    fakeCancellationToken()
  ));

  assert.deepEqual(vscode.toolInvocations, [
    { name: "read_file", options: { toolInvocationToken: "tool-token", input: { path: "package.json" } } },
    { name: "read_file", options: { toolInvocationToken: "tool-token", input: { path: "README.md" } } }
  ]);
  assert.deepEqual(response.progressValues, [
    "Running read_file.",
    "Running read_file."
  ]);
  assert.deepEqual(response.markdownValues, ["Done."]);

  const firstToolBody = JSON.parse(String(requestOptions[0].body));
  assert.equal(firstToolBody.tool_choice, "required");
  assert.equal(firstToolBody.stream, true);
  assert.deepEqual(firstToolBody.tools, [{
    type: "function",
    name: "read_file",
    description: "Read a workspace file.",
    parameters: { additionalProperties: false, type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    strict: true
  }]);
  assert.equal(/** @type {Record<string, string>} */ (requestOptions[0].headers).Accept, "text/event-stream");
  const secondToolBody = JSON.parse(String(requestOptions[1].body));
  assert.equal(secondToolBody.tool_choice, "auto");
  assert.equal(secondToolBody.stream, true);
  assert.equal(/** @type {Record<string, string>} */ (requestOptions[1].headers).Accept, "text/event-stream");
  const finalFollowUpBody = JSON.parse(String(requestOptions[2].body));
  assert.equal(finalFollowUpBody.tool_choice, "auto");
  assert.equal(finalFollowUpBody.stream, true);
  assert.equal(/** @type {Record<string, string>} */ (requestOptions[2].headers).Accept, "text/event-stream");
  assert.deepEqual(finalFollowUpBody.input, [
    { role: "user", content: [{ type: "input_text", text: "read two files" }] },
    { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "encrypted-one" },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
    { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) },
    { type: "reasoning", id: "rs-2", summary: [], encrypted_content: "encrypted-two" },
    { type: "function_call", call_id: "call-2", name: "read_file", arguments: jsonString({ path: "README.md" }) },
    { type: "function_call_output", call_id: "call-2", output: jsonString({ name: "cocopi" }) }
  ]);
  assert.deepEqual(finalFollowUpBody.include, ["reasoning.encrypted_content"]);
});

test("Cocopi chat handler logs payloads for follow-up request failures", async (testContext) => {
  /** @type {RequestInit[]} */
  const requestOptions = [];
  const logger = fakeLogger();
  const response = fakeChatResponseStream();
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const vscode = fakeVscode(configurationValues({ model: "gpt-test", debugLevel: "payloads" }));
  vscode.lm.tools = [{
    name: "read_file",
    description: "Read a workspace file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    tags: []
  }];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions.push(options);
    if (requestOptions.length === 1) {
      return eventStreamResponse([
        sseData({ type: "response.function_call_arguments.done", item_id: "item-1", output_index: 0, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) }),
        sseData({ type: "response.completed", response: {} })
      ]);
    }

    return Response.json({ error: { message: "follow-up failed" } }, {
      status: 400,
    });
  }));
  const handler = createCocopiChatRequestHandler(context, vscode, { logger });

  await Promise.resolve(handler(
    fakeChatRequest("read package", { toolReferences: [{ name: "read_file" }], toolInvocationToken: "tool-token" }),
    fakeChatContext(),
    response,
    fakeCancellationToken()
  ));

  assert.equal(requestOptions.length, 2);
  assert.deepEqual(response.markdownValues, ["Cocopi request failed. See the Cocopi output channel for details."]);
  assert.equal(logger.errorMessages[0]?.message, "Chat request failed.");
  assert.ok(logger.debugMessages.some((message) => /Codex request payload on error\./u.test(message)
    && /stage=follow-up-failure/u.test(message)
    && /function_call_output/u.test(message)
    && /package\.json/u.test(message)));
});

test("Cocopi chat handler pins blank runSubagent model input", async (testContext) => {
  /** @type {RequestInit[]} */
  const requestOptions = [];
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const vscode = fakeVscode(configurationValues({ model: "gpt-configured" }));
  vscode.lm.tools = [{
    name: "runSubagent",
    description: "Run a subagent.",
    inputSchema: { type: "object" },
    tags: []
  }];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions.push(options);
    if (requestOptions.length === 1) {
      return eventStreamResponse([
        sseData({ type: "response.function_call_arguments.done", item_id: "item-1", output_index: 0, call_id: "call-1", name: "runSubagent", arguments: jsonString({ description: "Search code", model: "", prompt: "Find the relevant files" }) }),
        sseData({ type: "response.completed", response: {} })
      ]);
    }

    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "Done." }),
      sseData({ type: "response.completed", response: {} })
    ]);
  }));
  const handler = createCocopiChatRequestHandler(context, vscode);

  await Promise.resolve(handler(
    fakeChatRequest("delegate it", { toolReferences: [{ name: "runSubagent" }], toolInvocationToken: "tool-token", model: { id: "gpt-5.5", name: "GPT-5.5", vendor: "cocopi" } }),
    fakeChatContext(),
    fakeChatResponseStream(),
    fakeCancellationToken()
  ));

  assert.deepEqual(vscode.toolInvocations, [
    {
      name: "runSubagent",
      options: {
        toolInvocationToken: "tool-token",
        input: {
          description: "Search code",
          model: "GPT-5.5 (cocopi)",
          prompt: "Find the relevant files"
        }
      }
    }
  ]);

  const followUpBody = JSON.parse(String(requestOptions[1].body));
  assert.deepEqual(followUpBody.input, [
    { role: "user", content: [{ type: "input_text", text: "delegate it" }] },
    { type: "function_call", call_id: "call-1", name: "runSubagent", arguments: jsonString({ description: "Search code", model: "GPT-5.5 (cocopi)", prompt: "Find the relevant files" }) },
    { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) }
  ]);
});

test("Cocopi chat handler passes cancellation to tool invocation", async (testContext) => {
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }));
  vscode.lm.tools = [{ name: "read_file", description: "Read a workspace file.", inputSchema: undefined, tags: [] }];
  const token = fakeCancellationToken();
  /** @type {import("vscode").CancellationToken | undefined} */
  let invocationToken;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.function_call_arguments.done", item_id: "item-1", output_index: 0, call_id: "call-1", name: "read_file", arguments: jsonString({}) }),
    sseData({ type: "response.completed", response: {} })
  ])));
  const handler = createCocopiChatRequestHandler(context, vscode);
  /**
   * @param {string} _name
   * @param {import("vscode").LanguageModelToolInvocationOptions<object>} _options
   * @param {import("vscode").CancellationToken} cancellationToken
   */
  vscode.lm.invokeTool = async (_name, _options, cancellationToken) => {
    invocationToken = cancellationToken;
    token.cancel();
    throw new Error("tool cancelled");
  };
  const response = fakeChatResponseStream();

  await Promise.resolve(handler(
    fakeChatRequest("read package", { toolReferences: [{ name: "read_file" }], toolInvocationToken: "tool-token" }),
    fakeChatContext(),
    response,
    token
  ));

  assert.equal(invocationToken, token);
  assert.deepEqual(response.progressValues, ["Running read_file."]);
  assert.deepEqual(response.markdownValues, ["Cocopi request was cancelled."]);
});

test("Cocopi chat handler stops after tool invocation cancellation", async (testContext) => {
  /** @type {RequestInit[]} */
  const requestOptions = [];
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }));
  vscode.lm.tools = [{ name: "read_file", description: "Read a workspace file.", inputSchema: undefined, tags: [] }];
  const token = fakeCancellationToken();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions.push(options);
    return eventStreamResponse([
      sseData({ type: "response.function_call_arguments.done", item_id: "item-1", output_index: 0, call_id: "call-1", name: "read_file", arguments: jsonString({}) }),
      sseData({ type: "response.completed", response: {} })
    ]);
  }));
  vscode.lm.invokeTool = async () => {
    token.cancel();
    return {
      content: [{ value: jsonString({ name: "cocopi" }) }]
    };
  };
  const handler = createCocopiChatRequestHandler(context, vscode, { logger });
  const response = fakeChatResponseStream();

  await Promise.resolve(handler(
    fakeChatRequest("read package", { toolReferences: [{ name: "read_file" }], toolInvocationToken: "tool-token" }),
    fakeChatContext(),
    response,
    token
  ));

  assert.equal(requestOptions.length, 1);
  assert.deepEqual(response.progressValues, ["Running read_file."]);
  assert.deepEqual(response.markdownValues, ["Cocopi request was cancelled."]);
  assert.ok(logger.infoMessages.some((message) => /VS Code cancellation event received\. source=chat/u.test(message)));
  assert.deepEqual(logger.errorMessages, []);
});

test("Cocopi chat handler reports tool invocation failures without follow-up request", async (testContext) => {
  /** @type {RequestInit[]} */
  const requestOptions = [];
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }));
  vscode.lm.tools = [{ name: "read_file", description: "Read a workspace file.", inputSchema: undefined, tags: [] }];
  vscode.lm.invokeTool = async () => {
    throw new Error("tool exploded");
  };
  const response = fakeChatResponseStream();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions.push(options);
    return eventStreamResponse([
      sseData({ type: "response.function_call_arguments.done", item_id: "item-1", output_index: 0, call_id: "call-1", name: "read_file", arguments: jsonString({}) }),
      sseData({ type: "response.completed", response: {} })
    ]);
  }));
  const handler = createCocopiChatRequestHandler(context, vscode, { logger });

  await Promise.resolve(handler(
    fakeChatRequest("read package", { toolReferences: [{ name: "read_file" }], toolInvocationToken: "tool-token" }),
    fakeChatContext(),
    response,
    fakeCancellationToken()
  ));

  assert.equal(requestOptions.length, 1);
  assert.deepEqual(response.progressValues, ["Running read_file."]);
  assert.deepEqual(response.markdownValues, ["Cocopi request failed. See the Cocopi output channel for details."]);
  assert.equal(logger.errorMessages[0]?.message, "Chat request failed.");
  assert.match(String(logger.errorMessages[0]?.error), /tool exploded/u);
});

test("Cocopi chat handler reports signed-out state", async () => {
  const response = fakeChatResponseStream();
  const logger = fakeLogger();
  const handler = createCocopiChatRequestHandler(fakeContext(), fakeVscode(), { logger });

  await Promise.resolve(handler(fakeChatRequest("hello"), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, ["Cocopi is not signed in."]);
  assert.deepEqual(logger.infoMessages, ["Chat request skipped because Cocopi is not signed in."]);
});

test("Cocopi chat handler maps VS Code cancellation to friendly chat output", async (testContext) => {
  /** @type {AbortSignal | undefined} */
  let requestSignal;
  const token = fakeCancellationToken();
  const response = fakeChatResponseStream();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestSignal = options.signal ?? undefined;
    token.cancel();
    return eventStreamResponse([sseData({ type: "response.completed", response: {} })]);
  }));
  const handler = createCocopiChatRequestHandler(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(), { logger });

  await Promise.resolve(handler(fakeChatRequest("hello"), fakeChatContext(), response, token));

  assert.equal(requestSignal?.aborted, true);
  assert.deepEqual(response.markdownValues, ["Cocopi request was cancelled."]);
  assert.ok(logger.infoMessages.some((message) => /VS Code cancellation event received\. source=chat/u.test(message)));
  assert.deepEqual(logger.errorMessages, []);
});

test("Cocopi chat handler reports request failures without exposing details in chat", async (testContext) => {
  clearCocopiIssues();
  clearCocopiTokenCacheDebugSummaries();
  const response = fakeChatResponseStream();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("Bearer access-token failed");
  }));
  const handler = createCocopiChatRequestHandler(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(), { logger });

  await Promise.resolve(handler(fakeChatRequest("hello"), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, ["Cocopi request failed. See the Cocopi output channel for details."]);
  assert.equal(logger.errorMessages[0]?.message, "Chat request failed.");
  assert.match(String(logger.errorMessages[0]?.error), /Bearer access-token failed/u);
  const summaries = readCocopiTokenCacheDebugSummaries();
  assert.equal(summaries.length, 0);
  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "token-cache");
  assert.equal(issues[0].title, "Codex request did not include usage counters");
  assert.equal(issues[0].metadata.source, "chat");
});

test("Cocopi chat handler records issues for missing instructions errors", async (testContext) => {
  clearCocopiIssues();
  const response = fakeChatResponseStream();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("Codex Responses WebSocket request failed; with status 400; message=Instructions are required");
  }));
  const handler = createCocopiChatRequestHandler(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await Promise.resolve(handler(fakeChatRequest("hello"), fakeChatContext(), response, fakeCancellationToken()));

  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "response-stream");
  assert.equal(issues[0].metadata.source, "chat");
  assert.equal(issues[0].metadata.transport, "sse");
  assert.equal(issues[0].metadata.hasTopLevelInstructions, false);
});

test("Cocopi chat handler logs response diagnostics and reports terminal failures", async (testContext) => {
  clearCocopiTokenCacheDebugSummaries();
  const response = fakeChatResponseStream();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.completed", response: { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 6 } }, new_field: true } }),
    sseData({ type: "response.incomplete", response: { id: "resp-test" } })
  ])));
  const handler = createCocopiChatRequestHandler(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ debugLevel: "metadata" })), { logger });

  await Promise.resolve(handler(fakeChatRequest("hello"), fakeChatContext(), response, fakeCancellationToken()));

  assert.deepEqual(response.markdownValues, ["Cocopi request failed. See the Cocopi output channel for details."]);
  assert.equal(logger.errorMessages[0]?.message, "Chat request failed.");
  assert.match(String(logger.errorMessages[0]?.error), /Codex response incomplete/u);
  assert.equal(logger.debugMessages.length, 2);
  assert.match(logger.debugMessages[0], /Codex request input/u);
  assert.match(logger.debugMessages[0], /inputItems=1/u);
  assert.match(logger.debugMessages[1], /unknownKeys=new_field/u);
  assert.match(logger.debugMessages[1], /cachedTokens=6/u);
  const summaries = readCocopiTokenCacheDebugSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].cacheStatus, "hit");
  assert.equal(summaries[0].inputTokens, 10);
  assert.equal(summaries[0].cachedTokens, 6);
});

/**
 * @param {Map<string, string>} [secrets]
 */
function fakeContext(secrets = new Map()) {
  return {
    subscriptions: [],
    secrets: {
      /** @param {string} key */
      async get(key) {
        return secrets.get(key);
      },
      /**
       * @param {string} key
       * @param {string} value
       */
      async store(key, value) {
        secrets.set(key, value);
      },
      /** @param {string} key */
      async delete(key) {
        secrets.delete(key);
      }
    }
  };
}

/**
 * @param {Map<string, string | number>} [configuration]
 * @param {{ chatThinkingPart?: boolean }} [options]
 */
function fakeVscode(configuration = new Map(), options = {}) {
  const vscode = {
    chatParticipantId: "",
    outputChannelName: "",
    /** @type {string[]} */
    outputLines: [],
    /** @type {Array<{ name: string, options: import("vscode").LanguageModelToolInvocationOptions<object> }>} */
    toolInvocations: [],
    /** @type {import("vscode").ChatRequestHandler | undefined} */
    chatParticipantHandler: undefined,
    ...(options.chatThinkingPart ? { ChatResponseThinkingProgressPart } : {}),
    chat: {
      /**
       * @param {string} id
       * @param {import("vscode").ChatRequestHandler} handler
       */
      createChatParticipant(id, handler) {
        vscode.chatParticipantId = id;
        vscode.chatParticipantHandler = handler;
        return { dispose() {} };
      }
    },
    lm: {
      /** @type {import("vscode").LanguageModelToolInformation[]} */
      tools: [],
      /**
       * @param {string} name
       * @param {import("vscode").LanguageModelToolInvocationOptions<object>} options
       * @param {import("vscode").CancellationToken} [cancellationToken]
       */
      async invokeTool(name, options, cancellationToken) {
        void cancellationToken;
        vscode.toolInvocations.push({ name, options });
        return {
          content: [{ value: jsonString({ name: "cocopi" }) }]
        };
      }
    },
    workspace: {
      getConfiguration() {
        return {
          /**
           * @template T
           * @param {string} key
           * @param {T} defaultValue
           * @returns {T}
           */
          get(key, defaultValue) {
            if (key === "transport" && !configuration.has(key)) {
              return /** @type {T} */ ("sse");
            }
            return /** @type {T} */ (configuration.get(key) ?? defaultValue);
          },
          /**
           * @param {string} key
           * @param {string | number} value
           */
          async update(key, value) {
            configuration.set(key, value);
          }
        };
      }
    },
    window: {
      /** @param {string} name */
      createOutputChannel(name) {
        vscode.outputChannelName = name;
        return {
          /** @param {string} value */
          appendLine(value) {
            vscode.outputLines.push(value);
          },
          dispose() {}
        };
      }
    }
  };

  return vscode;
}

/**
 * @param {Record<string, string | number>} record
 */
function configurationValues(record) {
  /** @type {Map<string, string | number>} */
  const values = new Map();
  for (const [key, value] of Object.entries(record)) {
    values.set(key, value);
  }

  return values;
}

/**
 * @param {string} prompt
 * @param {{
 *   toolReferences?: Array<{ name: string }>,
 *   toolInvocationToken?: string,
 *   model?: { id: string, name?: string, vendor: string },
 *   command?: string,
 *   conversationSummary?: string,
 *   conversationDescription?: string
 * }} [options]
 */
function fakeChatRequest(prompt, options = {}) {
  return /** @type {import("vscode").ChatRequest} */ (/** @type {object} */ ({
    prompt,
    toolReferences: options.toolReferences ?? [],
    toolInvocationToken: options.toolInvocationToken,
    conversationSummary: options.conversationSummary,
    conversationDescription: options.conversationDescription,
    references: [],
    command: options.command,
    model: options.model ?? { id: "gpt-test", vendor: "cocopi" }
  }));
}

/**
 * @param {{ chatParticipantModelSource?: "selected" | "configured" }} [options]
 * @returns {import("../lib/vscode/configuration.js").CocopiConfiguration}
 */
function fakeConfiguration(options = {}) {
  return {
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    model: "gpt-configured",
    authMode: "secretStorage",
    serviceTier: "auto",
    reasoningEffort: "default",
    reasoningSummary: "default",
    chatParticipantModelSource: options.chatParticipantModelSource ?? "selected",
    transport: "sse",
    debugLevel: "off",
    issueTracking: true,
    tokenTracking: true,
    toolStrict: true,
    chatInstructions: "",
    chatInstructionsMode: "optional",
    chatInstructionsRegexPattern: ".*",
    chatInstructionsRegexReplacement: "",
    chatInstructionsRegexFlags: "",
    streamIdleTimeoutMs: 120_000,
    useModelDefaultCompactionLimit: true,
    compactionFallbackStrategy: /** @type {"ninety-percent"} */ ("ninety-percent")
  };
}

/** @param {Array<import("vscode").ChatRequestTurn | import("vscode").ChatResponseTurn>} [history] */
function fakeChatContext(history = []) {
  return /** @type {import("vscode").ChatContext} */ ({ history });
}

/** @param {string} prompt */
function fakeRequestTurn(prompt) {
  return /** @type {import("vscode").ChatRequestTurn} */ ({ prompt, participant: "cocopi.chat", references: [], toolReferences: [] });
}

/**
 * @param {string} value
 * @param {import("vscode").ChatResult} [result]
 */
function fakeResponseTurn(value, result = {}) {
  return /** @type {import("vscode").ChatResponseTurn} */ ({
    participant: "cocopi.chat",
    result,
    response: [fakeMarkdownPart(value)]
  });
}

/** @param {string} value */
function fakeMarkdownPart(value) {
  return /** @type {import("vscode").ChatResponseMarkdownPart} */ ({
    value: fakeMarkdownString(value)
  });
}

/** @param {string} value */
function fakeMarkdownString(value) {
  const markdownString = {
    value,
    /** @param {string} text */
    appendText(text) {
      this.value += text;
      return this;
    },
    /** @param {string} text */
    appendMarkdown(text) {
      this.value += text;
      return this;
    },
    /** @param {string} text */
    appendCodeblock(text) {
      this.value += text;
      return this;
    }
  };

  return /** @type {import("vscode").MarkdownString} */ (markdownString);
}

function fakeChatResponseStream() {
  return /** @type {import("vscode").ChatResponseStream & { markdownValues: string[], progressValues: string[], pushedParts: unknown[] }} */ ({
    /** @type {string[]} */
    markdownValues: [],
    /** @type {string[]} */
    progressValues: [],
    /** @type {unknown[]} */
    pushedParts: [],
    /** @param {string} value */
    markdown(value) {
      this.markdownValues.push(value);
    },
    anchor() {},
    button() {},
    filetree() {},
    /** @param {string} value */
    progress(value) {
      this.progressValues.push(value);
    },
    reference() {},
    /** @param {import("vscode").ChatResponsePart} part */
    push(part) {
      this.pushedParts.push(part);
    }
  });
}

function fakeCancellationToken() {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {import("vscode").Event<void>} */
  const onCancellationRequested = (listener) => {
    listeners.add(listener);
    return {
      dispose() {
        listeners.delete(listener);
      }
    };
  };
  const token = /** @type {import("vscode").CancellationToken & { cancel(): void }} */ ({
    isCancellationRequested: false,
    onCancellationRequested,
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners) {
        listener();
      }
    }
  });

  return token;
}

/** @param {string[]} chunks */
function eventStreamResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

/** @param {object} event */
function sseData(event) {
  return `data: ${jsonString(event)}\n\n`;
}

/** @param {object} value */
function jsonString(value) {
  return JSON.stringify(value);
}

function fakeLogger() {
  return {
    /** @type {string[]} */
    infoMessages: [],
    /** @type {string[]} */
    debugMessages: [],
    /** @type {Array<{ message: string, error: Error | string | object | null | undefined }>} */
    errorMessages: [],
    /** @param {string} message */
    info(message) {
      this.infoMessages.push(message);
    },
    /** @param {string} message */
    debug(message) {
      this.debugMessages.push(message);
    },
    /**
     * @param {string} message
     * @param {Error | string | object | null | undefined} error
     */
    error(message, error) {
      this.errorMessages.push({ message, error });
    },
    dispose() {}
  };
}
