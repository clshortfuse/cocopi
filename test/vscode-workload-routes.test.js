import test from "node:test";
import assert from "node:assert/strict";

import { readCocopiConfiguration } from "../lib/vscode/configuration.js";
import { cocopiWorkloadRouteNameFromModelId, isCocopiWorkloadAlias, ordinaryCocopiWorkloadRoute, resolveCocopiWorkloadRoute } from "../lib/vscode/workload-routes.js";

const models = [
  { id: "gpt-main", displayName: "Main", supportedReasoningLevels: [{ effort: "medium" }, { effort: "high" }] },
  { id: "gpt-6-sol", displayName: "Sol", supportedReasoningLevels: [{ effort: "low" }, { effort: "medium" }] },
  { id: "gpt-6-luna", displayName: "Luna", supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }] },
  { id: "gpt-spark", displayName: "Spark", supportedReasoningLevels: [] }
];

test("resolveCocopiWorkloadRoute selects recommended workload targets", () => {
  const configuration = cocopiConfiguration({ model: "gpt-main" });

  assert.deepEqual(resolveCocopiWorkloadRoute("utility", configuration, models), {
    alias: "cocopi/utility",
    targetModel: "gpt-6-luna",
    reasoningEffort: "max",
    serviceTier: "auto",
    workload: "utility",
    workloadSubtype: "general"
  });
  assert.deepEqual(resolveCocopiWorkloadRoute("utility-small", configuration, models), {
    alias: "cocopi/utility-small",
    targetModel: "gpt-6-luna",
    reasoningEffort: "low",
    serviceTier: "auto",
    workload: "utility",
    workloadSubtype: "small"
  });
  assert.deepEqual(resolveCocopiWorkloadRoute("autocomplete", configuration, models), {
    alias: "cocopi/autocomplete",
    targetModel: "gpt-6-luna",
    reasoningEffort: "low",
    serviceTier: "auto",
    workload: "autocomplete",
    workloadSubtype: "inline"
  });
});

test("resolveCocopiWorkloadRoute applies explicit route profiles authoritatively", () => {
  const configuration = cocopiConfiguration({
    model: "gpt-main",
    "routes.utility.model": "gpt-main",
    "routes.utility.reasoningEffort": "low",
    "routes.utility.serviceTier": "priority"
  });
  const route = resolveCocopiWorkloadRoute("utility", configuration, models);

  assert.equal(route.targetModel, "gpt-main");
  assert.equal(route.reasoningEffort, "medium");
  assert.equal(route.serviceTier, "priority");
});

test("resolveCocopiWorkloadRoute resolves symbolic efforts from catalog support order-independently", () => {
  const reversedModels = [{
    id: "gpt-reversed",
    displayName: "Reversed",
    defaultReasoningLevel: "none",
    supportedReasoningLevels: [{ effort: "high" }, { effort: "minimal" }, { effort: "low" }]
  }];
  const lowest = resolveCocopiWorkloadRoute("autocomplete", cocopiConfiguration({
    model: "gpt-reversed",
    "routes.autocomplete.model": "gpt-reversed",
    "routes.autocomplete.reasoningEffort": "lowest"
  }), reversedModels);
  const defaultEffort = resolveCocopiWorkloadRoute("autocomplete", cocopiConfiguration({
    model: "gpt-reversed",
    "routes.autocomplete.model": "gpt-reversed",
    "routes.autocomplete.reasoningEffort": "default"
  }), reversedModels);
  const catalogUnavailable = resolveCocopiWorkloadRoute("autocomplete", cocopiConfiguration({
    model: "gpt-explicit",
    "routes.autocomplete.model": "gpt-explicit",
    "routes.autocomplete.reasoningEffort": "lowest"
  }));

  assert.equal(lowest.reasoningEffort, "minimal");
  assert.equal(defaultEffort.reasoningEffort, "high");
  assert.equal(catalogUnavailable.reasoningEffort, undefined);
});

test("resolveCocopiWorkloadRoute rejects recursive and fast targets", () => {
  const recursive = resolveCocopiWorkloadRoute("utility", cocopiConfiguration({
    model: "gpt-main",
    "routes.utility.model": "cocopi/utility-small"
  }), models);
  const fast = resolveCocopiWorkloadRoute("autocomplete", cocopiConfiguration({
    model: "gpt-main",
    "routes.autocomplete.model": "gpt-main:fast",
    "inlineCompletions.model": "gpt-main:fast"
  }), models);

  assert.equal(recursive.targetModel, "gpt-6-luna");
  assert.equal(fast.targetModel, "gpt-6-luna");
});

test("resolveCocopiWorkloadRoute retains API-key-disabled targets for ChatGPT auth", () => {
  const route = resolveCocopiWorkloadRoute("utility", cocopiConfiguration({
    model: "gpt-fallback-unsupported",
    "routes.utility.model": "gpt-route-unsupported"
  }), [
    { id: "gpt-route-unsupported", displayName: "Route", supportedInApi: false },
    { id: "gpt-fallback-unsupported", displayName: "Fallback", supportedInApi: false }
  ]);

  assert.equal(route.targetModel, "gpt-route-unsupported");
});

test("resolveCocopiWorkloadRoute does not recommend Spark or GPT-5.6 when GPT-6 is available", () => {
  const catalog = [
    { id: "gpt-5.6-sol", displayName: "Sol", supportedReasoningLevels: [{ effort: "low" }] },
    { id: "gpt-5.6-luna", displayName: "Luna", supportedReasoningLevels: [{ effort: "minimal" }, { effort: "low" }] },
    {
      id: "gpt-5.3-codex-spark",
      displayName: "GPT-5.3-Codex-Spark",
      supportedInApi: false,
      supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }]
    },
    { id: "gpt-6-luna", displayName: "GPT-6 Luna", supportedReasoningLevels: [{ effort: "low" }, { effort: "max" }] }
  ];
  const automatic = resolveCocopiWorkloadRoute("autocomplete", cocopiConfiguration({
    model: "gpt-5.6-sol",
    "routes.autocomplete.model": "auto"
  }), catalog);
  const explicit = resolveCocopiWorkloadRoute("autocomplete", cocopiConfiguration({
    model: "gpt-5.6-sol",
    "routes.autocomplete.model": "gpt-5.3-codex-spark"
  }), catalog);

  assert.equal(automatic.targetModel, "gpt-6-luna");
  assert.equal(automatic.reasoningEffort, "low");
  assert.equal(explicit.targetModel, "gpt-5.3-codex-spark");
  assert.equal(explicit.reasoningEffort, "low");
});

test("utility Auto tracks GPT-6 Luna without changing explicit legacy pins", () => {
  const catalog = [
    { id: "gpt-5.6-terra", displayName: "Terra", supportedReasoningLevels: [{ effort: "low" }, { effort: "max" }] },
    { id: "gpt-6-luna", displayName: "Luna", supportedReasoningLevels: [{ effort: "low" }, { effort: "max" }] }
  ];
  const automatic = cocopiConfiguration({ model: "gpt-5.6-sol", "routes.utility.model": "auto", "routes.utilitySmall.model": "auto" });
  const pinned = cocopiConfiguration({ model: "gpt-5.6-sol", "routes.utility.model": "gpt-5.6-terra" });

  assert.equal(resolveCocopiWorkloadRoute("utility", automatic, catalog).targetModel, "gpt-6-luna");
  assert.equal(resolveCocopiWorkloadRoute("utility-small", automatic, catalog).targetModel, "gpt-6-luna");
  assert.equal(resolveCocopiWorkloadRoute("utility", pinned, catalog).targetModel, "gpt-5.6-terra");
});

test("resolveCocopiWorkloadRoute uses GPT-6 Luna for both utility profiles", () => {
  const catalog = [
    { id: "gpt-6-sol", displayName: "Sol", supportedReasoningLevels: [{ effort: "low" }, { effort: "medium" }] },
    { id: "gpt-6-luna", displayName: "Luna", supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }] }
  ];

  const utility = resolveCocopiWorkloadRoute("utility", cocopiConfiguration({ model: "gpt-main" }), catalog);
  const utilitySmall = resolveCocopiWorkloadRoute("utility-small", cocopiConfiguration({ model: "gpt-main" }), catalog);
  assert.deepEqual({ model: utility.targetModel, effort: utility.reasoningEffort }, { model: "gpt-6-luna", effort: "max" });
  assert.deepEqual({ model: utilitySmall.targetModel, effort: utilitySmall.reasoningEffort }, { model: "gpt-6-luna", effort: "low" });
});

test("resolveCocopiWorkloadRoute uses GPT-6 Luna for Auto while the catalog is unavailable", () => {
  const route = resolveCocopiWorkloadRoute("autocomplete", cocopiConfiguration({
    model: "gpt-5.6-sol",
    "routes.autocomplete.model": "auto"
  }));

  assert.equal(route.targetModel, "gpt-6-luna");
  assert.equal(route.reasoningEffort, undefined);
});

test("workload route helpers recognize qualified and provider-local aliases", () => {
  assert.equal(cocopiWorkloadRouteNameFromModelId("cocopi/utility-small"), "utility-small");
  assert.equal(cocopiWorkloadRouteNameFromModelId("autocomplete"), "autocomplete");
  assert.equal(cocopiWorkloadRouteNameFromModelId("gpt-main"), undefined);
  assert.equal(isCocopiWorkloadAlias("cocopi/utility"), true);
  assert.equal(isCocopiWorkloadAlias("utility"), true);
  assert.equal(isCocopiWorkloadAlias("gpt-main"), false);
  assert.deepEqual(ordinaryCocopiWorkloadRoute("gpt-main:fast", "gpt-main"), {
    alias: "gpt-main:fast",
    targetModel: "gpt-main",
    reasoningEffort: undefined,
    serviceTier: "auto",
    workload: "chat",
    workloadSubtype: "main"
  });
});

/** @param {Record<string, unknown>} values */
function cocopiConfiguration(values) {
  const configuration = new Map(Object.entries(values));
  return readCocopiConfiguration({
    workspace: {
      getConfiguration() {
        return {
          /**
           * @template {string | number | boolean} T
           * @param {string} key
           * @param {T} defaultValue
           * @returns {T}
           */
          get(key, defaultValue) {
            return configuration.has(key) ? /** @type {T} */ (configuration.get(key)) : defaultValue;
          }
        };
      }
    }
  });
}
