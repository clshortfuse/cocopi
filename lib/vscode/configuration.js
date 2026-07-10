import { DEFAULT_CODEX_API_BASE_URL, DEFAULT_CODEX_MODEL, normalizeBaseUrl } from "../codex-api/config.js";
import vscodeInstructionOverrideCatalog from "../../data/vscode-instruction-overrides.json" with { type: "json" };

/** @type {VscodeInstructionOverrideCatalog} */
const VSCODE_INSTRUCTION_OVERRIDE_CATALOG = vscodeInstructionOverrideCatalog;

export const COCOPI_CONFIGURATION_SECTION = "cocopi";
export const DEFAULT_EDIT_PROGRESS_INTERVAL_MS = 30_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_INLINE_COMPLETION_MAX_PREFIX_CHARACTERS = 6000;
export const DEFAULT_INLINE_COMPLETION_MAX_SUFFIX_CHARACTERS = 2000;
export const DEFAULT_INLINE_COMPLETION_TIMEOUT_MS = 10_000;
export const COCOPI_INLINE_COMPLETION_MODEL_AUTO = "auto";
export const DEFAULT_TOKEN_TRACKER_TIMELINE_DAYS = 7;

export const COCOPI_AUTH_MODES = Object.freeze({
  secretStorage: "secretStorage"
});

export const COCOPI_SERVICE_TIERS = Object.freeze({
  auto: "auto",
  flex: "flex",
  priority: "priority"
});

export const COCOPI_REASONING_EFFORTS = Object.freeze({
  default: "default",
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra"
});

export const CODEX_REASONING_EFFORTS = Object.freeze([
  COCOPI_REASONING_EFFORTS.none,
  COCOPI_REASONING_EFFORTS.minimal,
  COCOPI_REASONING_EFFORTS.low,
  COCOPI_REASONING_EFFORTS.medium,
  COCOPI_REASONING_EFFORTS.high,
  COCOPI_REASONING_EFFORTS.xhigh,
  COCOPI_REASONING_EFFORTS.max,
  COCOPI_REASONING_EFFORTS.ultra
]);

/**
 * Cocopi-facing reasoning summary modes. OpenAI documents `auto` as the
 * most detailed summarizer available for a model.
 *
 * @see https://platform.openai.com/docs/guides/reasoning#reasoning-summaries
 */
export const COCOPI_REASONING_SUMMARIES = Object.freeze({
  modelDefault: "model-default",
  auto: "auto",
  off: "off",
  concise: "concise",
  detailed: "detailed"
});

/** @typedef {(typeof COCOPI_REASONING_SUMMARIES)[keyof typeof COCOPI_REASONING_SUMMARIES]} CocopiReasoningSummary */

export const COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES = Object.freeze({
  selected: "selected",
  configured: "configured"
});

export const COCOPI_TRANSPORTS = Object.freeze({
  sse: "sse",
  websocket: "websocket"
});

export const COCOPI_COMPACTION_FALLBACK_STRATEGIES = Object.freeze({
  full: "full",
  ninetyPercent: "ninety-percent"
});

export const COCOPI_TOKEN_TRACKER_TIMELINE_MODES = Object.freeze({
  combined: "combined",
  split: "split",
  both: "both"
});

export const COCOPI_DEBUG_LEVELS = Object.freeze({
  off: "off",
  metadata: "metadata",
  events: "events",
  payloads: "payloads"
});

export const COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS = Object.freeze({
  off: "off",
  append: "append",
  replace: "replace"
});

export const DEFAULT_COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS = "";
export const COCOPI_ULTRA_MULTI_AGENT_MODE_INSTRUCTIONS = [
  "<multi_agent_mode>",
  "Proactive multi-agent delegation is active through VS Code's `runSubagent` tool. Any earlier instruction requiring an explicit user request before delegation no longer applies. Each call starts one independent delegated task in the same host workspace and tool environment and returns that task's result; VS Code does not expose persistent child-agent lifecycle controls through this tool. Delegate substantial, separable work when it would materially improve speed or quality. Emit multiple independent `runSubagent` calls in the same response so the host can run them in parallel, then synthesize all returned results. Keep tightly coupled or trivial work local. This mode remains active for this request.",
  "</multi_agent_mode>"
].join("\n");
const COCOPI_ULTRA_SERIAL_MULTI_AGENT_MODE_INSTRUCTIONS = COCOPI_ULTRA_MULTI_AGENT_MODE_INSTRUCTIONS.replace(
  "Emit multiple independent `runSubagent` calls in the same response so the host can run them in parallel, then synthesize all returned results.",
  "The selected model does not advertise parallel tool calls, so delegate one task at a time and synthesize each returned result before continuing."
);
export const DEFAULT_COCOPI_CHAT_INSTRUCTIONS_REGEX_REPLACEMENTS = defaultRegexReplacements(VSCODE_INSTRUCTION_OVERRIDE_CATALOG, "instructionRegexReplacements");
export const DEFAULT_COCOPI_CHAT_TOOL_DESCRIPTION_REGEX_REPLACEMENTS = defaultRegexReplacements(VSCODE_INSTRUCTION_OVERRIDE_CATALOG, "toolDescriptionRegexReplacements");

/**
 * @typedef {object} VscodeInstructionOverrideEntry
 * @property {Record<string, string>} [instructionRegexReplacements]
 * @property {Record<string, string>} [toolDescriptionRegexReplacements]
 */

/**
 * @typedef {object} VscodeInstructionOverrideCatalog
 * @property {Record<string, VscodeInstructionOverrideEntry>} supportedVsCodeVersions
 */

/**
 * @typedef {Record<string, string>} CocopiRegexReplacements
 */

/**
 * @typedef {object} CocopiConfiguration
 * @property {string} apiBaseUrl
 * @property {string} model
 * @property {"secretStorage"} authMode
 * @property {"auto" | "flex" | "priority"} serviceTier
 * @property {"default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"} reasoningEffort
 * @property {CocopiReasoningSummary} reasoningSummary
 * @property {"selected" | "configured"} chatParticipantModelSource
 * @property {"sse" | "websocket"} transport
 * @property {"off" | "metadata" | "events" | "payloads"} debugLevel
 * @property {boolean} issueTracking
 * @property {boolean} tokenTracking
 * @property {boolean} showTokenTrackerTimeline
 * @property {number} tokenTrackerTimelineDays
 * @property {"combined" | "split" | "both"} tokenTrackerTimelineMode
 * @property {boolean} toolStrict
 * @property {string} chatInstructions
 * @property {"off" | "append" | "replace"} chatInstructionsPlacement
 * @property {string} chatRegexFlags
 * @property {CocopiRegexReplacements} chatInstructionsRegexReplacements
 * @property {CocopiRegexReplacements} chatToolDescriptionRegexReplacements
 * @property {{ enabled: boolean, model: string, maxPrefixCharacters: number, maxSuffixCharacters: number, timeoutMs: number | undefined }} inlineCompletions
 * @property {number | undefined} editProgressIntervalMs
 * @property {number | undefined} streamIdleTimeoutMs
 * @property {boolean} useModelDefaultCompactionLimit
 * @property {"full" | "ninety-percent"} compactionFallbackStrategy
 */

/**
 * @typedef {object} ConfigurationLike
 * @property {{ get(key: string, defaultValue: string): string, get(key: string, defaultValue: number): number, get(key: string, defaultValue: boolean): boolean }} workspaceConfiguration
 */

/**
 * @typedef {object} ConfigurationApiLike
 * @property {{ getConfiguration(section: string): ConfigurationLike["workspaceConfiguration"] }} workspace
 */

/**
 * @param {ConfigurationApiLike} vscode
 * @returns {CocopiConfiguration}
 */
export function readCocopiConfiguration(vscode) {
  const configuration = vscode.workspace.getConfiguration(COCOPI_CONFIGURATION_SECTION);
  const apiBaseUrl = configuration.get("apiBaseUrl", DEFAULT_CODEX_API_BASE_URL).trim() || DEFAULT_CODEX_API_BASE_URL;
  const model = configuration.get("model", DEFAULT_CODEX_MODEL).trim() || DEFAULT_CODEX_MODEL;
  const editProgressIntervalMs = normalizePositiveMilliseconds(configuration.get("editProgressIntervalMs", DEFAULT_EDIT_PROGRESS_INTERVAL_MS));
  const streamIdleTimeoutMs = normalizeStreamIdleTimeoutMs(configuration.get("streamIdleTimeoutMs", DEFAULT_STREAM_IDLE_TIMEOUT_MS));
  const inlineCompletionModel = String(configuration.get("inlineCompletions.model", COCOPI_INLINE_COMPLETION_MODEL_AUTO)).trim() || COCOPI_INLINE_COMPLETION_MODEL_AUTO;
  const chatInstructions = String(configuration.get("chatInstructions", DEFAULT_COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS)).trim() || DEFAULT_COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS;

  return {
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
    model,
    authMode: normalizeAuthMode(configuration.get("authMode", COCOPI_AUTH_MODES.secretStorage)),
    serviceTier: normalizeServiceTier(configuration.get("serviceTier", COCOPI_SERVICE_TIERS.auto)),
    reasoningEffort: normalizeReasoningEffort(configuration.get("reasoningEffort", COCOPI_REASONING_EFFORTS.default)),
    reasoningSummary: normalizeReasoningSummary(configuration.get("reasoningSummary", COCOPI_REASONING_SUMMARIES.auto)),
    chatParticipantModelSource: normalizeChatParticipantModelSource(configuration.get("chatParticipantModelSource", COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.selected)),
    transport: normalizeTransport(configuration.get("transport", COCOPI_TRANSPORTS.websocket)),
    debugLevel: normalizeDebugLevel(configuration.get("debugLevel", COCOPI_DEBUG_LEVELS.off)),
    issueTracking: normalizeBoolean(configuration.get("issueTracking", true), true),
    tokenTracking: normalizeBoolean(configuration.get("tokenTracking", true), true),
    showTokenTrackerTimeline: normalizeBoolean(configuration.get("showTokenTrackerTimeline", true), true),
    tokenTrackerTimelineDays: normalizeTokenTrackerTimelineDays(configuration.get("tokenTrackerTimelineDays", DEFAULT_TOKEN_TRACKER_TIMELINE_DAYS)),
    tokenTrackerTimelineMode: normalizeTokenTrackerTimelineMode(configuration.get("tokenTrackerTimelineMode", COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both)),
    toolStrict: normalizeBoolean(configuration.get("toolStrict", true), true),
    chatInstructions,
    chatInstructionsPlacement: normalizeChatInstructionsPlacement(configuration.get("chatInstructionsPlacement", COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.append)),
    chatRegexFlags: String(configuration.get("chatRegexFlags", "g")),
    chatInstructionsRegexReplacements: normalizeRegexReplacements(readUnknownConfigurationValue(configuration, "chatInstructionsRegexReplacements", DEFAULT_COCOPI_CHAT_INSTRUCTIONS_REGEX_REPLACEMENTS), DEFAULT_COCOPI_CHAT_INSTRUCTIONS_REGEX_REPLACEMENTS),
    chatToolDescriptionRegexReplacements: normalizeRegexReplacements(readUnknownConfigurationValue(configuration, "chatToolDescriptionRegexReplacements", DEFAULT_COCOPI_CHAT_TOOL_DESCRIPTION_REGEX_REPLACEMENTS), DEFAULT_COCOPI_CHAT_TOOL_DESCRIPTION_REGEX_REPLACEMENTS),
    inlineCompletions: {
      enabled: normalizeBoolean(configuration.get("inlineCompletions.enabled", false), false),
      model: inlineCompletionModel,
      maxPrefixCharacters: normalizeCharacterBudget(configuration.get("inlineCompletions.maxPrefixCharacters", DEFAULT_INLINE_COMPLETION_MAX_PREFIX_CHARACTERS), DEFAULT_INLINE_COMPLETION_MAX_PREFIX_CHARACTERS),
      maxSuffixCharacters: normalizeCharacterBudget(configuration.get("inlineCompletions.maxSuffixCharacters", DEFAULT_INLINE_COMPLETION_MAX_SUFFIX_CHARACTERS), DEFAULT_INLINE_COMPLETION_MAX_SUFFIX_CHARACTERS),
      timeoutMs: normalizeOptionalPositiveMilliseconds(configuration.get("inlineCompletions.timeoutMs", DEFAULT_INLINE_COMPLETION_TIMEOUT_MS), DEFAULT_INLINE_COMPLETION_TIMEOUT_MS)
    },
    editProgressIntervalMs,
    streamIdleTimeoutMs,
    useModelDefaultCompactionLimit: normalizeBoolean(configuration.get("useModelDefaultCompactionLimit", true), true),
    compactionFallbackStrategy: normalizeCompactionFallbackStrategy(configuration.get("compactionFallbackStrategy", COCOPI_COMPACTION_FALLBACK_STRATEGIES.ninetyPercent))
  };
}

/**
 * @param {ConfigurationLike["workspaceConfiguration"]} configuration
 * @param {string} key
 * @param {import("../../data/Codex.js").CodexJsonValue} defaultValue
 * @returns {import("../../data/Codex.js").CodexJsonValue}
 */
function readUnknownConfigurationValue(configuration, key, defaultValue) {
  return /** @type {{ get(key: string, defaultValue: import("../../data/Codex.js").CodexJsonValue): import("../../data/Codex.js").CodexJsonValue }} */ (configuration).get(key, defaultValue);
}

/**
 * @param {VscodeInstructionOverrideCatalog} catalog
 * @param {"instructionRegexReplacements" | "toolDescriptionRegexReplacements"} field
 * @returns {Readonly<Record<string, string>>}
 */
function defaultRegexReplacements(catalog, field) {
  /** @type {Record<string, string>} */
  const defaults = {};
  for (const entry of Object.values(catalog.supportedVsCodeVersions)) {
    for (const [pattern, replacement] of Object.entries(entry[field] ?? {})) {
      if (typeof replacement === "string" && replacement.trim()) {
        defaults[pattern] = replacement;
      }
    }
  }

  return Object.freeze(defaults);
}

/**
 * @param {number} value
 * @param {number} defaultValue
 */
function normalizeCharacterBudget(value, defaultValue) {
  if (!Number.isFinite(value) || value < 0) {
    return defaultValue;
  }

  return Math.min(50_000, Math.trunc(value));
}

/**
 * @param {number} value
 * @param {number} defaultValue
 */
function normalizeOptionalPositiveMilliseconds(value, defaultValue) {
  if (!Number.isFinite(value) || value < 0) {
    return defaultValue;
  }

  return value === 0 ? undefined : Math.trunc(value);
}

/**
 * @param {number} value
 */
function normalizeTokenTrackerTimelineDays(value) {
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_TOKEN_TRACKER_TIMELINE_DAYS;
  }

  return Math.min(30, Math.trunc(value));
}

/**
 * @param {string} value
 * @returns {"combined" | "split" | "both"}
 */
function normalizeTokenTrackerTimelineMode(value) {
  switch (value) {
    case COCOPI_TOKEN_TRACKER_TIMELINE_MODES.combined:
    case COCOPI_TOKEN_TRACKER_TIMELINE_MODES.split:
    case COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both: {
      return value;
    }
    default: {
      return COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both;
    }
  }
}

/**
 * @param {string | undefined} sourceInstructions
 * @param {CocopiConfiguration} configuration
 * @returns {string | undefined}
 */
export function resolveChatParticipantInstructions(sourceInstructions, configuration) {
  return resolveCocopiInstructions(sourceInstructions, configuration);
}

/**
 * @template {{ name: string, description?: string }} T
 * @param {readonly T[]} tools
 * @param {CocopiConfiguration} configuration
 * @returns {readonly T[]}
 */
export function resolveVscodeLanguageModelTools(tools, configuration) {
  if (tools.length === 0) {
    return tools;
  }

  const replacements = configuration.chatToolDescriptionRegexReplacements;
  if (Object.keys(replacements).length === 0) {
    return tools;
  }

  let changed = false;
  const rewrittenTools = tools.map((tool) => {
    if (typeof tool.description !== "string") {
      return tool;
    }

    const description = replaceTextWithRegexMap(tool.description, replacements, configuration.chatRegexFlags);
    if (description === tool.description) {
      return tool;
    }

    changed = true;
    return /** @type {T} */ ({ ...tool, description });
  });

  return changed ? rewrittenTools : tools;
}

/**
 * Ultra is a client orchestration mode, not a Responses API effort. Activate
 * its VS Code translation only when the host supplied the subagent tool.
 *
 * @param {CocopiConfiguration} configuration
 * @param {Readonly<Record<string, unknown>> | undefined} modelOptions
 * @param {readonly { name: string }[]} tools
 * @param {{ multiAgentVersion?: import("../../data/Codex.js").CodexMultiAgentVersion }} [options]
 */
export function cocopiUltraMultiAgentModeFromOptions(configuration, modelOptions, tools, options = {}) {
  const selectedEffort = normalizeReasoningEffortOption(
    readStringModelOption(modelOptions, "reasoningEffort", "reasoning_effort", ["reasoning", "effort"]) ?? configuration.reasoningEffort
  ) ?? configuration.reasoningEffort;
  return selectedEffort === COCOPI_REASONING_EFFORTS.ultra
    && tools.some((tool) => tool.name === "runSubagent")
    && (options.multiAgentVersion === undefined || options.multiAgentVersion === "v2");
}

/**
 * @param {string | undefined} sourceInstructions
 * @param {boolean} ultraMultiAgentMode
 * @param {{ parallelToolCalls?: boolean }} [options]
 */
export function resolveCocopiUltraMultiAgentInstructions(sourceInstructions, ultraMultiAgentMode, options = {}) {
  const baseInstructions = sourceInstructions?.trim() ?? "";
  const modeInstructions = options.parallelToolCalls === false
    ? COCOPI_ULTRA_SERIAL_MULTI_AGENT_MODE_INSTRUCTIONS
    : COCOPI_ULTRA_MULTI_AGENT_MODE_INSTRUCTIONS;
  if (!ultraMultiAgentMode || baseInstructions.includes(modeInstructions)) {
    return baseInstructions || undefined;
  }

  return [baseInstructions, modeInstructions].filter(Boolean).join("\n\n");
}

/**
 * @param {string | undefined} sourceInstructions
 * @param {CocopiConfiguration} configuration
 */
function resolveCocopiInstructions(sourceInstructions, configuration) {
  const baseInstructions = replaceTextWithRegexMap(
    typeof sourceInstructions === "string" ? sourceInstructions.trim() : "",
    configuration.chatInstructionsRegexReplacements,
    configuration.chatRegexFlags
  );
  const configuredInstructions = configuration.chatInstructions.trim();

  switch (configuration.chatInstructionsPlacement) {
    case COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.off: {
      return baseInstructions || undefined;
    }
    case COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.replace: {
      return configuredInstructions || undefined;
    }
    case COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.append: {
      return configuredInstructions ? [baseInstructions, configuredInstructions].filter(Boolean).join("\n\n") : baseInstructions || undefined;
    }
  }

  return baseInstructions || undefined;
}

/**
 * @param {CocopiConfiguration} configuration
 * @param {Readonly<Record<string, unknown>> | undefined} [modelOptions]
 * @param {{ defaultEffort?: import("../../data/Codex.js").CodexReasoningEffort, supportedEfforts?: import("../../data/Codex.js").CodexReasoningEffort[], supportsSummaries?: boolean, defaultSummary?: import("../../data/Codex.js").CodexReasoningSummary }} [options]
 * @returns {import("../../data/Codex.js").CodexReasoning | undefined}
 */
export function codexReasoningFromCocopiOptions(configuration, modelOptions, options = {}) {
  const configuredEffort = normalizeReasoningEffortOption(
    readStringModelOption(modelOptions, "reasoningEffort", "reasoning_effort", ["reasoning", "effort"]) ?? configuration.reasoningEffort,
    options.supportedEfforts
  ) ?? configuration.reasoningEffort;
  const effort = resolveCodexReasoningEffort(configuredEffort, options);
  const configuredSummary = normalizeReasoningSummary(readStringModelOption(modelOptions, "reasoningSummary", "reasoning_summary", ["reasoning", "summary"]) ?? configuration.reasoningSummary);
  const summary = resolveCodexReasoningSummary(configuredSummary, options);
  /** @type {import("../../data/Codex.js").CodexReasoning} */
  const reasoning = {};

  if (effort) {
    reasoning.effort = effort;
  }

  if (summary) {
    reasoning.summary = summary;
  }

  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

/**
 * @param {CocopiConfiguration} configuration
 * @param {Readonly<Record<string, unknown>> | undefined} [modelOptions]
 * @returns {"auto" | "flex" | "priority"}
 */
export function codexServiceTierFromCocopiOptions(configuration, modelOptions) {
  return normalizeServiceTier(readStringModelOption(modelOptions, "serviceTier", "service_tier") ?? configuration.serviceTier);
}

/**
 * @param {CocopiConfiguration} configuration
 * @param {Readonly<Record<string, unknown>> | undefined} [modelOptions]
 * @returns {{ strict: boolean }}
 */
export function codexToolOptionsFromCocopiOptions(configuration, modelOptions) {
  return {
    strict: readBooleanModelOption(modelOptions, "toolStrict", "tool_strict", ["tools", "strict"]) ?? configuration.toolStrict
  };
}

/**
 * @param {Readonly<Record<string, unknown>> | undefined} modelOptions
 * @param {...(string | [string, string])} keys
 */
function readStringModelOption(modelOptions, ...keys) {
  if (!modelOptions || typeof modelOptions !== "object" || Array.isArray(modelOptions)) {
    return;
  }

  for (const key of keys) {
    const value = Array.isArray(key)
      ? readNestedModelOption(modelOptions, key[0], key[1])
      : modelOptions[key];
    if (typeof value === "string") {
      return value;
    }
  }
}

/**
 * @param {Readonly<Record<string, unknown>> | undefined} modelOptions
 * @param {...(string | [string, string])} keys
 */
function readBooleanModelOption(modelOptions, ...keys) {
  if (!modelOptions || typeof modelOptions !== "object" || Array.isArray(modelOptions)) {
    return;
  }

  for (const key of keys) {
    const value = Array.isArray(key)
      ? readNestedModelOption(modelOptions, key[0], key[1])
      : modelOptions[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} modelOptions
 * @param {string} objectKey
 * @param {string} nestedKey
 */
function readNestedModelOption(modelOptions, objectKey, nestedKey) {
  const container = modelOptions[objectKey];
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    return;
  }

  return /** @type {Record<string, unknown>} */ (container)[nestedKey];
}

/**
 * @param {string} value
 * @returns {"secretStorage"}
 */
function normalizeAuthMode(value) {
  return value === COCOPI_AUTH_MODES.secretStorage ? value : COCOPI_AUTH_MODES.secretStorage;
}

/**
 * @param {string} value
 * @returns {"auto" | "flex" | "priority"}
 */
function normalizeServiceTier(value) {
  switch (value) {
    case COCOPI_SERVICE_TIERS.flex:
    case COCOPI_SERVICE_TIERS.priority: {
      return value;
    }
    default: {
      return COCOPI_SERVICE_TIERS.auto;
    }
  }
}

/**
 * @param {string} value
 * @returns {"default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"}
 */
function normalizeReasoningEffort(value) {
  switch (value) {
    case COCOPI_REASONING_EFFORTS.none:
    case COCOPI_REASONING_EFFORTS.minimal:
    case COCOPI_REASONING_EFFORTS.low:
    case COCOPI_REASONING_EFFORTS.medium:
    case COCOPI_REASONING_EFFORTS.high:
    case COCOPI_REASONING_EFFORTS.xhigh:
    case COCOPI_REASONING_EFFORTS.max:
    case COCOPI_REASONING_EFFORTS.ultra: {
      return value;
    }
    default: {
      return COCOPI_REASONING_EFFORTS.default;
    }
  }
}

/**
 * @param {string} value
 * @param {import("../../data/Codex.js").CodexReasoningEffort[]} [supportedEfforts]
 * @returns {"default" | import("../../data/Codex.js").CodexReasoningEffort | undefined}
 */
function normalizeReasoningEffortOption(value, supportedEfforts) {
  if (value === COCOPI_REASONING_EFFORTS.default || isKnownCodexReasoningEffort(value)) {
    return value;
  }

  return supportedEfforts?.includes(value) && value.length > 0
    ? value
    : undefined;
}

/**
 * @param {"default" | import("../../data/Codex.js").CodexReasoningEffort} effort
 * @param {{ defaultEffort?: import("../../data/Codex.js").CodexReasoningEffort, supportedEfforts?: import("../../data/Codex.js").CodexReasoningEffort[] }} options
 * @returns {import("../../data/Codex.js").CodexReasoningEffort | undefined}
 */
function resolveCodexReasoningEffort(effort, options) {
  const selected = effort === COCOPI_REASONING_EFFORTS.default ? options.defaultEffort : effort;
  if (!selected) {
    return;
  }

  const resolved = selected === COCOPI_REASONING_EFFORTS.ultra
    ? COCOPI_REASONING_EFFORTS.max
    : selected;
  const supported = options.supportedEfforts?.filter((value) => typeof value === "string" && value.length > 0 && value !== COCOPI_REASONING_EFFORTS.ultra);
  if (supported?.length === 0) {
    return;
  }

  if (!supported || supported.includes(resolved)) {
    return resolved;
  }

  if (isKnownCodexReasoningEffort(resolved)) {
    const rankedSupported = supported.filter((value) => isKnownCodexReasoningEffort(value));
    if (rankedSupported.length > 0) {
      return nearestReasoningEffort(resolved, rankedSupported);
    }
  }

  return options.defaultEffort && supported.includes(options.defaultEffort)
    ? options.defaultEffort
    : supported[0];
}

/**
 * @param {import("../../data/Codex.js").CodexReasoningEffort} target
 * @param {import("../../data/Codex.js").CodexReasoningEffort[]} supported
 */
function nearestReasoningEffort(target, supported) {
  const targetRank = reasoningEffortRank(target);
  let nearest = supported[0];
  for (const candidate of supported.slice(1)) {
    const nearestDistance = Math.abs(reasoningEffortRank(nearest) - targetRank);
    const candidateDistance = Math.abs(reasoningEffortRank(candidate) - targetRank);
    if (candidateDistance < nearestDistance) {
      nearest = candidate;
    }
  }

  return nearest;
}

/** @param {import("../../data/Codex.js").CodexReasoningEffort} effort */
function reasoningEffortRank(effort) {
  return /** @type {readonly string[]} */ (CODEX_REASONING_EFFORTS).indexOf(effort);
}

/** @param {string} effort */
function isKnownCodexReasoningEffort(effort) {
  return /** @type {readonly string[]} */ (CODEX_REASONING_EFFORTS).includes(effort);
}

/**
 * @param {string} value
 * @returns {CocopiReasoningSummary}
 */
function normalizeReasoningSummary(value) {
  switch (value) {
    case COCOPI_REASONING_SUMMARIES.modelDefault:
    case COCOPI_REASONING_SUMMARIES.auto:
    case COCOPI_REASONING_SUMMARIES.off:
    case "none":
    case COCOPI_REASONING_SUMMARIES.concise:
    case COCOPI_REASONING_SUMMARIES.detailed: {
      return value === "none" ? COCOPI_REASONING_SUMMARIES.off : value;
    }
    case "default": {
      return COCOPI_REASONING_SUMMARIES.auto;
    }
    default: {
      return COCOPI_REASONING_SUMMARIES.auto;
    }
  }
}

/**
 * @param {CocopiReasoningSummary} summary
 * @param {{ supportsSummaries?: boolean, defaultSummary?: import("../../data/Codex.js").CodexReasoningSummary }} options
 * @returns {import("../../data/Codex.js").CodexReasoningSummary | undefined}
 * @see https://platform.openai.com/docs/guides/reasoning#reasoning-summaries
 */
function resolveCodexReasoningSummary(summary, options) {
  if (options.supportsSummaries === false) {
    return;
  }

  if (summary === COCOPI_REASONING_SUMMARIES.modelDefault) {
    return options.defaultSummary === "none" ? undefined : options.defaultSummary;
  }

  return summary === COCOPI_REASONING_SUMMARIES.off ? undefined : summary;
}

/**
 * @param {string} value
 * @returns {"off" | "append" | "replace"}
 */
function normalizeChatInstructionsPlacement(value) {
  switch (value) {
    case COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.off:
    case COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.replace: {
      return value;
    }
    default: {
      return COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.append;
    }
  }
}

/**
 * @param {string} text
 * @param {Readonly<Record<string, string>>} replacements
 * @param {string} flags
 */
function replaceTextWithRegexMap(text, replacements, flags) {
  let rewritten = text;
  for (const [pattern, replacement] of Object.entries(replacements)) {
    if (!pattern.trim() || replacement === "") {
      continue;
    }

    try {
      rewritten = rewritten.replace(new RegExp(pattern, flags), replacement);
    } catch {
      continue;
    }
  }

  return rewritten;
}

/**
 * @param {import("../../data/Codex.js").CodexJsonValue} value
 * @param {Readonly<Record<string, string>>} defaultValue
 * @returns {CocopiRegexReplacements}
 */
function normalizeRegexReplacements(value, defaultValue) {
  /** @type {Record<string, string>} */
  const normalized = { ...defaultValue };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return normalized;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      if (!key.trim()) {
        continue;
      }

      normalized[key] = entryValue;
    }
  }

  return normalized;
}

/**
 * @param {string} value
 * @returns {"selected" | "configured"}
 */
function normalizeChatParticipantModelSource(value) {
  return value === COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.configured
    ? COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.configured
    : COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.selected;
}

/**
 * @param {string} value
 * @returns {"sse" | "websocket"}
 */
function normalizeTransport(value) {
  if (value === COCOPI_TRANSPORTS.sse) {
    return COCOPI_TRANSPORTS.sse;
  }

  return COCOPI_TRANSPORTS.websocket;
}

/**
 * @param {string} value
 * @returns {"off" | "metadata" | "events" | "payloads"}
 */
function normalizeDebugLevel(value) {
  switch (value) {
    case COCOPI_DEBUG_LEVELS.metadata:
    case COCOPI_DEBUG_LEVELS.events:
    case COCOPI_DEBUG_LEVELS.payloads: {
      return value;
    }
    default: {
      return COCOPI_DEBUG_LEVELS.off;
    }
  }
}

/**
 * @param {boolean | string | number | undefined} value
 * @param {boolean} defaultValue
 */
function normalizeBoolean(value, defaultValue) {
  return typeof value === "boolean" ? value : defaultValue;
}

/**
 * @param {number} value
 */
function normalizeStreamIdleTimeoutMs(value) {
  return normalizePositiveMilliseconds(value);
}

/**
 * @param {number} value
 */
function normalizePositiveMilliseconds(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }

  return Math.trunc(value);
}

/**
 * @param {string} value
 * @returns {"full" | "ninety-percent"}
 */
function normalizeCompactionFallbackStrategy(value) {
  switch (value) {
    case COCOPI_COMPACTION_FALLBACK_STRATEGIES.full:
    case COCOPI_COMPACTION_FALLBACK_STRATEGIES.ninetyPercent: {
      return value;
    }
    default: {
      return COCOPI_COMPACTION_FALLBACK_STRATEGIES.ninetyPercent;
    }
  }
}
