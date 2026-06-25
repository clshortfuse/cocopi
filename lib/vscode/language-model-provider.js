import { buildTextResponseBody } from "../codex-api/response-body.js";
import { canonicalCodexJsonString } from "../codex-api/json.js";
import { captureCodexOutputItemPhase, codexOutputTextDeltaPhase, codexReasoningSummaryMetadata, codexReasoningSummaryPartId, codexReasoningTextMetadata, codexReasoningTextPartId, isCodexCommentaryOutputPhase, readCodexReasoningSummaryTextDelta, readCodexReasoningTextDelta, readCodexTextDelta, throwIfCodexTerminalEvent } from "../codex-api/responses.js";
import { codexContinuationRequestState, isCodexPreviousResponseNotFoundError } from "../codex-api/websocket.js";
import { abortIfCancellationRequested, abortSignalFromCancellationToken, VSCODE_CANCELLATION_MESSAGE, vscodeCancellationSourceLabel } from "./cancellation.js";
import { COCOPI_COMMANDS } from "./commands.js";
import { CODEX_REASONING_EFFORTS, COCOPI_CHAT_INSTRUCTIONS_MODES, COCOPI_SERVICE_TIERS, codexReasoningFromCocopiOptions, codexServiceTierFromCocopiOptions, codexToolOptionsFromCocopiOptions, resolveChatParticipantInstructions } from "./configuration.js";
import { logCodexFailurePayloadDiagnostics, logCodexRequestDiagnostics, logCodexResponseEventDiagnostics, logCodexTokenCacheSummary, logCodexWebSocketContinuationDecision, noopCocopiLogger, readCodexUsageSummary, summarizeCodexRequestBodyForDiagnostics } from "./diagnostics.js";
import { fetchCodexResponseStreamWithAuthRefresh, listCodexModelsWithAuthRefresh } from "./codex-request.js";
import { recordCocopiIssue } from "./issues.js";
import { readCocopiRuntime } from "./runtime.js";
import { CODEX_SECRET_KEYS } from "./secret-storage.js";
import { newCocopiSessionId, normalizeCocopiSessionId } from "./session-id.js";
import { cocopiTurnClientMetadata } from "./turn-metadata.js";
import { codexFunctionCallInputItemFromToolCall, codexToolChoiceFromLanguageModelToolMode, codexToolsFromLanguageModelTools, languageModelQualifiedName, readCodexReasoningInputItem, readCodexToolCall, readCodexToolCallStart, stableCodexJsonString, stripUnsupportedLanguageModelToolSchemaMetadata, withDefaultRunSubagentToolModel, withOptionalNullToolArgumentsRemoved } from "./tool-bridge.js";

export const COCOPI_LANGUAGE_MODEL_VENDOR = "cocopi";
export const COCOPI_LANGUAGE_MODEL_INSTALLATION_ID = "cocopi-language-model";
export const COCOPI_STATEFUL_MARKER_MIME = "stateful_marker";
export const VSCODE_LANGUAGE_MODEL_USAGE_MIME = "usage";
export const COCOPI_MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const COCOPI_MODEL_CATALOG_REFRESH_BACKOFF_INITIAL_MS = 5 * 1000;
const COCOPI_MODEL_CATALOG_REFRESH_BACKOFF_MAX_MS = 5 * 60 * 1000;
const COCOPI_MODEL_CATALOG_STORAGE_KEY = "cocopi.modelCatalog.v1";
const COCOPI_STATEFUL_MARKER_PAYLOAD_PREFIX = "cocopi:response-items:v1:";
const COCOPI_FAST_MODEL_SUFFIX = ":fast";
const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384;
const LANGUAGE_MODEL_TEXT_REPORT_MAX_CHARS = 160;
const LANGUAGE_MODEL_TEXT_REPORT_MAX_DELAY_MS = 100;
const LANGUAGE_MODEL_PATCH_TOOL_NAMES = new Set(["apply_patch", "copilot_applyPatch"]);
const LANGUAGE_MODEL_STRUCTURED_EDIT_TOOL_NAMES = new Set(["copilot_insertEdit", "insert_edit_into_file"]);
const LANGUAGE_MODEL_FILE_CREATION_TOOL_NAMES = new Set(["create_file"]);
const LANGUAGE_MODEL_EDIT_TOOL_ARGUMENT_PROGRESS_MAX_CHARS = 64 * 1024;
const LANGUAGE_MODEL_TOOL_ARGUMENT_PROGRESS_FIRST_CHARS = 2 * 1024;
const LANGUAGE_MODEL_TOOL_ARGUMENT_PROGRESS_INTERVAL_CHARS = 8 * 1024;
const LANGUAGE_MODEL_TOOL_ARGUMENT_PROGRESS_TIMER_MS = 500;
const LANGUAGE_MODEL_CONFIGURATION_OPTIONS_KEY = "reasoningEffort";
const LANGUAGE_MODEL_CONFIGURATION_CONTEXT_SIZE_KEY = "contextSize";
const DEFAULT_MODEL_CONFIGURATION_REASONING_EFFORTS = /** @type {const} */ (["low", "medium", "high", "xhigh"]);
const COCOPI_AUTH_SECRET_KEYS = /** @type {Set<string>} */ (new Set(Object.values(CODEX_SECRET_KEYS)));
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * @param {import("./configuration.js").CocopiConfiguration} configuration
 */
function compactionOptionsFromConfiguration(configuration) {
  return {
    useModelDefaultCompactionLimit: configuration.useModelDefaultCompactionLimit,
    compactionFallbackStrategy: configuration.compactionFallbackStrategy
  };
}

/**
 * @param {import("vscode").LanguageModelChatInformation} information
 * @param {CodexModelSummary | undefined} model
 * @param {{ useModelDefaultCompactionLimit?: boolean, compactionFallbackStrategy?: "full" | "ninety-percent" }} options
 */
function languageModelCompactionDiagnosticKey(information, model, options) {
  return [
    information.id,
    languageModelDefaultContextSize(information),
    information.maxInputTokens,
    information.maxOutputTokens,
    model?.contextWindow ?? "",
    model?.maxContextWindow ?? "",
    model?.autoCompactTokenLimit ?? "",
    options.useModelDefaultCompactionLimit !== false,
    options.compactionFallbackStrategy ?? "ninety-percent"
  ].join("\n");
}

/**
 * @param {Map<string, number>} turnsBySession
 * @param {string} sessionId
 * @param {number | undefined} [restoredHostRequestIndex]
 */
function nextLanguageModelRequestTurn(turnsBySession, sessionId, restoredHostRequestIndex) {
  const previousTurn = Math.max(turnsBySession.get(sessionId) ?? 0, restoredHostRequestIndex ?? 0);
  const nextTurn = previousTurn + 1;
  turnsBySession.set(sessionId, nextTurn);
  return nextTurn;
}

/** @typedef {import("../../data/Codex.js").CodexResponseInputItem} CodexResponseInputItem */
/** @typedef {import("../../data/Codex.js").CodexResponseInputMessage} CodexResponseInputMessage */
/** @typedef {import("../../data/Codex.js").CodexContentItem} CodexContentItem */
/** @typedef {import("../../data/Codex.js").CodexResponseFunctionCallInputItem} CodexResponseFunctionCallInputItem */
/** @typedef {import("../../data/Codex.js").CodexResponseFunctionCallOutputInputItem} CodexResponseFunctionCallOutputInputItem */
/** @typedef {import("../../data/Codex.js").CodexResponseReasoningInputItem} CodexResponseReasoningInputItem */
/** @typedef {import("../../data/Codex.js").CodexModelSummary} CodexModelSummary */
/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */
/** @typedef {{ modelId: string, serviceTier?: "priority" }} CocopiLanguageModelRequestModel */
/** @typedef {{ input: CodexResponseInputItem[], responseItems: CodexResponseInputItem[], responseId: string, requestState?: Record<string, import("../../data/Codex.js").CodexJsonValue> }} RestoredContinuationAnchor */
/** @typedef {{ prompt_tokens: number, completion_tokens: number, total_tokens: number, prompt_tokens_details?: { cached_tokens: number }, completion_tokens_details?: { reasoning_tokens: number } }} VscodeLanguageModelUsagePayload */
/** @typedef {{ name: string, text: string, reports: number, nextProgressChars: number, startedAtMs: number, nextProgressMs: number, target?: string }} LanguageModelToolArgumentProgress */

/**
 * @typedef {object} VscodeLanguageModelApi
 * @property {{ registerLanguageModelChatProvider(vendor: string, provider: import("vscode").LanguageModelChatProvider): { dispose(): void }, selectChatModels?: (selector?: { vendor?: string }) => Thenable<readonly import("vscode").LanguageModelChat[]> }} lm
 * @property {typeof import("vscode").LanguageModelTextPart} LanguageModelTextPart
 * @property {{ new(value: string | string[], id?: string, metadata?: Record<string, unknown>): unknown }} [LanguageModelThinkingPart]
 * @property {typeof import("vscode").LanguageModelToolCallPart} LanguageModelToolCallPart
 * @property {typeof import("vscode").LanguageModelDataPart} LanguageModelDataPart
 * @property {typeof import("vscode").LanguageModelChatToolMode} LanguageModelChatToolMode
 * @property {typeof import("vscode").LanguageModelChatMessageRole} LanguageModelChatMessageRole
 * @property {typeof import("vscode").LanguageModelError} LanguageModelError
 * @property {import("./configuration.js").ConfigurationApiLike["workspace"]} workspace
 * @property {{ executeCommand?: (command: string) => Thenable<unknown> }} [commands]
 * @property {{ showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined> }} [window]
 */

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeLanguageModelApi} vscode
 * @param {{ logger?: import("./diagnostics.js").CocopiLogger }} [options]
 */
export function registerCocopiLanguageModelProvider(context, vscode, options = {}) {
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(
    COCOPI_LANGUAGE_MODEL_VENDOR,
    createCocopiLanguageModelProvider(context, vscode, options)
  ));
  void prewarmCocopiLanguageModelProvider(vscode, options.logger ?? noopCocopiLogger);
}

/**
 * @param {VscodeLanguageModelApi} vscode
 * @param {import("./diagnostics.js").CocopiLogger} logger
 */
async function prewarmCocopiLanguageModelProvider(vscode, logger) {
  if (typeof vscode.lm.selectChatModels !== "function") {
    return;
  }

  try {
    await vscode.lm.selectChatModels({ vendor: COCOPI_LANGUAGE_MODEL_VENDOR });
  } catch (error) {
    logger.debug(`Cocopi language model startup resolution skipped. error=${normalizeCaughtError(error).message}`);
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeLanguageModelApi} vscode
 * @param {{ logger?: import("./diagnostics.js").CocopiLogger }} [options]
 * @returns {import("vscode").LanguageModelChatProvider}
 */
export function createCocopiLanguageModelProvider(context, vscode, options = {}) {
  const logger = options.logger ?? noopCocopiLogger;
  /** @type {{ key: string, expiresAtMs: number, models: CodexModelSummary[] } | undefined} */
  let modelCatalogCache;
  /** @type {{ key: string, promise: Promise<void> } | undefined} */
  let modelCatalogRefresh;
  /** @type {{ key: string, retryAfterMs: number, delayMs: number } | undefined} */
  let modelCatalogRefreshBackoff;
  const languageModelOptionSnapshotsBySession = new Map();
  let warnedSignedOutModelFallback = false;
  let warnedCatalogModelFallback = false;
  const loggedLanguageModelCompactionDiagnostics = new Set();
  /** @type {Map<string, number>} */
  const languageModelRequestTurnBySession = new Map();
  /** @type {ReturnType<typeof languageModelOptionSnapshot> | undefined} */
  let effectiveLanguageModelSnapshot;
  const modelInformationChanged = createVoidEventEmitter();
  const secretChangeSubscription = subscribeToSecretChanges(context, (event) => {
    if (!isAuthSecretChange(event)) {
      return;
    }

    modelCatalogCache = undefined;
    modelCatalogRefresh = undefined;
    modelCatalogRefreshBackoff = undefined;
    warnedSignedOutModelFallback = false;
    warnedCatalogModelFallback = false;
    loggedLanguageModelCompactionDiagnostics.clear();
    modelInformationChanged.fire();
  });
  if (secretChangeSubscription && "subscriptions" in context && Array.isArray(context.subscriptions)) {
    context.subscriptions.push(secretChangeSubscription);
  }

  return {
    onDidChangeLanguageModelChatInformation: modelInformationChanged.event,

    async provideLanguageModelChatInformation(options, _token) {
      void _token;

      const runtime = await readCocopiRuntime(context, vscode, { refreshAuth: !options.silent });
      if (!runtime.auth) {
        if (!options.silent && !warnedSignedOutModelFallback) {
          warnedSignedOutModelFallback = true;
          await showModelCatalogWarning(vscode, `Cocopi is not signed in, so VS Code can only show the fallback model (${runtime.configuration.model}).`, () => {
            modelCatalogCache = undefined;
            modelInformationChanged.fire();
          });
        }
        return logLanguageModelCompactionDiagnostics(logger, runtime.configuration.debugLevel, [genericLanguageModelInformation(runtime.configuration.model, "Sign in required", compactionOptionsFromConfiguration(runtime.configuration))], [], compactionOptionsFromConfiguration(runtime.configuration), loggedLanguageModelCompactionDiagnostics);
      }

      const storedCatalogCache = options.silent ? await readStoredModelCatalogCache(context.secrets, modelCatalogCacheKey(runtime)) : undefined;
      if (storedCatalogCache && (!modelCatalogCache || modelCatalogCache.key !== storedCatalogCache.key)) {
        modelCatalogCache = storedCatalogCache;
      }

      if (modelCatalogCache?.key === modelCatalogCacheKey(runtime)) {
        if (modelCatalogCache.expiresAtMs > Date.now()) {
          return logLanguageModelCompactionDiagnostics(logger, runtime.configuration.debugLevel, languageModelInformationFromCodexModels(modelCatalogCache.models, runtime.configuration.model, compactionOptionsFromConfiguration(runtime.configuration)), modelCatalogCache.models, compactionOptionsFromConfiguration(runtime.configuration), loggedLanguageModelCompactionDiagnostics);
        }

        if (options.silent) {
          scheduleModelCatalogRefresh(context, runtime, logger, vscode);
          return logLanguageModelCompactionDiagnostics(logger, runtime.configuration.debugLevel, languageModelInformationFromCodexModels(modelCatalogCache.models, runtime.configuration.model, compactionOptionsFromConfiguration(runtime.configuration)), modelCatalogCache.models, compactionOptionsFromConfiguration(runtime.configuration), loggedLanguageModelCompactionDiagnostics);
        }
      }

      if (options.silent) {
        scheduleModelCatalogRefresh(context, runtime, logger, vscode);
        return logLanguageModelCompactionDiagnostics(logger, runtime.configuration.debugLevel, [genericLanguageModelInformation(runtime.configuration.model, "Model catalog loading", compactionOptionsFromConfiguration(runtime.configuration))], [], compactionOptionsFromConfiguration(runtime.configuration), loggedLanguageModelCompactionDiagnostics);
      }

      try {
        const models = await readCachedCodexModels(context, runtime, modelCatalogCache);
        modelCatalogCache = models.cache;
        if (models.catalogChanged) {
          modelInformationChanged.fire();
        }
        return logLanguageModelCompactionDiagnostics(logger, runtime.configuration.debugLevel, languageModelInformationFromCodexModels(models.catalog, runtime.configuration.model, compactionOptionsFromConfiguration(runtime.configuration)), models.catalog, compactionOptionsFromConfiguration(runtime.configuration), loggedLanguageModelCompactionDiagnostics);
      } catch (error) {
        logger.error("Cocopi model catalog refresh failed.", normalizeCaughtError(error));
        if (!warnedCatalogModelFallback) {
          warnedCatalogModelFallback = true;
          await showModelCatalogWarning(vscode, modelCatalogFallbackWarning(runtime.configuration.model, normalizeCaughtError(error)), () => {
            modelCatalogCache = undefined;
            modelInformationChanged.fire();
          });
        }
        return logLanguageModelCompactionDiagnostics(logger, runtime.configuration.debugLevel, [genericLanguageModelInformation(runtime.configuration.model, "Model catalog unavailable", compactionOptionsFromConfiguration(runtime.configuration))], [], compactionOptionsFromConfiguration(runtime.configuration), loggedLanguageModelCompactionDiagnostics);
      }
    },

    async provideLanguageModelChatResponse(model, messages, requestOptions, progress, token) {
      const abort = abortSignalFromCancellationToken(token);
      const logProviderBoundaryCancellation = () => {
        logger.info(`VS Code cancellation ${vscodeCancellationSourceLabel(abort.cancellationSource)}. source=language-model phase=provider model=${model.id || "unknown"}`);
      };
      if (abort.signal.aborted) {
        logProviderBoundaryCancellation();
      } else {
        abort.signal.addEventListener("abort", logProviderBoundaryCancellation, { once: true });
      }

      let runtime;
      try {
        runtime = await readCocopiRuntime(context, vscode);
      } catch (error) {
        abort.signal.removeEventListener("abort", logProviderBoundaryCancellation);
        abort.dispose();
        throw error;
      }
      if (!runtime.auth) {
        abort.signal.removeEventListener("abort", logProviderBoundaryCancellation);
        abort.dispose();
        throw vscode.LanguageModelError.NoPermissions("Cocopi is not signed in.");
      }

      const userTools = requestOptions.tools ?? [];
      const strippedToolSchemaMetadata = stripUnsupportedLanguageModelToolSchemaMetadata(userTools);
      if (strippedToolSchemaMetadata > 0) {
        logger.info(`VS Code tool schema metadata stripped before tool execution. source=language-model count=${strippedToolSchemaMetadata}`);
      }
      const runSubagentDefaultModel = languageModelQualifiedName(model, COCOPI_LANGUAGE_MODEL_VENDOR);
      const receivedModelId = model.id || runtime.configuration.model;
      const requestedModel = cocopiLanguageModelRequestModel(receivedModelId);
      let requestModelId = requestedModel.modelId;
      /** @type {import("../../data/Codex.js").CodexResponseCreateRequest | undefined} */
      let requestBody;
      /** @type {import("../../data/Codex.js").CodexResponseCreateRequest | undefined} */
      let wireRequestBody;
      /** @type {import("./diagnostics.js").CodexTokenCacheSummaryContext | undefined} */
      let tokenCacheSummaryContext;
      let tokenCacheSummaryLogged = false;
      /** @type {(() => void) | undefined} */
      let removeCancellationLogListener;
      const progressSummary = {
        textDeltas: 0,
        textBytes: 0,
        textReports: 0,
        reasoningSummaryDeltas: 0,
        reasoningSummaryBytes: 0,
        toolCalls: 0,
        lastLoggedTextDeltas: 0,
        lastLoggedReasoningSummaryDeltas: 0,
        lastLoggedToolCalls: 0
      };
      try {
        logger.info(`Starting language model request. model=${requestModelId} transport=${runtime.configuration.transport} apiBaseUrl=${runtime.configuration.apiBaseUrl} idleTimeoutMs=${runtime.configuration.streamIdleTimeoutMs ?? "disabled"} account=${runtime.auth.chatgptAccountId ? "present" : "none"}`);
        const messageSummary = languageModelMessageSummary(messages);
        logLanguageModelMessageDiagnostics(logger, runtime.configuration.debugLevel, messageSummary);
        const requestState = codexRequestStateFromLanguageModelMessages(messages, requestModelId, vscode, {
          debugLevel: runtime.configuration.debugLevel,
          logger,
          issueTracking: runtime.configuration.issueTracking
        });
        const requestInstructions = resolveLanguageModelInstructions(requestState.instructions, runtime.configuration);
        const automaticContinuation = isCodexToolContinuationInput(requestState.input);
        const conversationMetadata = languageModelConversationMetadata(requestState.input, messageSummary);
        const sessionId = requestState.sessionId ?? newCocopiSessionId("language-model");
        const hostRequestIndex = nextLanguageModelRequestTurn(languageModelRequestTurnBySession, sessionId, requestState.hostRequestIndex);
        const logCancellation = () => {
          logger.info(`VS Code cancellation ${vscodeCancellationSourceLabel(abort.cancellationSource)}. source=language-model hostRequest=${hostRequestIndex} sessionId=${sessionId} model=${requestModelId}`);
        };
        if (abort.signal.aborted) {
          logCancellation();
        } else {
          abort.signal.addEventListener("abort", logCancellation, { once: true });
          removeCancellationLogListener = () => abort.signal.removeEventListener("abort", logCancellation);
        }
        if (abortIfCancellationRequested(abort, token)) {
          throw new Error(VSCODE_CANCELLATION_MESSAGE);
        }
        const modelOptions = languageModelRequestModelOptions(requestOptions);
        const toolOptions = codexToolOptionsFromCocopiOptions(runtime.configuration, modelOptions);
        const tools = codexToolsFromLanguageModelTools(userTools, toolOptions);
        const toolChoice = codexToolChoiceFromLanguageModelToolMode(requestOptions.toolMode, userTools.length > 0, vscode.LanguageModelChatToolMode.Required);
        const modelReasoningOptions = codexModelReasoningOptions(modelCatalogCache?.models, requestModelId);
        const reasoning = codexReasoningFromCocopiOptions(runtime.configuration, modelOptions, modelReasoningOptions);
        const fastRequested = requestedModel.serviceTier === COCOPI_SERVICE_TIERS.priority || languageModelFastOptionSelected(modelOptions);
        const serviceTier = requestedModel.serviceTier ?? (fastRequested ? COCOPI_SERVICE_TIERS.priority : codexServiceTierFromCocopiOptions(runtime.configuration, modelOptions));
        logLanguageModelProfileConfigurationApplied(logger, {
          requestOptions,
          hostRequestIndex,
          sessionId,
          receivedModelId,
          requestModelId
        });
        logLanguageModelRequestOptionsDiagnostics(logger, runtime.configuration.debugLevel, modelOptions, {
          serviceTier,
          reasoningEffort: reasoning?.effort,
          reasoningSummary: reasoning?.summary ?? undefined,
          fastRequested
        });
        effectiveLanguageModelSnapshot = logEffectiveLanguageModelState(logger, effectiveLanguageModelSnapshot, {
          sessionId,
          hostRequestIndex,
          receivedModelId,
          requestModelId,
          modelOptions,
          serviceTier,
          serviceTierSource: requestedModel.serviceTier ? "model" : "option",
          reasoningEffort: reasoning?.effort,
          reasoningSummary: reasoning?.summary ?? undefined,
          fastRequested
        });
        logLanguageModelOptionReceipt(logger, languageModelOptionSnapshotsBySession, {
          sessionId,
          hostRequestIndex,
          receivedModelId,
          requestModelId,
          modelOptions,
          serviceTier,
          serviceTierSource: requestedModel.serviceTier ? "model" : "option",
          reasoningEffort: reasoning?.effort,
          reasoningSummary: reasoning?.summary ?? undefined,
          fastRequested
        });
        const body = buildTextResponseBody({
          model: requestModelId,
          ...(requestInstructions ? { instructions: requestInstructions } : {}),
          input: requestState.input,
          tools,
          toolChoice,
          stream: true,
          parallelToolCalls: tools.length > 1,
          serviceTier,
          ...(reasoning ? { reasoning } : {}),
          include: /** @type {import("../../data/Codex.js").CodexResponseInclude[]} */ (["reasoning.encrypted_content"]),
          promptCacheKey: sessionId,
          clientMetadata: {
            "x-codex-installation-id": COCOPI_LANGUAGE_MODEL_INSTALLATION_ID,
            ...cocopiTurnClientMetadata("language-model", sessionId, hostRequestIndex)
          }
        });
        requestBody = body;
        const requestContinuationState = codexContinuationRequestState(body);
        const requestDiagnostics = summarizeCodexRequestBodyForDiagnostics(body);
        const continuationAnchors = continuationAnchorsFromLanguageModelRequestState(requestState, body);
        tokenCacheSummaryContext = {
          source: "language-model",
          selectedModel: receivedModelId,
          model: requestModelId,
          hostRequestIndex,
          sessionId,
          conversationSummary: conversationMetadata.summary,
          conversationDescription: conversationMetadata.description,
          inputItems: body.input?.length ?? 0,
          stateRestored: Boolean(requestState.sessionId),
          requestMessages: messageSummary.messages,
          requestTextParts: messageSummary.textParts,
          requestToolCallParts: messageSummary.toolCallParts,
          requestToolResultParts: messageSummary.toolResultParts,
          requestDataParts: messageSummary.dataParts,
          requestCocopiDataParts: messageSummary.cocopiDataParts,
          requestCocopiDataBytes: messageSummary.cocopiDataBytes,
          requestDataMimeTypes: messageSummary.dataMimeTypes,
          transport: runtime.configuration.transport,
          serviceTier,
          serviceTierSource: requestedModel.serviceTier ? "model" : "option",
          reasoningEffort: reasoning?.effort,
          reasoningSummary: reasoning?.summary ?? undefined,
          fastRequested,
          automaticContinuation,
          promptCacheKey: body.prompt_cache_key,
          requestKind: requestDiagnostics.requestKind,
          requestInputDigest: requestDiagnostics.inputDigest,
          requestToolsDigest: requestDiagnostics.toolsDigest,
          requestBodyDigest: requestDiagnostics.bodyDigest,
          ...(runtime.configuration.transport === "websocket" ? {} : {
            wireMode: requestDiagnostics.wireMode,
            wireInputItems: requestDiagnostics.inputItems,
            wireInputDigest: requestDiagnostics.inputDigest,
            wireToolsDigest: requestDiagnostics.toolsDigest,
            wireBodyDigest: requestDiagnostics.bodyDigest
          })
        };
        const requestDiagnosticsContext = {
          source: "language-model",
          hostRequestIndex,
          sessionId
        };
        logCodexRequestDiagnostics(logger, runtime.configuration.debugLevel, body, {
          ...requestDiagnosticsContext,
          stage: "prepared"
        });
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
        const events = await fetchCodexResponseStreamWithAuthRefresh(context, runtime, {
          body,
          continuationAnchors,
          signal: abort.signal,
          idleTimeoutMs: runtime.configuration.streamIdleTimeoutMs,
          onWebSocketResponseCancel() {
            logger.info(`Codex WebSocket response.cancel sent. source=language-model hostRequest=${hostRequestIndex} sessionId=${sessionId} model=${requestModelId}`);
          },
          onWebSocketReconnect(error) {
            logger.info(`Codex WebSocket reached its connection limit before output; retrying with a fresh WebSocket. source=language-model hostRequest=${hostRequestIndex} sessionId=${sessionId} model=${requestModelId} error=${error.message}`);
          },
          onWebSocketFallbackToSse(error) {
            logger.info(`Codex WebSocket failed before output; retrying full request with SSE. source=language-model hostRequest=${hostRequestIndex} sessionId=${sessionId} model=${requestModelId} error=${error.message}`);
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
            logCodexRequestDiagnostics(logger, runtime.configuration.debugLevel, wireBody, {
              ...requestDiagnosticsContext,
              stage: "wire"
            });
          },
          onWebSocketContinuationDecision(decision) {
            if (tokenCacheSummaryContext) {
              tokenCacheSummaryContext.webSocketContinuationDecision = decision;
            }
            logCodexWebSocketContinuationDecision(logger, runtime.configuration.debugLevel, {
              source: "language-model",
              model: requestModelId,
              hostRequestIndex,
              sessionId,
              promptCacheKey: body.prompt_cache_key
            }, decision, {
              issueTracking: runtime.configuration.issueTracking
            });
          }
        });

        const reportedToolCallIds = new Set();
        const responseState = createResponseStateBuilder();
        /** @type {string[]} */
        const textDeltas = [];
        /** @type {Map<string, string | null>} */
        const outputItemPhases = new Map();
        let completedOutputText = "";
        let completedCommentaryOutputText = "";
        let completedMessageOutputText = "";
        let commentaryTextDeltas = 0;
        let statefulMarkerEmitted = false;
        let streamResponseId = "";
        const reportedToolCallStartIds = new Set();
        /** @type {Map<string, string>} */
        const toolCallIdByOutputItemId = new Map();
        /** @type {Map<string, LanguageModelToolArgumentProgress>} */
        const editToolArgumentProgressByCallId = new Map();
        /** @type {ReturnType<typeof setInterval> | undefined} */
        let editToolArgumentProgressTimer;
        /** @type {import("../../data/Codex.js").CodexResponseCompletedEvent["response"] | undefined} */
        let completedResponse;
        const textProgress = createLanguageModelTextProgressReporter(progress, vscode, {
          debugLevel: runtime.configuration.debugLevel,
          logger,
          onReport() {
            progressSummary.textReports += 1;
          }
        });
        const reasoningProgress = createLanguageModelReasoningProgressReporter(progress, vscode, true);
        /**
         * @param {string} callId
         * @param {LanguageModelToolArgumentProgress} editProgress
         * @param {string} message
         */
        const reportEditToolProgress = (callId, editProgress, message) => {
          editProgress.reports += 1;
          textProgress.finish();
          reasoningProgress.report(message, {
            id: `cocopi-tool-progress:${callId}:${editProgress.reports}`,
            metadata: { cocopi_tool_progress: editProgress.name }
          });
          progressSummary.reasoningSummaryDeltas += 1;
          progressSummary.reasoningSummaryBytes += message.length;
          logLanguageModelProgressMilestone(logger, runtime.configuration.debugLevel, progressSummary, "reasoning");
        };
        const clearEditToolArgumentProgressTimer = () => {
          if (editToolArgumentProgressTimer) {
            clearInterval(editToolArgumentProgressTimer);
            editToolArgumentProgressTimer = undefined;
          }
        };
        /** @param {string} callId */
        const finishEditToolArgumentProgress = (callId) => {
          editToolArgumentProgressByCallId.delete(callId);
          if (editToolArgumentProgressByCallId.size === 0) {
            clearEditToolArgumentProgressTimer();
          }
        };
        const reportTimedEditToolProgress = () => {
          if (!runtime.configuration.editProgressIntervalMs) {
            return;
          }

          const now = Date.now();
          for (const [callId, editProgress] of editToolArgumentProgressByCallId) {
            if (now < editProgress.nextProgressMs) {
              continue;
            }

            const message = editToolTimedProgressMessage(editProgress.name, editProgress.target, editProgress.text.length, now - editProgress.startedAtMs);
            editProgress.nextProgressMs = now + runtime.configuration.editProgressIntervalMs;
            reportEditToolProgress(callId, editProgress, message);
          }
        };
        const ensureEditToolArgumentProgressTimer = () => {
          if (editToolArgumentProgressTimer || !runtime.configuration.editProgressIntervalMs) {
            return;
          }

          editToolArgumentProgressTimer = setInterval(reportTimedEditToolProgress, LANGUAGE_MODEL_TOOL_ARGUMENT_PROGRESS_TIMER_MS);
          editToolArgumentProgressTimer.unref?.();
        };

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
          streamResponseId = codexResponseIdFromStreamEvent(event) ?? streamResponseId;
          captureCodexOutputItemPhase(outputItemPhases, event);

          const toolCallStart = readCodexToolCallStart(event);
          if (toolCallStart && !reportedToolCallStartIds.has(toolCallStart.callId)) {
            reportedToolCallStartIds.add(toolCallStart.callId);
            if (toolCallStart.itemId) {
              toolCallIdByOutputItemId.set(toolCallStart.itemId, toolCallStart.callId);
            }
            if (isEditProgressTool(toolCallStart.name)) {
              const startedAtMs = Date.now();
              const nextProgressMs = runtime.configuration.editProgressIntervalMs
                ? startedAtMs + runtime.configuration.editProgressIntervalMs
                : Number.POSITIVE_INFINITY;
              const editProgress = {
                name: toolCallStart.name,
                text: "",
                reports: 0,
                nextProgressChars: LANGUAGE_MODEL_TOOL_ARGUMENT_PROGRESS_FIRST_CHARS,
                startedAtMs,
                nextProgressMs
              };
              editToolArgumentProgressByCallId.set(toolCallStart.callId, editProgress);
              ensureEditToolArgumentProgressTimer();
            }
          }

          const toolArgumentDelta = readCodexToolCallArgumentDelta(event);
          if (toolArgumentDelta) {
            const callId = toolCallIdByOutputItemId.get(toolArgumentDelta.itemId);
            const editProgress = callId ? editToolArgumentProgressByCallId.get(callId) : undefined;
            if (callId && editProgress) {
              editProgress.text = appendBoundedToolArgumentText(editProgress.text, toolArgumentDelta.delta);
              const target = editToolTargetFromArgumentText(editProgress.name, editProgress.text);
              const targetMessage = editToolTargetProgressMessage(editProgress.name, target);
              if (target && target !== editProgress.target && targetMessage) {
                editProgress.target = target;
                reportEditToolProgress(callId, editProgress, targetMessage);
              }
              if (editProgress.text.length >= editProgress.nextProgressChars) {
                const progressMessage = editToolArgumentProgressMessage(editProgress.name, editProgress.target, editProgress.text.length);
                editProgress.nextProgressChars += LANGUAGE_MODEL_TOOL_ARGUMENT_PROGRESS_INTERVAL_CHARS;
                reportEditToolProgress(callId, editProgress, progressMessage);
              }
            }
          }

          const delta = readCodexTextDelta(event);
          if (delta) {
            markFirstOutput();
            const phase = codexOutputTextDeltaPhase(outputItemPhases, event);
            if (isCodexCommentaryOutputPhase(phase)) {
              reasoningProgress.finish();
              textDeltas.push(delta);
              textProgress.report(delta);
              progressSummary.textDeltas += 1;
              progressSummary.textBytes += delta.length;
              commentaryTextDeltas += 1;
              logLanguageModelProgressMilestone(logger, runtime.configuration.debugLevel, progressSummary, "text");
            } else {
              reasoningProgress.finish();
              textDeltas.push(delta);
              textProgress.report(delta);
              progressSummary.textDeltas += 1;
              progressSummary.textBytes += delta.length;
              logLanguageModelProgressMilestone(logger, runtime.configuration.debugLevel, progressSummary, "text");
            }
          }

          const reasoningDelta = readCodexReasoningSummaryTextDelta(event) || readCodexReasoningTextDelta(event);
          if (reasoningDelta) {
            markFirstOutput();
            reasoningProgress.report(reasoningDelta, {
              id: codexReasoningSummaryPartId(event) ?? codexReasoningTextPartId(event),
              metadata: codexReasoningSummaryMetadata(event) ?? codexReasoningTextMetadata(event)
            });
            progressSummary.reasoningSummaryDeltas += 1;
            progressSummary.reasoningSummaryBytes += reasoningDelta.length;
            logLanguageModelProgressMilestone(logger, runtime.configuration.debugLevel, progressSummary, "reasoning");
          }

          if (event.type === "response.completed") {
            markFirstOutput();
            completedOutputText = codexOutputTextFromCompletedEvent(event) ?? completedOutputText;
            completedCommentaryOutputText ||= codexCommentaryOutputTextFromCompletedEvent(event) ?? "";
            captureCompletedResponseOutputItems(responseState, event);
            completedResponse = event.response;
            streamResponseId = event.response.id ?? streamResponseId;
            if (tokenCacheSummaryContext) {
              tokenCacheSummaryContext.response = completedResponse;
            }
          }

          const duplicateToolCallId = outputItemDoneToolCallId(event);
          const rawToolCall = duplicateToolCallId && reportedToolCallIds.has(duplicateToolCallId)
            ? undefined
            : readCodexToolCall(event);
          const prunedToolCall = withOptionalNullToolArgumentsRemoved(rawToolCall, userTools);
          const toolCall = withDefaultRunSubagentToolModel(prunedToolCall, runSubagentDefaultModel);
          if (toolCall) {
            markFirstOutput();
            if (prunedToolCall && toolCall !== prunedToolCall) {
              logger.info(`VS Code runSubagent tool call pinned to Cocopi model. source=language-model model=${runSubagentDefaultModel}`);
            }
            const editProgress = editToolArgumentProgressByCallId.get(toolCall.callId);
            if (editProgress) {
              const target = editToolTargetFromToolInput(toolCall.name, toolCall.input);
              const targetMessage = editToolTargetProgressMessage(toolCall.name, target);
              if (target && target !== editProgress.target && targetMessage) {
                editProgress.target = target;
                reportEditToolProgress(toolCall.callId, editProgress, targetMessage);
              }
              finishEditToolArgumentProgress(toolCall.callId);
            }
            responseState.capture(codexFunctionCallInputItemFromToolCall(toolCall), responseOutputItemOrderFromEvent(event));
            if (!reportedToolCallIds.has(toolCall.callId)) {
              reportedToolCallIds.add(toolCall.callId);
              textProgress.finish();
              statefulMarkerEmitted = emitLanguageModelStatefulMarker({
                responseState,
                fallbackAssistantText: textDeltas.join(""),
                sessionId,
                responseId: streamResponseId,
                requestState: requestContinuationState,
                hostRequestIndex,
                requestModelId,
                progress,
                textProgress,
                vscode,
                logger,
                debugLevel: runtime.configuration.debugLevel,
                emissionPoint: "before-tool-call"
              }) || statefulMarkerEmitted;
              logLanguageModelToolCallReported(logger, runtime.configuration.debugLevel, toolCall);
              progress.report(new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input));
              progressSummary.toolCalls += 1;
              logLanguageModelProgressMilestone(logger, runtime.configuration.debugLevel, progressSummary, "tool");
            }
          }

          const reasoningItem = readCodexReasoningInputItem(event);
          if (reasoningItem) {
            responseState.capture(reasoningItem, responseOutputItemOrderFromEvent(event));
          }

          if (event.type === "response.output_item.done") {
            const messageItem = codexAssistantMessageInputItemFromOutputItem(event.item);
            if (messageItem) {
              responseState.capture(messageItem, responseOutputItemOrderFromEvent(event));
              if (isCodexCommentaryOutputPhase(messageItem.phase)) {
                completedCommentaryOutputText = appendOutputText(completedCommentaryOutputText, codexOutputTextFromAssistantMessageInputItem(messageItem));
              } else {
                completedMessageOutputText = appendOutputText(completedMessageOutputText, codexOutputTextFromAssistantMessageInputItem(messageItem));
              }
            }
          }
        }
        } finally {
          clearEditToolArgumentProgressTimer();
        }

        const fallbackOutputText = completedOutputText || completedMessageOutputText;
        if (commentaryTextDeltas === 0 && completedCommentaryOutputText) {
          reasoningProgress.finish();
          textDeltas.push(completedCommentaryOutputText);
          textProgress.report(completedCommentaryOutputText);
          progressSummary.textDeltas += 1;
          progressSummary.textBytes += completedCommentaryOutputText.length;
          logLanguageModelProgressMilestone(logger, runtime.configuration.debugLevel, progressSummary, "text");
        }
        if (textDeltas.length === 0 && fallbackOutputText) {
          reasoningProgress.finish();
          textDeltas.push(fallbackOutputText);
          textProgress.report(fallbackOutputText);
          progressSummary.textDeltas += 1;
          progressSummary.textBytes += fallbackOutputText.length;
          logLanguageModelProgressMilestone(logger, runtime.configuration.debugLevel, progressSummary, "text");
        }

        textProgress.finish();
        reasoningProgress.finish();
        if (tokenCacheSummaryContext) {
          const requestCompletedAtMs = Date.now();
          tokenCacheSummaryContext.requestCompletedAt = new Date(requestCompletedAtMs).toISOString();
          tokenCacheSummaryContext.requestDurationMs = requestCompletedAtMs - requestStartedAtMs;
        }
        logCodexTokenCacheSummary(logger, runtime.configuration.debugLevel, {
          ...tokenCacheSummaryContext,
          source: "language-model",
          model: requestModelId,
          hostRequestIndex,
          sessionId,
          conversationSummary: conversationMetadata.summary,
          conversationDescription: conversationMetadata.description,
          inputItems: body.input?.length ?? 0,
          stateRestored: Boolean(requestState.sessionId),
          requestMessages: messageSummary.messages,
          requestTextParts: messageSummary.textParts,
          requestToolCallParts: messageSummary.toolCallParts,
          requestToolResultParts: messageSummary.toolResultParts,
          requestDataParts: messageSummary.dataParts,
          requestCocopiDataParts: messageSummary.cocopiDataParts,
          requestCocopiDataBytes: messageSummary.cocopiDataBytes,
          requestDataMimeTypes: messageSummary.dataMimeTypes,
          transport: runtime.configuration.transport,
          automaticContinuation,
          promptCacheKey: body.prompt_cache_key,
          response: completedResponse
        }, {
          issueTracking: runtime.configuration.issueTracking,
          tokenTracking: runtime.configuration.tokenTracking
        });
        tokenCacheSummaryLogged = true;

        if (!statefulMarkerEmitted) {
          emitLanguageModelStatefulMarker({
            responseState,
            fallbackAssistantText: textDeltas.join(""),
            sessionId,
            responseId: streamResponseId,
            requestState: requestContinuationState,
            hostRequestIndex,
            requestModelId,
            progress,
            textProgress,
            vscode,
            logger,
            debugLevel: runtime.configuration.debugLevel,
            emissionPoint: "final"
          });
        }
        emitLanguageModelUsage(completedResponse, progress, vscode);
        logLanguageModelProgressDiagnostics(logger, runtime.configuration.debugLevel, progressSummary);
      } catch (error) {
        const normalizedError = normalizeCaughtError(error);
        logLanguageModelProgressDiagnostics(logger, runtime.configuration.debugLevel, progressSummary);
        if (!tokenCacheSummaryLogged && tokenCacheSummaryContext) {
          logCodexTokenCacheSummary(logger, "off", tokenCacheSummaryContext, {
            issueTracking: runtime.configuration.issueTracking
              && !abort.signal.aborted
              && !isMissingInstructionsError(normalizedError),
            tokenTracking: runtime.configuration.tokenTracking
          });
        }
        if (abort.signal.aborted) {
          return;
        }
        logCodexFailurePayloadDiagnostics(logger, runtime.configuration.debugLevel, normalizedError, {
          source: "language-model",
          hostRequestIndex: tokenCacheSummaryContext?.hostRequestIndex,
          sessionId: tokenCacheSummaryContext?.sessionId,
          stage: "failure"
        }, {
          requestBody,
          wireBody: wireRequestBody
        });
        recordMissingInstructionsIssue(normalizedError, {
          source: "language-model",
          transport: runtime.configuration.transport,
          model: requestModelId,
          hasTopLevelInstructions: Boolean(requestBody?.instructions),
          inputItems: requestBody?.input?.length ?? 0,
          issueTracking: runtime.configuration.issueTracking
        });
        logger.error("Cocopi language model request failed.", normalizedError);
        throw languageModelErrorFromCodexError(normalizedError, abort.signal, vscode);
      } finally {
        removeCancellationLogListener?.();
        abort.signal.removeEventListener("abort", logProviderBoundaryCancellation);
        abort.dispose();
      }
    },

    async provideTokenCount(model, text, _token) {
      void _token;

      const estimatedCharacters = typeof text === "string"
        ? text.length
        : estimatedLanguageModelMessageCharacters(text);
      return approximateTokenCountFromCharacters(estimatedCharacters);
    }
  };

  /**
   * @param {CocopiSecretContext} refreshContext
   * @param {Awaited<ReturnType<typeof readCocopiRuntime>>} runtime
   * @param {import("./diagnostics.js").CocopiLogger} refreshLogger
   * @param {VscodeLanguageModelApi} refreshVscode
   */
  function scheduleModelCatalogRefresh(refreshContext, runtime, refreshLogger, refreshVscode) {
    const key = modelCatalogCacheKey(runtime);
    const nowMs = Date.now();
    if (modelCatalogRefreshBackoff?.key === key && modelCatalogRefreshBackoff.retryAfterMs > nowMs) {
      refreshLogger.debug(`Cocopi model catalog background refresh suppressed. reason=backoff retryAfterMs=${modelCatalogRefreshBackoff.retryAfterMs} delayMs=${modelCatalogRefreshBackoff.delayMs}`);
      return;
    }

    if (modelCatalogRefresh?.key === key) {
      return;
    }

    /** @type {{ key: string, promise: Promise<void> }} */
    const refresh = { key, promise: Promise.resolve() };
    modelCatalogRefresh = refresh;
    const currentCache = modelCatalogCache;
    const hadCatalogCache = Boolean(currentCache && currentCache.key === key);
    refresh.promise = refreshModelCatalogInBackground(refreshContext, runtime, refreshLogger, currentCache, ({ cache, catalogChanged }) => {
      modelCatalogCache = cache;
      modelCatalogRefreshBackoff = undefined;
      if (catalogChanged || !hadCatalogCache) {
        modelInformationChanged.fire();
      }
    }, async (error) => {
      if (!warnedCatalogModelFallback) {
        warnedCatalogModelFallback = true;
        await showModelCatalogWarning(refreshVscode, modelCatalogFallbackWarning(runtime.configuration.model, error), () => {
          modelCatalogCache = undefined;
          modelCatalogRefresh = undefined;
          modelCatalogRefreshBackoff = undefined;
          modelInformationChanged.fire();
        });
      }
    }, () => {
      const previousDelay = modelCatalogRefreshBackoff?.key === key
        ? modelCatalogRefreshBackoff.delayMs
        : 0;
      const delayMs = previousDelay > 0
        ? Math.min(previousDelay * 2, COCOPI_MODEL_CATALOG_REFRESH_BACKOFF_MAX_MS)
        : COCOPI_MODEL_CATALOG_REFRESH_BACKOFF_INITIAL_MS;
      modelCatalogRefreshBackoff = {
        key,
        delayMs,
        retryAfterMs: Date.now() + delayMs
      };
      if (modelCatalogRefresh === refresh) {
        modelCatalogRefresh = undefined;
      }
    }).finally(() => {
      if (modelCatalogRefresh === refresh) {
        modelCatalogRefresh = undefined;
      }
    });
  }
}

/**
 * @param {import("vscode").ProvideLanguageModelChatResponseOptions} requestOptions
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
function languageModelRequestModelOptions(requestOptions) {
  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  const modelConfiguration = /** @type {{ modelConfiguration?: unknown }} */ (requestOptions).modelConfiguration;
  const configuration = /** @type {{ configuration?: unknown }} */ (requestOptions).configuration;
  if (isPlainRecord(requestOptions.modelOptions)) {
    candidates.push(/** @type {Record<string, unknown>} */ (requestOptions.modelOptions));
  }
  if (isPlainRecord(configuration)) {
    candidates.push(/** @type {Record<string, unknown>} */ (configuration));
  }
  if (isPlainRecord(modelConfiguration)) {
    candidates.push(/** @type {Record<string, unknown>} */ (modelConfiguration));
  }

  if (candidates.length === 0) {
    return;
  }

  /** @type {Record<string, unknown>} */
  const merged = {};
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(candidate)) {
      if (key === "reasoning" && isPlainRecord(value) && isPlainRecord(merged.reasoning)) {
        merged.reasoning = {
          .../** @type {Record<string, unknown>} */ (merged.reasoning),
          .../** @type {Record<string, unknown>} */ (value)
        };
      } else {
        merged[key] = value;
      }
    }
  }

  removeInvalidReasoningEffortOptions(merged);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** @param {Record<string, unknown>} options */
function removeInvalidReasoningEffortOptions(options) {
  for (const key of ["reasoningEffort", "reasoning_effort"]) {
    const value = options[key];
    if (typeof value === "string" && !isCocopiReasoningEffortOption(value)) {
      delete options[key];
    }
  }

  if (!isPlainRecord(options.reasoning)) {
    return;
  }

  const reasoning = /** @type {Record<string, unknown>} */ (options.reasoning);
  if (typeof reasoning.effort === "string" && !isCocopiReasoningEffortOption(reasoning.effort)) {
    const nextReasoning = { ...reasoning };
    delete nextReasoning.effort;
    if (Object.keys(nextReasoning).length === 0) {
      delete options.reasoning;
      return;
    }
    options.reasoning = nextReasoning;
  }
}

/** @param {string} value */
function isCocopiReasoningEffortOption(value) {
  return value === "default" || CODEX_REASONING_EFFORTS.includes(/** @type {import("../../data/Codex.js").CodexReasoningEffort} */ (value));
}

/* eslint-disable jsdoc/reject-any-type -- VS Code request option fields are external and untyped. */
/**
 * @param {*} value
 * @returns {boolean}
 */
function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/* eslint-enable jsdoc/reject-any-type */

/**
 * @param {CocopiSecretContext} context
 * @param {Awaited<ReturnType<typeof readCocopiRuntime>>} runtime
 * @param {{ key: string, expiresAtMs: number, models: CodexModelSummary[] }} [cache]
 * @returns {Promise<{ catalog: CodexModelSummary[], cache: { key: string, expiresAtMs: number, models: CodexModelSummary[] }, catalogChanged: boolean }>}
 */
async function readCachedCodexModels(context, runtime, cache) {
  const key = modelCatalogCacheKey(runtime);
  const nowMs = Date.now();
  if (cache && cache.key === key && cache.expiresAtMs > nowMs) {
    return { catalog: cache.models, cache, catalogChanged: false };
  }

  const catalog = await listCodexModelsWithAuthRefresh(context, runtime);
  const catalogChanged = !cache || cache.key !== key || !sameCodexModelCatalog(cache.models, catalog);
  const nextCache = {
    key,
    expiresAtMs: nowMs + COCOPI_MODEL_CATALOG_CACHE_TTL_MS,
    models: catalog
  };
  await storeModelCatalogCache(context.secrets, nextCache);
  return {
    catalog,
    cache: nextCache,
    catalogChanged
  };
}

/**
 * @param {import("./secret-storage.js").SecretStorageLike} secrets
 * @param {string} key
 * @returns {Promise<{ key: string, expiresAtMs: number, models: CodexModelSummary[] } | undefined>}
 */
async function readStoredModelCatalogCache(secrets, key) {
  const stored = await secrets.get(COCOPI_MODEL_CATALOG_STORAGE_KEY);
  const caches = parseStoredModelCatalogCaches(stored);
  return caches.find((cache) => cache.key === key);
}

/**
 * @param {import("./secret-storage.js").SecretStorageLike} secrets
 * @param {{ key: string, expiresAtMs: number, models: CodexModelSummary[] }} cache
 * @returns {Promise<boolean>}
 */
async function storeModelCatalogCache(secrets, cache) {
  const stored = await secrets.get(COCOPI_MODEL_CATALOG_STORAGE_KEY);
  const storedCaches = parseStoredModelCatalogCaches(stored);
  const existingCache = storedCaches.find((entry) => entry.key === cache.key);
  if (existingCache && sameCodexModelCatalog(existingCache.models, cache.models)) {
    return false;
  }

  const caches = storedCaches.filter((entry) => entry.key !== cache.key);
  caches.unshift(cache);
  await secrets.store(COCOPI_MODEL_CATALOG_STORAGE_KEY, JSON.stringify(caches.slice(0, 8)));
  return true;
}

/**
 * @param {CodexModelSummary[]} left
 * @param {CodexModelSummary[]} right
 */
function sameCodexModelCatalog(left, right) {
  return canonicalCodexJsonString(left) === canonicalCodexJsonString(right);
}

/**
 * @param {string | undefined} stored
 * @returns {{ key: string, expiresAtMs: number, models: CodexModelSummary[] }[]}
 */
function parseStoredModelCatalogCaches(stored) {
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => sanitizeStoredModelCatalogCache(value))
      .filter((value) => value !== undefined);
  } catch {
    return [];
  }
}

/* eslint-disable jsdoc/reject-any-type -- Stored JSON is unknown until sanitized. */
/**
 * @param {*} value
 * @returns {{ key: string, expiresAtMs: number, models: CodexModelSummary[] } | undefined}
 */
function sanitizeStoredModelCatalogCache(value) {
  if (!isPlainRecord(value) || typeof value.key !== "string" || !Array.isArray(value.models)) {
    return;
  }

  const models = /** @type {unknown[]} */ (value.models)
    .map((model) => sanitizeStoredCodexModel(model))
    .filter((model) => model !== undefined);
  if (models.length === 0) {
    return;
  }

  return {
    key: value.key,
    expiresAtMs: Math.max(Date.now(), typeof value.expiresAtMs === "number" ? value.expiresAtMs : 0),
    models
  };
}

/**
 * @param {*} value
 * @returns {CodexModelSummary | undefined}
 */
function sanitizeStoredCodexModel(value) {
  if (!isPlainRecord(value) || typeof value.id !== "string") {
    return;
  }

  return {
    id: value.id,
    displayName: typeof value.displayName === "string" ? value.displayName : value.id,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.supportedInApi === "boolean" ? { supportedInApi: value.supportedInApi } : {}),
    ...(typeof value.priority === "number" ? { priority: value.priority } : {}),
    ...(typeof value.contextWindow === "number" ? { contextWindow: value.contextWindow } : {}),
    ...(typeof value.maxContextWindow === "number" ? { maxContextWindow: value.maxContextWindow } : {}),
    ...(typeof value.autoCompactTokenLimit === "number" || value.autoCompactTokenLimit === null ? { autoCompactTokenLimit: value.autoCompactTokenLimit } : {}),
    ...(Array.isArray(value.additionalSpeedTiers) ? { additionalSpeedTiers: /** @type {unknown[]} */ (value.additionalSpeedTiers).filter((tier) => typeof tier === "string") } : {}),
    ...(isCodexReasoningEffort(value.defaultReasoningLevel) ? { defaultReasoningLevel: value.defaultReasoningLevel } : {}),
    ...(Array.isArray(value.supportedReasoningLevels) ? { supportedReasoningLevels: sanitizeStoredReasoningLevels(value.supportedReasoningLevels) } : {}),
    ...(typeof value.supportsReasoningSummaries === "boolean" ? { supportsReasoningSummaries: value.supportsReasoningSummaries } : {}),
    ...(isCodexReasoningSummary(value.defaultReasoningSummary) ? { defaultReasoningSummary: value.defaultReasoningSummary } : {}),
    ...(Array.isArray(value.availableInPlans) ? { availableInPlans: /** @type {unknown[]} */ (value.availableInPlans).filter((plan) => typeof plan === "string") } : {}),
    ...(typeof value.imageInput === "boolean" ? { imageInput: value.imageInput } : {})
  };
}
/* eslint-enable jsdoc/reject-any-type */

/**
 * @param {unknown[]} levels
 * @returns {{ effort: import("../../data/Codex.js").CodexReasoningEffort, description?: string }[]}
 */
function sanitizeStoredReasoningLevels(levels) {
  return levels.flatMap((level) => {
    if (!isPlainRecord(level)) {
      return [];
    }

    const record = /** @type {Record<string, unknown>} */ (level);
    if (!isCodexReasoningEffort(record.effort)) {
      return [];
    }

    return [{
      effort: /** @type {import("../../data/Codex.js").CodexReasoningEffort} */ (record.effort),
      ...(typeof record.description === "string" ? { description: record.description } : {})
    }];
  });
}

/* eslint-disable jsdoc/reject-any-type -- These helpers narrow untyped stored JSON values. */
/** @param {*} value */
function isCodexReasoningEffort(value) {
  return typeof value === "string" && CODEX_REASONING_EFFORTS.includes(/** @type {import("../../data/Codex.js").CodexReasoningEffort} */ (value));
}

/** @param {*} value */
function isCodexReasoningSummary(value) {
  return value === "auto" || value === "concise" || value === "detailed" || value === "none";
}
/* eslint-enable jsdoc/reject-any-type */

/**
 * @param {Awaited<ReturnType<typeof readCocopiRuntime>>} runtime
 */
function modelCatalogCacheKey(runtime) {
  return [
    runtime.configuration.apiBaseUrl,
    runtime.clientVersion,
    runtime.auth?.chatgptAccountId ?? ""
  ].join("\n");
}

/**
 * @param {CodexModelSummary[]} models
 * @param {string} configuredModel
 * @param {{ useModelDefaultCompactionLimit?: boolean, compactionFallbackStrategy?: "full" | "ninety-percent" }} [options]
 * @returns {import("vscode").LanguageModelChatInformation[]}
 */
export function languageModelInformationFromCodexModels(models, configuredModel, options = {}) {
  const orderedModels = orderCodexModels(models, cocopiBaseLanguageModelId(configuredModel), { includeConfiguredFallback: false });
  const modelIds = new Set(orderedModels.map((model) => model.id));
  return orderedModels.flatMap((model) => languageModelInformationVariantsFromCodexModel(model, modelIds, options));
}

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {import("./configuration.js").CocopiConfiguration["debugLevel"]} debugLevel
 * @param {import("vscode").LanguageModelChatInformation[]} information
 * @param {CodexModelSummary[]} models
 * @param {{ useModelDefaultCompactionLimit?: boolean, compactionFallbackStrategy?: "full" | "ninety-percent" }} options
 * @param {Set<string>} [loggedDiagnostics]
 * @returns {import("vscode").LanguageModelChatInformation[]}
 */
function logLanguageModelCompactionDiagnostics(logger, debugLevel, information, models, options, loggedDiagnostics) {
  if (debugLevel === "off") {
    return information;
  }

  const modelsById = new Map(models.map((model) => [model.id, model]));
  for (const modelInformation of information) {
    const model = modelsById.get(modelInformation.id) ?? modelsById.get(cocopiBaseLanguageModelId(modelInformation.id));
    const key = loggedDiagnostics ? languageModelCompactionDiagnosticKey(modelInformation, model, options) : "";
    if (loggedDiagnostics?.has(key)) {
      continue;
    }
    loggedDiagnostics?.add(key);
    logger.debug(formatLanguageModelCompactionDiagnostic(modelInformation, model, options));
  }

  return information;
}

/**
 * @param {import("vscode").LanguageModelChatInformation} information
 * @param {CodexModelSummary | undefined} model
 * @param {{ useModelDefaultCompactionLimit?: boolean, compactionFallbackStrategy?: "full" | "ninety-percent" }} options
 */
function formatLanguageModelCompactionDiagnostic(information, model, options) {
  const fallbackStrategy = options.compactionFallbackStrategy ?? "ninety-percent";
  const defaultInputTokens = languageModelDefaultContextSize(information);
  const source = compactionDiagnosticSource(defaultInputTokens, information.maxInputTokens, model?.autoCompactTokenLimit, options.useModelDefaultCompactionLimit, fallbackStrategy, hasModelContextSizeChoice(model));
  const contextWindow = model?.contextWindow ?? (information.maxInputTokens + information.maxOutputTokens);
  return [
    "Cocopi language model compaction limit.",
    `model=${information.id}`,
    `source=${source}`,
    `defaultInputTokens=${defaultInputTokens}`,
    `maxInputTokens=${information.maxInputTokens}`,
    `maxOutputTokens=${information.maxOutputTokens}`,
    `contextWindow=${contextWindow}`,
    `maxContextWindow=${model?.maxContextWindow ?? "unavailable"}`,
    `useModelDefaultCompactionLimit=${options.useModelDefaultCompactionLimit !== false}`,
    `compactionFallbackStrategy=${fallbackStrategy}`,
    `modelAutoCompactTokenLimit=${model?.autoCompactTokenLimit ?? "unavailable"}`
  ].join(" ");
}

/** @param {import("vscode").LanguageModelChatInformation} information */
function languageModelDefaultContextSize(information) {
  const configurationSchema = /** @type {{ configurationSchema?: { properties?: Record<string, { default?: unknown }> } }} */ (information).configurationSchema;
  const defaultContextSize = configurationSchema?.properties?.[LANGUAGE_MODEL_CONFIGURATION_CONTEXT_SIZE_KEY]?.default;
  return typeof defaultContextSize === "number" ? defaultContextSize : information.maxInputTokens;
}

/**
 * @param {number} defaultInputTokens
 * @param {number} maxInputTokens
 * @param {number | null | undefined} autoCompactTokenLimit
 * @param {boolean | undefined} useModelDefaultCompactionLimit
 * @param {"full" | "ninety-percent"} fallbackStrategy
 * @param {boolean} hasContextSizeChoice
 */
function compactionDiagnosticSource(defaultInputTokens, maxInputTokens, autoCompactTokenLimit, useModelDefaultCompactionLimit, fallbackStrategy, hasContextSizeChoice) {
  if (useModelDefaultCompactionLimit !== false && typeof autoCompactTokenLimit === "number" && autoCompactTokenLimit > 0 && defaultInputTokens <= autoCompactTokenLimit) {
    return "model-provided";
  }

  if (hasContextSizeChoice && defaultInputTokens < maxInputTokens) {
    return "model-context-window";
  }

  return `fallback-${fallbackStrategy}`;
}

/** @param {CodexModelSummary | undefined} model */
function hasModelContextSizeChoice(model) {
  return typeof model?.contextWindow === "number"
    && typeof model.maxContextWindow === "number"
    && model.maxContextWindow > model.contextWindow;
}

/**
 * @param {Error | string | Record<string, unknown> | null | undefined} error
 * @param {AbortSignal} signal
 * @param {{ LanguageModelError: typeof import("vscode").LanguageModelError }} vscode
 * @returns {Error & { code?: string }}
 */
export function languageModelErrorFromCodexError(error, signal, vscode) {
  const message = extractCodexErrorMessage(error);
  if (signal.aborted || /abort|cancel/iu.test(message)) {
    return vscode.LanguageModelError.Blocked("Cocopi request was cancelled.");
  }

  if (/status\s+(?:401|403)\b|permission|not signed in|unauthorized|forbidden/iu.test(message)) {
    return vscode.LanguageModelError.NoPermissions("Cocopi is not signed in or does not have access to this Codex model.");
  }

  if (error instanceof Error && isCodexPreviousResponseNotFoundError(error) || /\bprevious_response_not_found\b/iu.test(message)) {
    return new Error("Cocopi request failed: Codex no longer has the previous response id needed for WebSocket continuation.", {
      cause: error instanceof Error ? error : undefined
    });
  }

  if (/status\s+404\b|not found|does not exist/iu.test(message)) {
    return vscode.LanguageModelError.NotFound("The requested Cocopi model was not found.");
  }

  if (/status\s+429\b|quota|rate limit|blocked|idle for \d+ms/iu.test(message)) {
    return vscode.LanguageModelError.Blocked(blockedLanguageModelErrorMessage(message));
  }

  const details = normalizeCodexErrorMessage(message);
  const requestMessage = details ? `Cocopi request failed: ${details}` : "Cocopi request failed.";
  return new Error(requestMessage, { cause: error instanceof Error ? error : undefined });
}

/** @param {string} message */
function blockedLanguageModelErrorMessage(message) {
  const details = normalizeCodexErrorMessage(message);
  const idleMatch = /\bidle for (\d+)ms\b/iu.exec(details || message);
  if (idleMatch?.[1]) {
    return `Cocopi request timed out waiting for Codex stream activity (idle for ${idleMatch[1]}ms).`;
  }

  if (!details) {
    return "Cocopi request was blocked or timed out.";
  }

  if (/status\s+429\b|quota|rate limit/iu.test(details)) {
    return `Cocopi request was rate limited by Codex: ${details}`;
  }

  return `Cocopi request was blocked by Codex: ${details}`;
}

/**
 * @param {Error | string | Record<string, unknown> | null | undefined} error
 * @returns {string}
 */
function extractCodexErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || "";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    /** @type {Record<string, unknown>} */
    const record = error;
    const messageFromObject = extractCodexErrorMessageFromObject(record);
    if (messageFromObject) {
      return messageFromObject;
    }

    return extractCodexErrorMessage(readNestedErrorMessage(
      /** @type {Error | string | Record<string, unknown> | null | undefined} */ (record.error)
    )) ||
      extractCodexErrorMessage(readNestedErrorMessage(
        /** @type {Error | string | Record<string, unknown> | null | undefined} */ (record.event)
      )) ||
      extractCodexErrorMessage(readNestedErrorMessage(
        /** @type {Error | string | Record<string, unknown> | null | undefined} */ (record.cause)
      )) ||
      "";
  }

  return "";
}

/**
 * @param {Error | string | Record<string, unknown> | null | undefined} value
 * @returns {Error | string | Record<string, unknown> | null | undefined}
 */
function readNestedErrorMessage(value) {
  if (value === null || value === undefined || value instanceof Error || typeof value === "string") {
    return value;
  }

  return typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/**
 * @param {Record<string, unknown>} error
 * @returns {string}
 */
function extractCodexErrorMessageFromObject(error) {
  const keys = ["message", "detail", "error", "errorMessage", "statusText"];
  for (const key of keys) {
    const value = error[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

/**
 * @param {string | undefined} message
 * @returns {string}
 */
function normalizeCodexErrorMessage(message) {
  if (!message) {
    return "";
  }

  const normalized = message.trim().replaceAll(/\s+/gu, " ");
  const match = normalized.match(/(?:^|;\s*)message=([^;]+)/iu);
  if (match?.[1]) {
    const extracted = match[1].trim();
    if (extracted) {
      return extracted;
    }
  }

  return normalized;
}

// eslint-disable-next-line jsdoc/reject-any-type -- Catch values are untyped external data; normalize before provider error mapping.
/** @param {*} error */
function normalizeCaughtError(error) {
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
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {'off' | 'metadata' | 'events' | 'payloads'} debugLevel
 * @param {{ textDeltas: number, textBytes: number, textReports: number, reasoningSummaryDeltas: number, reasoningSummaryBytes: number, toolCalls: number }} summary
 */
function logLanguageModelProgressDiagnostics(logger, debugLevel, summary) {
  if (debugLevel === "off") {
    return;
  }

  logger.debug([
    "VS Code language model progress.",
    `textDeltas=${summary.textDeltas}`,
    `textBytes=${summary.textBytes}`,
    `textReports=${summary.textReports}`,
    `reasoningSummaryDeltas=${summary.reasoningSummaryDeltas}`,
    `reasoningSummaryBytes=${summary.reasoningSummaryBytes}`,
    `toolCalls=${summary.toolCalls}`
  ].join(" "));
}

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {'off' | 'metadata' | 'events' | 'payloads'} debugLevel
 * @param {Readonly<Record<string, unknown>> | undefined} modelOptions
 * @param {{ serviceTier?: string, reasoningEffort?: string, reasoningSummary?: string, fastRequested?: boolean }} resolved
 */
function logLanguageModelRequestOptionsDiagnostics(logger, debugLevel, modelOptions, resolved) {
  if (debugLevel === "off") {
    return;
  }

  const keys = modelOptions ? Object.keys(modelOptions).toSorted() : [];
  logger.debug([
    "VS Code language model request options.",
    `keys=${keys.join(",") || "absent"}`,
    `selectedServiceTier=${formatDiagnosticScalar(readRequestOptionForDiagnostics(modelOptions, "serviceTier", "service_tier"))}`,
    `selectedReasoningEffort=${formatDiagnosticScalar(readRequestOptionForDiagnostics(modelOptions, "reasoningEffort", "reasoning_effort", ["reasoning", "effort"]))}`,
    `selectedReasoningSummary=${formatDiagnosticScalar(readRequestOptionForDiagnostics(modelOptions, "reasoningSummary", "reasoning_summary", ["reasoning", "summary"]))}`,
    `selectedFast=${formatDiagnosticScalar(readLanguageModelFastOption(modelOptions))}`,
    `resolvedServiceTier=${formatDiagnosticScalar(resolved.serviceTier)}`,
    `resolvedReasoningEffort=${formatDiagnosticScalar(resolved.reasoningEffort)}`,
    `resolvedReasoningSummary=${formatDiagnosticScalar(resolved.reasoningSummary)}`,
    `resolvedFast=${resolved.fastRequested === true}`
  ].join(" "));
}

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {{ requestOptions: import("vscode").ProvideLanguageModelChatResponseOptions, hostRequestIndex: number, sessionId: string, receivedModelId: string, requestModelId: string }} options
 */
function logLanguageModelProfileConfigurationApplied(logger, options) {
  const configuration = /** @type {{ configuration?: unknown }} */ (options.requestOptions).configuration;
  const modelConfiguration = /** @type {{ modelConfiguration?: unknown }} */ (options.requestOptions).modelConfiguration;
  const configurationRecord = isPlainRecord(configuration) ? /** @type {Readonly<Record<string, unknown>>} */ (configuration) : undefined;
  const modelConfigurationRecord = isPlainRecord(modelConfiguration) ? /** @type {Readonly<Record<string, unknown>>} */ (modelConfiguration) : undefined;
  if (!configurationRecord && !modelConfigurationRecord) {
    return;
  }

  logger.info([
    "VS Code profile language model configuration applied.",
    "source=language-model",
    `hostRequest=${options.hostRequestIndex}`,
    `sessionId=${options.sessionId}`,
    `receivedModel=${formatDiagnosticScalar(options.receivedModelId)}`,
    `codexModel=${formatDiagnosticScalar(options.requestModelId)}`,
    "scope=profile-wide",
    `configurationKeys=${formatDiagnosticKeys(configurationRecord)}`,
    `modelConfigurationKeys=${formatDiagnosticKeys(modelConfigurationRecord)}`,
    `configurationReasoningEffort=${formatDiagnosticScalar(readRequestOptionForDiagnostics(configurationRecord, "reasoningEffort", "reasoning_effort", ["reasoning", "effort"]))}`,
    `modelConfigurationReasoningEffort=${formatDiagnosticScalar(readRequestOptionForDiagnostics(modelConfigurationRecord, "reasoningEffort", "reasoning_effort", ["reasoning", "effort"]))}`,
    `configurationReasoningSummary=${formatDiagnosticScalar(readRequestOptionForDiagnostics(configurationRecord, "reasoningSummary", "reasoning_summary", ["reasoning", "summary"]))}`,
    `modelConfigurationReasoningSummary=${formatDiagnosticScalar(readRequestOptionForDiagnostics(modelConfigurationRecord, "reasoningSummary", "reasoning_summary", ["reasoning", "summary"]))}`
  ].join(" "));
}

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {ReturnType<typeof languageModelOptionSnapshot> | undefined} previous
 * @param {{ sessionId: string, hostRequestIndex: number, receivedModelId: string, requestModelId: string, modelOptions: Readonly<Record<string, unknown>> | undefined, serviceTier?: string, serviceTierSource: "model" | "option", reasoningEffort?: string, reasoningSummary?: string, fastRequested?: boolean }} options
 * @returns {ReturnType<typeof languageModelOptionSnapshot>}
 */
function logEffectiveLanguageModelState(logger, previous, options) {
  const snapshot = languageModelOptionSnapshot(options);
  const changed = previous?.key !== snapshot.key;
  if (!changed) {
    return snapshot;
  }

  logger.info([
    `Cocopi effective language model state ${previous ? "changed" : "initial"}.`,
    "source=language-model",
    `hostRequest=${options.hostRequestIndex}`,
    `sessionId=${options.sessionId}`,
    `receivedModel=${formatDiagnosticScalar(snapshot.receivedModelId)}`,
    `codexModel=${formatDiagnosticScalar(snapshot.requestModelId)}`,
    `selectedServiceTier=${formatDiagnosticScalar(snapshot.selectedServiceTier)}`,
    `resolvedServiceTier=${formatDiagnosticScalar(snapshot.serviceTier)}`,
    `serviceTierSource=${snapshot.serviceTierSource}`,
    `selectedReasoningEffort=${formatDiagnosticScalar(snapshot.selectedReasoningEffort)}`,
    `resolvedReasoningEffort=${formatDiagnosticScalar(snapshot.reasoningEffort)}`,
    `selectedReasoningSummary=${formatDiagnosticScalar(snapshot.selectedReasoningSummary)}`,
    `resolvedReasoningSummary=${formatDiagnosticScalar(snapshot.reasoningSummary)}`,
    `selectedFast=${formatDiagnosticScalar(snapshot.selectedFast)}`,
    `resolvedFast=${snapshot.fastRequested === true}`,
    ...(previous ? [`previous=${previous.key}`] : [])
  ].join(" "));

  return snapshot;
}

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {Map<string, ReturnType<typeof languageModelOptionSnapshot>>} snapshotsBySession
 * @param {{ sessionId: string, hostRequestIndex: number, receivedModelId: string, requestModelId: string, modelOptions: Readonly<Record<string, unknown>> | undefined, serviceTier?: string, serviceTierSource: "model" | "option", reasoningEffort?: string, reasoningSummary?: string, fastRequested?: boolean }} options
 */
function logLanguageModelOptionReceipt(logger, snapshotsBySession, options) {
  const snapshot = languageModelOptionSnapshot(options);
  const previous = snapshotsBySession.get(options.sessionId);
  snapshotsBySession.set(options.sessionId, snapshot);
  const state = previous ? (previous.key === snapshot.key ? "unchanged" : "changed") : "initial";
  logger.info([
    `VS Code language model options ${state}.`,
    "source=language-model",
    `hostRequest=${options.hostRequestIndex}`,
    `sessionId=${options.sessionId}`,
    `receivedModel=${formatDiagnosticScalar(snapshot.receivedModelId)}`,
    `codexModel=${formatDiagnosticScalar(snapshot.requestModelId)}`,
    `selectedServiceTier=${formatDiagnosticScalar(snapshot.selectedServiceTier)}`,
    `resolvedServiceTier=${formatDiagnosticScalar(snapshot.serviceTier)}`,
    `serviceTierSource=${snapshot.serviceTierSource}`,
    `selectedReasoningEffort=${formatDiagnosticScalar(snapshot.selectedReasoningEffort)}`,
    `resolvedReasoningEffort=${formatDiagnosticScalar(snapshot.reasoningEffort)}`,
    `selectedReasoningSummary=${formatDiagnosticScalar(snapshot.selectedReasoningSummary)}`,
    `resolvedReasoningSummary=${formatDiagnosticScalar(snapshot.reasoningSummary)}`,
    `selectedFast=${formatDiagnosticScalar(snapshot.selectedFast)}`,
    `resolvedFast=${snapshot.fastRequested === true}`,
    ...(previous && previous.key !== snapshot.key ? [`previous=${previous.key}`] : [])
  ].join(" "));
}

/**
 * @param {{ receivedModelId: string, requestModelId: string, modelOptions: Readonly<Record<string, unknown>> | undefined, serviceTier?: string, serviceTierSource: "model" | "option", reasoningEffort?: string, reasoningSummary?: string, fastRequested?: boolean }} options
 */
function languageModelOptionSnapshot(options) {
  const snapshot = {
    receivedModelId: options.receivedModelId,
    requestModelId: options.requestModelId,
    selectedServiceTier: diagnosticSnapshotValue(readRequestOptionForDiagnostics(options.modelOptions, "serviceTier", "service_tier")),
    serviceTier: diagnosticSnapshotValue(options.serviceTier),
    serviceTierSource: options.serviceTierSource,
    selectedReasoningEffort: diagnosticSnapshotValue(readRequestOptionForDiagnostics(options.modelOptions, "reasoningEffort", "reasoning_effort", ["reasoning", "effort"])),
    reasoningEffort: diagnosticSnapshotValue(options.reasoningEffort),
    selectedReasoningSummary: diagnosticSnapshotValue(readRequestOptionForDiagnostics(options.modelOptions, "reasoningSummary", "reasoning_summary", ["reasoning", "summary"])),
    reasoningSummary: diagnosticSnapshotValue(options.reasoningSummary),
    selectedFast: diagnosticSnapshotValue(readLanguageModelFastOption(options.modelOptions)),
    fastRequested: options.fastRequested === true
  };
  return {
    ...snapshot,
    key: JSON.stringify(snapshot)
  };
}

// eslint-disable-next-line jsdoc/check-types -- VS Code model options are external untyped values; normalize for diagnostics only.
/** @param {unknown} value */
function diagnosticSnapshotValue(value) {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

/**
 * @param {Readonly<Record<string, unknown>> | undefined} record
 * @param {string} camelKey
 * @param {string} snakeKey
 * @param {[string, string]} [nestedKey]
 */
function readRequestOptionForDiagnostics(record, camelKey, snakeKey, nestedKey) {
  if (!record) {
    return;
  }

  const direct = record[camelKey] ?? record[snakeKey];
  if (direct !== undefined || !nestedKey) {
    return direct;
  }

  const nested = record[nestedKey[0]];
  if (!isPlainRecord(nested)) {
    return;
  }

  return /** @type {Record<string, unknown>} */ (nested)[nestedKey[1]];
}

/** @param {Readonly<Record<string, unknown>> | undefined} modelOptions */
function readLanguageModelFastOption(modelOptions) {
  return readRequestOptionForDiagnostics(modelOptions, "fast", "fast_tier")
    ?? readRequestOptionForDiagnostics(modelOptions, "fastTier", "fast_tier")
    ?? readRequestOptionForDiagnostics(modelOptions, "serviceTier", "service_tier");
}

/** @param {Readonly<Record<string, unknown>> | undefined} record */
function formatDiagnosticKeys(record) {
  const keys = record ? Object.keys(record).toSorted() : [];
  return keys.length > 0 ? keys.join(",") : "absent";
}

/** @param {Readonly<Record<string, unknown>> | undefined} modelOptions */
function languageModelFastOptionSelected(modelOptions) {
  const value = readLanguageModelFastOption(modelOptions);
  return value === true || value === "true" || value === "on" || value === "fast" || value === COCOPI_SERVICE_TIERS.priority;
}

/* eslint-disable jsdoc/reject-any-type -- Diagnostic formatting accepts external untyped option values. */
/**
 * @param {*} value
 */
function formatDiagnosticScalar(value) {
  if (value === undefined || value === null || value === "") {
    return "absent";
  }

  const normalized = String(value).trim().replaceAll(/\s+/gu, " ");
  return normalized || "absent";
}
/* eslint-enable jsdoc/reject-any-type */

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {"off" | "metadata" | "events" | "payloads"} debugLevel
 * @param {{ textDeltas: number, textBytes: number, textReports: number, reasoningSummaryDeltas: number, reasoningSummaryBytes: number, toolCalls: number, lastLoggedTextDeltas: number, lastLoggedReasoningSummaryDeltas: number, lastLoggedToolCalls: number }} summary
 * @param {"text" | "reasoning" | "tool"} reason
 */
function logLanguageModelProgressMilestone(logger, debugLevel, summary, reason) {
  if (debugLevel === "off") {
    return;
  }

  const shouldLogText = summary.textDeltas === 1 || summary.textDeltas - summary.lastLoggedTextDeltas >= 50;
  const shouldLogReasoning = summary.reasoningSummaryDeltas === 1 || summary.reasoningSummaryDeltas - summary.lastLoggedReasoningSummaryDeltas >= 50;
  const shouldLogTool = summary.toolCalls !== summary.lastLoggedToolCalls;
  if (
    (reason === "text" && !shouldLogText)
    || (reason === "reasoning" && !shouldLogReasoning)
    || (reason === "tool" && !shouldLogTool)
  ) {
    return;
  }

  summary.lastLoggedTextDeltas = summary.textDeltas;
  summary.lastLoggedReasoningSummaryDeltas = summary.reasoningSummaryDeltas;
  summary.lastLoggedToolCalls = summary.toolCalls;
  logger.debug([
    "VS Code language model progress reported.",
    `reason=${reason}`,
    `textDeltas=${summary.textDeltas}`,
    `textBytes=${summary.textBytes}`,
    `textReports=${summary.textReports}`,
    `reasoningSummaryDeltas=${summary.reasoningSummaryDeltas}`,
    `reasoningSummaryBytes=${summary.reasoningSummaryBytes}`,
    `toolCalls=${summary.toolCalls}`
  ].join(" "));
}

/**
 * @param {import("vscode").Progress<import("vscode").LanguageModelResponsePart>} progress
 * @param {{ LanguageModelTextPart: typeof import("vscode").LanguageModelTextPart }} vscode
 * @param {{ debugLevel: "off" | "metadata" | "events" | "payloads", logger: import("./diagnostics.js").CocopiLogger, onReport: () => void }} options
 */
function createLanguageModelTextProgressReporter(progress, vscode, options) {
  let pending = "";
  let reportedAnyText = false;
  let lastReportMs = 0;

  return {
    /** @param {string} text */
    report(text) {
      if (!text) {
        return;
      }

      pending += text;
      const now = Date.now();
      if (
        !reportedAnyText
        || pending.length >= LANGUAGE_MODEL_TEXT_REPORT_MAX_CHARS
        || pending.includes("\n")
        || now - lastReportMs >= LANGUAGE_MODEL_TEXT_REPORT_MAX_DELAY_MS
      ) {
        this.flush(now);
      }
    },

    finish() {
      this.flush();
    },

    /** @param {number} [now] */
    flush(now = Date.now()) {
      if (!pending) {
        return;
      }

      progress.report(new vscode.LanguageModelTextPart(pending));
      logLanguageModelTextReportDiagnostics(options.logger, options.debugLevel, pending);
      pending = "";
      reportedAnyText = true;
      lastReportMs = now;
      options.onReport();
    }
  };
}

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {"off" | "metadata" | "events" | "payloads"} debugLevel
 * @param {string} text
 */
function logLanguageModelTextReportDiagnostics(logger, debugLevel, text) {
  if (debugLevel !== "payloads") {
    return;
  }

  logger.debug([
    "VS Code language model text part reported.",
    `chars=${text.length}`,
    `preview=${JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}...` : text)}`
  ].join(" "));
}

/**
 * @param {import("vscode").Progress<import("vscode").LanguageModelResponsePart>} progress
 * @param {{ LanguageModelTextPart: typeof import("vscode").LanguageModelTextPart, LanguageModelThinkingPart?: { new(value: string | string[], id?: string, metadata?: Record<string, unknown>): unknown } }} vscode
 * @param {boolean} visible
 */
function createLanguageModelReasoningProgressReporter(progress, vscode, visible) {
  let fallbackOpen = false;
  let nativeOpen = false;
  /** @type {string | undefined} */
  let nativeId;

  return {
    /**
     * @param {string} text
     * @param {{ id?: string, metadata?: Record<string, unknown>, nativeOnly?: boolean }} [options]
     */
    report(text, options = {}) {
      if (!visible) {
        return;
      }

      if (vscode.LanguageModelThinkingPart) {
        if (nativeOpen && nativeId !== options.id) {
          progress.report(/** @type {import("vscode").LanguageModelResponsePart} */ (new vscode.LanguageModelThinkingPart("", "", { vscode_reasoning_done: true })));
          nativeOpen = false;
        }
        progress.report(/** @type {import("vscode").LanguageModelResponsePart} */ (new vscode.LanguageModelThinkingPart(text, options.id, options.metadata)));
        nativeOpen = true;
        nativeId = options.id;
        return;
      }

      if (options.nativeOnly) {
        return;
      }

      if (!fallbackOpen) {
        progress.report(new vscode.LanguageModelTextPart("<details open><summary>Thinking</summary>\n\n"));
        fallbackOpen = true;
      }
      progress.report(new vscode.LanguageModelTextPart(text));
    },

    finish() {
      if (vscode.LanguageModelThinkingPart) {
        if (visible && nativeOpen) {
          progress.report(/** @type {import("vscode").LanguageModelResponsePart} */ (new vscode.LanguageModelThinkingPart("", "", { vscode_reasoning_done: true })));
          nativeOpen = false;
          nativeId = undefined;
        }
        return;
      }

      if (!fallbackOpen) {
        return;
      }

      progress.report(new vscode.LanguageModelTextPart("\n\n</details>\n\n"));
      fallbackOpen = false;
    }
  };
}

/**
 * @param {CodexModelSummary[]} models
 * @param {string} configuredModel
 * @param {{ includeConfiguredFallback?: boolean }} [options]
 */
function orderCodexModels(models, configuredModel, options = {}) {
  const seen = new Set();
  /** @type {CodexModelSummary[]} */
  const ordered = [];
  const push = (/** @type {CodexModelSummary} */ model) => {
    if (!model.id || seen.has(model.id)) {
      return;
    }

    seen.add(model.id);
    ordered.push(model);
  };

  const preferred = models.find((model) => model.id === configuredModel);
  if (preferred) {
    push(preferred);
  } else if (options.includeConfiguredFallback) {
    push({ id: configuredModel, displayName: configuredModel });
  }

  for (const model of models) {
    push(model);
  }

  return ordered;
}

/**
 * @param {number | undefined} contextWindow
 * @param {{ maxContextWindow?: number, autoCompactTokenLimit?: number | null, useModelDefaultCompactionLimit?: boolean, compactionFallbackStrategy?: "full" | "ninety-percent" }} [options]
 */
function languageModelTokenLimits(contextWindow, options = {}) {
  const modelContextWindow = contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const hasCatalogContextSizeChoice = typeof contextWindow === "number" && typeof options.maxContextWindow === "number" && options.maxContextWindow > modelContextWindow;
  const catalogMaxContextWindow = hasCatalogContextSizeChoice
    ? Number(options.maxContextWindow)
    : modelContextWindow;
  const maxOutputTokens = Math.min(DEFAULT_MODEL_MAX_OUTPUT_TOKENS, catalogMaxContextWindow - 1);
  const defaultOutputReserveTokens = Math.min(maxOutputTokens, modelContextWindow - 1);
  const fullInputTokens = Math.max(1, modelContextWindow - defaultOutputReserveTokens);
  let defaultInputTokens = fullInputTokens;
  let maxInputTokens = Math.max(1, catalogMaxContextWindow - maxOutputTokens);

  const fallbackStrategy = options.compactionFallbackStrategy ?? "ninety-percent";
  if (options.useModelDefaultCompactionLimit !== false && typeof options.autoCompactTokenLimit === "number" && options.autoCompactTokenLimit > 0) {
    defaultInputTokens = Math.min(options.autoCompactTokenLimit, fullInputTokens);
  } else if (!hasCatalogContextSizeChoice && fallbackStrategy === "ninety-percent") {
    defaultInputTokens = Math.max(1, Math.floor(fullInputTokens * 0.9));
    maxInputTokens = defaultInputTokens;
  }
  return {
    defaultInputTokens,
    maxInputTokens,
    maxOutputTokens
  };
}

/**
 * @param {CodexModelSummary} model
 * @param {{ id?: string, name?: string, useModelDefaultCompactionLimit?: boolean, compactionFallbackStrategy?: "full" | "ninety-percent" }} [options]
 * @returns {import("vscode").LanguageModelChatInformation}
 */
function languageModelInformationFromCodexModel(model, options = {}) {
  const id = options.id ?? model.id;
  const tokenLimits = languageModelTokenLimits(model.contextWindow, {
    maxContextWindow: model.maxContextWindow,
    autoCompactTokenLimit: model.autoCompactTokenLimit,
    useModelDefaultCompactionLimit: options.useModelDefaultCompactionLimit,
    compactionFallbackStrategy: options.compactionFallbackStrategy
  });
  const configurationSchema = cocopiLanguageModelConfigurationSchema(model, tokenLimits);
  /** @type {import("vscode").LanguageModelChatInformation & Record<string, unknown>} */
  const information = {
    id,
    name: options.name ?? model.displayName,
    family: "codex",
    tooltip: cocopiModelTooltip(model.description),
    detail: cocopiModelDetail(id),
    version: id,
    isBYOK: true,
    isUserSelectable: true,
    maxInputTokens: tokenLimits.maxInputTokens,
    maxOutputTokens: tokenLimits.maxOutputTokens,
    ...(configurationSchema ? { configurationSchema } : {}),
    capabilities: {
      imageInput: model.imageInput ?? false,
      toolCalling: true
    }
  };
  return information;
}

/**
 * @param {CodexModelSummary} model
 * @param {Set<string>} modelIds
 * @param {{ useModelDefaultCompactionLimit?: boolean, compactionFallbackStrategy?: "full" | "ninety-percent" }} [options]
 * @returns {import("vscode").LanguageModelChatInformation[]}
 */
function languageModelInformationVariantsFromCodexModel(model, modelIds, options = {}) {
  const information = [languageModelInformationFromCodexModel(model, options)];
  const baseModelId = cocopiBaseLanguageModelId(model.id);
  const fastModelId = cocopiFastLanguageModelId(baseModelId);
  if (
    model.id === baseModelId
    && model.additionalSpeedTiers?.includes("fast")
    && !modelIds.has(fastModelId)
  ) {
    information.push(languageModelInformationFromCodexModel(model, {
      ...options,
      id: fastModelId,
      name: `${model.displayName} Fast`
    }));
  }

  return information;
}

/** @param {string} modelId */
function cocopiBaseLanguageModelId(modelId) {
  return cocopiLanguageModelRequestModel(modelId).modelId;
}

/** @param {string} modelId */
function cocopiFastLanguageModelId(modelId) {
  return `${modelId}${COCOPI_FAST_MODEL_SUFFIX}`;
}

/**
 * @param {string} modelId
 * @returns {CocopiLanguageModelRequestModel}
 */
function cocopiLanguageModelRequestModel(modelId) {
  if (modelId.endsWith(COCOPI_FAST_MODEL_SUFFIX)) {
    return {
      modelId: modelId.slice(0, -COCOPI_FAST_MODEL_SUFFIX.length),
      serviceTier: COCOPI_SERVICE_TIERS.priority
    };
  }
  return { modelId };
}

/**
 * @param {CodexModelSummary} model
 * @param {{ defaultInputTokens: number, maxInputTokens: number }} tokenLimits
 */
function cocopiLanguageModelConfigurationSchema(model, tokenLimits) {
  /** @type {Record<string, Record<string, unknown>>} */
  const properties = {};
  const reasoningEffort = cocopiLanguageModelReasoningConfiguration(model);
  if (reasoningEffort) {
    properties[LANGUAGE_MODEL_CONFIGURATION_OPTIONS_KEY] = reasoningEffort;
  }

  const contextSize = cocopiLanguageModelContextSizeConfiguration(tokenLimits);
  if (contextSize) {
    properties[LANGUAGE_MODEL_CONFIGURATION_CONTEXT_SIZE_KEY] = contextSize;
  }

  return Object.keys(properties).length > 0 ? { properties } : undefined;
}

/** @param {CodexModelSummary} model */
function cocopiLanguageModelReasoningConfiguration(model) {
  const choices = cocopiLanguageModelConfigurationChoices(model);
  if (choices.length < 2) {
    return;
  }

  const defaultEffort = defaultReasoningEffortForChoices(model, choices);
  const defaultChoice = defaultEffort
    ? choices.find((choice) => choice.effort === defaultEffort)?.value
    : undefined;
  return {
    type: "string",
    title: "Thinking Effort",
    description: "Controls how much thinking Cocopi requests from this model.",
    enum: choices.map((choice) => choice.value),
    enumItemLabels: choices.map((choice) => choice.label),
    enumDescriptions: choices.map((choice) => choice.description),
    ...(defaultChoice ? { default: defaultChoice } : {}),
    group: "navigation"
  };
}

/**
 * @param {{ defaultInputTokens: number, maxInputTokens: number }} tokenLimits
 */
function cocopiLanguageModelContextSizeConfiguration(tokenLimits) {
  if (tokenLimits.defaultInputTokens >= tokenLimits.maxInputTokens) {
    return;
  }

  return {
    type: "number",
    title: "Context Size",
    description: "Controls how much chat context VS Code keeps before compacting Cocopi requests.",
    enum: [tokenLimits.defaultInputTokens, tokenLimits.maxInputTokens],
    enumItemLabels: [languageModelTokenCountLabel(tokenLimits.defaultInputTokens), languageModelTokenCountLabel(tokenLimits.maxInputTokens)],
    enumDescriptions: ["Default recommended context size.", "Longer sessions without earlier VS Code compaction."],
    default: tokenLimits.defaultInputTokens,
    group: "tokens"
  };
}

/** @param {number} tokens */
function languageModelTokenCountLabel(tokens) {
  if (tokens >= 1_000_000) {
    return `${languageModelTokenCountUnitLabel(tokens / 1_000_000)}M`;
  }

  if (tokens >= 1000) {
    return `${languageModelTokenCountUnitLabel(tokens / 1000)}K`;
  }

  return String(tokens);
}

/** @param {number} value */
function languageModelTokenCountUnitLabel(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}

/** @param {CodexModelSummary} model */
function cocopiLanguageModelConfigurationChoices(model) {
  if (Array.isArray(model.supportedReasoningLevels)) {
    return uniqueReasoningChoices(model.supportedReasoningLevels.map((level) => cocopiLanguageModelConfigurationChoice(level.effort, level.description)));
  }

  const efforts = model.defaultReasoningLevel ? [...DEFAULT_MODEL_CONFIGURATION_REASONING_EFFORTS] : [];
  return efforts.map((effort) => cocopiLanguageModelConfigurationChoice(effort));
}

/**
 * @param {import("../../data/Codex.js").CodexReasoningEffort} effort
 * @param {string | undefined} [description]
 */
function cocopiLanguageModelConfigurationChoice(effort, description) {
  return {
    effort,
    value: effort,
    label: reasoningEffortLabel(effort),
    description: description ?? reasoningOptionDescription(effort)
  };
}

/**
 * @param {CodexModelSummary} model
 * @param {{ effort: import("../../data/Codex.js").CodexReasoningEffort }[]} choices
 */
function defaultReasoningEffortForChoices(model, choices) {
  const efforts = choices.map((choice) => choice.effort);
  if (model.defaultReasoningLevel && efforts.includes(model.defaultReasoningLevel)) {
    return model.defaultReasoningLevel;
  }

  return highestReasoningEffort(efforts);
}

/**
 * @param {{ effort: import("../../data/Codex.js").CodexReasoningEffort, value: string, label: string, description: string }[]} choices
 */
function uniqueReasoningChoices(choices) {
  const seen = new Set();
  return choices.filter((choice) => {
    if (!CODEX_REASONING_EFFORTS.includes(choice.effort) || seen.has(choice.effort)) {
      return false;
    }

    seen.add(choice.effort);
    return true;
  });
}

/** @param {readonly import("../../data/Codex.js").CodexReasoningEffort[]} efforts */
function uniqueReasoningEfforts(efforts) {
  const seen = new Set();
  return efforts.filter((effort) => {
    if (!CODEX_REASONING_EFFORTS.includes(effort) || seen.has(effort)) {
      return false;
    }

    seen.add(effort);
    return true;
  });
}

/** @param {readonly import("../../data/Codex.js").CodexReasoningEffort[]} [efforts] */
function highestReasoningEffort(efforts) {
  const supported = uniqueReasoningEfforts(efforts ?? []);
  if (supported.length === 0) {
    return;
  }

  let highest = supported[0];
  for (const effort of supported.slice(1)) {
    if (codexReasoningEffortRank(effort) > codexReasoningEffortRank(highest)) {
      highest = effort;
    }
  }

  return highest;
}

/** @param {import("../../data/Codex.js").CodexReasoningEffort} effort */
function codexReasoningEffortRank(effort) {
  return CODEX_REASONING_EFFORTS.indexOf(effort);
}

/** @param {string} option */
function reasoningOptionDescription(option) {
  switch (option) {
    case "none": {
      return "No reasoning applied.";
    }
    case "minimal": {
      return "Minimal reasoning.";
    }
    case "low": {
      return "Faster responses with less reasoning.";
    }
    case "medium": {
      return "Balanced reasoning and speed.";
    }
    case "high": {
      return "Greater reasoning depth but slower.";
    }
    case "xhigh": {
      return "Maximum reasoning depth but slower.";
    }
    case "concise": {
      return "Show concise reasoning summaries.";
    }
    case "detailed": {
      return "Show detailed reasoning summaries.";
    }
    case "fast": {
      return "Use fast processing when available.";
    }
    default: {
      return option;
    }
  }
}

/** @param {import("../../data/Codex.js").CodexReasoningEffort} effort */
function reasoningEffortLabel(effort) {
  switch (effort) {
    case "none": {
      return "None";
    }
    case "minimal": {
      return "Minimal";
    }
    case "low": {
      return "Low";
    }
    case "medium": {
      return "Medium";
    }
    case "high": {
      return "High";
    }
    case "xhigh": {
      return "Extra High";
    }
    default: {
      return effort;
    }
  }
}

/**
 * @param {string} model
 * @param {string} detail
 * @param {{ useModelDefaultCompactionLimit?: boolean, compactionFallbackStrategy?: "full" | "ninety-percent" }} [options]
 * @returns {import("vscode").LanguageModelChatInformation}
 */
function genericLanguageModelInformation(model, detail, options = {}) {
  const tokenLimits = languageModelTokenLimits(undefined, options);
  /** @type {import("vscode").LanguageModelChatInformation} */
  const information = {
    id: model,
    name: model,
    family: "codex",
    tooltip: "Remote Codex through Cocopi",
    detail: cocopiModelDetail(detail),
    version: model,
    isBYOK: true,
    isUserSelectable: true,
    maxInputTokens: tokenLimits.maxInputTokens,
    maxOutputTokens: tokenLimits.maxOutputTokens,
    capabilities: {
      imageInput: false,
      toolCalling: true
    }
  };
  return information;
}

/**
 * @param {CodexModelSummary[] | undefined} models
 * @param {string} modelId
 */
function codexModelReasoningOptions(models, modelId) {
  const model = models?.find((candidate) => candidate.id === modelId);
  if (!model) {
    return {};
  }

  if (codexModelSupportsReasoning(model) === false) {
    return {
      supportedEfforts: [],
      supportsSummaries: false
    };
  }

  const supportedEfforts = model.supportedReasoningLevels?.map((level) => level.effort);
  return {
    defaultEffort: defaultCodexModelReasoningEffort(model, supportedEfforts),
    supportedEfforts,
    supportsSummaries: codexModelSupportsReasoningSummaries(model),
    defaultSummary: model.defaultReasoningSummary
  };
}

/**
 * @param {CodexModelSummary} model
 * @param {import("../../data/Codex.js").CodexReasoningEffort[] | undefined} supportedEfforts
 */
function defaultCodexModelReasoningEffort(model, supportedEfforts) {
  if (model.defaultReasoningLevel && (!supportedEfforts || supportedEfforts.includes(model.defaultReasoningLevel))) {
    return model.defaultReasoningLevel;
  }

  return highestReasoningEffort(supportedEfforts) ?? model.defaultReasoningLevel;
}

/** @param {CodexModelSummary} model */
function codexModelSupportsReasoning(model) {
  if (model.supportedInApi === false) {
    return false;
  }

  if (Array.isArray(model.supportedReasoningLevels)) {
    return model.supportedReasoningLevels.length > 0;
  }

  if (model.defaultReasoningLevel !== undefined) {
    return true;
  }
}

/** @param {CodexModelSummary} model */
function codexModelSupportsReasoningSummaries(model) {
  if (typeof model.supportsReasoningSummaries === "boolean") {
    return model.supportsReasoningSummaries;
  }

  if (model.defaultReasoningSummary !== undefined) {
    return model.defaultReasoningSummary !== "none";
  }
}

/** @param {string | undefined} description */
function cocopiModelTooltip(description) {
  return description ? `Cocopi - ${description}` : "Remote Codex through Cocopi";
}

/** @param {string} detail */
function cocopiModelDetail(detail) {
  return `Cocopi - ${detail}`;
}

/**
 * @param {readonly import("vscode").LanguageModelChatRequestMessage[]} messages
 * @param {{ LanguageModelChatMessageRole: typeof import("vscode").LanguageModelChatMessageRole }} vscode
 * @param {{ modelId?: string, debugLevel?: 'off' | 'metadata' | 'events' | 'payloads', logger?: import("./diagnostics.js").CocopiLogger, issueTracking?: boolean }} [options]
 * @returns {CodexResponseInputItem[]}
 */
export function codexInputFromLanguageModelMessages(messages, vscode, options = {}) {
  return codexRequestStateFromLanguageModelMessages(messages, options.modelId ?? "", vscode, options).input;
}

/**
 * @param {string | undefined} sourceInstructions
 * @param {import("./configuration.js").CocopiConfiguration} configuration
 * @returns {string | undefined}
 */
function resolveLanguageModelInstructions(sourceInstructions, configuration) {
  if (configuration.chatInstructionsMode === COCOPI_CHAT_INSTRUCTIONS_MODES.optional) {
    return sourceInstructions;
  }

  return resolveChatParticipantInstructions(sourceInstructions, configuration);
}

/**
 * @param {readonly import("vscode").LanguageModelChatRequestMessage[]} messages
 * @param {string} modelId
 * @param {{ LanguageModelChatMessageRole: typeof import("vscode").LanguageModelChatMessageRole }} vscode
 * @param {{ debugLevel?: 'off' | 'metadata' | 'events' | 'payloads', logger?: import("./diagnostics.js").CocopiLogger, issueTracking?: boolean }} [options]
 * @returns {{ input: CodexResponseInputItem[], sessionId?: string, hostRequestIndex?: number, instructions?: string, continuationAnchors?: RestoredContinuationAnchor[] }}
 */
export function codexRequestStateFromLanguageModelMessages(messages, modelId, vscode, options = {}) {
  /** @type {CodexResponseInputItem[]} */
  const input = [];
  /** @type {RestoredContinuationAnchor[]} */
  const continuationAnchors = [];
  /** @type {string | undefined} */
  let sessionId;
  /** @type {number | undefined} */
  let hostRequestIndex;
  /** @type {string | undefined} */
  let instructions;
  for (const [index, message] of messages.entries()) {
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
    if (index === 0 && role === "user") {
      instructions = instructionTextFromLanguageModelMessage(message);
      if (instructions) {
        continue;
      }
    }

    const state = pushLanguageModelMessage(input, role, message, modelId, index, {
      ...options,
      continuationAnchors
    });
    sessionId = state?.sessionId ?? sessionId;
    hostRequestIndex = maxPositiveInteger(hostRequestIndex, state?.hostRequestIndex);
  }

  const pairedInput = pruneUnpairedFunctionCallItems(input, options);
  return {
    input: pairedInput,
    ...(continuationAnchors.length > 0 ? { continuationAnchors } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(hostRequestIndex ? { hostRequestIndex } : {}),
    ...(instructions ? { instructions } : {})
  };
}

/**
 * @param {{ continuationAnchors?: RestoredContinuationAnchor[] }} requestState
 * @param {import("../../data/Codex.js").CodexResponseCreateRequest} body
 * @returns {import("../codex-api/websocket.js").CodexContinuationAnchor[]}
 */
function continuationAnchorsFromLanguageModelRequestState(requestState, body) {
  return (requestState.continuationAnchors ?? []).map((anchor) => {
    /** @type {import("../../data/Codex.js").CodexResponseCreateRequest} */
    const request = {
      ...body,
      ...anchor.requestState,
      input: anchor.input
    };
    delete request.previous_response_id;
    return {
      request,
      responseId: anchor.responseId,
      itemsAdded: anchor.responseItems
    };
  });
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage} message
 */
function instructionTextFromLanguageModelMessage(message) {
  const text = textFromLanguageModelMessage(message).trim();
  if (!looksLikeLanguageModelInstructionText(text)) {
    return;
  }

  return text;
}

/** @param {string} text */
function looksLikeLanguageModelInstructionText(text) {
  if (!text) {
    return false;
  }

  return text.includes("You are an expert AI programming assistant")
    && text.includes("<instructions>")
    && text.includes("</instructions>")
    && text.includes("<toolUseInstructions>")
    && text.includes("</toolUseInstructions>");
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage} message
 */
function textFromLanguageModelMessage(message) {
  return message.content
    .map((part) => textFromLanguageModelPart(part))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage} message
 */
function estimatedLanguageModelMessageCharacters(message) {
  let characters = 0;
  for (const part of message.content) {
    const text = textFromLanguageModelPart(part);
    if (text) {
      characters += text.length;
      continue;
    }

    const markerCharacters = estimatedStatefulMarkerCharacters(part);
    if (markerCharacters !== undefined) {
      characters += markerCharacters;
      continue;
    }

    const dataCharacters = estimatedDataPartCharacters(part);
    if (dataCharacters !== undefined) {
      characters += dataCharacters;
      continue;
    }

    characters += safeJsonStringLength(part);
  }

  return characters;
}

/**
 * @param {number} characters
 */
function approximateTokenCountFromCharacters(characters) {
  return Math.max(1, Math.ceil(characters / 4));
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage["content"][number]} part
 * @returns {number | undefined}
 */
function estimatedStatefulMarkerCharacters(part) {
  const marker = statefulMarkerFromLanguageModelPart(part, {});
  if (!marker) {
    return;
  }

  const state = decodeCocopiStatefulMarkerPayload(marker.marker, {});
  if (!state) {
    return estimatedDataPartCharacters(part);
  }

  return safeJsonStringLength(state.responseItems);
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage["content"][number]} part
 * @returns {number | undefined}
 */
function estimatedDataPartCharacters(part) {
  if (!part || typeof part !== "object" || !("data" in part)) {
    return;
  }

  const data = /** @type {{ data?: unknown }} */ (part).data;
  return data instanceof Uint8Array ? Math.ceil(data.byteLength * 4 / 3) : safeJsonStringLength(part);
}

// eslint-disable-next-line jsdoc/check-types -- JSON.stringify accepts arbitrary VS Code message part values for rough token estimation.
/** @param {unknown} value */
function safeJsonStringLength(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * @param {CodexResponseInputItem[]} input
 * @param {'user' | 'assistant'} role
 * @param {import("vscode").LanguageModelChatRequestMessage} message
 * @param {string} modelId
 * @param {number} messageIndex
 * @param {{ debugLevel?: 'off' | 'metadata' | 'events' | 'payloads', logger?: import("./diagnostics.js").CocopiLogger, continuationAnchors?: RestoredContinuationAnchor[] }} options
 * @returns {{ sessionId?: string, hostRequestIndex?: number } | undefined}
 */
function pushLanguageModelMessage(input, role, message, modelId, messageIndex, options) {
  const state = statefulMarkerStateFromLanguageModelMessage(message, modelId, messageIndex, options);
  if (state) {
    if (state.responseId && state.requestState) {
      options.continuationAnchors?.push({
        input: [...input],
        responseItems: state.responseItems,
        responseId: state.responseId,
        requestState: state.requestState
      });
    }
    input.push(...state.responseItems);
    if (role === "assistant") {
      return {
        sessionId: state.sessionId,
        hostRequestIndex: state.hostRequestIndex
      };
    }
  }

  /** @type {CodexContentItem[]} */
  const contentParts = [];
  const flushContent = () => {
    pushMessage(input, role, [...contentParts]);
    contentParts.length = 0;
  };

  for (const part of message.content) {
    if (statefulMarkerFromLanguageModelPart(part, options)) {
      continue;
    }

    const toolCall = codexFunctionCallInputItemFromLanguageModelPart(part);
    if (toolCall) {
      flushContent();
      input.push(toolCall);
      continue;
    }

    const toolOutput = codexFunctionCallOutputInputItemFromLanguageModelPart(part);
    if (toolOutput) {
      flushContent();
      input.push(toolOutput);
      continue;
    }

    const text = textFromLanguageModelPart(part);
    const trimmedText = text.trim();
    if (trimmedText) {
      contentParts.push({ type: role === "assistant" ? "output_text" : "input_text", text: trimmedText });
      continue;
    }

    const image = codexInputImageContentFromLanguageModelPart(part);
    if (image && role === "user") {
      contentParts.push(image);
    }
  }

  flushContent();
  return state ? {
    sessionId: state.sessionId,
    hostRequestIndex: state.hostRequestIndex
  } : undefined;
}

/**
 * Stateless Responses replay must include both a prior function_call and its
 * function_call_output. VS Code can occasionally re-enter with partial tool
 * state, so drop unpaired tool items before sending the request.
 *
 * @param {CodexResponseInputItem[]} input
 * @param {{ debugLevel?: 'off' | 'metadata' | 'events' | 'payloads', logger?: import("./diagnostics.js").CocopiLogger, issueTracking?: boolean }} options
 */
function pruneUnpairedFunctionCallItems(input, options) {
  /** @type {Set<string>} */
  const callIds = new Set();
  /** @type {Set<string>} */
  const outputIds = new Set();
  for (const item of input) {
    if (isFunctionCallInputItem(item)) {
      callIds.add(item.call_id);
    }
    if (isFunctionCallOutputInputItem(item)) {
      outputIds.add(item.call_id);
    }
  }

  let prunedToolCalls = 0;
  let prunedToolOutputs = 0;
  /** @type {string[]} */
  const prunedToolCallIds = [];
  /** @type {string[]} */
  const prunedToolOutputIds = [];
  const pairedInput = input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return true;
    }

    if (isFunctionCallInputItem(item) && !outputIds.has(item.call_id)) {
      prunedToolCalls += 1;
      prunedToolCallIds.push(item.call_id);
      return false;
    }

    if (isFunctionCallOutputInputItem(item) && !callIds.has(item.call_id)) {
      prunedToolOutputs += 1;
      prunedToolOutputIds.push(item.call_id);
      return false;
    }

    return true;
  });

  if (prunedToolCalls > 0 || prunedToolOutputs > 0) {
    if (options.issueTracking !== false) {
      recordUnpairedToolReplayIssue({
        toolCalls: callIds.size,
        toolOutputs: outputIds.size,
        prunedToolCalls,
        prunedToolOutputs,
        prunedToolCallIds,
        prunedToolOutputIds
      });
    }
    logUnpairedToolReplayDiagnostics(options.logger, options.debugLevel, {
      toolCalls: callIds.size,
      toolOutputs: outputIds.size,
      prunedToolCalls,
      prunedToolOutputs,
      prunedToolCallIds,
      prunedToolOutputIds
    });
  }

  return pairedInput;
}

/**
 * @param {{ toolCalls: number, toolOutputs: number, prunedToolCalls: number, prunedToolOutputs: number, prunedToolCallIds: string[], prunedToolOutputIds: string[] }} summary
 */
function recordUnpairedToolReplayIssue(summary) {
  recordCocopiIssue({
    severity: "warning",
    category: "tool-replay",
    title: "Cocopi pruned unpaired tool replay items",
    details: "VS Code provided stateless replay items where prior function calls and function outputs did not match. Cocopi dropped the unpaired items before sending the Responses request.",
    metadata: {
      toolCalls: summary.toolCalls,
      toolOutputs: summary.toolOutputs,
      prunedToolCalls: summary.prunedToolCalls,
      prunedToolOutputs: summary.prunedToolOutputs,
      prunedToolCallIds: formatLimitedList(summary.prunedToolCallIds),
      prunedToolOutputIds: formatLimitedList(summary.prunedToolOutputIds)
    }
  });
}

/**
 * @param {import("./diagnostics.js").CocopiLogger | undefined} logger
 * @param {'off' | 'metadata' | 'events' | 'payloads' | undefined} debugLevel
 * @param {{ toolCalls: number, toolOutputs: number, prunedToolCalls: number, prunedToolOutputs: number, prunedToolCallIds: string[], prunedToolOutputIds: string[] }} summary
 */
function logUnpairedToolReplayDiagnostics(logger, debugLevel, summary) {
  if (!logger || !debugLevel || debugLevel === "off") {
    return;
  }

  logger.debug([
    "Codex request input pruned unpaired tool replay items.",
    `toolCalls=${summary.toolCalls}`,
    `toolOutputs=${summary.toolOutputs}`,
    `prunedToolCalls=${summary.prunedToolCalls}`,
    `prunedToolOutputs=${summary.prunedToolOutputs}`,
    `prunedToolCallIds=${formatLimitedList(summary.prunedToolCallIds)}`,
    `prunedToolOutputIds=${formatLimitedList(summary.prunedToolOutputIds)}`
  ].join(" "));
}

/** @param {string[]} values */
function formatLimitedList(values) {
  if (values.length === 0) {
    return "none";
  }

  const limit = 8;
  const head = values.slice(0, limit).join(",");
  return values.length > limit ? `${head},+${values.length - limit}` : head;
}

/**
 * @param {CodexResponseInputItem} item
 * @returns {item is CodexResponseFunctionCallInputItem}
 */
function isFunctionCallInputItem(item) {
  return Boolean(item && typeof item === "object" && !Array.isArray(item) && item.type === "function_call" && typeof item.call_id === "string");
}

/**
 * @param {CodexResponseInputItem} item
 * @returns {item is CodexResponseFunctionCallOutputInputItem}
 */
function isFunctionCallOutputInputItem(item) {
  return Boolean(item && typeof item === "object" && !Array.isArray(item) && item.type === "function_call_output" && typeof item.call_id === "string");
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage} message
 * @param {string} modelId
 * @param {number} messageIndex
 * @param {{ debugLevel?: 'off' | 'metadata' | 'events' | 'payloads', logger?: import("./diagnostics.js").CocopiLogger }} options
 * @returns {{ responseItems: CodexResponseInputItem[], sessionId?: string, hostRequestIndex?: number, responseId?: string, requestState?: Record<string, import("../../data/Codex.js").CodexJsonValue> } | undefined}
 */
function statefulMarkerStateFromLanguageModelMessage(message, modelId, messageIndex, options) {
  if (!modelId) {
    return;
  }

  for (const part of message.content) {
    const marker = statefulMarkerFromLanguageModelPart(part, options);
    if (!marker) {
      continue;
    }

    const state = decodeCocopiStatefulMarkerPayload(marker.marker, options);
    if (!state) {
      logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "ignored", `reason=unsupported-marker markerModelId=${marker.modelId} requestModelId=${modelId} markerBytes=${marker.marker.length} messageIndex=${messageIndex}`);
      continue;
    }

    logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decoded", `markerModelId=${marker.modelId} requestModelId=${modelId} items=${state.responseItems.length} sessionId=${state.sessionId ? "present" : "missing"} hostRequestIndex=${state.hostRequestIndex ? "present" : "missing"} responseId=${state.responseId ? "present" : "missing"} markerBytes=${marker.marker.length} messageIndex=${messageIndex}`);
    return state;
  }
}

/**
 * @param {readonly import("vscode").LanguageModelChatRequestMessage[]} messages
 * @returns {{ messages: number, textParts: number, toolCallParts: number, toolResultParts: number, dataParts: number, cocopiDataParts: number, cocopiDataBytes: number, dataMimeTypes: string, toolCallIds: string, toolResultIds: string }}
 */
function languageModelMessageSummary(messages) {
  let textParts = 0;
  let toolCallParts = 0;
  let toolResultParts = 0;
  let dataParts = 0;
  let cocopiDataParts = 0;
  let cocopiDataBytes = 0;
  /** @type {string[]} */
  const toolCallIds = [];
  /** @type {string[]} */
  const toolResultIds = [];
  /** @type {Map<string, number>} */
  const dataMimeTypes = new Map();
  for (const message of messages) {
    for (const part of message.content) {
      if (part && typeof part === "object" && "value" in part && typeof part.value === "string") {
        textParts += 1;
      }
      if (part && typeof part === "object" && "callId" in part && "name" in part && "input" in part) {
        toolCallParts += 1;
        toolCallIds.push(formatLanguageModelPartId(typeof part.callId === "string" ? part.callId : undefined, typeof part.name === "string" ? part.name : undefined));
      }
      if (part && typeof part === "object" && "callId" in part && "content" in part) {
        toolResultParts += 1;
        toolResultIds.push(formatLanguageModelPartId(typeof part.callId === "string" ? part.callId : undefined));
      }
      if (part && typeof part === "object" && "data" in part && "mimeType" in part) {
        dataParts += 1;
        const mimeType = typeof part.mimeType === "string" ? part.mimeType : String(part.mimeType);
        dataMimeTypes.set(mimeType, (dataMimeTypes.get(mimeType) ?? 0) + 1);
        if (mimeType === COCOPI_STATEFUL_MARKER_MIME) {
          cocopiDataParts += 1;
          if (part.data instanceof Uint8Array) {
            cocopiDataBytes += part.data.byteLength;
          }
        }
      }
    }
  }

  return {
    messages: messages.length,
    textParts,
    toolCallParts,
    toolResultParts,
    dataParts,
    cocopiDataParts,
    cocopiDataBytes,
    dataMimeTypes: formatCounts(dataMimeTypes),
    toolCallIds: formatDiagnosticList(toolCallIds),
    toolResultIds: formatDiagnosticList(toolResultIds)
  };
}

/**
 * @param {CodexResponseInputItem[]} input
 * @param {{ messages: number, textParts: number, toolCallParts: number, toolResultParts: number, dataParts: number }} messageSummary
 * @returns {{ summary: string | undefined, description: string | undefined }}
 */
function languageModelConversationMetadata(input, messageSummary) {
  const promptText = latestUserInputText(input);
  const summary = compactConversationMetadataText(promptText, 96);
  const description = compactConversationMetadataText(promptText, 240)
    ?? languageModelRequestShapeDescription(input.length, messageSummary);

  return { summary, description };
}

/**
 * @param {CodexResponseInputItem[]} input
 */
function latestUserInputText(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const text = userTextFromCodexInputItem(input[index]);
    if (text) {
      return text;
    }
  }
}

/**
 * VS Code re-enters providers after it has invoked model-requested tools. In
 * that shape the replay ends with function_call_output items, not a fresh user
 * message, so the token tracker should fold the follow-up API call into the
 * original user turn.
 *
 * @param {CodexResponseInputItem[]} input
 */
function isCodexToolContinuationInput(input) {
  let lastUserMessageIndex = -1;
  let lastToolOutputIndex = -1;
  for (const [index, item] of input.entries()) {
    if (item && typeof item === "object" && !Array.isArray(item) && "role" in item && item.role === "user") {
      lastUserMessageIndex = index;
    }
    if (isFunctionCallOutputInputItem(item)) {
      lastToolOutputIndex = index;
    }
  }

  return lastToolOutputIndex >= 0 && lastToolOutputIndex > lastUserMessageIndex;
}

/** @param {CodexResponseInputItem} item */
function userTextFromCodexInputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || !("role" in item) || item.role !== "user" || !("content" in item) || !Array.isArray(item.content)) {
    return;
  }

  const text = item.content
    .map((part) => part && typeof part === "object" && "type" in part && part.type === "input_text" && "text" in part && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n\n");
  return text.trim() || undefined;
}

/**
 * @param {string | undefined} text
 * @param {number} maxCharacters
 */
function compactConversationMetadataText(text, maxCharacters) {
  const normalized = text?.replaceAll(/\s+/gu, " ").trim();
  if (!normalized) {
    return;
  }

  if (normalized.length <= maxCharacters) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`;
}

/**
 * @param {number} inputItems
 * @param {{ messages: number, textParts: number, toolCallParts: number, toolResultParts: number, dataParts: number }} messageSummary
 */
function languageModelRequestShapeDescription(inputItems, messageSummary) {
  const parts = [
    `${inputItems} input ${inputItems === 1 ? "item" : "items"}`,
    `${messageSummary.messages} ${messageSummary.messages === 1 ? "message" : "messages"}`,
    messageSummary.textParts > 0 ? `${messageSummary.textParts} text` : undefined,
    messageSummary.toolCallParts > 0 ? `${messageSummary.toolCallParts} tool calls` : undefined,
    messageSummary.toolResultParts > 0 ? `${messageSummary.toolResultParts} tool results` : undefined,
    messageSummary.dataParts > 0 ? `${messageSummary.dataParts} data` : undefined
  ].filter(Boolean);

  return parts.join(" · ");
}

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {'off' | 'metadata' | 'events' | 'payloads'} debugLevel
 * @param {ReturnType<typeof languageModelMessageSummary>} summary
 */
function logLanguageModelMessageDiagnostics(logger, debugLevel, summary) {
  if (debugLevel === "off") {
    return;
  }

  logger.debug([
    "VS Code language model messages.",
    `messages=${summary.messages}`,
    `textParts=${summary.textParts}`,
    `toolCallParts=${summary.toolCallParts}`,
    `toolResultParts=${summary.toolResultParts}`,
    `toolCallIds=${summary.toolCallIds}`,
    `toolResultIds=${summary.toolResultIds}`,
    `dataParts=${summary.dataParts}`,
    `cocopiDataParts=${summary.cocopiDataParts}`,
    `cocopiDataBytes=${summary.cocopiDataBytes}`,
    `dataMimeTypes=${summary.dataMimeTypes}`
  ].join(" "));
}

/**
 * @param {import("../../data/Codex.js").CodexResponseStreamEvent} event
 * @returns {string | undefined}
 */
function codexResponseIdFromStreamEvent(event) {
  if (event.type === "response.completed") {
    return event.response.id;
  }

  const record = /** @type {Record<string, unknown>} */ (event);
  const response = record.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const id = /** @type {Record<string, unknown>} */ (response).id;
    if (typeof id === "string" && id.trim()) {
      return id;
    }
  }

  const value = record.response_id;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * @param {object} options
 * @param {ReturnType<typeof createResponseStateBuilder>} options.responseState
 * @param {string} options.fallbackAssistantText
 * @param {string} options.sessionId
 * @param {string | undefined} options.responseId
 * @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} options.requestState
 * @param {number} options.hostRequestIndex
 * @param {string} options.requestModelId
 * @param {import("vscode").Progress<import("vscode").LanguageModelResponsePart>} options.progress
 * @param {ReturnType<typeof createLanguageModelTextProgressReporter>} options.textProgress
 * @param {VscodeLanguageModelApi} options.vscode
 * @param {import("./diagnostics.js").CocopiLogger} options.logger
 * @param {'off' | 'metadata' | 'events' | 'payloads'} options.debugLevel
 * @param {"before-tool-call" | "final"} options.emissionPoint
 * @returns {boolean}
 */
function emitLanguageModelStatefulMarker(options) {
  const responseItems = options.responseState.toResponseItems(options.fallbackAssistantText);
  if (responseItems.length === 0) {
    logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "not-emitted", `reason=no-response-items emissionPoint=${options.emissionPoint}`);
    return false;
  }

  const marker = encodeCocopiStatefulMarkerPayload(responseItems, options.sessionId, {
    responseId: options.responseId,
    requestState: options.requestState,
    hostRequestIndex: options.hostRequestIndex
  });
  logProviderStatefulMarkerDiagnostics(
    options.logger,
    options.debugLevel,
    "emitted",
    `mimeType=${COCOPI_STATEFUL_MARKER_MIME} modelId=${options.requestModelId} items=${responseItems.length} markerBytes=${marker.length} emissionPoint=${options.emissionPoint}`
  );
  options.textProgress.flush();
  options.progress.report(cocopiStatefulMarkerDataPart(marker, options.requestModelId, options.vscode));
  return true;
}

/**
 * @param {import("../../data/Codex.js").CodexResponse | undefined} response
 * @param {import("vscode").Progress<import("vscode").LanguageModelResponsePart>} progress
 * @param {VscodeLanguageModelApi} vscode
 */
function emitLanguageModelUsage(response, progress, vscode) {
  const payload = languageModelUsagePayloadFromCodexResponse(response);
  if (!payload) {
    return;
  }

  progress.report(new vscode.LanguageModelDataPart(TEXT_ENCODER.encode(JSON.stringify(payload)), VSCODE_LANGUAGE_MODEL_USAGE_MIME));
}

/**
 * @param {import("../../data/Codex.js").CodexResponse | undefined} response
 * @returns {VscodeLanguageModelUsagePayload | undefined}
 */
function languageModelUsagePayloadFromCodexResponse(response) {
  if (!response) {
    return;
  }

  const usage = readCodexUsageSummary(/** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (response));
  if (!usage || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") {
    return;
  }

  /** @type {VscodeLanguageModelUsagePayload} */
  const payload = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: typeof usage.totalTokens === "number" ? usage.totalTokens : usage.inputTokens + usage.outputTokens
  };
  if (typeof usage.cachedTokens === "number") {
    payload.prompt_tokens_details = { cached_tokens: usage.cachedTokens };
  }
  if (typeof usage.reasoningTokens === "number") {
    payload.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }

  return payload;
}

/**
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {'off' | 'metadata' | 'events' | 'payloads'} debugLevel
 * @param {import("./tool-bridge.js").CodexToolCall} toolCall
 */
function logLanguageModelToolCallReported(logger, debugLevel, toolCall) {
  if (debugLevel === "off") {
    return;
  }

  logger.debug([
    "VS Code language model tool call reported.",
    `callId=${formatDiagnosticScalar(toolCall.callId)}`,
    `name=${formatDiagnosticScalar(toolCall.name)}`,
    `inputKeys=${Object.keys(toolCall.input).toSorted().join(",") || "absent"}`,
    `inputPreview=${formatDiagnosticJsonPreview(toolCall.input)}`
  ].join(" "));
}

/**
 * @param {import("./diagnostics.js").CocopiLogger | undefined} logger
 * @param {'off' | 'metadata' | 'events' | 'payloads' | undefined} debugLevel
 * @param {'emitted' | 'not-emitted' | 'decoded' | 'decode-failed' | 'ignored'} event
 * @param {string} [details]
 */
function logProviderStatefulMarkerDiagnostics(logger, debugLevel, event, details = "") {
  if (!logger || !debugLevel || debugLevel === "off") {
    return;
  }

  logger.debug([
    "VS Code stateful marker.",
    `event=${event}`,
    details
  ].filter(Boolean).join(" "));
}

/** @param {Map<string, number>} counts */
function formatCounts(counts) {
  if (counts.size === 0) {
    return "none";
  }

  return [...counts.entries()].map(([key, count]) => `${key}:${count}`).join(",");
}

/**
 * @param {string | undefined} callId
 * @param {string | undefined} [name]
 */
function formatLanguageModelPartId(callId, name) {
  const formattedCallId = formatDiagnosticScalar(callId);
  const formattedName = formatDiagnosticScalar(name);
  return formattedName === "absent" ? formattedCallId : `${formattedCallId}:${formattedName}`;
}

/** @param {readonly string[]} values */
function formatDiagnosticList(values) {
  if (values.length === 0) {
    return "absent";
  }

  const formatted = values.slice(0, 12).join(",");
  return values.length > 12 ? `${formatted},...(+${values.length - 12})` : formatted;
}

/** @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} value */
function formatDiagnosticJsonPreview(value) {
  try {
    const json = JSON.stringify(value);
    if (!json) {
      return "absent";
    }

    return JSON.stringify(json.length > 220 ? `${json.slice(0, 217)}...` : json);
  } catch {
    return "unserializable";
  }
}

/**
 * @param {string} marker
 * @param {string} modelId
 * @param {{ LanguageModelDataPart: typeof import("vscode").LanguageModelDataPart }} vscode
 */
function cocopiStatefulMarkerDataPart(marker, modelId, vscode) {
  return new vscode.LanguageModelDataPart(encodeStatefulMarker(modelId, marker), COCOPI_STATEFUL_MARKER_MIME);
}

/**
 * @returns {{ capture(item: CodexResponseInputItem, order?: number): void, toResponseItems(fallbackAssistantText?: string): CodexResponseInputItem[] }}
 */
function createResponseStateBuilder() {
  /** @type {Array<{ key: string | undefined, order: number, sequence: number, item: CodexResponseInputItem }>} */
  const entries = [];
  const keyedEntries = new Set();
  let sequence = 0;
  return {
    capture(item, order) {
      const key = codexResponseInputItemKey(item);
      if (key && keyedEntries.has(key)) {
        return;
      }

      if (key) {
        keyedEntries.add(key);
      }

      entries.push({
        key,
        order: Number.isFinite(order) ? /** @type {number} */ (order) : Number.MAX_SAFE_INTEGER,
        sequence,
        item
      });
      sequence += 1;
    },
    toResponseItems(fallbackAssistantText = "") {
      const allEntries = [...entries];
      if (!allEntries.some((entry) => isAssistantMessageInputItem(entry.item))) {
        const message = codexAssistantMessageInputItemFromText(fallbackAssistantText);
        if (message) {
          allEntries.push({
            key: undefined,
            order: Number.MAX_SAFE_INTEGER,
            sequence,
            item: message
          });
        }
      }

      return allEntries
        // eslint-disable-next-line unicorn/no-array-sort -- The project target does not include Array#toSorted.
        .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
        .map((entry) => entry.item);
    }
  };
}

/**
 * @param {CocopiSecretContext} context
 * @param {Awaited<ReturnType<typeof readCocopiRuntime>>} runtime
 * @param {import("./diagnostics.js").CocopiLogger} logger
 * @param {{ key: string, expiresAtMs: number, models: CodexModelSummary[] } | undefined} cache
 * @param {(result: { cache: { key: string, expiresAtMs: number, models: CodexModelSummary[] }, catalogChanged: boolean }) => void} updateCache
 * @param {(error: Error | string | object | null | undefined) => Promise<void>} [notifyFailure]
 * @param {(error: Error) => void} [onFailure]
 */
async function refreshModelCatalogInBackground(context, runtime, logger, cache, updateCache, notifyFailure, onFailure) {
  try {
    const models = await readCachedCodexModels(context, runtime, cache);
    updateCache({
      cache: models.cache,
      catalogChanged: models.catalogChanged
    });
  } catch (error) {
    const normalizedError = normalizeCaughtError(error);
    logger.error("Cocopi background model catalog refresh failed.", normalizedError);
    onFailure?.(normalizedError);
    await notifyFailure?.(normalizedError);
  }
}

/**
 * @param {string} model
 * @param {Error | string | object | null | undefined} error
 */
function modelCatalogFallbackWarning(model, error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/status\s+401\b|unauthorized|token refresh failed/iu.test(message)) {
    return `Cocopi could not refresh your Codex sign-in, so VS Code is showing only the fallback model (${model}).`;
  }

  return `Cocopi could not load your Codex model list, so VS Code is showing only the fallback model (${model}). Check your sign-in and Cocopi output logs.`;
}

/**
 * @param {VscodeLanguageModelApi} vscode
 * @param {string} message
 * @param {() => void} [onSignInComplete]
 */
async function showModelCatalogWarning(vscode, message, onSignInComplete) {
  const selection = await vscode.window?.showWarningMessage(message, "Sign In");
  if (selection === "Sign In") {
    await vscode.commands?.executeCommand?.(COCOPI_COMMANDS.signIn);
    onSignInComplete?.();
  }
}

function createVoidEventEmitter() {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    /**
     * @param {() => void} listener
     * @returns {{ dispose(): void }}
     */
    event(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        }
      };
    },
    fire() {
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

/**
 * @param {CocopiSecretContext} context
 * @param {(event?: { key?: string }) => void} listener
 * @returns {{ dispose(): void } | undefined}
 */
function subscribeToSecretChanges(context, listener) {
  const onDidChange = Reflect.get(context.secrets, "onDidChange");
  if (typeof onDidChange !== "function") {
    return;
  }

  return Reflect.apply(onDidChange, context.secrets, [listener]);
}

/**
 * @param {{ key?: string } | undefined} event
 */
function isAuthSecretChange(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return true;
  }

  const key = event.key;
  return typeof key === "string" && COCOPI_AUTH_SECRET_KEYS.has(key);
}

/**
 * @param {CodexResponseInputItem} item
 * @returns {string | undefined}
 */
function codexResponseInputItemKey(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return;
  }

  if (item.type === "function_call" && typeof item.call_id === "string") {
    return `function_call:${item.call_id}`;
  }

  if (item.type === "reasoning" && typeof item.id === "string") {
    return `reasoning:${item.id}`;
  }
}

/**
 * @param {CodexResponseInputItem} item
 */
function isAssistantMessageInputItem(item) {
  return Boolean(item && typeof item === "object" && !Array.isArray(item) && "role" in item && item.role === "assistant");
}

/**
 * @param {import("../../data/Codex.js").CodexResponseStreamEvent} event
 */
function responseOutputItemOrderFromEvent(event) {
  return "output_index" in event && typeof event.output_index === "number" && Number.isFinite(event.output_index)
    ? event.output_index
    : undefined;
}

/**
 * @param {import("../../data/Codex.js").CodexResponseStreamEvent} event
 * @returns {string | undefined}
 */
function outputItemDoneToolCallId(event) {
  if (event.type !== "response.output_item.done") {
    return;
  }

  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "function_call") {
    return;
  }

  return cleanString(item.call_id) ?? cleanString(item.id);
}

/**
 * @param {ReturnType<typeof createResponseStateBuilder>} responseState
 * @param {import("../../data/Codex.js").CodexResponseCompletedEvent} event
 */
function captureCompletedResponseOutputItems(responseState, event) {
  const output = event.response.output;
  if (!Array.isArray(output)) {
    return;
  }

  for (const [index, outputItem] of output.entries()) {
    const item = codexResponseInputItemFromOutputItem(outputItem);
    if (item) {
      responseState.capture(item, index);
    }
  }
}

/**
 * @param {import("../../data/Codex.js").CodexResponseCompletedEvent} event
 */
function codexOutputTextFromCompletedEvent(event) {
  if (Array.isArray(event.response.output)) {
    let text = "";
    for (const outputItem of event.response.output) {
      text = appendOutputText(text, codexOutputTextFromOutputItem(outputItem));
    }

    if (text) {
      return text;
    }
  }

  const outputText = event.response.output_text;
  return typeof outputText === "string" && outputText.trim() ? outputText : undefined;
}

/**
 * @param {import("../../data/Codex.js").CodexResponseCompletedEvent} event
 */
function codexCommentaryOutputTextFromCompletedEvent(event) {
  if (!Array.isArray(event.response.output)) {
    return;
  }

  let text = "";
  for (const outputItem of event.response.output) {
    text = appendOutputText(text, codexCommentaryOutputTextFromOutputItem(outputItem));
  }

  return text || undefined;
}

/**
 * @param {string} text
 * @param {string | undefined} next
 * @returns {string}
 */
function appendOutputText(text, next) {
  return next && next.trim() ? `${text}${next}` : text;
}

/**
 * @param {import("../../data/Codex.js").CodexResponseStreamEvent} event
 * @returns {{ itemId: string, delta: string } | undefined}
 */
function readCodexToolCallArgumentDelta(event) {
  if (event.type !== "response.function_call_arguments.delta") {
    return;
  }

  return {
    itemId: event.item_id,
    delta: event.delta
  };
}

/**
 * @param {string} text
 * @param {string} delta
 * @returns {string}
 */
function appendBoundedToolArgumentText(text, delta) {
  const next = `${text}${delta}`;
  return next.length > LANGUAGE_MODEL_EDIT_TOOL_ARGUMENT_PROGRESS_MAX_CHARS
    ? next.slice(0, LANGUAGE_MODEL_EDIT_TOOL_ARGUMENT_PROGRESS_MAX_CHARS)
    : next;
}

/**
 * @param {string} toolName
 * @param {string | undefined} target
 * @returns {string | undefined}
 */
function editToolTargetProgressMessage(toolName, target) {
  if (!target) {
    return;
  }

  const noun = editToolProgressNoun(toolName);
  return `Preparing ${noun} for ${target}.`;
}

/**
 * @param {string} toolName
 * @param {string | undefined} target
 * @param {number} chars
 * @returns {string}
 */
function editToolArgumentProgressMessage(toolName, target, chars) {
  const noun = editToolProgressNoun(toolName);
  const targetText = target ? ` for ${target}` : "";
  return `Generating ${noun}${targetText} (${formatStreamedArgumentSize(chars)} streamed).`;
}

/**
 * @param {string} toolName
 * @param {string | undefined} target
 * @param {number} chars
 * @param {number} elapsedMs
 * @returns {string}
 */
function editToolTimedProgressMessage(toolName, target, chars, elapsedMs) {
  const noun = editToolProgressNoun(toolName);
  const targetText = target ? ` for ${target}` : "";
  const elapsed = formatElapsedTime(elapsedMs);
  if (chars === 0) {
    return `Preparing ${noun}${targetText} (${elapsed} elapsed).`;
  }

  return `Generating ${noun}${targetText} (${formatStreamedArgumentSize(chars)} streamed, ${elapsed} elapsed).`;
}

/**
 * @param {string} toolName
 * @returns {string}
 */
function editToolProgressNoun(toolName) {
  if (isFileCreationTool(toolName)) {
    return "file creation";
  }

  if (isStructuredEditTool(toolName)) {
    return "edit";
  }

  return "patch";
}

/**
 * @param {number} chars
 * @returns {string}
 */
function formatStreamedArgumentSize(chars) {
  if (chars < 1024) {
    return `${chars} chars`;
  }

  return `${Math.ceil(chars / 1024)} KB`;
}

/**
 * @param {number} elapsedMs
 * @returns {string}
 */
function formatElapsedTime(elapsedMs) {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  return `${seconds}s`;
}

/**
 * @param {string} toolName
 * @param {string} text
 * @returns {string | undefined}
 */
function editToolTargetFromArgumentText(toolName, text) {
  if (isPatchEditTool(toolName)) {
    return patchTargetSummaryFromPatchText(normalizeStreamedJsonStringText(text));
  }

  if (isFileCreationTool(toolName) || isStructuredEditTool(toolName)) {
    return filePathTargetFromArgumentText(text);
  }
}

/**
 * @param {string} toolName
 * @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} input
 * @returns {string | undefined}
 */
function editToolTargetFromToolInput(toolName, input) {
  if (isPatchEditTool(toolName) && typeof input.input === "string") {
    return patchTargetSummaryFromPatchText(input.input);
  }

  if ((isFileCreationTool(toolName) || isStructuredEditTool(toolName)) && typeof input.filePath === "string") {
    return basename(input.filePath);
  }
}

/**
 * @param {string} toolName
 * @returns {boolean}
 */
function isEditProgressTool(toolName) {
  return isPatchEditTool(toolName) || isStructuredEditTool(toolName) || isFileCreationTool(toolName);
}

/**
 * @param {string} toolName
 * @returns {boolean}
 */
function isPatchEditTool(toolName) {
  return LANGUAGE_MODEL_PATCH_TOOL_NAMES.has(toolName);
}

/**
 * @param {string} toolName
 * @returns {boolean}
 */
function isStructuredEditTool(toolName) {
  return LANGUAGE_MODEL_STRUCTURED_EDIT_TOOL_NAMES.has(toolName);
}

/**
 * @param {string} toolName
 * @returns {boolean}
 */
function isFileCreationTool(toolName) {
  return LANGUAGE_MODEL_FILE_CREATION_TOOL_NAMES.has(toolName);
}

/**
 * @param {string} text
 * @returns {string | undefined}
 */
function filePathTargetFromArgumentText(text) {
  const filePath = jsonStringFieldFromArgumentText(text, "filePath");
  return filePath ? basename(filePath) : undefined;
}

/**
 * @param {string} text
 * @param {string} fieldName
 * @returns {string | undefined}
 */
function jsonStringFieldFromArgumentText(text, fieldName) {
  const match = new RegExp(String.raw`"${escapeRegExp(fieldName)}"\s*:\s*"((?:\\.|[^"\\])*)"`, "u").exec(text);
  if (!match?.[1]) {
    return;
  }

  try {
    const value = JSON.parse(`"${match[1]}"`);
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return;
  }
}

/**
 * @param {string} value
 */
function escapeRegExp(value) {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/gu, String.raw`\$&`);
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeStreamedJsonStringText(text) {
  return text
    .replaceAll(String.raw`\r\n`, "\n")
    .replaceAll(String.raw`\n`, "\n")
    .replaceAll(String.raw`\r`, "\n");
}

/**
 * @param {string} patch
 * @returns {string | undefined}
 */
function patchTargetSummaryFromPatchText(patch) {
  const fileNames = patchFileBasenames(patch);
  if (fileNames.length === 1) {
    return fileNames[0];
  }

  if (fileNames.length > 1) {
    return `${fileNames.length} files`;
  }
}

/**
 * @param {string} patch
 * @returns {string[]}
 */
function patchFileBasenames(patch) {
  const fileNames = new Set();
  const pattern = /(?:^|\n)\*\*\* (?:Add|Update|Delete) File:\s+([^\r\n"]+)(?:\r?\n)/gu;
  for (const match of patch.matchAll(pattern)) {
    const fileName = basename(match[1]?.trim() ?? "");
    if (fileName) {
      fileNames.add(fileName);
    }
  }

  return [...fileNames];
}

/**
 * @param {string} filePath
 */
function basename(filePath) {
  return filePath.split(/[\\/]/u).findLast(Boolean) ?? "";
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue} item
 * @returns {string | undefined}
 */
function codexOutputTextFromOutputItem(item) {
  const message = codexAssistantMessageInputItemFromOutputItem(item);
  return message && !isCodexCommentaryOutputPhase(message.phase)
    ? codexOutputTextFromAssistantMessageInputItem(message)
    : undefined;
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue} item
 * @returns {string | undefined}
 */
function codexCommentaryOutputTextFromOutputItem(item) {
  const message = codexAssistantMessageInputItemFromOutputItem(item);
  return message && isCodexCommentaryOutputPhase(message.phase)
    ? codexOutputTextFromAssistantMessageInputItem(message)
    : undefined;
}

/**
 * @param {CodexResponseInputMessage} message
 * @returns {string | undefined}
 */
function codexOutputTextFromAssistantMessageInputItem(message) {
  if (!Array.isArray(message.content)) {
    return message.content.trim() ? message.content : undefined;
  }

  let text = "";
  for (const content of message.content) {
    if (content.type === "output_text" && typeof content.text === "string") {
      text += content.text;
    }
  }

  return text || undefined;
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue} item
 * @returns {CodexResponseInputItem | undefined}
 */
function codexResponseInputItemFromOutputItem(item) {
  const reasoning = codexReasoningInputItemFromOutputItem(item);
  if (reasoning) {
    return reasoning;
  }

  const toolCall = codexFunctionCallInputItemFromOutputItem(item);
  if (toolCall) {
    return toolCall;
  }

  return codexAssistantMessageInputItemFromOutputItem(item);
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue} item
 * @returns {CodexResponseReasoningInputItem | undefined}
 */
function codexReasoningInputItemFromOutputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return;
  }

  const outputItem = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (item);
  if (outputItem.type !== "reasoning") {
    return;
  }

  /** @type {CodexResponseReasoningInputItem} */
  const reasoning = { type: "reasoning" };
  if (typeof outputItem.id === "string") {
    reasoning.id = outputItem.id;
  }
  if (Array.isArray(outputItem.summary)) {
    reasoning.summary = outputItem.summary;
  }
  if (typeof outputItem.encrypted_content === "string" || outputItem.encrypted_content === null) {
    reasoning.encrypted_content = outputItem.encrypted_content;
  }
  if (typeof outputItem.phase === "string" || outputItem.phase === null) {
    reasoning.phase = outputItem.phase;
  }

  return reasoning.id || reasoning.summary || reasoning.encrypted_content || reasoning.phase ? reasoning : undefined;
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue} item
 * @returns {CodexResponseFunctionCallInputItem | undefined}
 */
function codexFunctionCallInputItemFromOutputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return;
  }

  const outputItem = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (item);
  if (outputItem.type !== "function_call") {
    return;
  }

  const callId = cleanString(outputItem.call_id) ?? cleanString(outputItem.id);
  const name = cleanString(outputItem.name);
  if (!callId || !name) {
    return;
  }

  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: typeof outputItem.arguments === "string" ? outputItem.arguments : "{}"
  };
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue} item
 * @returns {CodexResponseInputMessage | undefined}
 */
function codexAssistantMessageInputItemFromOutputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return;
  }

  const outputItem = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (item);
  if (outputItem.type !== "message" || outputItem.role !== "assistant" || !Array.isArray(outputItem.content)) {
    return;
  }

  /** @type {CodexContentItem[]} */
  const content = [];
  for (const contentItem of /** @type {import("../../data/Codex.js").CodexJsonValue[]} */ (outputItem.content)) {
    if (!contentItem || typeof contentItem !== "object" || Array.isArray(contentItem)) {
      continue;
    }

    const outputContentItem = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (contentItem);
    if (outputContentItem.type !== "output_text" || typeof outputContentItem.text !== "string") {
      continue;
    }

    content.push({ type: "output_text", text: outputContentItem.text });
  }

  if (content.length === 0) {
    return;
  }

  /** @type {CodexResponseInputMessage} */
  const message = { role: "assistant", content };
  if (typeof outputItem.phase === "string" || outputItem.phase === null) {
    message.phase = outputItem.phase;
  }

  return message;
}

/**
 * @param {CodexResponseInputItem | undefined} item
 * @param {{ debugLevel: "off" | "metadata" | "events" | "payloads", logger: import("./diagnostics.js").CocopiLogger, source: string }} options
 * @returns {CodexResponseInputItem | undefined}
 */
/**
 * @param {string} text
 * @returns {CodexResponseInputMessage | undefined}
 */
function codexAssistantMessageInputItemFromText(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  return {
    role: "assistant",
    content: [{ type: "output_text", text: trimmed }]
  };
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue | undefined} value
 */
function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage["content"][number]} part
 * @param {{ debugLevel?: 'off' | 'metadata' | 'events' | 'payloads', logger?: import("./diagnostics.js").CocopiLogger }} options
 * @returns {{ modelId: string, marker: string } | undefined}
 */
function statefulMarkerFromLanguageModelPart(part, options) {
  if (!part || typeof part !== "object" || !("data" in part) || !("mimeType" in part)) {
    return;
  }

  const mimeType = typeof part.mimeType === "string" ? part.mimeType : "";
  if (mimeType !== COCOPI_STATEFUL_MARKER_MIME) {
    return;
  }

  if (!(part.data instanceof Uint8Array)) {
    logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", `reason=invalid-data mimeType=${mimeType}`);
    return;
  }

  const marker = decodeStatefulMarkerDataPart(part.data);
  if (!marker) {
    logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", `reason=invalid-payload mimeType=${mimeType} bytes=${part.data.byteLength}`);
    return;
  }

  return marker;
}

/**
 * @param {CodexResponseInputItem[]} responseItems
 * @param {string} sessionId
 * @param {{ responseId?: string, requestState?: Record<string, import("../../data/Codex.js").CodexJsonValue>, hostRequestIndex?: number }} [options]
 */
function encodeCocopiStatefulMarkerPayload(responseItems, sessionId, options = {}) {
  return `${COCOPI_STATEFUL_MARKER_PAYLOAD_PREFIX}${base64UrlEncodeUtf8(canonicalCodexJsonString({
    version: 1,
    sessionId,
    ...(options.responseId ? { responseId: options.responseId } : {}),
    ...(options.requestState ? { requestState: options.requestState } : {}),
    ...(isPositiveInteger(options.hostRequestIndex) ? { hostRequestIndex: options.hostRequestIndex } : {}),
    responseItems
  }))}`;
}

/**
 * @param {string} marker
 * @param {{ debugLevel?: 'off' | 'metadata' | 'events' | 'payloads', logger?: import("./diagnostics.js").CocopiLogger }} options
 * @returns {{ responseItems: CodexResponseInputItem[], sessionId?: string, hostRequestIndex?: number, responseId?: string, requestState?: Record<string, import("../../data/Codex.js").CodexJsonValue> } | undefined}
 */
function decodeCocopiStatefulMarkerPayload(marker, options) {
  if (!marker.startsWith(COCOPI_STATEFUL_MARKER_PAYLOAD_PREFIX)) {
    return;
  }

  try {
    const json = base64UrlDecodeUtf8(marker.slice(COCOPI_STATEFUL_MARKER_PAYLOAD_PREFIX.length));
    const value = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", "reason=invalid-state-shape");
      return;
    }

    const state = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue | undefined>} */ (value);
    if (state.version !== 1 || !Array.isArray(state.responseItems)) {
      logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", "reason=invalid-state-shape");
      return;
    }

    const sessionId = normalizeCocopiSessionId(state.sessionId);
    if (state.sessionId !== undefined && !sessionId) {
      logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", "reason=invalid-session-id");
    }
    const responseId = typeof state.responseId === "string" && state.responseId.trim()
      ? state.responseId
      : undefined;
    const requestState = isCodexContinuationRequestState(state.requestState)
      ? state.requestState
      : undefined;
    if (state.requestState !== undefined && !requestState) {
      logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", "reason=invalid-request-state");
    }
    const hostRequestIndex = isPositiveInteger(state.hostRequestIndex)
      ? state.hostRequestIndex
      : undefined;
    if (state.hostRequestIndex !== undefined && !hostRequestIndex) {
      logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", "reason=invalid-host-request-index");
    }

    const rawResponseItems = /** @type {import("../../data/Codex.js").CodexJsonValue[]} */ (state.responseItems);
    /** @type {CodexResponseInputItem[]} */
    const responseItems = [];
    for (const item of rawResponseItems) {
      const responseItem = codexMarkerResponseInputItem(item);
      if (responseItem) {
        responseItems.push(responseItem);
      }
    }
    if (responseItems.length !== rawResponseItems.length) {
      logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", `reason=invalid-response-item invalidItems=${rawResponseItems.length - responseItems.length}`);
    }

    return responseItems.length > 0 || sessionId ? {
      responseItems,
      ...(sessionId ? { sessionId } : {}),
      ...(hostRequestIndex ? { hostRequestIndex } : {}),
      ...(responseId ? { responseId } : {}),
      ...(requestState ? { requestState } : {})
    } : undefined;
  } catch (error) {
    logProviderStatefulMarkerDiagnostics(options.logger, options.debugLevel, "decode-failed", `reason=invalid-state-payload error=${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param {number | undefined} left
 * @param {number | undefined} right
 * @returns {number | undefined}
 */
function maxPositiveInteger(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Math.max(left, right);
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue | undefined} value
 * @returns {value is number}
 */
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue | undefined} value
 * @returns {value is Record<string, import("../../data/Codex.js").CodexJsonValue>}
 */
function isCodexContinuationRequestState(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue | undefined} value
 * @returns {CodexResponseInputItem | undefined}
 */
function codexMarkerResponseInputItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const item = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (value);
  if (item.type === "reasoning") {
    return codexReasoningInputItemFromOutputItem(value);
  }

  if (item.type === "function_call") {
    return codexFunctionCallInputItemFromOutputItem(value);
  }

  if (item.type === "function_call_output") {
    return codexMarkerFunctionCallOutputInputItem(item);
  }

  if (item.role === "assistant" && Array.isArray(item.content)) {
    return codexMarkerAssistantMessageInputItem(item);
  }
}

/**
 * @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} item
 * @returns {CodexResponseFunctionCallOutputInputItem | undefined}
 */
function codexMarkerFunctionCallOutputInputItem(item) {
  if (typeof item.call_id !== "string" || typeof item.output !== "string") {
    return;
  }

  return {
    type: "function_call_output",
    call_id: item.call_id,
    output: item.output
  };
}

/**
 * @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} item
 * @returns {CodexResponseInputMessage | undefined}
 */
function codexMarkerAssistantMessageInputItem(item) {
  if (!Array.isArray(item.content)) {
    return;
  }

  /** @type {CodexContentItem[]} */
  const markerContent = [];
  for (const content of item.content) {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return;
    }

    const contentItem = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (content);
    if (contentItem.type !== "output_text" || typeof contentItem.text !== "string") {
      return;
    }

    markerContent.push({ type: "output_text", text: contentItem.text });
  }

  if (markerContent.length === 0) {
    return;
  }

  /** @type {CodexResponseInputMessage} */
  const message = { role: "assistant", content: markerContent };
  if (typeof item.phase === "string" || item.phase === null) {
    message.phase = item.phase;
  }

  return message;
}

/**
 * @param {string} modelId
 * @param {string} marker
 */
function encodeStatefulMarker(modelId, marker) {
  return TEXT_ENCODER.encode(`${modelId}\\${marker}`);
}

/**
 * @param {Uint8Array} data
 */
function decodeStatefulMarkerDataPart(data) {
  const text = TEXT_DECODER.decode(data);
  const separatorIndex = text.indexOf("\\");
  if (separatorIndex === -1) {
    return;
  }

  const modelId = text.slice(0, separatorIndex);
  const marker = text.slice(separatorIndex + 1);
  if (!modelId || !marker) {
    return;
  }

  return { modelId, marker };
}

/** @param {string} text */
function base64UrlEncodeUtf8(text) {
  return base64Encode(TEXT_ENCODER.encode(text))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** @param {string} value */
function base64UrlDecodeUtf8(value) {
  if (value.length % 4 === 1) {
    throw new Error("Invalid base64url value.");
  }

  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }

  return TEXT_DECODER.decode(bytes);
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage["content"][number]} part
 * @returns {CodexResponseFunctionCallInputItem | undefined}
 */
function codexFunctionCallInputItemFromLanguageModelPart(part) {
  if (!part || typeof part !== "object" || !("callId" in part) || !("name" in part) || !("input" in part)) {
    return;
  }

  if (typeof part.callId !== "string" || typeof part.name !== "string" || !part.input || typeof part.input !== "object" || Array.isArray(part.input)) {
    return;
  }

  return {
    type: "function_call",
    call_id: part.callId,
    name: part.name,
    arguments: stableCodexJsonString(part.input)
  };
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage["content"][number]} part
 * @returns {CodexResponseFunctionCallOutputInputItem | undefined}
 */
function codexFunctionCallOutputInputItemFromLanguageModelPart(part) {
  if (!part || typeof part !== "object" || !("callId" in part) || !("content" in part) || !Array.isArray(part.content)) {
    return;
  }

  if (typeof part.callId !== "string") {
    return;
  }

  return {
    type: "function_call_output",
    call_id: part.callId,
    output: part.content.map((contentPart) => textFromLanguageModelPart(contentPart)).filter(Boolean).join("\n\n")
  };
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage["content"][number]} part
 */
function textFromLanguageModelPart(part) {
  if (!part || typeof part !== "object" || !("value" in part) || typeof part.value !== "string") {
    return "";
  }

  return part.value;
}

/**
 * @param {import("vscode").LanguageModelChatRequestMessage["content"][number]} part
 * @returns {import("../../data/Codex.js").CodexInputImageContent | undefined}
 */
function codexInputImageContentFromLanguageModelPart(part) {
  if (!part || typeof part !== "object" || !("data" in part) || !("mimeType" in part)) {
    return;
  }

  if (!(part.data instanceof Uint8Array) || typeof part.mimeType !== "string" || !part.mimeType.startsWith("image/")) {
    return;
  }

  return {
    type: "input_image",
    image_url: `data:${part.mimeType};base64,${base64Encode(part.data)}`
  };
}

/**
 * @param {CodexResponseInputItem[]} input
 * @param {'user' | 'assistant'} role
 * @param {CodexContentItem[]} content
 */
function pushMessage(input, role, content) {
  if (content.length === 0) {
    return;
  }

  input.push(/** @type {CodexResponseInputMessage} */ ({
    role,
    content
  }));
}

/** @param {Uint8Array} data */
function base64Encode(data) {
  const chunkSize = 32_768;
  if (data.length <= chunkSize) {
    return btoa(String.fromCodePoint(...data));
  }

  /** @type {string[]} */
  const chunks = [];
  for (let index = 0; index < data.length; index += chunkSize) {
    chunks.push(String.fromCodePoint(...data.subarray(index, index + chunkSize)));
  }

  return btoa(chunks.join(""));
}
