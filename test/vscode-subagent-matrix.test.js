import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSubagentMatrix, resolveSubagentChoice, resolveSubagentMatrix, subagentChoiceAvailable, subagentDefaultModel, subagentMatrixForParent, withSubagentMatrixGuidance } from "../lib/vscode/subagent-matrix.js";
import { withDefaultRunSubagentToolModel } from "../lib/vscode/tool-bridge.js";

const choice = { id: "lookup", model: "test-small", reasoningEffort: "low", label: "Lookup", description: "Locate definitions." };
const matrix = { enabled: true, defaultChoice: "lookup", choices: [choice] };
const models = [{ id: "test-small", displayName: "Small", supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }] }];
const tools = [{ name: "runSubagent", description: "Host description", inputSchema: { type: "object", properties: { model: { type: "string" } } } }];

test("operating default permits only GPT-6 Ultra parents and catalog non-Fast targets", () => {
  const catalog = ["gpt-6-astra", "gpt-5.6", "gpt-6-fast", "gpt-5.6-fast", "gpt-5.5", "gpt-60"].map((id) => ({
    id, displayName: id, supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort }))
  }));
  const preset = normalizeSubagentMatrix({ preset: "gpt6-ultra" });
  const resolved = resolveSubagentMatrix(preset, catalog);
  const row = subagentMatrixForParent(resolved, "gpt-6-astra", "ultra");
  assert.equal(row?.choices.length, 10);
  assert.ok(row?.choices.every((entry) => ["gpt-6-astra", "gpt-5.6"].includes(entry.model) && entry.reasoningEffort !== "ultra"));
  assert.equal(withSubagentMatrixGuidance(tools, row).length, 1);
  for (const [model, effort] of [["gpt-6-astra", "xhigh"], ["gpt-6-astra", "max"], ["gpt-5.6", "ultra"], ["gpt-6-fast", "ultra"]]) {
    assert.deepEqual(withSubagentMatrixGuidance(tools, subagentMatrixForParent(resolved, model, effort)), []);
  }
  assert.deepEqual(normalizeSubagentMatrix(resolved), resolved);
  assert.throws(() => resolveSubagentChoice("subagent-gpt-6-astra-ultra", resolved, catalog), /unavailable/u);
  assert.equal(resolveSubagentMatrix(matrix, catalog), matrix);
  assert.deepEqual(withSubagentMatrixGuidance(tools, subagentMatrixForParent(resolveSubagentMatrix(preset, []), "gpt-6-astra", "ultra")), []);
});

test("cross matrix selects directed targets by both parent model and effort", () => {
  const strong = { ...choice, id: "strong", reasoningEffort: "high" };
  const cross = normalizeSubagentMatrix({ ...matrix, defaultChoice: "strong", choices: [strong, choice], routes: [
    { parent: "strong", targets: ["lookup"] },
    { parent: "lookup", targets: [] }
  ] });
  const row = subagentMatrixForParent(cross, choice.model, "high");
  assert.deepEqual(row?.choices, [choice]);
  assert.equal(subagentDefaultModel(row, tools, "Parent"), "Cocopi Subagent lookup (cocopi)");
  const guided = withSubagentMatrixGuidance(tools, row);
  assert.match(guided[0].description, /Cocopi Subagent lookup/u);
  assert.doesNotMatch(guided[0].description, /Cocopi Subagent strong/u);
  for (const [model, effort] of [[choice.model, "low"], ["other", "high"], [choice.model, "medium"]]) {
    const empty = subagentMatrixForParent(cross, model, effort);
    assert.deepEqual(withSubagentMatrixGuidance(tools, empty), []);
    assert.equal(subagentDefaultModel(empty, tools, "Parent"), "Parent");
  }
  assert.equal(cross.choices.length, 2);
  assert.equal(subagentMatrixForParent(matrix, "other", "high"), matrix);
});

test("cross matrix validates links without requiring a global default", () => {
  const cross = normalizeSubagentMatrix({ ...matrix, defaultChoice: "", routes: [
    { parent: "lookup", targets: ["lookup", "lookup", "missing"] },
    { parent: "missing", targets: ["lookup"] }
  ] });
  assert.equal(cross.enabled, true);
  assert.deepEqual(cross.routes, [{ parent: "lookup", targets: ["lookup"] }]);
  const noReasoning = { ...choice, reasoningEffort: "not-applicable" };
  assert.deepEqual(subagentMatrixForParent({ ...cross, choices: [noReasoning] }, choice.model)?.choices, [noReasoning]);
});

test("matrix normalizes external settings and requires an enabled default", () => {
  assert.deepEqual(normalizeSubagentMatrix(matrix), matrix);
  assert.equal(normalizeSubagentMatrix(null).enabled, false);
  assert.equal(normalizeSubagentMatrix({ ...matrix, defaultChoice: "missing" }).enabled, false);
  for (const model of ["auto", "utility", "subagent-lookup", "test-small:fast", "copilot/model"]) {
    assert.equal(normalizeSubagentMatrix({ ...matrix, choices: [{ ...choice, model }] }).enabled, false);
  }
  assert.equal(normalizeSubagentMatrix({ ...matrix, choices: [{ ...choice, reasoningEffort: "ultra" }] }).enabled, false);
  assert.equal(normalizeSubagentMatrix({ ...matrix, choices: [choice, choice] }).choices.length, 1);
});

test("matrix rejects unknown, stale and unsupported aliases without fallback", () => {
  assert.equal(resolveSubagentChoice("cocopi/subagent-lookup", matrix, models), choice);
  assert.equal(resolveSubagentChoice("test-small", matrix, models), undefined);
  for (const catalog of [[], [{ ...models[0], supportedReasoningLevels: [{ effort: "high" }] }]]) {
    assert.throws(() => resolveSubagentChoice("subagent-lookup", matrix, catalog), /unavailable/u);
  }
  assert.throws(() => resolveSubagentChoice("subagent-missing", matrix, models), /unavailable/u);
  assert.throws(() => resolveSubagentChoice("subagent-lookup", { ...matrix, enabled: false }, models), /unavailable/u);
  assert.equal(subagentChoiceAvailable(choice, [{ id: choice.model, displayName: "Unknown" }]), false);
  assert.equal(subagentChoiceAvailable({ ...choice, reasoningEffort: "not-applicable" }, [{ ...models[0], supportedReasoningLevels: [] }]), true);
});

test("matrix guidance copies descriptions without modifying the host schema", () => {
  const guided = withSubagentMatrixGuidance(tools, matrix);
  assert.match(guided[0].description, /Cocopi Subagent lookup \(cocopi\)/u);
  assert.match(guided[0].description, /effort low \(default\)/u);
  assert.equal(tools[0].description, "Host description");
  assert.equal(guided[0].inputSchema, tools[0].inputSchema);
  assert.deepEqual(withSubagentMatrixGuidance(tools, { ...matrix, enabled: false }), tools);
  const incompatible = [{ name: "runSubagent", description: "Original" }];
  assert.deepEqual(withSubagentMatrixGuidance(incompatible, matrix), incompatible);
  assert.equal(subagentDefaultModel(matrix, incompatible, "Parent"), "Parent");
});

test("matrix default replaces omitted models but preserves explicit selections", () => {
  const defaultModel = subagentDefaultModel(matrix, tools, "Parent");
  assert.equal(defaultModel, "Cocopi Subagent lookup (cocopi)");
  for (const model of [undefined, null, "", " "]) {
    const call = withDefaultRunSubagentToolModel({ callId: "call", name: "runSubagent", input: model === undefined ? {} : { model }, rawArguments: "{}" }, defaultModel);
    assert.equal(call?.input.model, defaultModel);
    assert.equal(JSON.parse(call?.rawArguments ?? "{}").model, defaultModel);
  }
  const explicit = { callId: "call", name: "runSubagent", input: { model: "Explicit (copilot)" }, rawArguments: "{}" };
  assert.equal(withDefaultRunSubagentToolModel(explicit, defaultModel), explicit);
  assert.equal(subagentDefaultModel({ ...matrix, enabled: false }, tools, "Parent"), "Parent");
});

test("enabled empty routing hides only runSubagent even without a model parameter", () => {
  const empty = normalizeSubagentMatrix({ enabled: true, choices: [], routes: [] });
  assert.equal(empty.enabled, true);
  const hostTools = [{ name: "runSubagent", description: "Spawn" }, { name: "read_file", description: "Read" }];
  assert.deepEqual(withSubagentMatrixGuidance(hostTools, subagentMatrixForParent(empty, "any", "high")), [hostTools[1]]);
  assert.deepEqual(withSubagentMatrixGuidance(hostTools, { ...empty, enabled: false }), hostTools);
});