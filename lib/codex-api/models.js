import { CODEX_CLIENT_VERSION, DEFAULT_CODEX_MODEL } from "./config.js";
import { codexAuthHeaders } from "./codex-headers.js";
import { fetchWithRetries, readJsonResponse } from "../utils/http.js";

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */
/** @typedef {import("../../data/Codex.js").CodexModelInfo} CodexModelInfo */
/** @typedef {import("../../data/Codex.js").CodexModelsResponse} CodexModelsResponse */
/** @typedef {import("../../data/Codex.js").CodexModelSummary} CodexModelSummary */
/** @typedef {import("../../data/Codex.js").CodexReasoningEffort} CodexReasoningEffort */

const CODEX_REASONING_SUMMARIES = new Set(["auto", "concise", "detailed", "none"]);
const CODEX_MULTI_AGENT_VERSIONS = new Set(["disabled", "v1", "v2"]);
const CODEX_TOOL_MODES = new Set(["direct", "code_mode", "code_mode_only"]);

/**
 * @param {{ apiBaseUrl: string, accessToken: string, chatgptAccountId?: string, clientVersion?: string, fetch?: typeof fetch }} options
 * @returns {Promise<CodexModelSummary[]>}
 */
export async function listCodexModels(options) {
  const response = await fetchCodexModelsResponse(options);
  return response.models;
}

/**
 * @param {{ apiBaseUrl: string, accessToken: string, chatgptAccountId?: string, clientVersion?: string, fetch?: typeof fetch }} options
 * @returns {Promise<{ models: CodexModelSummary[], debug: { url: string, status: number, etag: string | undefined, modelIds: string[] } }>}
 */
export async function fetchCodexModelsResponse(options) {
  const url = new URL(`${options.apiBaseUrl}/models`);
  url.searchParams.set("client_version", options.clientVersion ?? CODEX_CLIENT_VERSION);
  const response = await fetchWithRetries(url, {
    method: "GET",
    headers: codexAuthHeaders({ accessToken: options.accessToken, chatgptAccountId: options.chatgptAccountId })
  }, {
    fetch: options.fetch
  });

  const models = parseModelsResponse(await readJsonResponse(response, "Codex models request"));
  return {
    models,
    debug: {
      url: url.toString(),
      status: response.status,
      etag: response.headers?.get?.("etag") ?? undefined,
      modelIds: models.map((model) => model.id)
    }
  };
}

/**
 * @param {CodexModelsResponse | Record<string, CodexJsonValue>} body
 * @returns {CodexModelSummary[]}
 */
export function parseModelsResponse(body) {
  const rawModels = readModelArray(body);
  return rawModels.map((model) => {
    const record = /** @type {Record<string, CodexJsonValue>} */ (model);
    const id = readModelId(record);
    const displayName = typeof record.display_name === "string" ? record.display_name : id;
    /** @type {CodexModelSummary} */
    const summary = { id, displayName };
    if (typeof record.description === "string") summary.description = record.description;
    if (typeof record.supported_in_api === "boolean") summary.supportedInApi = record.supported_in_api;
    const priority = readPositiveInteger(record.priority);
    if (priority !== undefined) summary.priority = priority;
    const contextWindow = readPositiveInteger(record.context_window);
    if (contextWindow !== undefined) summary.contextWindow = contextWindow;
    const maxContextWindow = readPositiveInteger(record.max_context_window);
    if (maxContextWindow !== undefined) summary.maxContextWindow = maxContextWindow;
    if (record.auto_compact_token_limit === null) {
      summary.autoCompactTokenLimit = null;
    } else {
      const autoCompactTokenLimit = readPositiveInteger(record.auto_compact_token_limit);
      if (autoCompactTokenLimit !== undefined) summary.autoCompactTokenLimit = autoCompactTokenLimit;
    }

    const additionalSpeedTiers = readStringArray(record.additional_speed_tiers);
    if (additionalSpeedTiers) summary.additionalSpeedTiers = additionalSpeedTiers;
    const serviceTiers = readModelServiceTiers(record.service_tiers);
    if (serviceTiers) summary.serviceTiers = serviceTiers;
    const defaultServiceTier = readNonEmptyString(record.default_service_tier);
    if (defaultServiceTier) summary.defaultServiceTier = defaultServiceTier;
    const defaultReasoningLevel = readReasoningEffort(record.default_reasoning_level ?? record.defaultReasoningEffort);
    if (defaultReasoningLevel) summary.defaultReasoningLevel = defaultReasoningLevel;
    const supportedReasoningLevels = readReasoningEffortPresets(record.supported_reasoning_levels ?? record.supportedReasoningEfforts);
    if (supportedReasoningLevels !== undefined) summary.supportedReasoningLevels = supportedReasoningLevels;
    if (typeof record.supports_reasoning_summaries === "boolean") summary.supportsReasoningSummaries = record.supports_reasoning_summaries;
    const defaultReasoningSummary = readReasoningSummary(record.default_reasoning_summary);
    if (defaultReasoningSummary) summary.defaultReasoningSummary = defaultReasoningSummary;
    const multiAgentVersion = readCatalogSelector(record.multi_agent_version, CODEX_MULTI_AGENT_VERSIONS);
    if (multiAgentVersion) summary.multiAgentVersion = /** @type {import("../../data/Codex.js").CodexMultiAgentVersion} */ (multiAgentVersion);
    const toolMode = readCatalogSelector(record.tool_mode, CODEX_TOOL_MODES);
    if (toolMode) summary.toolMode = /** @type {import("../../data/Codex.js").CodexToolMode} */ (toolMode);
    if (typeof record.supports_parallel_tool_calls === "boolean") summary.supportsParallelToolCalls = record.supports_parallel_tool_calls;
    const availableInPlans = readStringArray(record.available_in_plans);
    if (availableInPlans) summary.availableInPlans = availableInPlans;
    const imageInput = readModelImageInput(record);
    if (imageInput !== undefined) summary.imageInput = imageInput;
    return summary;
  });
}

/**
 * @param {CodexModelSummary[]} models
 * @param {string} [preferredModel]
 */
export function chooseCodexModel(models, preferredModel = DEFAULT_CODEX_MODEL) {
  if (models.some((model) => model.id === preferredModel)) {
    return preferredModel;
  }

  const codexModel = models.find((model) => /codex/u.test(model.id));
  return codexModel?.id ?? models[0]?.id ?? preferredModel;
}

/**
 * @param {CodexModelsResponse | Record<string, CodexJsonValue>} body
 */
function readModelArray(body) {
  if (!body || typeof body !== "object") {
    throw new Error("invalid Codex models response");
  }

  const record = /** @type {Record<string, CodexJsonValue | CodexModelInfo[] | undefined>} */ (body);
  if (Array.isArray(record.models)) {
    return record.models;
  }

  if (Array.isArray(record.data)) {
    return record.data;
  }

  throw new Error("Codex models response did not include models");
}

/**
 * @param {Record<string, CodexJsonValue>} model
 */
function readModelId(model) {
  if (typeof model.slug === "string" && model.slug) {
    return model.slug;
  }

  if (typeof model.id === "string" && model.id) {
    return model.id;
  }

  throw new Error("Codex model entry did not include an id");
}

/**
 * @param {CodexJsonValue} value
 */
function readPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * @param {CodexJsonValue} value
 */
function readStringArray(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return;
  }

  return value;
}

/**
 * @param {CodexJsonValue} value
 */
function readModelServiceTiers(value) {
  if (!Array.isArray(value)) {
    return;
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = /** @type {Record<string, CodexJsonValue>} */ (item);
    const id = readNonEmptyString(record.id);
    if (!id) {
      return [];
    }

    return [{
      id,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {})
    }];
  });
}

/** @param {CodexJsonValue} value */
function readNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * @param {CodexJsonValue} value
 * @returns {CodexReasoningEffort | undefined}
 */
function readReasoningEffort(value) {
  return /** @type {CodexReasoningEffort | undefined} */ (readNonEmptyString(value));
}

/**
 * @param {CodexJsonValue} value
 */
function readReasoningSummary(value) {
  if (typeof value !== "string") {
    return;
  }

  return CODEX_REASONING_SUMMARIES.has(value)
    ? /** @type {"auto" | "concise" | "detailed" | "none"} */ (value)
    : undefined;
}

/**
 * Catalog selectors are closed upstream enums. Unknown strings are omitted so
 * missing metadata remains distinguishable from an explicit disabled value.
 *
 * @param {CodexJsonValue} value
 * @param {Set<string>} recognized
 */
function readCatalogSelector(value, recognized) {
  return typeof value === "string" && recognized.has(value) ? value : undefined;
}

/**
 * @param {CodexJsonValue} value
 */
function readReasoningEffortPresets(value) {
  if (!Array.isArray(value)) {
    return;
  }

  const presets = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = /** @type {Record<string, CodexJsonValue>} */ (item);
    const effort = readReasoningEffort(record.effort ?? record.reasoningEffort);
    return effort ? [{ effort, ...(typeof record.description === "string" ? { description: record.description } : {}) }] : [];
  });

  return presets;
}

/**
 * @param {Record<string, CodexJsonValue>} model
 */
function readModelImageInput(model) {
  for (const key of ["supports_images", "supports_image_input", "supports_vision"]) {
    const value = model[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  const topLevelModalities = readImageInputFromModalities(model.input_modalities ?? model.inputModalities ?? model.modalities);
  if (topLevelModalities !== undefined) {
    return topLevelModalities;
  }

  const capabilities = model.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return;
  }

  const record = /** @type {Record<string, CodexJsonValue>} */ (capabilities);
  for (const key of ["image_input", "images", "vision", "supports_images", "supports_image_input", "supports_vision"]) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return readImageInputFromModalities(record.input_modalities ?? record.inputModalities ?? record.modalities);
}

/** @param {CodexJsonValue} value */
function readImageInputFromModalities(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return;
  }

  return value.some((item) => /image|vision/u.test(item));
}
