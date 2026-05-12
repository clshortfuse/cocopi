import test from "node:test";
import assert from "node:assert/strict";

import { COCOPI_OUTPUT_CHANNEL_NAME, createCocopiLogger, logCodexFailurePayloadDiagnostics, logCodexRequestDiagnostics, logCodexResponseEventDiagnostics, logCodexTokenCacheSummary, logCodexWebSocketContinuationDecision, readCodexUsageSummary, redactCocopiLogText, summarizeCodexRequestBodyForDiagnostics } from "../lib/vscode/diagnostics.js";
import { clearCocopiIssues, readCocopiIssues } from "../lib/vscode/issues.js";
import { clearCocopiTokenCacheDebugSummaries, readCocopiTokenCacheDebugSummaries, recordCocopiTokenCacheSummary } from "../lib/vscode/token-cache-debug.js";

test("readCodexUsageSummary parses usage counters and cache hit ratio", () => {
  const usage = readCodexUsageSummary({
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens_details: { reasoning_tokens: 12 }
    }
  });

  assert.equal(usage?.inputTokens, 100);
  assert.equal(usage?.outputTokens, 20);
  assert.equal(usage?.totalTokens, 120);
  assert.equal(usage?.cachedTokens, 80);
  assert.equal(usage?.cacheStatus, "hit");
  assert.equal(usage?.cacheHitRatio?.toFixed(1), "80.0");
  assert.deepEqual(usage?.usageKeys, ["input_tokens", "input_tokens_details", "output_tokens", "output_tokens_details", "total_tokens"]);
  assert.ok(usage?.cacheFields.includes("input_tokens_details.cached_tokens=80"));
});

test("logCodexTokenCacheSummary includes request source and cache ratio", () => {
  const logger = fakeLogger();
  clearCocopiTokenCacheDebugSummaries();

  logCodexTokenCacheSummary(logger, "metadata", {
    source: "chat",
    selectedModel: "gpt-test:fast",
    model: "gpt-test",
    hostRequestIndex: 2,
    sessionId: "session-id",
    conversationSummary: "Fix login flow",
    conversationDescription: "User asked about session continuity",
    inputItems: 3,
    transport: "sse",
    serviceTier: "priority",
    serviceTierSource: "model",
    reasoningEffort: "xhigh",
    reasoningSummary: "detailed",
    fastRequested: true,
    promptCacheKey: "prompt-cache-key",
    requestKind: "compaction",
    requestInputDigest: "sha256:inputdigest",
    requestToolsDigest: "sha256:toolsdigest",
    requestBodyDigest: "sha256:bodydigest",
    wireMode: "previous-response",
    wireInputItems: 1,
    wireInputDigest: "sha256:wireinput",
    wireToolsDigest: "sha256:wiretools",
    wireBodyDigest: "sha256:wirebody",
    response: {
      id: "resp-id",
      usage: {
        input_tokens: 200,
        output_tokens: 30,
        total_tokens: 230,
        prompt_tokens_details: { cached_tokens: 50 }
      }
    }
  });

  assert.equal(logger.debugMessages.length, 1);
  assert.match(logger.debugMessages[0], /Codex token\/cache summary./u);
  assert.match(logger.debugMessages[0], /source=chat/u);
  assert.match(logger.debugMessages[0], /hostRequest=2/u);
  assert.match(logger.debugMessages[0], /sessionId=session-id/u);
  assert.match(logger.debugMessages[0], /model=gpt-test/u);
  assert.match(logger.debugMessages[0], /selectedModel=gpt-test:fast/u);
  assert.match(logger.debugMessages[0], /conversationSummary=Fix_login_flow/u);
  assert.match(logger.debugMessages[0], /conversationDescription=User_asked_about_session_continuity/u);
  assert.match(logger.debugMessages[0], /inputItems=3/u);
  assert.match(logger.debugMessages[0], /transport=sse/u);
  assert.match(logger.debugMessages[0], /serviceTier=priority/u);
  assert.match(logger.debugMessages[0], /serviceTierSource=model/u);
  assert.match(logger.debugMessages[0], /reasoningEffort=xhigh/u);
  assert.match(logger.debugMessages[0], /reasoningSummary=detailed/u);
  assert.match(logger.debugMessages[0], /fastRequested=true/u);
  assert.match(logger.debugMessages[0], /promptCacheKey=prompt-cache-key/u);
  assert.match(logger.debugMessages[0], /requestKind=compaction/u);
  assert.match(logger.debugMessages[0], /requestInputDigest=sha256:inputdigest/u);
  assert.match(logger.debugMessages[0], /wireMode=previous-response/u);
  assert.match(logger.debugMessages[0], /wireInputItems=1/u);
  assert.match(logger.debugMessages[0], /wireBodyDigest=sha256:wirebody/u);
  assert.match(logger.debugMessages[0], /responseId=resp-id/u);
  assert.match(logger.debugMessages[0], /cacheHitRatio=25.0/u);
  assert.match(logger.debugMessages[0], /cacheStatus=hit/u);
  const [summary] = readCocopiTokenCacheDebugSummaries();
  assert.equal(summary?.selectedModel, "gpt-test:fast");
  assert.equal(summary?.reasoningEffort, "xhigh");
  assert.equal(summary?.reasoningSummary, "detailed");
  assert.equal(summary?.serviceTier, "priority");
  assert.equal(summary?.fastRequested, true);
  assert.equal(summary?.requestKind, "compaction");
  assert.equal(summary?.wireMode, "previous-response");
  assert.equal(summary?.wireBodyDigest, "sha256:wirebody");
});

test("logCodexTokenCacheSummary records suspected cache drops as issues", () => {
  clearCocopiIssues();
  clearCocopiTokenCacheDebugSummaries();
  recordCocopiTokenCacheSummary({
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 1,
    sessionId: "session-id",
    inputItems: 3,
    promptCacheKey: "cache-key",
    responseId: "resp-hit",
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    totalTokens: 110,
    cachedTokens: 80,
    cacheStatus: "hit",
    cacheHitRatio: 80
  });

  logCodexTokenCacheSummary(fakeLogger(), "metadata", {
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 2,
    sessionId: "session-id",
    conversationSummary: "Conversation summary",
    conversationDescription: "Conversation description",
    inputItems: 4,
    promptCacheKey: "cache-key",
    webSocketContinuationDecision: {
      action: "used",
      reason: "matched-prefix",
      inputItems: 4,
      baselineItems: 3,
      deltaItems: 1,
      requestStateChanges: ["tools.added:Build_CMakeTools", "tools.removed:activate_cmake_project_management_tools"]
    },
    response: {
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: { cached_tokens: 0 }
      }
    }
  });

  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "warning");
  assert.equal(issues[0].category, "token-cache");
  assert.match(issues[0].title, /missed after a previous hit/u);
  assert.equal(issues[0].metadata.conversationSummary, "Conversation summary");
  assert.equal(issues[0].metadata.conversationDescription, "Conversation description");
  assert.equal(issues[0].metadata.previousHitHostRequest, 1);
  assert.equal(issues[0].metadata.webSocketContinuationAction, "used");
  assert.equal(issues[0].metadata.webSocketContinuationReason, "matched-prefix");
  assert.equal(issues[0].metadata.webSocketStateChanges, "tools.added:Build_CMakeTools,tools.removed:activate_cmake_project_management_tools");
  assert.match(issues[0].details, /used previous_response_id/u);
  assert.match(issues[0].details, /Build_CMakeTools/u);
});

test("logCodexTokenCacheSummary preserves and annotates cache miss issues after later hits", () => {
  clearCocopiIssues();
  clearCocopiTokenCacheDebugSummaries();
  recordCocopiTokenCacheSummary({
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 1,
    sessionId: "session-id",
    inputItems: 3,
    promptCacheKey: "cache-key",
    responseId: "resp-hit",
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    totalTokens: 110,
    cachedTokens: 80,
    cacheStatus: "hit",
    cacheHitRatio: 80
  });

  logCodexTokenCacheSummary(fakeLogger(), "off", {
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 2,
    sessionId: "session-id",
    inputItems: 4,
    promptCacheKey: "cache-key",
    response: {
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: { cached_tokens: 0 }
      }
    }
  });

  assert.equal(readCocopiIssues().length, 1);
  assert.equal(readCocopiIssues()[0].metadata.recovered, undefined);

  logCodexTokenCacheSummary(fakeLogger(), "off", {
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 3,
    sessionId: "session-id",
    inputItems: 5,
    promptCacheKey: "cache-key",
    response: {
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: { cached_tokens: 90 }
      }
    }
  });

  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].metadata.cacheStatus, "miss");
  assert.equal(issues[0].metadata.recovered, true);
  assert.equal(issues[0].metadata.recoveredHostRequest, 3);
  assert.equal(issues[0].metadata.recoveredCachedTokens, 90);
  assert.match(issues[0].details, /miss remains recorded/u);
});

test("logCodexTokenCacheSummary tracks tokens when debug logging is off", () => {
  const logger = fakeLogger();
  clearCocopiIssues();
  clearCocopiTokenCacheDebugSummaries();

  logCodexTokenCacheSummary(logger, "off", {
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 1,
    sessionId: "session-id",
    inputItems: 2,
    promptCacheKey: "cache-key",
    response: {
      id: "resp-id",
      usage: {
        input_tokens: 120,
        output_tokens: 8,
        total_tokens: 128,
        input_tokens_details: { cached_tokens: 40 }
      }
    }
  });

  assert.deepEqual(logger.debugMessages, []);
  assert.equal(readCocopiIssues().length, 0);
  const summaries = readCocopiTokenCacheDebugSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].model, "gpt-test");
  assert.equal(summaries[0].cachedTokens, 40);
});

test("logCodexTokenCacheSummary does not track token rows without usage", () => {
  const logger = fakeLogger();
  clearCocopiIssues();
  clearCocopiTokenCacheDebugSummaries();

  logCodexTokenCacheSummary(logger, "metadata", {
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 1,
    sessionId: "session-id",
    inputItems: 2,
    promptCacheKey: "cache-key",
    response: {}
  });

  assert.match(logger.debugMessages[0], /usage=absent/u);
  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "token-cache");
  assert.equal(issues[0].title, "Codex request did not include usage counters");
  assert.equal(readCocopiTokenCacheDebugSummaries().length, 0);
});

test("logCodexWebSocketContinuationDecision logs metadata and records continuity issues", () => {
  clearCocopiIssues();
  const logger = fakeLogger();

  logCodexWebSocketContinuationDecision(logger, "metadata", {
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 3,
    sessionId: "session-id",
    promptCacheKey: "prompt-cache-key"
  }, {
    action: "skipped",
    reason: "input-prefix-mismatch",
    inputItems: 4,
    baselineItems: 3,
    inputPrefixMatchingItems: 2,
    inputPrefixMismatchIndex: 2,
    inputPrefixExpected: "message:assistant:content=1:output_text:text:4ch/sha256:abcd",
    inputPrefixActual: "function_call_output:call=sha256:efgh:output=6ch/sha256:ijkl",
    inputPrefixExpectedDigest: "sha256:expected",
    inputPrefixActualDigest: "sha256:actual"
  });

  assert.equal(logger.debugMessages.length, 1);
  assert.match(logger.debugMessages[0], /Codex WebSocket continuation/u);
  assert.match(logger.debugMessages[0], /action=skipped/u);
  assert.match(logger.debugMessages[0], /reason=input-prefix-mismatch/u);
  assert.match(logger.debugMessages[0], /inputPrefixMismatchIndex=2/u);
  assert.match(logger.debugMessages[0], /inputPrefixExpected=message:assistant:content=1:output_text:text:4ch\/sha256:abcd/u);
  assert.match(logger.debugMessages[0], /inputPrefixActual=function_call_output:call=sha256:efgh:output=6ch\/sha256:ijkl/u);
  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "websocket-continuation");
  assert.equal(issues[0].metadata.reason, "input-prefix-mismatch");
  assert.equal(issues[0].metadata.inputItems, 4);
  assert.equal(issues[0].metadata.inputPrefixMismatchIndex, 2);
  assert.equal(issues[0].metadata.inputPrefixExpectedDigest, "sha256:expected");
});

test("logCodexWebSocketContinuationDecision does not issue-track diagnostic request state changes", () => {
  clearCocopiIssues();

  logCodexWebSocketContinuationDecision(fakeLogger(), "off", {
    source: "language-model",
    model: "gpt-test",
    hostRequestIndex: 3,
    sessionId: "session-id",
    promptCacheKey: "prompt-cache-key"
  }, {
    action: "used",
    reason: "matched-prefix",
    inputItems: 4,
    baselineItems: 3,
    deltaItems: 1,
    requestStateChanges: ["tools.added:Build_CMakeTools"]
  });

  assert.equal(readCocopiIssues().length, 0);
});

test("logCodexWebSocketContinuationDecision does not issue-track routine cold starts", () => {
  clearCocopiIssues();

  logCodexWebSocketContinuationDecision(fakeLogger(), "off", {
    source: "chat",
    model: "gpt-test",
    hostRequestIndex: 1,
    sessionId: "session-id"
  }, {
    action: "skipped",
    reason: "no-prior-request",
    inputItems: 1
  });

  assert.equal(readCocopiIssues().length, 0);
});

test("logCodexTokenCacheSummary can disable issue and token tracking", () => {
  clearCocopiIssues();
  clearCocopiTokenCacheDebugSummaries();

  logCodexTokenCacheSummary(fakeLogger(), "off", {
    source: "chat",
    model: "gpt-test",
    hostRequestIndex: 1,
    sessionId: "session-id",
    inputItems: 2,
    promptCacheKey: "cache-key",
    response: {}
  }, {
    issueTracking: false,
    tokenTracking: false
  });

  assert.equal(readCocopiIssues().length, 0);
  assert.equal(readCocopiTokenCacheDebugSummaries().length, 0);
});

test("redactCocopiLogText redacts common credential shapes", () => {
  const text = [
    "Authorization: Bearer access-token-value",
    "api_key=sk-secret",
    "https://example.test?access_token=secret-token",
    '{"access_token":"secret","refresh_token":"refresh","cookie":"session"}'
  ].join("\n");

  const redacted = redactCocopiLogText(text);

  assert.match(redacted, /Bearer \[redacted\]/u);
  assert.match(redacted, /sk-\[redacted\]/u);
  assert.match(redacted, /access_token=\[redacted\]/u);
  assert.match(redacted, /"access_token":"\[redacted\]"/u);
  assert.match(redacted, /"refresh_token":"\[redacted\]"/u);
  assert.match(redacted, /"cookie":"\[redacted\]"/u);
  assert.doesNotMatch(redacted, /secret-token|"secret"|"refresh"|"session"/u);
});

test("createCocopiLogger writes redacted lines to the Cocopi output channel", () => {
  const vscode = fakeVscode();
  const logger = createCocopiLogger(vscode);

  logger.info("Starting with Bearer access-token-value");
  logger.debug("Debug token=secret-token");
  logger.error("Failed", new Error("token=secret-token"));
  logger.dispose();

  assert.equal(vscode.outputChannelName, COCOPI_OUTPUT_CHANNEL_NAME);
  assert.equal(vscode.disposed, true);
  assert.equal(vscode.lines.length, 4);
  assert.doesNotMatch(vscode.lines.join("\n"), /access-token-value|secret-token/u);
});

test("logCodexResponseEventDiagnostics reports usage cache and unknown response keys", () => {
  const logger = fakeLogger();

  logCodexResponseEventDiagnostics(logger, "metadata", {
    type: "response.completed",
    response: {
      id: "resp-test",
      output_text: "do not log this",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 7 },
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 80 }
      },
      prompt_cache_key: "backend-cache-key",
      prompt_cache_retention: "24h",
      surprise_field: true
    }
  });

  assert.equal(logger.debugMessages.length, 1);
  assert.match(logger.debugMessages[0], /unknownKeys=surprise_field/u);
  assert.match(logger.debugMessages[0], /inputTokens=100/u);
  assert.match(logger.debugMessages[0], /reasoningTokens=7/u);
  assert.match(logger.debugMessages[0], /cachedTokens=80/u);
  assert.match(logger.debugMessages[0], /cacheStatus=hit/u);
  assert.match(logger.debugMessages[0], /cacheFields=input_tokens_details\.cached_tokens=80/u);
  assert.match(logger.debugMessages[0], /promptCacheKey=backend-cache-key/u);
  assert.match(logger.debugMessages[0], /promptCacheRetention=24h/u);
  assert.doesNotMatch(logger.debugMessages[0], /do not log this/u);
});

test("logCodexResponseEventDiagnostics reports known cache misses", () => {
  const logger = fakeLogger();

  logCodexResponseEventDiagnostics(logger, "metadata", {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 }
      }
    }
  });

  assert.equal(logger.debugMessages.length, 1);
  assert.match(logger.debugMessages[0], /cachedTokens=0/u);
  assert.match(logger.debugMessages[0], /cacheStatus=miss/u);
});

test("logCodexResponseEventDiagnostics reports unfamiliar cache usage counters", () => {
  const logger = fakeLogger();

  logCodexResponseEventDiagnostics(logger, "metadata", {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 100,
        token_cache: {
          read_tokens: 42
        }
      }
    }
  });

  assert.equal(logger.debugMessages.length, 1);
  assert.match(logger.debugMessages[0], /cachedTokens=unknown/u);
  assert.match(logger.debugMessages[0], /cacheStatus=unknown/u);
  assert.match(logger.debugMessages[0], /cacheFields=token_cache\.read_tokens=42/u);
});

test("logCodexResponseEventDiagnostics reports unknown event shapes", () => {
  const logger = fakeLogger();

  logCodexResponseEventDiagnostics(logger, "metadata", {
    type: "response.unknown.delta",
    delta: "do not log this"
  });

  assert.deepEqual(logger.debugMessages, ["Unknown Codex stream event. type=response.unknown.delta keys=delta,type"]);
});

test("logCodexResponseEventDiagnostics treats function argument deltas as known", () => {
  const logger = fakeLogger();

  logCodexResponseEventDiagnostics(logger, "metadata", {
    type: "response.function_call_arguments.delta",
    item_id: "fc-1",
    output_index: 0,
    delta: '{"path"'
  });

  assert.deepEqual(logger.debugMessages, []);
});

test("logCodexResponseEventDiagnostics treats Codex rate limit events as known", () => {
  const logger = fakeLogger();

  logCodexResponseEventDiagnostics(logger, "metadata", {
    type: "codex.rate_limits",
    plan_type: "plus",
    credits: 10,
    rate_limits: {},
    additional_rate_limits: {},
    code_review_rate_limits: {},
    promo: null
  });

  assert.deepEqual(logger.debugMessages, []);
});

test("logCodexRequestDiagnostics reports request shape without payload text by default", () => {
  const logger = fakeLogger();

  logCodexRequestDiagnostics(logger, "metadata", {
    model: "gpt-test",
    instructions: "do not log these instructions",
    input: [
      { role: "user", content: [{ type: "input_text", text: "do not log this" }] },
      { role: "assistant", content: [{ type: "output_text", text: "or this" }] },
      { type: "reasoning", encrypted_content: "do not log this either" }
    ],
    tools: [],
    prompt_cache_key: "cache-key"
  }, {
    source: "language-model",
    hostRequestIndex: 7,
    sessionId: "session-id",
    stage: "prepared"
  });

  assert.equal(logger.debugMessages.length, 1);
  assert.match(logger.debugMessages[0], /source=language-model/u);
  assert.match(logger.debugMessages[0], /hostRequest=7/u);
  assert.match(logger.debugMessages[0], /sessionId=session-id/u);
  assert.match(logger.debugMessages[0], /stage=prepared/u);
  assert.match(logger.debugMessages[0], /requestKind=normal/u);
  assert.match(logger.debugMessages[0], /wireMode=full/u);
  assert.match(logger.debugMessages[0], /inputItems=3/u);
  assert.match(logger.debugMessages[0], /reasoningItems=1/u);
  assert.match(logger.debugMessages[0], /userMessages=1/u);
  assert.match(logger.debugMessages[0], /assistantMessages=1/u);
  assert.match(logger.debugMessages[0], /instructions=present/u);
  assert.match(logger.debugMessages[0], /promptCacheKey=cache-key/u);
  assert.match(logger.debugMessages[0], /inputDigest=sha256:[0-9a-f]{16}/u);
  assert.match(logger.debugMessages[0], /toolsDigest=sha256:[0-9a-f]{16}/u);
  assert.match(logger.debugMessages[0], /bodyDigest=sha256:[0-9a-f]{16}/u);
  assert.match(logger.debugMessages[0], /toolsShape=empty/u);
  assert.match(logger.debugMessages[0], /inputShape=0:message:user:content=1:input_text:text:15ch\/sha256:[0-9a-f]{12}/u);
  assert.match(logger.debugMessages[0], /1:message:assistant:content=1:output_text:text:7ch\/sha256:[0-9a-f]{12}/u);
  assert.match(logger.debugMessages[0], /2:reasoning:id=sha256:[0-9a-f]{12}:summary=absent:encrypted=present/u);
  assert.doesNotMatch(logger.debugMessages[0], /do not log this|or this|do not log these instructions/u);
});

test("summarizeCodexRequestBodyForDiagnostics detects compaction and previous response requests", () => {
  const compaction = summarizeCodexRequestBodyForDiagnostics({
    model: "gpt-test",
    previous_response_id: "resp-before",
    input: [{ role: "user", content: [{ type: "input_text", text: "The conversation has grown too large for the context window and must be compacted now." }] }]
  });

  assert.equal(compaction.requestKind, "compaction");
  assert.equal(compaction.wireMode, "previous-response");
  assert.equal(compaction.inputItems, 1);
  assert.match(compaction.inputDigest, /^sha256:[0-9a-f]{16}$/u);

  const summaryReplay = summarizeCodexRequestBodyForDiagnostics({
    model: "gpt-test",
    input: [{ role: "user", content: [{ type: "input_text", text: "<conversation-summary>Prior work</conversation-summary>" }] }]
  });
  assert.equal(summaryReplay.requestKind, "conversation-summary");
});

test("payload debug level logs request and stream event payload text", () => {
  const logger = fakeLogger();

  logCodexRequestDiagnostics(logger, "payloads", {
    model: "gpt-test",
    input: [{ role: "user", content: [{ type: "input_text", text: "debug this prompt" }] }]
  });
  logCodexResponseEventDiagnostics(logger, "payloads", {
    type: "response.output_text.delta",
    delta: "debug this output"
  });

  assert.equal(logger.debugMessages.length, 4);
  assert.match(logger.debugMessages[0], /debug this prompt/u);
  assert.match(logger.debugMessages[3], /debug this output/u);
});

test("payload debug level logs failure payloads", () => {
  const logger = fakeLogger();
  const requestBody = {
    model: "gpt-test",
    input: [{ role: "user", content: [{ type: "input_text", text: "debug failing prompt" }] }]
  };
  const wireBody = {
    ...requestBody,
    previous_response_id: "resp-prev",
    input: [{ role: "user", content: [{ type: "input_text", text: "debug failing delta" }] }]
  };
  const error = new Error("failed");
  Object.defineProperty(error, "event", {
    value: {
      type: "error",
      error: { message: "debug failing backend error" }
    }
  });

  logCodexResponseEventDiagnostics(logger, "payloads", {
    type: "response.output_text.delta",
    delta: "debug normal output too"
  });
  logCodexResponseEventDiagnostics(logger, "payloads", {
    type: "response.failed",
    error: { message: "debug failing event" }
  });
  logCodexFailurePayloadDiagnostics(logger, "payloads", error, {
    source: "language-model",
    hostRequestIndex: 4,
    sessionId: "session-id",
    stage: "failure"
  }, {
    requestBody,
    wireBody
  });

  assert.ok(logger.debugMessages.some((message) => /Codex stream event payload\./u.test(message) && /debug normal output too/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /Codex stream event payload\./u.test(message) && /debug failing event/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /Codex request payload on error\./u.test(message) && /debug failing prompt/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /Codex wire request payload on error\./u.test(message) && /debug failing delta/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /Codex error event payload\./u.test(message) && /debug failing backend error/u.test(message)));
});

test("payload debug level chunks large payloads without truncating", () => {
  const logger = fakeLogger();
  const outputText = "x".repeat(20_000);

  logCodexResponseEventDiagnostics(logger, "payloads", {
    type: "response.completed",
    response: {
      id: "resp-large",
      output_text: outputText
    }
  });

  const header = logger.debugMessages.find((message) => /Codex stream event payload\. chunks=/u.test(message));
  assert.ok(header);
  const chunks = logger.debugMessages.filter((message) => /Codex stream event payload\. chunk=/u.test(message));
  assert.ok(chunks.length > 1);
  assert.equal(chunks.some((message) => /\[truncated chars=/u.test(message)), false);
  const reconstructed = chunks.map((message) => message.replace(/^Codex stream event payload\. chunk=\d+\/\d+ /u, "")).join("");
  assert.match(reconstructed, new RegExp(`output_text":"${outputText}`, "u"));
});

function fakeVscode() {
  const vscode = {
    outputChannelName: "",
    disposed: false,
    /** @type {string[]} */
    lines: [],
    window: {
      /** @param {string} name */
      createOutputChannel(name) {
        vscode.outputChannelName = name;
        return {
          /** @param {string} value */
          appendLine(value) {
            vscode.lines.push(value);
          },
          dispose() {
            vscode.disposed = true;
          }
        };
      }
    }
  };

  return vscode;
}

function fakeLogger() {
  return {
    /** @type {string[]} */
    debugMessages: [],
    /** @param {string} message */
    debug(message) {
      this.debugMessages.push(message);
    },
    info() {},
    error() {},
    dispose() {}
  };
}
