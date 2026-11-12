import assert from "node:assert/strict";
import test from "node:test";
import { languageModelInformationFromCodexModels } from "../lib/vscode/language-model-provider.js";
import { readCocopiConfiguration } from "../lib/vscode/configuration.js";

test("conservative Copilot context total is the catalog default, not the compaction threshold", () => {
  const catalog = [{ id: "context-total-fixture", displayName: "Synthetic Context Total", contextWindow: 500_000, maxContextWindow: 1_000_000 }];
  const [conservative] = languageModelInformationFromCodexModels(catalog, "context-total-fixture");
  assert.equal(conservative.maxInputTokens, 450_000);
  assert.equal(conservative.maxOutputTokens, 16_384);
  assert.equal(conservative.maxContextWindowTokens, 500_000);
  assert.equal(conservative.configurationSchema?.properties?.contextSize, undefined);
  const [extended] = languageModelInformationFromCodexModels(catalog, "context-total-fixture", { lowestContextWindow: false });
  assert.equal(extended.maxContextWindowTokens, 1_000_000);
  assert.equal(extended.maxInputTokens, 950_000);
});

test("Copilot BYOK defaults to the lowest context tier and its fixed compaction budget", () => {
  const models = languageModelInformationFromCodexModels([{
    id: "context-fixture", displayName: "Context Fixture", contextWindow: 100_000,
    maxContextWindow: 1_000_000, autoCompactTokenLimit: 64_000,
    serviceTiers: [{ id: "priority" }]
  }], "context-fixture");
  assert.equal(models.length, 2);
  for (const model of models) {
    assert.equal(model.maxContextWindowTokens, 100_000);
    assert.equal(model.maxInputTokens, 64_000);
    assert.equal(model.maxOutputTokens, 16_384);
    assert.equal(model.configurationSchema?.properties?.contextSize, undefined);
  }
});

test("conservative reporting preserves maximum-only capacity separately from compaction", () => {
  const [model] = languageModelInformationFromCodexModels([{
    id: "maximum-only", displayName: "Maximum Only", maxContextWindow: 100_000,
    autoCompactTokenLimit: 64_000
  }], "maximum-only");
  assert.equal(model.maxContextWindowTokens, 100_000);
  assert.equal(model.maxInputTokens, 64_000);
  assert.equal(model.configurationSchema?.properties?.contextSize, undefined);
});

test("conservative reporting bounds output reserves for small catalog windows", () => {
  const [model] = languageModelInformationFromCodexModels([{
    id: "small", displayName: "Small", contextWindow: 8000, maxContextWindow: 100_000
  }], "small");
  assert.equal(model.maxContextWindowTokens, 8000);
  assert.ok(model.maxInputTokens > 0);
  assert.ok(model.maxInputTokens + model.maxOutputTokens <= 8000);
});

test("lowest-context setting is enabled by default and allows explicit opt-out", () => {
  assert.equal(readCocopiConfiguration(configurationApi()).lowestContextWindow, true);
  assert.equal(readCocopiConfiguration(configurationApi(false)).lowestContextWindow, false);
});

test("explicit opt-out restores extended context capacity and choices", () => {
  const [model] = languageModelInformationFromCodexModels([{
    id: "extended", displayName: "Extended", contextWindow: 100_000,
    maxContextWindow: 1_000_000, autoCompactTokenLimit: 64_000
  }], "extended", { lowestContextWindow: false });
  assert.equal(model.maxContextWindowTokens, 1_000_000);
  assert.equal(model.maxInputTokens, 950_000);
  assert.deepEqual(model.configurationSchema?.properties?.contextSize?.enum, [64_000, 950_000]);
});

/**
 * @param {boolean} [lowestContextWindow]
 */
function configurationApi(lowestContextWindow = true) {
  return { workspace: { getConfiguration: () => ({
    /**
     * @template {string | number | boolean} T
     * @param {string} key
     * @param {T} fallback
     * @returns {T}
     */
    get: (key, fallback) => key === "lowestContextWindow" ? /** @type {T} */ (lowestContextWindow) : fallback
  }) } };
}