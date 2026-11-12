import test from "node:test";
import assert from "node:assert/strict";

import { CODEX_CLIENT_VERSION, DEFAULT_CODEX_API_BASE_URL } from "../lib/codex-api/config.js";
import { CODEX_SECRET_KEYS } from "../lib/vscode/secret-storage.js";
import { COCOPI_AGENT_FEATURE_COVERAGE, createCocopiSdkAgentProfiles, withSdkCustomAgentGuidance } from "../lib/vscode/sdk-agent-profiles.js";
import { previewCocopiSdkAgentProfile } from "../lib/vscode/sdk-profile-preview.js";

/** @type {import('../data/Codex.js').CodexModelSummary[]} */
const models = [{ id: "gpt-fixture", displayName: "Fixture", supportedReasoningLevels: [{ effort: "high" }, { effort: "future" }] }];
/** @type {import('../lib/vscode/subagent-matrix.js').SubagentMatrix} */
const matrix = { enabled: true, defaultChoice: "review", choices: [{ id: "review", model: "gpt-fixture", reasoningEffort: "high", label: 'Review: "carefully"', description: "First line\n---\nmodel: other/model" }] };

test("SDK profile output is deterministic, qualified, escaped and does not redefine tool permissions", () => {
  const generated = createCocopiSdkAgentProfiles(matrix, models);
  assert.deepEqual(generated, createCocopiSdkAgentProfiles(matrix, models));
  assert.deepEqual(generated.rejected, []);
  const [profile] = generated.profiles;
  assert.equal(profile.model, "cocopi/subagent-review");
  assert.equal(profile.filename, "cocopi-review.agent.md");
  const frontmatter = profile.content.split("\n---\n")[0];
  const lines = frontmatter.split("\n");
  assert.equal(JSON.parse(lines.find((line) => line.startsWith("description: "))?.slice(13) ?? "null"), `${matrix.choices[0].label}: gpt-fixture, high. ${matrix.choices[0].description.replaceAll(/\s+/gu, " ")}`);
  assert.match(frontmatter, /reasoning-effort: "high"/u);
  assert.doesNotMatch(frontmatter, /^tools:|^model: other/mu);
  assert.match(profile.content, /fall back to the parent model/u);
  assert.match(profile.content, /does not.*enforce the Local routing matrix/u);
});

test("unsupported, unavailable and disabled routes are rejected rather than coerced", () => {
  const future = { ...matrix, choices: [{ ...matrix.choices[0], reasoningEffort: "future" }] };
  assert.match(createCocopiSdkAgentProfiles(future, models).rejected[0].reason, /does not accept effort future/u);
  assert.equal(createCocopiSdkAgentProfiles(matrix, []).profiles.length, 0);
  assert.match(createCocopiSdkAgentProfiles({ ...matrix, enabled: false }, models).rejected[0].reason, /disabled/u);
  const ultra = { ...matrix, routes: [{ parent: "review", targets: [] }], choices: [{ ...matrix.choices[0], reasoningEffort: "ultra" }] };
  assert.equal(createCocopiSdkAgentProfiles(ultra, models).profiles.length, 0);
});

test("non-reasoning catalog routes omit effort explicitly rather than inventing one", () => {
  const route = { ...matrix, choices: [{ ...matrix.choices[0], reasoningEffort: "not-applicable" }] };
  const result = createCocopiSdkAgentProfiles(route, [{ ...models[0], supportedReasoningLevels: [] }]);
  assert.equal(result.profiles.length, 1);
  assert.doesNotMatch(result.profiles[0].content, /reasoning-effort:/u);
  assert.match(result.profiles[0].content, /effort: not-applicable/u);
});

test("feature coverage names the routes not controlled by the Local matrix", () => {
  for (const name of ["Local runSubagent", "SDK custom agents", "SDK task / execution subagents", "Context Size", "Dynamic workflows", "Remote / mobile / detached chat"]) {
    assert.ok(COCOPI_AGENT_FEATURE_COVERAGE.some((entry) => entry.route === name));
  }
});

test("SDK task guidance uses exact host-enumerated names without changing schema or other tools", () => {
  const schema = Object.freeze({ type: "object", properties: Object.freeze({ agent_type: Object.freeze({ type: "string", enum: Object.freeze(["explore", "cocopi-review"]) }), model: Object.freeze({ type: "string" }) }) });
  const task = Object.freeze({ name: "task", description: "Host task instructions", inputSchema: schema });
  const local = Object.freeze({ name: "runSubagent", description: "Local", inputSchema: {} });
  const execution = Object.freeze({ name: "execution_subagent", description: "Execution", inputSchema: {} });
  const [guided, keptLocal, keptExecution] = withSdkCustomAgentGuidance([task, local, execution], matrix, models);
  assert.match(guided.description, /^Host task instructions\n\n/u);
  assert.match(guided.description, /agent_type "cocopi-review"; expected profile model "cocopi\/subagent-review"/u);
  assert.match(guided.description, /Names alone do not verify/u);
  assert.equal(guided.inputSchema, schema);
  assert.equal(task.description, "Host task instructions");
  assert.equal(keptLocal, local);
  assert.equal(keptExecution, execution);
});

test("SDK task guidance never infers discovery from names in descriptions or unconstrained schemas", () => {
  for (const schema of [undefined, {}, { properties: { agent_type: { type: "string" } } }, { properties: { agent_type: { enum: ["cocopi-review-other", "explore"] } } }]) {
    const task = { name: "task", description: "cocopi-review exists", inputSchema: schema };
    assert.equal(withSdkCustomAgentGuidance([task], matrix, models)[0], task);
  }
});

test("SDK task guidance respects enabled available catalog routes, not the Local parent graph", () => {
  const task = { name: "task", description: "Delegate", inputSchema: { properties: { agent_type: { enum: ["cocopi-review"] } } } };
  assert.equal(withSdkCustomAgentGuidance([task], { ...matrix, enabled: false }, models)[0], task);
  assert.equal(withSdkCustomAgentGuidance([task], matrix, [])[0], task);
  const noLocalEdges = { ...matrix, routes: [{ parent: "review", targets: [] }] };
  assert.match(withSdkCustomAgentGuidance([task], noLocalEdges, models)[0].description, /matching configured Cocopi SDK profile candidates/u);
  assert.equal(withSdkCustomAgentGuidance([{ ...task, name: "create_session" }], matrix, models)[0].description, "Delegate");
});

test("SDK preview uses current-account cached routes without network or automatic save", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  const fixture = previewFixture();
  await previewCocopiSdkAgentProfile(fixture.context, fixture.vscode);
  assert.equal(fixture.documents.length, 1);
  assert.equal(fixture.documents[0].language, "markdown");
  assert.match(fixture.documents[0].content, /model: "cocopi\/subagent-review"/u);
  assert.doesNotMatch(fixture.documents[0].content, /synthetic-token|synthetic-refresh/u);
  assert.deepEqual(fixture.executed, []);
  assert.deepEqual(fixture.warnings, []);
});

test("SDK preview invokes native Save As only after explicit selection", async () => {
  const fixture = previewFixture();
  fixture.state.save = true;
  await previewCocopiSdkAgentProfile(fixture.context, fixture.vscode);
  assert.deepEqual(fixture.executed, ["workbench.action.files.saveAs"]);
});

test("SDK preview cancellation and wrong-account cache create no documents", async () => {
  const fixture = previewFixture();
  fixture.state.cancel = true;
  await previewCocopiSdkAgentProfile(fixture.context, fixture.vscode);
  assert.equal(fixture.documents.length, 0);
  fixture.state.cancel = false;
  fixture.secrets.set(CODEX_SECRET_KEYS.chatgptAccountId, "other-account");
  await previewCocopiSdkAgentProfile(fixture.context, fixture.vscode);
  assert.equal(fixture.documents.length, 0);
  assert.match(fixture.warnings.at(-1) ?? "", /No SDK-compatible cached model routes/u);
});

test("SDK preview refuses strict policy and missing proposal authorization", async () => {
  const fixture = previewFixture();
  fixture.state.strict = true;
  await previewCocopiSdkAgentProfile(fixture.context, fixture.vscode);
  assert.equal(fixture.documents.length, 0);
  assert.match(fixture.warnings[0], /Strict plugin-only/u);
  fixture.state.strict = false;
  fixture.context.extension.packageJSON.enabledApiProposals = [];
  await previewCocopiSdkAgentProfile(fixture.context, fixture.vscode);
  assert.match(fixture.warnings.at(-1) ?? "", /full Cocopi build/u);
});

test("SDK preview rechecks policy, route and account after asynchronous selection", async () => {
  for (const change of ["policy", "route", "account"]) {
    const fixture = previewFixture();
    fixture.state.onPick = () => {
      if (change === "policy") fixture.state.strict = true;
      if (change === "route") fixture.state.enabled = false;
      if (change === "account") fixture.secrets.set(CODEX_SECRET_KEYS.accessToken, "other-token");
    };
    await previewCocopiSdkAgentProfile(fixture.context, fixture.vscode);
    assert.equal(fixture.documents.length, 0, change);
    assert.equal(fixture.warnings.length, 1, change);
  }
});

test("SDK preview rechecks policy before Save As and leaves preview unsaved", async () => {
  const fixture = previewFixture();
  fixture.state.save = true;
  fixture.state.onInformation = () => { fixture.state.strict = true; };
  await previewCocopiSdkAgentProfile(fixture.context, fixture.vscode);
  assert.equal(fixture.documents.length, 1);
  assert.deepEqual(fixture.executed, []);
  assert.match(fixture.warnings.at(-1) ?? "", /Strict plugin-only/u);
});

function previewFixture() {
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, "synthetic-token"],
    [CODEX_SECRET_KEYS.refreshToken, "synthetic-refresh"],
    [CODEX_SECRET_KEYS.idToken, "synthetic-id"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "fixture-account"],
    ["cocopi.modelCatalog.v1", JSON.stringify([{ key: `${DEFAULT_CODEX_API_BASE_URL}\n${CODEX_CLIENT_VERSION}\nfixture-account`, models, expiresAtMs: 0 }])]
  ]);
  const state = { strict: false, enabled: true, cancel: false, save: false, onPick: () => {}, onInformation: () => {} };
  /** @type {{ language: string, content: string }[]} */
  const documents = [];
  /** @type {string[]} */
  const executed = [];
  /** @type {string[]} */
  const warnings = [];
  const context = {
    secrets: { get: async (/** @type {string} */ key) => secrets.get(key), store: async () => {}, delete: async () => {} },
    extension: { packageJSON: { enabledApiProposals: ["chatProvider"] } }
  };
  // eslint-disable-next-line jsdoc/check-types -- Partial editor mock implements only the APIs exercised by this command.
  const vscode = /** @type {import('../lib/vscode/commands.js').VscodeCommandApi} */ (/** @type {unknown} */ ({
    workspace: {
      getConfiguration: (/** @type {string} */ section) => ({
        get: (/** @type {string} */ key, /** @type {object | string | number | boolean | undefined} */ fallback) => section === "chat.customizations" ? state.strict : (key === "subagents" ? { ...matrix, enabled: state.enabled } : fallback),
        inspect: () => ({ defaultValue: false })
      }),
      openTextDocument: async (/** @type {{ language: string, content: string }} */ options) => { documents.push(options); return options; }
    },
    window: {
      showQuickPick: async (/** @type {{ modelId: string }[]} */ items) => { state.onPick(); return state.cancel ? undefined : items[0]; },
      showInformationMessage: async () => { state.onInformation(); return state.save ? "Save As" : undefined; },
      showWarningMessage: async (/** @type {string} */ message) => { warnings.push(message); },
      showTextDocument: async () => {}
    },
    commands: { executeCommand: async (/** @type {string} */ command) => { executed.push(command); } }
  }));
  return { context, vscode, secrets, state, documents, executed, warnings };
}