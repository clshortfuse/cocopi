import assert from "node:assert/strict";
import test from "node:test";
import { parseModelsResponse } from "../lib/codex-api/models.js";
import { languageModelInformationFromCodexModels } from "../lib/vscode/language-model-provider.js";

test("upstream default window remains total while compaction defaults to ninety percent", () => {
  const catalog = parseModelsResponse({ models: [{ slug: "upstream-context-fixture", context_window: 500_000, max_context_window: 1_000_000 }] });
  const [model] = languageModelInformationFromCodexModels(catalog, "upstream-context-fixture");
  assert.equal(model.maxContextWindowTokens, 500_000);
  assert.equal(model.maxInputTokens, 450_000);
  assert.equal(model.maxOutputTokens, 16_384);
  assert.equal(model.configurationSchema?.properties?.contextSize, undefined);
  const [extended] = languageModelInformationFromCodexModels(catalog, "upstream-context-fixture", { lowestContextWindow: false });
  assert.equal(extended.maxContextWindowTokens, 1_000_000);
  assert.equal(extended.maxInputTokens, 950_000);
  assert.deepEqual(extended.configurationSchema?.properties?.contextSize?.enum, [450_000, 950_000]);
});

test("catalog effective context percentage survives parsing and caps the prompt budget", () => {
  const catalog = parseModelsResponse({ models: [{ slug: "headroom-fixture", context_window: 500_000, effective_context_window_percent: 80, auto_compact_token_limit: 490_000 }] });
  assert.equal(catalog[0].effectiveContextWindowPercent, 80);
  const [model] = languageModelInformationFromCodexModels(catalog, "headroom-fixture");
  assert.equal(model.maxContextWindowTokens, 500_000);
  assert.equal(model.maxInputTokens, 400_000);
});

test("explicit compaction cannot exceed ninety percent of the raw default window", () => {
  const [model] = languageModelInformationFromCodexModels([{
    id: "compact-fixture", displayName: "Compact Fixture", contextWindow: 500_000, autoCompactTokenLimit: 490_000
  }], "compact-fixture");
  assert.equal(model.maxContextWindowTokens, 500_000);
  assert.equal(model.maxInputTokens, 450_000);
});

test("full local fallback uses upstream usable context without changing physical capacity", () => {
  const [model] = languageModelInformationFromCodexModels([{
    id: "full-fixture", displayName: "Full Fixture", contextWindow: 500_000
  }], "full-fixture", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "full" });
  assert.equal(model.maxContextWindowTokens, 500_000);
  assert.equal(model.maxInputTokens, 475_000);
});

test("opt-out does not invent an extended tier without catalog evidence", () => {
  const [model] = languageModelInformationFromCodexModels([{
    id: "single-fixture", displayName: "Single Fixture", contextWindow: 500_000
  }], "single-fixture", { lowestContextWindow: false });
  assert.equal(model.maxContextWindowTokens, 500_000);
  assert.equal(model.maxInputTokens, 450_000);
  assert.equal(model.configurationSchema?.properties?.contextSize, undefined);
});