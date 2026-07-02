import { buildTextResponseBody } from "../codex-api/response-body.js";
import { captureCodexOutputItemPhase, codexOutputTextDeltaPhase, codexOutputTextMetadata, codexOutputTextPartId, codexReasoningSummaryMetadata, codexReasoningSummaryPartId, isCodexCommentaryOutputPhase, readCodexReasoningSummaryTextDelta, readCodexTextDelta, throwIfCodexTerminalEvent } from "../codex-api/responses.js";
import { abortIfCancellationRequested, abortSignalFromCancellationToken, VSCODE_CANCELLATION_MESSAGE, vscodeCancellationSourceLabel } from "./cancellation.js";
import { chatResultWithCodexState, cocopiSessionIdFromChatHistory, codexInputFromChatHistory } from "./chat-history.js";
import { fetchCodexResponseStreamWithAuthRefresh } from "./codex-request.js";
import { COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES, COCOPI_SERVICE_TIERS, codexReasoningFromCocopiOptions, codexToolOptionsFromCocopiOptions, resolveChatParticipantInstructions } from "./configuration.js";
import { createCocopiLogger, logCodexFailurePayloadDiagnostics, logCodexRequestDiagnostics, logCodexResponseEventDiagnostics, logCodexTokenCacheSummary, logCodexWebSocketContinuationDecision, logCocopiMemoryDiagnostics, noopCocopiLogger, readCodexUsageSummary, summarizeCodexRequestBodyForDiagnostics } from "./diagnostics.js";
import { recordCocopiIssue } from "./issues.js";
import { COCOPI_LANGUAGE_MODEL_VENDOR } from "./language-model-provider.js";
import { readCocopiRuntime } from "./runtime.js";
import { newCocopiSessionId } from "./session-id.js";
import { cocopiTurnClientMetadata } from "./turn-metadata.js";
import { codexFunctionCallInputItemFromToolCall, codexFunctionCallOutputInputItemFromToolResult, codexToolsFromLanguageModelTools, languageModelQualifiedName, readCodexReasoningInputItem, readCodexToolCall, stripUnsupportedLanguageModelToolSchemaMetadata, withDefaultRunSubagentToolModel, withOptionalNullToolArgumentsRemoved } from "./tool-bridge.js";

export const COCOPI_CHAT_PARTICIPANT_ID = "cocopi.chat";
const COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS = "You are Cocopi, a coding assistant running in VS Code. Follow the user's request.";
const EDIT_TOOL_PROGRESS_MESSAGES = /** @type {Readonly<Record<string, { started: string, completed: string, failed: string }>>} */ (Object.freeze({
  apply_patch: {
    started: "Applying patch.",
    completed: "Applied patch.",
    failed: "Patch failed."
  },
  copilot_applyPatch: {
    started: "Applying patch.",
    completed: "Applied patch.",
    failed: "Patch failed."
  },
  create_file: {
    started: "Creating file.",
    completed: "Created file.",
    failed: "File creation failed."
  },
  get_errors: {
    started: "Checking errors.",
    completed: "Checked errors.",
    failed: "Error check failed."
  }
}));

/** @type {Map<string, number>} */
const chatRequestTurnBySession = new Map();

/** @param {string} sessionId */
function nextChatRequestTurn(sessionId) {
  const nextTurn = (chatRequestTurnBySession.get(sessionId) ?? 0) + 1;
  chatRequestTurnBySession.set(sessionId, nextTurn);
  return nextTurn;
}

/** @typedef {import("../../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */
/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */

/**
 * @typedef {object} VscodeLanguageModelApi
 * @property {readonly import("vscode").LanguageModelToolInformation[]} tools
 * @property {(name: string, options: import("vscode").LanguageModelToolInvocationOptions<object>, token?: import("vscode").CancellationToken) => Thenable<import("vscode").LanguageModelToolResult>} invokeTool
 */

/**
 * @typedef {object} VscodeChatApi
 * @property {{ createChatParticipant(id: string, handler: import("vscode").ChatRequestHandler): { dispose(): void } }} chat
 * @property {VscodeLanguageModelApi} lm
 * @property {{ new(value: string | string[], id?: string, metadata?: Record<string, unknown>): unknown }} [ChatResponseThinkingProgressPart]
 * @property {import("./configuration.js").ConfigurationApiLike["workspace"]} workspace
 * @property {{ createOutputChannel(name: string): { appendLine(value: string): void, dispose(): void } }} window
 */

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeChatApi} vscode
 * @param {{ logger?: import("./diagnostics.js").CocopiLogger }} [options]
 */
export function registerCocopiChatParticipant(context, vscode, options = {}) {
  const logger = options.logger ?? createCocopiLogger(vscode);
  context.subscriptions.push(vscode.chat.createChatParticipant(
    COCOPI_CHAT_PARTICIPANT_ID,
    createCocopiChatRequestHandler(context, vscode, { logger })
  ));
  if (!options.logger) {
    context.subscriptions.push(logger);
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {import("./configuration.js").ConfigurationApiLike & Pick<VscodeChatApi, "lm" | "ChatResponseThinkingProgressPart">} vscode
 * @param {{ logger?: import("./diagnostics.js").CocopiLogger }} [options]
 * @returns {import("vscode").ChatRequestHandler}
 */
export function createCocopiChatRequestHandler(context, vscode, options = {}) {
  const logger = options.logger ?? noopCocopiLogger;
  return async (request, chatContext, response, token) => {
    /** @type {string} */
    let requestModel = "";
    /** @type {string | undefined} */
    let requestInstructions;
    /** @type {import("../../data/Codex.js").CodexResponseCreateRequest | undefined} */
    let requestBody;
    /** @type {import("../../data/Codex.js").CodexResponseCreateRequest | undefined} */
    let wireRequestBody;
    /** @type {Awaited<ReturnType<typeof readCocopiRuntime>> | undefined} */
    let runtime;
    /** @type {import("./diagnostics.js").CodexTokenCacheSummaryContext | undefined} */
    let tokenCacheSummaryContext;
    let tokenCacheSummaryLogged = false;
    const abort = abortSignalFromCancellationToken(token);
    const logChatBoundaryCancellation = () => {
      logger.info(`VS Code cancellation ${vscodeCancellationSourceLabel(abort.cancellationSource)}. source=chat phase=handler model=${requestModel || "unknown"}`);
    };
    if (abort.signal.aborted) {
      logChatBoundaryCancellation();
    } else {
      abort.signal.addEventListener("abort", logChatBoundaryCancellation, { once: true });
    }
    const prompt = request.prompt.trim();
    try {
      if (!prompt) {
        response.markdown("Send a prompt to Cocopi.");
        return;
      }

      runtime = await readCocopiRuntime(context, vscode);
      if (!runtime.auth) {
        logger.info("Chat request skipped because Cocopi is not signed in.");
        response.markdown("Cocopi is not signed in.");
        return;
      }

      const requestRuntime = runtime;
      const requestAuth = requestRuntime.auth;
      if (!requestAuth) {
        logger.info("Chat request skipped because Cocopi is not signed in.");
        response.markdown("Cocopi is not signed in.");
        return;
      }
      requestModel = chatParticipantModelForRequest(request, requestRuntime.configuration);
      logger.info(`Starting chat request. model=${requestModel} transport=${requestRuntime.configuration.transport} apiBaseUrl=${requestRuntime.configuration.apiBaseUrl} idleTimeoutMs=${requestRuntime.configuration.streamIdleTimeoutMs ?? "disabled"} account=${requestAuth.chatgptAccountId ? "present" : "none"}`);
      const userTools = languageModelToolsFromChatRequest(request, vscode);
      const strippedToolSchemaMetadata = stripUnsupportedLanguageModelToolSchemaMetadata(userTools);
      if (strippedToolSchemaMetadata > 0) {
        logger.info(`VS Code tool schema metadata stripped before tool execution. source=chat count=${strippedToolSchemaMetadata}`);
      }
      const toolOptions = codexToolOptionsFromCocopiOptions(requestRuntime.configuration);
      const requestTools = codexToolsFromLanguageModelTools(userTools, toolOptions);
      const runSubagentDefaultModel = chatRequestLanguageModelQualifiedName(request, requestModel);
      requestInstructions = resolveChatParticipantInstructions(COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS, requestRuntime.configuration);
      const sessionId = cocopiSessionIdFromChatHistory(chatContext) ?? newCocopiSessionId("chat");
      const conversationDescription = prompt;
      const input = codexInputFromChatHistory(chatContext, prompt);
      const reasoning = codexReasoningFromCocopiOptions(requestRuntime.configuration);
      const hostRequestIndex = nextChatRequestTurn(sessionId);
      logCocopiMemoryDiagnostics(logger, requestRuntime.configuration.debugLevel, {
        source: "chat",
        hostRequestIndex,
        sessionId,
        stage: "history",
        model: requestModel,
        inputItems: input.length,
        tools: requestTools.length
      });
      const body = buildTextResponseBody({
        model: requestModel,
        instructions: requestInstructions,
        input,
        tools: requestTools,
        toolChoice: userTools.length > 0 ? "required" : "auto",
        stream: true,
        serviceTier: requestRuntime.configuration.serviceTier,
        ...(reasoning ? { reasoning } : {}),
        include: /** @type {import("../../data/Codex.js").CodexResponseInclude[]} */ (["reasoning.encrypted_content"]),
        promptCacheKey: sessionId,
        clientMetadata: {
          "x-codex-installation-id": "cocopi-chat",
          ...cocopiTurnClientMetadata("chat", sessionId, hostRequestIndex)
        }
      });
      requestBody = body;
      const requestDiagnostics = summarizeCodexRequestBodyForDiagnostics(body);
      logCocopiMemoryDiagnostics(logger, requestRuntime.configuration.debugLevel, {
        source: "chat",
        hostRequestIndex,
        sessionId,
        stage: "request-body",
        model: requestModel,
        inputItems: body.input?.length ?? 0,
        tools: requestTools.length
      });
      tokenCacheSummaryContext = {
        source: "chat",
        selectedModel: requestModel,
        model: requestModel,
        hostRequestIndex,
        sessionId,
        conversationDescription,
        inputItems: body.input?.length ?? 0,
        transport: runtime.configuration.transport,
        serviceTier: requestRuntime.configuration.serviceTier,
        serviceTierSource: "configuration",
        reasoningEffort: reasoning?.effort,
        reasoningSummary: reasoning?.summary ?? undefined,
        fastRequested: requestRuntime.configuration.serviceTier === COCOPI_SERVICE_TIERS.priority,
        promptCacheKey: body.prompt_cache_key,
        requestKind: requestDiagnostics.requestKind,
        requestInputDigest: requestDiagnostics.inputDigest,
        requestToolsDigest: requestDiagnostics.toolsDigest,
        requestBodyDigest: requestDiagnostics.bodyDigest,
        ...(requestRuntime.configuration.transport === "websocket" ? {} : {
          wireMode: requestDiagnostics.wireMode,
          wireInputItems: requestDiagnostics.inputItems,
          wireInputDigest: requestDiagnostics.inputDigest,
          wireToolsDigest: requestDiagnostics.toolsDigest,
          wireBodyDigest: requestDiagnostics.bodyDigest
        })
      };
      const requestDiagnosticsContext = {
        source: "chat",
        hostRequestIndex,
        sessionId
      };
      logCodexRequestDiagnostics(logger, requestRuntime.configuration.debugLevel, body, {
        ...requestDiagnosticsContext,
        stage: "prepared"
      });
      if (abortIfCancellationRequested(abort, token)) {
        throw new Error(VSCODE_CANCELLATION_MESSAGE);
      }
      const requestStartedAtMs = Date.now();
      if (tokenCacheSummaryContext) {
        tokenCacheSummaryContext.requestStartedAt = new Date(requestStartedAtMs).toISOString();
      }
      /** @type {number | undefined} */
      let firstStreamEventAtMs;
      /** @type {number | undefined} */
      let firstOutputAtMs;
      const markFirstStreamEvent = () => {
        if (firstStreamEventAtMs !== undefined) {
          return;
        }
        firstStreamEventAtMs = Date.now();
        if (tokenCacheSummaryContext) {
          tokenCacheSummaryContext.firstEventLatencyMs = firstStreamEventAtMs - requestStartedAtMs;
        }
      };
      const markFirstOutput = () => {
        if (firstOutputAtMs !== undefined) {
          return;
        }
        firstOutputAtMs = Date.now();
        if (tokenCacheSummaryContext) {
          tokenCacheSummaryContext.firstOutputLatencyMs = firstOutputAtMs - requestStartedAtMs;
        }
      };
      const events = await fetchCodexResponseStreamWithAuthRefresh(context, requestRuntime, {
        body,
        signal: abort.signal,
        idleTimeoutMs: requestRuntime.configuration.streamIdleTimeoutMs,
        onWebSocketResponseCancel() {
          logger.info(`Codex WebSocket response.cancel sent. source=chat hostRequest=${hostRequestIndex} sessionId=${sessionId} model=${requestModel}`);
        },
        onWebSocketReconnect(error) {
          logger.info(`Codex WebSocket reached its connection limit before output; retrying with a fresh WebSocket. source=chat hostRequest=${hostRequestIndex} sessionId=${sessionId} model=${requestModel} error=${error.message}`);
        },
        onWebSocketFallbackToSse(error) {
          logger.info(`Codex WebSocket closed before output; retrying with SSE. source=chat hostRequest=${hostRequestIndex} sessionId=${sessionId} model=${requestModel} error=${error.message}`);
        },
        onWebSocketRequestPrepared(wireBody) {
          wireRequestBody = wireBody;
          const wireDiagnostics = summarizeCodexRequestBodyForDiagnostics(wireBody);
          if (tokenCacheSummaryContext) {
            tokenCacheSummaryContext.wireMode = wireDiagnostics.wireMode;
            tokenCacheSummaryContext.wireInputItems = wireDiagnostics.inputItems;
            tokenCacheSummaryContext.wireInputDigest = wireDiagnostics.inputDigest;
            tokenCacheSummaryContext.wireToolsDigest = wireDiagnostics.toolsDigest;
            tokenCacheSummaryContext.wireBodyDigest = wireDiagnostics.bodyDigest;
          }
          logCodexRequestDiagnostics(logger, requestRuntime.configuration.debugLevel, wireBody, {
            ...requestDiagnosticsContext,
            stage: "wire"
          });
          logCocopiMemoryDiagnostics(logger, requestRuntime.configuration.debugLevel, {
            source: "chat",
            hostRequestIndex,
            sessionId,
            stage: "wire-body",
            model: requestModel,
            inputItems: wireBody.input?.length ?? 0,
            tools: Array.isArray(wireBody.tools) ? wireBody.tools.length : undefined
          });
        },
        onWebSocketContinuationDecision(decision) {
          if (tokenCacheSummaryContext) {
            tokenCacheSummaryContext.webSocketContinuationDecision = decision;
          }
          logCodexWebSocketContinuationDecision(logger, requestRuntime.configuration.debugLevel, {
            source: "chat",
            model: requestModel,
            hostRequestIndex,
            sessionId,
            promptCacheKey: body.prompt_cache_key
          }, decision, {
            issueTracking: requestRuntime.configuration.issueTracking
          });
        }
      });

      /** @type {import("./tool-bridge.js").CodexToolCall[]} */
      const toolCalls = [];
      /** @type {import("../../data/Codex.js").CodexResponseReasoningInputItem[]} */
      const reasoningItems = [];
      /** @type {Map<string, string | null>} */
      const outputItemPhases = new Map();
      const commentaryProgress = createChatVisibleProgressReporter(response, vscode, "Commentary");
      /** @type {import("../../data/Codex.js").CodexResponseCompletedEvent["response"] | undefined} */
      let completedResponse;
      try {
        for await (const event of events) {
          markFirstStreamEvent();
          if (abortIfCancellationRequested(abort, token)) {
            throw new Error(VSCODE_CANCELLATION_MESSAGE);
          }
          logCodexResponseEventDiagnostics(logger, runtime.configuration.debugLevel, event, {
            ...requestDiagnosticsContext,
            stage: "stream"
          });
          throwIfCodexTerminalEvent(event);
          captureCodexOutputItemPhase(outputItemPhases, event);

          const delta = readCodexTextDelta(event);
          if (delta) {
            markFirstOutput();
            const phase = codexOutputTextDeltaPhase(outputItemPhases, event);
            if (isCodexCommentaryOutputPhase(phase)) {
              commentaryProgress.report(delta, {
                id: codexOutputTextPartId(event),
                metadata: codexOutputTextMetadata(event, phase)
              });
            } else {
              commentaryProgress.finish();
              response.markdown(delta);
            }
          }

          const reasoningSummaryDelta = readCodexReasoningSummaryTextDelta(event);
          if (reasoningSummaryDelta) {
            markFirstOutput();
            commentaryProgress.finish();
            reportChatReasoningProgress(response, vscode, reasoningSummaryDelta, {
              id: codexReasoningSummaryPartId(event),
              metadata: codexReasoningSummaryMetadata(event)
            });
          }

          const rawToolCall = readCodexToolCall(event);
          const prunedToolCall = withOptionalNullToolArgumentsRemoved(rawToolCall, userTools);
          const toolCall = withDefaultRunSubagentToolModel(prunedToolCall, runSubagentDefaultModel);
          if (toolCall) {
            markFirstOutput();
            if (prunedToolCall && toolCall !== prunedToolCall) {
              logger.info(`VS Code runSubagent tool call pinned to Cocopi model. source=chat model=${runSubagentDefaultModel}`);
            }
            toolCalls.push(toolCall);
          }

          const reasoningItem = readCodexReasoningInputItem(event);
          if (reasoningItem) {
            reasoningItems.push(reasoningItem);
          }

          if (event.type === "response.completed" && "response" in event && event.response && typeof event.response === "object" && !Array.isArray(event.response)) {
            markFirstOutput();
            completedResponse = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (event.response);
            if (tokenCacheSummaryContext) {
              tokenCacheSummaryContext.response = completedResponse;
            }
          }
        }
      } finally {
        commentaryProgress.finish();
      }

      const conversationSummary = formatBilledTokensSummary(completedResponse);
      if (tokenCacheSummaryContext) {
        const requestCompletedAtMs = Date.now();
        tokenCacheSummaryContext.requestCompletedAt = new Date(requestCompletedAtMs).toISOString();
        tokenCacheSummaryContext.requestDurationMs = requestCompletedAtMs - requestStartedAtMs;
      }
      logCodexTokenCacheSummary(logger, runtime.configuration.debugLevel, {
        ...tokenCacheSummaryContext,
        source: "chat",
        model: requestModel,
        hostRequestIndex,
        sessionId,
        conversationSummary,
        conversationDescription,
        inputItems: body.input?.length ?? 0,
        transport: runtime.configuration.transport,
        promptCacheKey: body.prompt_cache_key,
        response: completedResponse
      }, {
        issueTracking: runtime.configuration.issueTracking,
        tokenTracking: runtime.configuration.tokenTracking
      });
      tokenCacheSummaryLogged = true;
      logCocopiMemoryDiagnostics(logger, runtime.configuration.debugLevel, {
        source: "chat",
        hostRequestIndex,
        sessionId,
        stage: "completed",
        model: requestModel,
        inputItems: body.input?.length ?? 0,
        toolCalls: toolCalls.length,
        reasoningItems: reasoningItems.length
      });

      if (toolCalls.length > 0) {
        const responseItems = await streamToolFollowUp({
          context,
          runtime,
          input,
          request,
          response,
          token,
          vscode,
          requestTools,
          userTools,
          toolCalls,
          reasoningItems,
          model: requestModel,
          sessionId,
          conversationSummary,
          conversationDescription,
          logger,
          signal: abort.signal,
          abort
        });
        logger.info("Chat request completed.");
        return chatResultWithCodexState(responseItems, sessionId, {
          summary: conversationSummary,
          description: conversationDescription
        });
      }

      logger.info("Chat request completed.");
      return chatResultWithCodexState(reasoningItems, sessionId, {
        summary: conversationSummary,
        description: conversationDescription
      });
    } catch (error) {
      const loggableError = toLoggableError(error);
      if (!tokenCacheSummaryLogged && tokenCacheSummaryContext && runtime) {
        logCodexTokenCacheSummary(logger, "off", tokenCacheSummaryContext, {
          issueTracking: runtime.configuration.issueTracking
            && !abort.signal.aborted
            && !isMissingInstructionsError(loggableError),
          tokenTracking: runtime.configuration.tokenTracking
        });
      }
      recordMissingInstructionsIssue(loggableError, {
        source: "chat",
        transport: runtime?.configuration.transport,
        model: requestModel || runtime?.configuration.model || "unknown",
        hasTopLevelInstructions: Boolean(requestInstructions),
        inputItems: requestBody?.input?.length ?? 0,
        issueTracking: runtime?.configuration.issueTracking
      });
      if (!abort.signal.aborted) {
        logCocopiMemoryDiagnostics(logger, runtime?.configuration.debugLevel ?? "off", {
          source: "chat",
          hostRequestIndex: tokenCacheSummaryContext?.hostRequestIndex,
          sessionId: tokenCacheSummaryContext?.sessionId,
          stage: "failure",
          model: requestModel || runtime?.configuration.model,
          inputItems: requestBody?.input?.length ?? 0
        });
        logCodexFailurePayloadDiagnostics(logger, runtime?.configuration.debugLevel ?? "off", loggableError, {
          source: "chat",
          hostRequestIndex: tokenCacheSummaryContext?.hostRequestIndex,
          sessionId: tokenCacheSummaryContext?.sessionId,
          stage: "failure"
        }, {
          requestBody,
          wireBody: wireRequestBody
        });
        logger.error("Chat request failed.", loggableError);
      }
      response.markdown(formatChatErrorMessage(loggableError, abort.signal));
    } finally {
      abort.signal.removeEventListener("abort", logChatBoundaryCancellation);
      abort.dispose();
    }
  };
}

/**
 * @param {Error | string | object | null | undefined} error
 * @param {AbortSignal} signal
 */
function formatChatErrorMessage(error, signal) {
  if (signal.aborted || (error instanceof Error && /abort|cancel/iu.test(error.message))) {
    return "Cocopi request was cancelled.";
  }

  if (error instanceof Error && /idle for \d+ms/iu.test(error.message)) {
    return "Cocopi request timed out waiting for Codex stream activity.";
  }

  if (error instanceof Error && /status\s+404\b|not found|does not exist/iu.test(error.message)) {
    return "The configured Cocopi model was not found. Check the cocopi.model setting or refresh the model catalog.";
  }

  return "Cocopi request failed. See the Cocopi output channel for details.";
}

/**
 * @param {import("vscode").ChatRequest} request
 * @param {import("./configuration.js").CocopiConfiguration} configuration
 */
export function chatParticipantModelForRequest(request, configuration) {
  if (configuration.chatParticipantModelSource === COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.configured) {
    return configuration.model;
  }

  return request.model?.vendor === COCOPI_LANGUAGE_MODEL_VENDOR && request.model.id
    ? request.model.id
    : configuration.model;
}

/**
 * @param {import("vscode").ChatRequest} request
 * @param {string} fallbackModelId
 */
function chatRequestLanguageModelQualifiedName(request, fallbackModelId) {
  const requestModel = request.model?.vendor === COCOPI_LANGUAGE_MODEL_VENDOR
    ? request.model
    : { id: fallbackModelId, name: fallbackModelId };
  return languageModelQualifiedName(requestModel, COCOPI_LANGUAGE_MODEL_VENDOR);
}

// eslint-disable-next-line jsdoc/reject-any-type -- Catch values are untyped external data; normalize before logging or formatting.
/** @param {*} error */
function toLoggableError(error) {
  if (error instanceof Error || typeof error === "string" || error === null || error === undefined) {
    return error;
  }

  if (typeof error === "object") {
    return error;
  }

  return String(error);
}

/**
 * @param {Error | string | object | null | undefined} error
 * @param {{ source: "language-model" | "chat", transport?: string, model: string, hasTopLevelInstructions: boolean, inputItems: number, issueTracking?: boolean }} options
 */
function recordMissingInstructionsIssue(error, options) {
  if (options.issueTracking === false) {
    return;
  }

  if (!isMissingInstructionsError(error)) {
    return;
  }

  recordCocopiIssue({
    severity: "error",
    category: "response-stream",
    title: "Codex rejected request without instructions",
    details: "Codex returned 'Instructions are required'. VS Code usually provides instructions, so this likely indicates a request-shape mismatch.",
    metadata: {
      source: options.source,
      transport: options.transport,
      model: options.model,
      hasTopLevelInstructions: options.hasTopLevelInstructions,
      inputItems: options.inputItems
    }
  });
}

/** @param {Error | string | object | null | undefined} error */
function isMissingInstructionsError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /instructions are required/iu.test(message);
}

/**
 * @param {{ context: CocopiSecretContext, runtime: Awaited<ReturnType<typeof readCocopiRuntime>>, input: import("../../data/Codex.js").CodexResponseInputItem[], request: import("vscode").ChatRequest, response: import("vscode").ChatResponseStream, token: import("vscode").CancellationToken, vscode: Pick<VscodeChatApi, "lm" | "ChatResponseThinkingProgressPart">, requestTools: import("../../data/Codex.js").CodexTool[], userTools: import("vscode").LanguageModelToolInformation[], toolCalls: import("./tool-bridge.js").CodexToolCall[], reasoningItems: import("../../data/Codex.js").CodexResponseReasoningInputItem[], model: string, sessionId: string, conversationSummary: string | undefined, conversationDescription: string | undefined, logger: import("./diagnostics.js").CocopiLogger, signal?: AbortSignal, abort: import("./cancellation.js").AbortSignalRegistration }} options
 * @returns {Promise<import("../../data/Codex.js").CodexResponseInputItem[]>}
 */
async function streamToolFollowUp(options) {
  const followUpInput = [...options.input];
  let pendingReasoningItems = options.reasoningItems;
  let pendingToolCalls = options.toolCalls;
  const followUpInstructions = resolveChatParticipantInstructions(COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS, options.runtime.configuration);
  const runSubagentDefaultModel = chatRequestLanguageModelQualifiedName(options.request, options.model);

  while (pendingToolCalls.length > 0) {
    throwIfChatCancellationRequested(options);
    const hostRequestIndex = nextChatRequestTurn(options.sessionId);
    followUpInput.push(...pendingReasoningItems);
    for (const toolCall of pendingToolCalls) {
      throwIfChatCancellationRequested(options);
      followUpInput.push(codexFunctionCallInputItemFromToolCall(toolCall));
      reportToolInvocationProgress(options.response, toolCall, "started");
      let result;
      try {
        result = await options.vscode.lm.invokeTool(toolCall.name, {
          toolInvocationToken: options.request.toolInvocationToken,
          input: toolCall.input
        }, options.token);
      } catch (error) {
        reportToolInvocationProgress(options.response, toolCall, "failed");
        throw error;
      }
      throwIfChatCancellationRequested(options);
      reportToolInvocationProgress(options.response, toolCall, "completed");
      followUpInput.push(codexFunctionCallOutputInputItemFromToolResult(toolCall.callId, result));
    }

    throwIfChatCancellationRequested(options);
    const reasoning = codexReasoningFromCocopiOptions(options.runtime.configuration);
    const body = buildTextResponseBody({
      model: options.model,
      instructions: followUpInstructions,
      input: followUpInput,
      tools: options.requestTools,
      toolChoice: "auto",
      stream: true,
      serviceTier: options.runtime.configuration.serviceTier,
      ...(reasoning ? { reasoning } : {}),
      include: /** @type {import("../../data/Codex.js").CodexResponseInclude[]} */ (["reasoning.encrypted_content"]),
      promptCacheKey: options.sessionId,
      clientMetadata: {
        "x-codex-installation-id": "cocopi-chat",
        ...cocopiTurnClientMetadata("chat", options.sessionId, hostRequestIndex)
      }
    });
    const requestDiagnostics = summarizeCodexRequestBodyForDiagnostics(body);
    const requestDiagnosticsContext = {
      source: "chat",
      hostRequestIndex,
      sessionId: options.sessionId
    };
    logCocopiMemoryDiagnostics(options.logger, options.runtime.configuration.debugLevel, {
      source: "chat",
      hostRequestIndex,
      sessionId: options.sessionId,
      stage: "follow-up-body",
      model: options.model,
      inputItems: body.input?.length ?? 0,
      tools: options.requestTools.length,
      toolCalls: pendingToolCalls.length,
      reasoningItems: pendingReasoningItems.length
    });
    /** @type {ReturnType<typeof summarizeCodexRequestBodyForDiagnostics> | undefined} */
    let wireDiagnostics = options.runtime.configuration.transport === "websocket" ? undefined : requestDiagnostics;
    logCodexRequestDiagnostics(options.logger, options.runtime.configuration.debugLevel, body, {
      ...requestDiagnosticsContext,
      stage: "prepared"
    });
    /** @type {import("../../data/Codex.js").CodexResponseCreateRequest | undefined} */
    let wireBodyForFailure;
    /** @type {import("../../data/Codex.js").CodexPreviousResponseDecision | undefined} */
    let webSocketContinuationDecision;
    const requestStartedAtMs = Date.now();
    /** @type {number | undefined} */
    let firstStreamEventAtMs;
    /** @type {number | undefined} */
    let firstOutputAtMs;
    const markFirstStreamEvent = () => {
      if (firstStreamEventAtMs === undefined) {
        firstStreamEventAtMs = Date.now();
      }
    };
    const markFirstOutput = () => {
      if (firstOutputAtMs === undefined) {
        firstOutputAtMs = Date.now();
      }
    };
    /** @type {import("./tool-bridge.js").CodexToolCall[]} */
    const nextToolCalls = [];
    /** @type {import("../../data/Codex.js").CodexResponseReasoningInputItem[]} */
    const nextReasoningItems = [];
    /** @type {import("../../data/Codex.js").CodexResponseCompletedEvent["response"] | undefined} */
    let completedResponse;
    /** @type {Map<string, string | null>} */
    const outputItemPhases = new Map();
    const commentaryProgress = createChatVisibleProgressReporter(options.response, options.vscode, "Commentary");
    try {
      const followUpEvents = await fetchCodexResponseStreamWithAuthRefresh(options.context, options.runtime, {
        body,
        signal: options.signal,
        idleTimeoutMs: options.runtime.configuration.streamIdleTimeoutMs,
        onWebSocketResponseCancel() {
          options.logger.info(`Codex WebSocket response.cancel sent. source=chat hostRequest=${hostRequestIndex} sessionId=${options.sessionId} model=${options.model}`);
        },
        onWebSocketReconnect(error) {
          options.logger.info(`Codex WebSocket reached its connection limit before output; retrying with a fresh WebSocket. source=chat hostRequest=${hostRequestIndex} sessionId=${options.sessionId} model=${options.model} error=${error.message}`);
        },
        onWebSocketFallbackToSse(error) {
          options.logger.info(`Codex WebSocket closed before output; retrying with SSE. source=chat hostRequest=${hostRequestIndex} sessionId=${options.sessionId} model=${options.model} error=${error.message}`);
        },
        onWebSocketRequestPrepared(wireBody) {
          wireBodyForFailure = wireBody;
          wireDiagnostics = summarizeCodexRequestBodyForDiagnostics(wireBody);
          logCodexRequestDiagnostics(options.logger, options.runtime.configuration.debugLevel, wireBody, {
            ...requestDiagnosticsContext,
            stage: "wire"
          });
          logCocopiMemoryDiagnostics(options.logger, options.runtime.configuration.debugLevel, {
            source: "chat",
            hostRequestIndex,
            sessionId: options.sessionId,
            stage: "follow-up-wire-body",
            model: options.model,
            inputItems: wireBody.input?.length ?? 0,
            tools: Array.isArray(wireBody.tools) ? wireBody.tools.length : undefined
          });
        },
        onWebSocketContinuationDecision(decision) {
          webSocketContinuationDecision = decision;
          logCodexWebSocketContinuationDecision(options.logger, options.runtime.configuration.debugLevel, {
            source: "chat",
            model: options.model,
            hostRequestIndex,
            sessionId: options.sessionId,
            promptCacheKey: body.prompt_cache_key
          }, decision, {
            issueTracking: options.runtime.configuration.issueTracking
          });
        }
      });

      for await (const event of followUpEvents) {
        markFirstStreamEvent();
        throwIfChatCancellationRequested(options);
        logCodexResponseEventDiagnostics(options.logger, options.runtime.configuration.debugLevel, event, {
          ...requestDiagnosticsContext,
          stage: "stream"
        });
        throwIfCodexTerminalEvent(event);
        captureCodexOutputItemPhase(outputItemPhases, event);

        const delta = readCodexTextDelta(event);
        if (delta) {
          markFirstOutput();
          const phase = codexOutputTextDeltaPhase(outputItemPhases, event);
          if (isCodexCommentaryOutputPhase(phase)) {
            commentaryProgress.report(delta, {
              id: codexOutputTextPartId(event),
              metadata: codexOutputTextMetadata(event, phase)
            });
          } else {
            commentaryProgress.finish();
            options.response.markdown(delta);
          }
        }

        const reasoningSummaryDelta = readCodexReasoningSummaryTextDelta(event);
        if (reasoningSummaryDelta) {
          markFirstOutput();
          commentaryProgress.finish();
          reportChatReasoningProgress(options.response, options.vscode, reasoningSummaryDelta, {
            id: codexReasoningSummaryPartId(event),
            metadata: codexReasoningSummaryMetadata(event)
          });
        }

        const rawToolCall = readCodexToolCall(event);
        const prunedToolCall = withOptionalNullToolArgumentsRemoved(rawToolCall, options.userTools);
        const toolCall = withDefaultRunSubagentToolModel(prunedToolCall, runSubagentDefaultModel);
        if (toolCall) {
          markFirstOutput();
          if (prunedToolCall && toolCall !== prunedToolCall) {
            options.logger.info(`VS Code runSubagent tool call pinned to Cocopi model. source=chat model=${runSubagentDefaultModel}`);
          }
          nextToolCalls.push(toolCall);
        }

        const reasoningItem = readCodexReasoningInputItem(event);
        if (reasoningItem) {
          nextReasoningItems.push(reasoningItem);
        }

        if (event.type === "response.completed" && "response" in event && event.response && typeof event.response === "object" && !Array.isArray(event.response)) {
          markFirstOutput();
          completedResponse = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (event.response);
        }
      }
    } catch (error) {
      if (!options.abort.signal.aborted) {
        logCodexFailurePayloadDiagnostics(options.logger, options.runtime.configuration.debugLevel, toLoggableError(error), {
          source: "chat",
          hostRequestIndex,
          sessionId: options.sessionId,
          stage: "follow-up-failure"
        }, {
          requestBody: body,
          wireBody: wireBodyForFailure
        });
      }
      throw error;
    } finally {
      commentaryProgress.finish();
    }

    const requestCompletedAtMs = Date.now();
    logCodexTokenCacheSummary(options.logger, options.runtime.configuration.debugLevel, {
      source: "chat",
      selectedModel: options.model,
      model: options.model,
      hostRequestIndex,
      sessionId: options.sessionId,
      conversationSummary: options.conversationSummary,
      conversationDescription: options.conversationDescription,
      inputItems: body.input?.length ?? 0,
      transport: options.runtime.configuration.transport,
      serviceTier: options.runtime.configuration.serviceTier,
      serviceTierSource: "configuration",
      reasoningEffort: reasoning?.effort,
      reasoningSummary: reasoning?.summary ?? undefined,
      fastRequested: options.runtime.configuration.serviceTier === COCOPI_SERVICE_TIERS.priority,
      automaticContinuation: true,
      promptCacheKey: body.prompt_cache_key,
      requestKind: requestDiagnostics.requestKind,
      requestInputDigest: requestDiagnostics.inputDigest,
      requestToolsDigest: requestDiagnostics.toolsDigest,
      requestBodyDigest: requestDiagnostics.bodyDigest,
      wireMode: wireDiagnostics?.wireMode,
      wireInputItems: wireDiagnostics?.inputItems,
      wireInputDigest: wireDiagnostics?.inputDigest,
      wireToolsDigest: wireDiagnostics?.toolsDigest,
      wireBodyDigest: wireDiagnostics?.bodyDigest,
      webSocketContinuationDecision,
      requestStartedAt: new Date(requestStartedAtMs).toISOString(),
      requestCompletedAt: new Date(requestCompletedAtMs).toISOString(),
      requestDurationMs: requestCompletedAtMs - requestStartedAtMs,
      firstEventLatencyMs: firstStreamEventAtMs === undefined ? undefined : firstStreamEventAtMs - requestStartedAtMs,
      firstOutputLatencyMs: firstOutputAtMs === undefined ? undefined : firstOutputAtMs - requestStartedAtMs,
      response: completedResponse
    }, {
      issueTracking: options.runtime.configuration.issueTracking,
      tokenTracking: options.runtime.configuration.tokenTracking
    });
    logCocopiMemoryDiagnostics(options.logger, options.runtime.configuration.debugLevel, {
      source: "chat",
      hostRequestIndex,
      sessionId: options.sessionId,
      stage: "follow-up-completed",
      model: options.model,
      inputItems: body.input?.length ?? 0,
      toolCalls: nextToolCalls.length,
      reasoningItems: nextReasoningItems.length
    });

    pendingToolCalls = nextToolCalls;
    pendingReasoningItems = nextReasoningItems;
  }

  return followUpInput.slice(options.input.length);
}

/**
 * @param {import("vscode").ChatResponseStream} response
 * @param {import("./tool-bridge.js").CodexToolCall} toolCall
 * @param {"started" | "completed" | "failed"} state
 */
function reportToolInvocationProgress(response, toolCall, state) {
  const editToolMessages = EDIT_TOOL_PROGRESS_MESSAGES[toolCall.name];
  if (editToolMessages) {
    response.progress(editToolMessages[state]);
    return;
  }

  if (state === "started") {
    response.progress(`Running ${toolCall.name}.`);
  }
}

/**
 * @param {import("vscode").ChatResponseStream} response
 * @param {Pick<VscodeChatApi, "ChatResponseThinkingProgressPart">} vscode
 * @param {string} fallbackLabel
 */
function createChatVisibleProgressReporter(response, vscode, fallbackLabel) {
  let fallbackOpen = false;
  return {
    /**
     * @param {string} text
     * @param {{ id?: string, metadata?: Record<string, unknown> }} [options]
     */
    report(text, options = {}) {
      if (!text) {
        return;
      }

      if (vscode.ChatResponseThinkingProgressPart) {
        response.push(/** @type {import("vscode").ChatResponsePart} */ (new vscode.ChatResponseThinkingProgressPart(text, options.id, options.metadata)));
        return;
      }

      if (!fallbackOpen) {
        response.markdown(`<details open><summary>${fallbackLabel}</summary>\n\n`);
        fallbackOpen = true;
      }
      response.markdown(text);
    },

    finish() {
      if (vscode.ChatResponseThinkingProgressPart || !fallbackOpen) {
        return;
      }

      response.markdown("\n\n</details>\n\n");
      fallbackOpen = false;
    }
  };
}

/**
 * @param {import("vscode").ChatResponseStream} response
 * @param {Pick<VscodeChatApi, "ChatResponseThinkingProgressPart">} vscode
 * @param {string} text
 * @param {{ id?: string, metadata?: Record<string, unknown> }} [options]
 */
function reportChatReasoningProgress(response, vscode, text, options = {}) {
  if (!text) {
    return;
  }

  if (vscode.ChatResponseThinkingProgressPart) {
    response.push(/** @type {import("vscode").ChatResponsePart} */ (new vscode.ChatResponseThinkingProgressPart(text, options.id, options.metadata)));
    return;
  }

  response.markdown(text);
}

/**
 * @param {{ token: import("vscode").CancellationToken, signal?: AbortSignal, abort?: import("./cancellation.js").AbortSignalRegistration, logger: import("./diagnostics.js").CocopiLogger, model: string, sessionId: string }} options
 */
function throwIfChatCancellationRequested(options) {
  const cancelled = options.abort
    ? abortIfCancellationRequested(options.abort, options.token)
    : options.signal?.aborted || options.token.isCancellationRequested;
  if (cancelled) {
    options.logger.info(`VS Code cancellation ${vscodeCancellationSourceLabel(options.abort?.cancellationSource)}. source=chat sessionId=${options.sessionId} model=${options.model}`);
    throw new Error(VSCODE_CANCELLATION_MESSAGE);
  }
}

/**
 * @param {import("vscode").ChatRequest} request
 * @param {Pick<VscodeChatApi, "lm">} vscode
 */
function languageModelToolsFromChatRequest(request, vscode) {
  if (request.toolReferences.length === 0) {
    return [];
  }

  const requestedNames = new Set(request.toolReferences.map((toolReference) => toolReference.name));
  return vscode.lm.tools.filter((tool) => requestedNames.has(tool.name));
}

/**
 * @param {import("../../data/Codex.js").CodexResponseCompletedEvent["response"] | undefined} completedResponse
 * @returns {string | undefined}
 */
function formatBilledTokensSummary(completedResponse) {
  if (!completedResponse) {
    return;
  }

  const usage = readCodexUsageSummary(completedResponse);
  if (!usage) {
    return;
  }

  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const totalTokens = usage.totalTokens
    ?? (typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined);
  if (totalTokens === undefined) {
    return;
  }

  const details = [
    inputTokens === undefined ? undefined : `in=${inputTokens}`,
    outputTokens === undefined ? undefined : `out=${outputTokens}`
  ].filter((part) => part !== undefined);
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";

  return `${totalTokens} tokens${suffix}`;
}
