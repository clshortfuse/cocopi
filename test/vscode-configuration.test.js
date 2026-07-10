import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CODEX_API_BASE_URL, DEFAULT_CODEX_MODEL } from "../lib/codex-api/config.js";
import { COCOPI_AUTH_MODES, COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS, COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES, COCOPI_COMPACTION_FALLBACK_STRATEGIES, COCOPI_DEBUG_LEVELS, COCOPI_INLINE_COMPLETION_MODEL_AUTO, COCOPI_REASONING_EFFORTS, COCOPI_REASONING_SUMMARIES, COCOPI_SERVICE_TIERS, COCOPI_TOKEN_TRACKER_TIMELINE_MODES, COCOPI_TRANSPORTS, COCOPI_ULTRA_MULTI_AGENT_MODE_INSTRUCTIONS, DEFAULT_COCOPI_CHAT_INSTRUCTIONS_REGEX_REPLACEMENTS, DEFAULT_COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS, DEFAULT_COCOPI_CHAT_TOOL_DESCRIPTION_REGEX_REPLACEMENTS, DEFAULT_EDIT_PROGRESS_INTERVAL_MS, DEFAULT_INLINE_COMPLETION_MAX_PREFIX_CHARACTERS, DEFAULT_INLINE_COMPLETION_MAX_SUFFIX_CHARACTERS, DEFAULT_INLINE_COMPLETION_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_TOKEN_TRACKER_TIMELINE_DAYS, codexReasoningFromCocopiOptions, codexServiceTierFromCocopiOptions, codexToolOptionsFromCocopiOptions, cocopiUltraMultiAgentModeFromOptions, readCocopiConfiguration, resolveChatParticipantInstructions, resolveCocopiUltraMultiAgentInstructions } from "../lib/vscode/configuration.js";

test("readCocopiConfiguration reads defaults", () => {
  assert.deepEqual(readCocopiConfiguration(fakeVscodeConfiguration()), {
    apiBaseUrl: DEFAULT_CODEX_API_BASE_URL,
    model: DEFAULT_CODEX_MODEL,
    authMode: COCOPI_AUTH_MODES.secretStorage,
    serviceTier: COCOPI_SERVICE_TIERS.auto,
    reasoningEffort: COCOPI_REASONING_EFFORTS.default,
    reasoningSummary: COCOPI_REASONING_SUMMARIES.auto,
    chatParticipantModelSource: COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.selected,
    transport: COCOPI_TRANSPORTS.websocket,
    debugLevel: COCOPI_DEBUG_LEVELS.off,
    issueTracking: true,
    tokenTracking: true,
    showTokenTrackerTimeline: true,
    tokenTrackerTimelineDays: DEFAULT_TOKEN_TRACKER_TIMELINE_DAYS,
    tokenTrackerTimelineMode: COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both,
    toolStrict: true,
    editProgressIntervalMs: DEFAULT_EDIT_PROGRESS_INTERVAL_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    chatInstructions: DEFAULT_COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS,
    chatInstructionsPlacement: COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.append,
    chatRegexFlags: "g",
    chatInstructionsRegexReplacements: DEFAULT_COCOPI_CHAT_INSTRUCTIONS_REGEX_REPLACEMENTS,
    chatToolDescriptionRegexReplacements: DEFAULT_COCOPI_CHAT_TOOL_DESCRIPTION_REGEX_REPLACEMENTS,
    inlineCompletions: {
      enabled: false,
      model: COCOPI_INLINE_COMPLETION_MODEL_AUTO,
      maxPrefixCharacters: DEFAULT_INLINE_COMPLETION_MAX_PREFIX_CHARACTERS,
      maxSuffixCharacters: DEFAULT_INLINE_COMPLETION_MAX_SUFFIX_CHARACTERS,
      timeoutMs: DEFAULT_INLINE_COMPLETION_TIMEOUT_MS
    },
    useModelDefaultCompactionLimit: true,
    compactionFallbackStrategy: COCOPI_COMPACTION_FALLBACK_STRATEGIES.ninetyPercent
  });
});

test("readCocopiConfiguration normalizes configured values", () => {
  const values = configurationValues({
    apiBaseUrl: "https://example.test/codex///",
    model: "model-test",
    serviceTier: "priority",
    reasoningEffort: "xhigh",
    reasoningSummary: "detailed",
    chatParticipantModelSource: "configured",
    transport: "websocket",
    debugLevel: "payloads",
    issueTracking: false,
    tokenTracking: false,
    showTokenTrackerTimeline: false,
    tokenTrackerTimelineDays: 14,
    tokenTrackerTimelineMode: "split",
    toolStrict: false,
    editProgressIntervalMs: 2345.67,
    streamIdleTimeoutMs: 1234.56,
    chatInstructions: "Use a pirate accent and concise responses.",
    chatInstructionsPlacement: "replace",
    chatRegexFlags: "gi",
    chatInstructionsRegexReplacements: {
      "": "ignored",
      "summary": "final answer",
      " tool metadata": "leading-space pattern",
      "tool metadata": "host metadata"
    },
    chatToolDescriptionRegexReplacements: {
      "Do not restate": "Emit visible summary first"
    },
    "inlineCompletions.enabled": true,
    "inlineCompletions.model": "gpt-5-spark",
    "inlineCompletions.maxPrefixCharacters": 1234.56,
    "inlineCompletions.maxSuffixCharacters": 2345.67,
    "inlineCompletions.timeoutMs": 3456.78,
    useModelDefaultCompactionLimit: false,
    compactionFallbackStrategy: "full"
  });

  assert.deepEqual(readCocopiConfiguration(fakeVscodeConfiguration(values)), {
    apiBaseUrl: "https://example.test/codex",
    model: "model-test",
    authMode: COCOPI_AUTH_MODES.secretStorage,
    serviceTier: COCOPI_SERVICE_TIERS.priority,
    reasoningEffort: COCOPI_REASONING_EFFORTS.xhigh,
    reasoningSummary: COCOPI_REASONING_SUMMARIES.detailed,
    chatParticipantModelSource: COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.configured,
    transport: COCOPI_TRANSPORTS.websocket,
    debugLevel: COCOPI_DEBUG_LEVELS.payloads,
    issueTracking: false,
    tokenTracking: false,
    showTokenTrackerTimeline: false,
    tokenTrackerTimelineDays: 14,
    tokenTrackerTimelineMode: COCOPI_TOKEN_TRACKER_TIMELINE_MODES.split,
    toolStrict: false,
    editProgressIntervalMs: 2345,
    streamIdleTimeoutMs: 1234,
    chatInstructions: "Use a pirate accent and concise responses.",
    chatInstructionsPlacement: COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.replace,
    chatRegexFlags: "gi",
    chatInstructionsRegexReplacements: {
      ...DEFAULT_COCOPI_CHAT_INSTRUCTIONS_REGEX_REPLACEMENTS,
      "summary": "final answer",
      " tool metadata": "leading-space pattern",
      "tool metadata": "host metadata"
    },
    chatToolDescriptionRegexReplacements: {
      ...DEFAULT_COCOPI_CHAT_TOOL_DESCRIPTION_REGEX_REPLACEMENTS,
      "Do not restate": "Emit visible summary first"
    },
    inlineCompletions: {
      enabled: true,
      model: "gpt-5-spark",
      maxPrefixCharacters: 1234,
      maxSuffixCharacters: 2345,
      timeoutMs: 3456
    },
    useModelDefaultCompactionLimit: false,
    compactionFallbackStrategy: COCOPI_COMPACTION_FALLBACK_STRATEGIES.full
  });
});

test("readCocopiConfiguration falls back from blank and disabled values", () => {
  const values = configurationValues({
    apiBaseUrl: "",
    model: "",
    authMode: "unsupported",
    serviceTier: "unsupported",
    reasoningEffort: "unsupported",
    reasoningSummary: "unsupported",
    chatParticipantModelSource: "unsupported",
    transport: "unsupported",
    debugLevel: "unsupported",
    chatInstructionsPlacement: "unsupported",
    tokenTrackerTimelineDays: 0,
    tokenTrackerTimelineMode: "unsupported",
    editProgressIntervalMs: 0,
    streamIdleTimeoutMs: 0,
    "inlineCompletions.enabled": "unsupported",
    "inlineCompletions.model": "   ",
    "inlineCompletions.maxPrefixCharacters": -1,
    "inlineCompletions.maxSuffixCharacters": -1,
    "inlineCompletions.timeoutMs": 0,
    useModelDefaultCompactionLimit: "unsupported",
    compactionFallbackStrategy: "unsupported"
  });

  assert.deepEqual(readCocopiConfiguration(fakeVscodeConfiguration(values)), {
    apiBaseUrl: DEFAULT_CODEX_API_BASE_URL,
    model: DEFAULT_CODEX_MODEL,
    authMode: COCOPI_AUTH_MODES.secretStorage,
    serviceTier: COCOPI_SERVICE_TIERS.auto,
    reasoningEffort: COCOPI_REASONING_EFFORTS.default,
    reasoningSummary: COCOPI_REASONING_SUMMARIES.auto,
    chatParticipantModelSource: COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.selected,
    transport: COCOPI_TRANSPORTS.websocket,
    debugLevel: COCOPI_DEBUG_LEVELS.off,
    issueTracking: true,
    tokenTracking: true,
    showTokenTrackerTimeline: true,
    tokenTrackerTimelineDays: DEFAULT_TOKEN_TRACKER_TIMELINE_DAYS,
    tokenTrackerTimelineMode: COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both,
    toolStrict: true,
    editProgressIntervalMs: undefined,
    streamIdleTimeoutMs: undefined,
    chatInstructions: DEFAULT_COCOPI_CHAT_PARTICIPANT_INSTRUCTIONS,
    chatInstructionsPlacement: COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.append,
    chatRegexFlags: "g",
    chatInstructionsRegexReplacements: DEFAULT_COCOPI_CHAT_INSTRUCTIONS_REGEX_REPLACEMENTS,
    chatToolDescriptionRegexReplacements: DEFAULT_COCOPI_CHAT_TOOL_DESCRIPTION_REGEX_REPLACEMENTS,
    inlineCompletions: {
      enabled: false,
      model: COCOPI_INLINE_COMPLETION_MODEL_AUTO,
      maxPrefixCharacters: DEFAULT_INLINE_COMPLETION_MAX_PREFIX_CHARACTERS,
      maxSuffixCharacters: DEFAULT_INLINE_COMPLETION_MAX_SUFFIX_CHARACTERS,
      timeoutMs: undefined
    },
    useModelDefaultCompactionLimit: true,
    compactionFallbackStrategy: COCOPI_COMPACTION_FALLBACK_STRATEGIES.ninetyPercent
  });
});

test("codexReasoningFromCocopiOptions defaults to auto summary", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration())), { summary: "auto" });
});

test("codexReasoningFromCocopiOptions uses catalog default reasoning effort", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), undefined, {
    defaultEffort: "xhigh",
    supportedEfforts: ["medium", "xhigh"],
    defaultSummary: "auto"
  }), { effort: "xhigh", summary: "auto" });
});

test("codexReasoningFromCocopiOptions defaults to auto over catalog default reasoning summary", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), undefined, {
    defaultEffort: "high",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultSummary: "detailed"
  }), { effort: "high", summary: "auto" });
});

test("codexReasoningFromCocopiOptions defaults to auto over none catalog default summary", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), undefined, {
    defaultEffort: "high",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultSummary: "none"
  }), { effort: "high", summary: "auto" });
});

test("codexReasoningFromCocopiOptions uses auto summary when catalog default is none", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), undefined, {
    defaultEffort: "high",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    supportsSummaries: true,
    defaultSummary: "none"
  }), { effort: "high", summary: "auto" });
});

test("codexReasoningFromCocopiOptions keeps auto summary over catalog default", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), undefined, {
    defaultEffort: "high",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    supportsSummaries: true,
    defaultSummary: "auto"
  }), { effort: "high", summary: "auto" });
});

test("codexReasoningFromCocopiOptions maps configured model default summary", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    reasoningSummary: "model-default"
  })));

  assert.deepEqual(codexReasoningFromCocopiOptions(configuration, undefined, {
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
    supportsSummaries: true,
    defaultSummary: "concise"
  }), { effort: "medium", summary: "concise" });
});

test("codexReasoningFromCocopiOptions omits model default summary when catalog default is none", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    reasoningSummary: "model-default"
  })));

  assert.deepEqual(codexReasoningFromCocopiOptions(configuration, undefined, {
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
    supportsSummaries: true,
    defaultSummary: "none"
  }), { effort: "medium" });
});

test("codexReasoningFromCocopiOptions omits summaries for models that do not support them", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), undefined, {
    defaultEffort: "xhigh",
    supportedEfforts: ["medium", "xhigh"],
    supportsSummaries: false
  }), { effort: "xhigh" });
});

test("codexReasoningFromCocopiOptions can request summaries without supported efforts", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), undefined, {
    defaultEffort: "xhigh",
    supportedEfforts: []
  }), { summary: "auto" });
});

test("codexReasoningFromCocopiOptions maps unsupported selected effort to nearest catalog effort", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), {
    reasoningEffort: "high"
  }, {
    defaultEffort: "low",
    supportedEfforts: ["low", "medium"]
  }), { effort: "medium", summary: "auto" });
});

test("codexReasoningFromCocopiOptions maps catalog-advertised ultra to max on the wire", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), {
    reasoningEffort: "ultra"
  }, {
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
  }), { effort: "max", summary: "auto" });
});

test("codexReasoningFromCocopiOptions maps ultra to max without catalog metadata", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), {
    reasoningEffort: "ultra"
  }), { effort: "max", summary: "auto" });
});

test("codexReasoningFromCocopiOptions maps max and ultra to a model-supported xhigh effort", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration());
  const options = {
    defaultEffort: /** @type {import("../data/Codex.js").CodexReasoningEffort} */ ("medium"),
    supportedEfforts: ["low", "medium", "high", "xhigh"]
  };

  assert.deepEqual(codexReasoningFromCocopiOptions(configuration, { reasoningEffort: "max" }, options), { effort: "xhigh", summary: "auto" });
  assert.deepEqual(codexReasoningFromCocopiOptions(configuration, { reasoningEffort: "ultra" }, options), { effort: "xhigh", summary: "auto" });
});

test("codexReasoningFromCocopiOptions preserves a catalog-supported custom effort", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), {
    reasoningEffort: "future"
  }, {
    defaultEffort: "medium",
    supportedEfforts: ["medium", "future"]
  }), { effort: "future", summary: "auto" });
});

test("Cocopi Ultra mode requires the VS Code runSubagent tool", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration());
  const modelOptions = { reasoningEffort: "ultra" };

  assert.equal(cocopiUltraMultiAgentModeFromOptions(configuration, modelOptions, [{ name: "runSubagent" }]), true);
  assert.equal(cocopiUltraMultiAgentModeFromOptions(configuration, modelOptions, [{ name: "runSubagent" }], { multiAgentVersion: "v2" }), true);
  assert.equal(cocopiUltraMultiAgentModeFromOptions(configuration, modelOptions, [{ name: "runSubagent" }], { multiAgentVersion: "v1" }), false);
  assert.equal(cocopiUltraMultiAgentModeFromOptions(configuration, modelOptions, [{ name: "runSubagent" }], { multiAgentVersion: "disabled" }), false);
  assert.equal(cocopiUltraMultiAgentModeFromOptions(configuration, modelOptions, [{ name: "read_file" }]), false);
  assert.equal(cocopiUltraMultiAgentModeFromOptions(configuration, { reasoningEffort: "max" }, [{ name: "runSubagent" }]), false);
});

test("resolveCocopiUltraMultiAgentInstructions appends proactive runSubagent guidance once", () => {
  const resolved = resolveCocopiUltraMultiAgentInstructions("Base instructions.", true);

  assert.equal(resolved, `Base instructions.\n\n${COCOPI_ULTRA_MULTI_AGENT_MODE_INSTRUCTIONS}`);
  assert.match(resolved ?? "", /Proactive multi-agent delegation is active/u);
  assert.match(resolved ?? "", /`runSubagent` tool/u);
  assert.match(resolved ?? "", /multiple independent `runSubagent` calls/u);
  assert.equal(resolveCocopiUltraMultiAgentInstructions(resolved, true), resolved);
  assert.equal(resolveCocopiUltraMultiAgentInstructions("Base instructions.", false), "Base instructions.");
});

test("resolveCocopiUltraMultiAgentInstructions avoids parallel claims when unsupported", () => {
  const resolved = resolveCocopiUltraMultiAgentInstructions("Base instructions.", true, { parallelToolCalls: false });

  assert.match(resolved ?? "", /delegate one task at a time/u);
  assert.doesNotMatch(resolved ?? "", /host can run them in parallel/u);
  assert.equal(resolveCocopiUltraMultiAgentInstructions(resolved, true, { parallelToolCalls: false }), resolved);
});

test("codexReasoningFromCocopiOptions maps selected reasoning options", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), {
    reasoningEffort: "medium",
    reasoningSummary: "concise"
  }), {
    effort: "medium",
    summary: "concise"
  });
});

test("codexReasoningFromCocopiOptions maps configured reasoning settings", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    reasoningEffort: "xhigh",
    reasoningSummary: "detailed"
  })));

  assert.deepEqual(codexReasoningFromCocopiOptions(configuration), {
    effort: "xhigh",
    summary: "detailed"
  });
});

test("codexReasoningFromCocopiOptions lets request options override configured reasoning", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    reasoningEffort: "xhigh",
    reasoningSummary: "detailed"
  })));

  assert.deepEqual(codexReasoningFromCocopiOptions(configuration, {
    reasoningEffort: "low",
    reasoningSummary: "concise"
  }), {
    effort: "low",
    summary: "concise"
  });
});

test("codexReasoningFromCocopiOptions omits off summary", () => {
  assert.ok(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), {
    reasoningSummary: "off"
  }) === undefined);
});

test("codexReasoningFromCocopiOptions reads nested request reasoning options", () => {
  assert.deepEqual(codexReasoningFromCocopiOptions(readCocopiConfiguration(fakeVscodeConfiguration()), {
    reasoning: { effort: "low", summary: "off" }
  }), {
    effort: "low"
  });
});

test("codexServiceTierFromCocopiOptions maps configured service tier", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    serviceTier: "priority"
  })));

  assert.equal(codexServiceTierFromCocopiOptions(configuration), "priority");
});

test("codexServiceTierFromCocopiOptions lets request modelOptions override configuration", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    serviceTier: "flex"
  })));

  assert.equal(codexServiceTierFromCocopiOptions(configuration, { serviceTier: "priority" }), "priority");
  assert.equal(codexServiceTierFromCocopiOptions(configuration, { service_tier: "flex" }), "flex");
});

test("codexServiceTierFromCocopiOptions falls back for unsupported modelOptions", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    serviceTier: "flex"
  })));

  assert.equal(codexServiceTierFromCocopiOptions(configuration, { serviceTier: "unsupported" }), "auto");
  assert.equal(codexServiceTierFromCocopiOptions(configuration, { serviceTier: "fast" }), "auto");
  assert.equal(codexServiceTierFromCocopiOptions(configuration, { service_tier: "default" }), "auto");
});

test("codexToolOptionsFromCocopiOptions maps strict defaults and request overrides", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    apiBaseUrl: "https://example.test/codex",
    toolStrict: true
  })));

  assert.deepEqual(codexToolOptionsFromCocopiOptions(configuration), { strict: true });
  assert.deepEqual(codexToolOptionsFromCocopiOptions(configuration, {
    toolStrict: false
  }), { strict: false });
  assert.deepEqual(codexToolOptionsFromCocopiOptions(configuration, {
    tools: { strict: false }
  }), { strict: false });
});

test("resolveChatParticipantInstructions applies placement and regex maps", () => {
  const configuration = readCocopiConfiguration(fakeVscodeConfiguration(configurationValues({
    chatInstructions: "Use concise responses.",
    chatInstructionsPlacement: "append",
    chatInstructionsRegexReplacements: {
      "coding": "coding & architecture"
    }
  })));

  const base = "Custom base instructions for integration tests.";
  assert.equal(resolveChatParticipantInstructions(base, { ...configuration, chatInstructionsPlacement: COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.off }), base);
  assert.equal(resolveChatParticipantInstructions(base, { ...configuration, chatInstructionsPlacement: COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.replace }), "Use concise responses.");
  assert.equal(resolveChatParticipantInstructions(base, { ...configuration, chatInstructionsPlacement: COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.append }), `${base}\n\nUse concise responses.`);
  assert.equal(resolveChatParticipantInstructions("coding summary", {
    ...configuration,
    chatInstructionsPlacement: COCOPI_CHAT_INSTRUCTIONS_PLACEMENTS.off,
    chatInstructionsRegexReplacements: {
      "coding": "engineering",
      "summary": "final answer"
    }
  }), "engineering final answer");
});

test("default instruction rewrites route completion summaries without suppressing work notes", () => {
  const defaultReplacementText = Object.values(DEFAULT_COCOPI_CHAT_INSTRUCTIONS_REGEX_REPLACEMENTS).join("\n");

  assert.match(defaultReplacementText, /Cocopi renders/u);
  assert.match(defaultReplacementText, /do not emit (?:a duplicate|the same) completion summary/u);
  assert.doesNotMatch(defaultReplacementText, /final-answer content/u);
  assert.doesNotMatch(defaultReplacementText, /Commentary, thinking, reasoning/u);
  assert.doesNotMatch(defaultReplacementText, /must stay in hidden reasoning/u);
});

/**
 * @param {Map<string, unknown>} [values]
 */
function fakeVscodeConfiguration(values = new Map()) {
  return {
    workspace: {
      /** @param {string} section */
      getConfiguration(section) {
        assert.equal(section, "cocopi");
        return {
          /**
           * @template T
           * @param {string} key
           * @param {T} defaultValue
           * @returns {T}
           */
          get(key, defaultValue) {
            return /** @type {T} */ (values.get(key) ?? defaultValue);
          }
        };
      }
    }
  };
}

/**
 * @param {Record<string, unknown>} record
 */
function configurationValues(record) {
  /** @type {Map<string, unknown>} */
  const values = new Map();
  for (const [key, value] of Object.entries(record)) {
    values.set(key, value);
  }

  return values;
}
