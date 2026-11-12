import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AdmZip from "adm-zip";

const archivePath = path.resolve(process.argv[2]);
const directory = await mkdtemp(path.join(tmpdir(), "cocopi-provider-vsix-"));
try {
  const archive = new AdmZip(archivePath);
  archive.extractAllTo(directory);
  const root = path.join(directory, "extension");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.capabilities?.agentsWindow?.supported, true);
  assert.equal(manifest.engines.vscode, "^1.146.0");
  assert.equal(manifest.contributes.chatParticipants, undefined);
  assert.equal(manifest.contributes.configuration.properties["cocopi.chatParticipantModelSource"], undefined);
  assert.equal(manifest.contributes.configuration.properties["cocopi.lowestContextWindow"].default, true);
  for (const name of ["chat-participant", "chat-history", "chat-references"]) {
    assert.equal(archive.getEntry(`extension/lib/vscode/${name}.js`), null);
  }
  const { COCOPI_PROPOSED_APIS_ENABLED: proposed } = await import(pathToFileURL(path.join(root, "data/build-profile.js")).href);
  assert.ok(manifest.contributes.commands.some((/** @type {{ command: string }} */ command) => command.command === "cocopi.previewSdkAgentProfile"));
  const { createCocopiSdkAgentProfiles, withSdkCustomAgentGuidance } = await import(pathToFileURL(path.join(root, "lib/vscode/sdk-agent-profiles.js")).href);
  const generated = createCocopiSdkAgentProfiles({
    enabled: true, defaultChoice: "smoke", choices: [{ id: "smoke", model: "gpt-fixture", reasoningEffort: "high", label: "Smoke", description: "Fixture only" }]
  }, [{ id: "gpt-fixture", displayName: "Fixture", supportedReasoningLevels: [{ effort: "high" }] }]);
  assert.equal(generated.profiles[0].model, "cocopi/subagent-smoke");
  assert.match(generated.profiles[0].content, /reasoning-effort: "high"/u);
  const task = { name: "task", description: "Host task", inputSchema: { properties: { agent_type: { enum: ["cocopi-smoke"] } } } };
  const [guidedTask] = withSdkCustomAgentGuidance([task], {
    enabled: true, defaultChoice: "smoke", choices: [{ id: "smoke", model: "gpt-fixture", reasoningEffort: "high", label: "Smoke", description: "Fixture only" }]
  }, [{ id: "gpt-fixture", displayName: "Fixture", supportedReasoningLevels: [{ effort: "high" }] }]);
  assert.equal(guidedTask.description.includes("Host-listed agent names"), proposed);
  assert.equal(guidedTask.inputSchema, task.inputSchema);
  const { buildTextResponseBody } = await import(pathToFileURL(path.join(root, "lib/codex-api/response-body.js")).href);
  const replayBody = buildTextResponseBody({
    model: "gpt-test",
    input: [{ type: "reasoning", id: "rs-smoke", encrypted_content: "synthetic-state" }]
  });
  assert.deepEqual(replayBody.input, [{ type: "reasoning", id: "rs-smoke", encrypted_content: "synthetic-state", summary: [] }]);
  const { codexRequestStateFromLanguageModelMessages, createCocopiLanguageModelProvider, languageModelErrorFromCodexError, languageModelInformationFromCodexModels } = await import(pathToFileURL(path.join(root, "lib/vscode/language-model-provider.js")).href);
  const [capacityModel] = languageModelInformationFromCodexModels([
    { id: "capacity-only", displayName: "Capacity Only", maxContextWindow: 100_000 }
  ], "capacity-only", { compactionFallbackStrategy: "full" });
  assert.equal(capacityModel.maxContextWindowTokens, 100_000);
  assert.equal(capacityModel.maxInputTokens, 83_616);
  assert.equal(capacityModel.maxOutputTokens, 16_384);
  const contextFixture = [{ id: "context-smoke", displayName: "Context Smoke", contextWindow: 100_000, maxContextWindow: 1_000_000, autoCompactTokenLimit: 64_000 }];
  const [conservative] = languageModelInformationFromCodexModels(contextFixture, "context-smoke");
  assert.equal(conservative.maxContextWindowTokens, 100_000);
  assert.equal(conservative.maxInputTokens, 64_000);
  assert.equal(conservative.configurationSchema?.properties?.contextSize, undefined);
  const [extended] = languageModelInformationFromCodexModels(contextFixture, "context-smoke", { lowestContextWindow: false });
  assert.equal(extended.maxContextWindowTokens, 1_000_000);
  assert.equal(extended.maxInputTokens, 950_000);
  const roles = { User: 1, Assistant: 2, System: 3 };
  const state = codexRequestStateFromLanguageModelMessages([
    { role: roles.System, content: [{ value: "Respect host tool permissions." }] },
    { role: roles.User, content: [{ value: "inspect" }] }
  ], "gpt-test", { LanguageModelChatMessageRole: roles }, { includeEncryptedThinking: proposed });
  assert.equal(state.instructions, "Respect host tool permissions.");
  assert.deepEqual(state.input, [{ role: "user", content: [{ type: "input_text", text: "inspect" }] }]);
  const { createFailClosedCocopiLanguageModelProvider } = await import(pathToFileURL(path.join(root, "lib/vscode/fail-closed-language-model-provider.js")).href);
  const provider = createCocopiLanguageModelProvider({ secrets: { get: async () => {} } }, {
    workspace: { getConfiguration: () => ({ get: (/** @type {string} */ _key, /** @type {import("../data/Codex.js").CodexJsonValue | undefined} */ fallback) => fallback }) }
  });
  const models = await provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false });
  assert.ok(models.length > 0);
  for (const model of models) {
    assert.equal(model.capabilities.apiType, proposed ? 2 : undefined);
    assert.equal(model.isBYOK, proposed ? true : undefined);
    assert.equal(Object.hasOwn(model, "targetChatSessionType"), false);
    if (!proposed) {
      assert.deepEqual(Object.keys(model.capabilities).toSorted(), ["imageInput", "toolCalling"]);
      assert.equal(Object.hasOwn(model, "configurationSchema"), false);
      assert.equal(Object.hasOwn(model, "maxContextWindowTokens"), false);
    }
  }
  for (const authorized of [false, true]) {
    const boundary = createFailClosedCocopiLanguageModelProvider({
      subscriptions: [],
      secrets: { get: async () => {}, store: async () => {} },
      extension: { packageJSON: { enabledApiProposals: authorized ? ["languageModelCapabilities"] : [] } }
    }, { workspace: { getConfiguration: () => ({ get: (/** @type {string} */ _key, /** @type {string} */ fallback) => fallback }) } });
    boundary.setDelegate(provider);
    const registeredModels = await boundary.provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false });
    assert.ok(registeredModels.length > 0);
    for (const model of registeredModels) {
      const delegateModel = models.find((/** @type {import("vscode").LanguageModelChatInformation} */ entry) => entry.id === model.id);
      assert.equal(model.capabilities.apiType, proposed && authorized ? delegateModel?.capabilities.apiType : undefined);
    }
  }
  const error = languageModelErrorFromCodexError(new Error("failed with status 429"), new AbortController().signal, {
    LanguageModelError: {
      RateLimited: () => Object.assign(new Error("rate limited"), { code: "RateLimited" }),
      Blocked: () => Object.assign(new Error("blocked"), { code: "Blocked" })
    }
  });
  assert.equal(error.code, proposed ? "RateLimited" : "Blocked");
  console.log(`Packaged provider smoke passed (${proposed ? "full" : "marketplace"}): ${archivePath}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}