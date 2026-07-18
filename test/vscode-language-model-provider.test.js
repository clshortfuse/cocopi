import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CODEX_CLIENT_VERSION, DEFAULT_CODEX_API_BASE_URL } from "../lib/codex-api/config.js";
import { parseModelsResponse } from "../lib/codex-api/models.js";
import { codexContinuationAnchorFromInputItems } from "../lib/codex-api/websocket.js";
import { COCOPI_COMMANDS } from "../lib/vscode/commands.js";
import {
  COCOPI_LANGUAGE_MODEL_VENDOR,
  COCOPI_STATEFUL_MARKER_MIME,
  VSCODE_LANGUAGE_MODEL_USAGE_MIME,
  COCOPI_MODEL_CATALOG_CACHE_TTL_MS,
  codexInputFromLanguageModelMessages,
  codexRequestStateFromLanguageModelMessages,
  createCocopiLanguageModelProvider,
  languageModelErrorFromCodexError,
  languageModelInformationFromCodexModels,
  registerCocopiLanguageModelProvider
} from "../lib/vscode/language-model-provider.js";
import { clearCocopiIssues, readCocopiIssues } from "../lib/vscode/issues.js";
import { registerFailClosedCocopiLanguageModelProvider } from "../lib/vscode/fail-closed-language-model-provider.js";
import { CODEX_SECRET_KEYS } from "../lib/vscode/secret-storage.js";
import { clearCocopiTokenCacheDebugSummaries, readCocopiTokenCacheDebugSummaries } from "../lib/vscode/token-cache-debug.js";

const chatgptProCatalogFixture = JSON.parse(await readFile(new URL("fixtures/codex-models/chatgpt-pro-catalog.json", import.meta.url), "utf8"));
const reasoningRequestPayloadFixtures = JSON.parse(await readFile(new URL("fixtures/codex-request-payloads/reasoning-variants.json", import.meta.url), "utf8"));

const LanguageModelChatMessageRole = Object.freeze({ User: 1, Assistant: 2 });
const LanguageModelChatToolMode = Object.freeze({ Auto: 1, Required: 2 });
const COCOPI_LEGACY_STATEFUL_MARKER_PAYLOAD_PREFIX = "cocopi:response-items:v1:";
const COCOPI_LEGACY_STATEFUL_MARKER_METADATA_PREFIX = "cocopi:state:v2:";
const COCOPI_VERSIONED_STATEFUL_MARKER_METADATA_PREFIX = "cocopi:state:v3:";
const COCOPI_STATEFUL_MARKER_PREFIX = "cocopi:state:";
const COCOPI_MODEL_CATALOG_STORAGE_KEY = "cocopi.modelCatalog.v1";
const COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY = "cocopi.protectedModelIds.v1";

class LanguageModelTextPart {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelToolCallPart {
  /**
   * @param {string} callId
   * @param {string} name
   * @param {object} input
   */
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  /**
   * @param {string} callId
   * @param {Array<LanguageModelTextPart>} content
   */
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class LanguageModelDataPart {
  /**
   * @param {Uint8Array} data
   * @param {string} mimeType
   */
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }

  /**
   * @param {Uint8Array} data
   * @param {string} mimeType
   */
  static image(data, mimeType) {
    return new LanguageModelDataPart(data, mimeType);
  }

  /** @param {object} value */
  static json(value) {
    return new LanguageModelDataPart(new TextEncoder().encode(jsonString(value)), "application/json");
  }

  /** @param {string} value */
  static text(value) {
    return new LanguageModelDataPart(new TextEncoder().encode(value), "text/plain");
  }
}

class LanguageModelThinkingPart {
  /**
   * @param {string | string[]} value
   * @param {string} [id]
   * @param {Record<string, unknown>} [metadata]
   */
  constructor(value, id, metadata) {
    this.value = value;
    this.id = id;
    this.metadata = metadata;
  }
}

class DeniedLanguageModelThinkingPart {
  /**
   * @param {string | string[]} value
   * @param {string} [id]
   * @param {Record<string, unknown>} [metadata]
   */
  constructor(value, id, metadata) {
    void value;
    void id;
    void metadata;
    throw new Error("Extension 'shortfuse.cocopi' CANNOT use API proposal: languageModelThinkingPart");
  }
}

class LanguageModelError extends Error {
  code = "Unknown";

  /** @param {string} [message] */
  static NoPermissions(message) {
    const error = new LanguageModelError(message);
    error.code = "NoPermissions";
    return error;
  }

  /** @param {string} [message] */
  static Blocked(message) {
    const error = new LanguageModelError(message);
    error.code = "Blocked";
    return error;
  }

  /** @param {string} [message] */
  static NotFound(message) {
    const error = new LanguageModelError(message);
    error.code = "NotFound";
    return error;
  }
}

test("registerCocopiLanguageModelProvider registers the Cocopi vendor", () => {
  const context = fakeContext();
  const vscode = fakeVscode();

  registerCocopiLanguageModelProvider(context, vscode);

  assert.equal(vscode.languageModelVendor, COCOPI_LANGUAGE_MODEL_VENDOR);
  assert.ok(vscode.languageModelProvider);
  assert.equal(context.subscriptions.length, 2);
});

test("bootstrap provider handles requests before the full provider loads", async () => {
  const progress = fakeProgress();
  const vscode = fakeVscode(configurationValues({ model: "gpt-bootstrap" }));

  registerFailClosedCocopiLanguageModelProvider(fakeContext(), vscode);
  const information = await vscode.languageModelProvider?.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken());
  await vscode.languageModelProvider?.provideLanguageModelChatResponse(
    fakeModel("gpt-bootstrap"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "hello")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );
  const tokens = await vscode.languageModelProvider?.provideTokenCount(
    fakeModel("gpt-bootstrap"),
    "12345678",
    fakeCancellationToken()
  );

  assert.deepEqual(information?.map((model) => model.id), ["gpt-bootstrap"]);
  assert.match(/** @type {LanguageModelTextPart} */ (progress.parts[0]).value, /No model request was sent/u);
  assert.equal(tokens, 2);
});

test("bootstrap provider does not escape failures from storage, diagnostics, or local progress", async () => {
  const vscode = fakeVscode(configurationValues({ model: "gpt-bootstrap" }));
  const logger = {
    debug() {},
    info() {},
    error() {
      throw new Error("diagnostics unavailable");
    },
    dispose() {}
  };

  registerFailClosedCocopiLanguageModelProvider(fakeContext(new Map(), {
    getError: new Error("secret storage unavailable")
  }), vscode, { logger });

  const information = await vscode.languageModelProvider?.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken());
  assert.deepEqual(information?.map((model) => model.id), ["gpt-bootstrap"]);
  await assert.doesNotReject(async () => vscode.languageModelProvider?.provideLanguageModelChatResponse(
    fakeModel("gpt-bootstrap"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "hello")],
    fakeResponseOptions({ toolMode: 1 }),
    { report() { throw new Error("progress unavailable"); } },
    fakeCancellationToken()
  ));
});

test("registered provider protects stored and configured Cocopi model identifiers", async () => {
  const secrets = new Map([
    [COCOPI_MODEL_CATALOG_STORAGE_KEY, JSON.stringify([{
      key: "previous-account",
      expiresAtMs: 1,
      models: [{ id: "gpt-previous", displayName: "GPT Previous" }]
    }])]
  ]);
  const context = fakeContext(secrets);
  const vscode = fakeVscode(configurationValues({
    model: "gpt-configured",
    "chat.utilityModel": "cocopi/gpt-utility",
    "chat.utilitySmallModel": "cocopi/gpt-small",
    "inlineChat.defaultModel": "cocopi/gpt-inline",
    "github.copilot.chat.executionSubagent.model": "cocopi/gpt-subagent"
  }));

  registerCocopiLanguageModelProvider(context, vscode);
  const information = await vscode.languageModelProvider?.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken());
  const modelIds = new Set(information?.map((model) => model.id));

  assert.deepEqual(modelIds, new Set([
    "gpt-configured",
    "gpt-previous",
    "gpt-utility",
    "gpt-small",
    "gpt-inline",
    "gpt-subagent"
  ]));
  assert.deepEqual(
    new Set(JSON.parse(secrets.get(COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY) ?? "[]")),
    modelIds
  );
});

test("registered provider never removes a model identifier after catalog refresh", async (testContext) => {
  let nowMs = 1000;
  let requestCount = 0;
  testContext.mock.method(Date, "now", () => nowMs);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    requestCount += 1;
    return Response.json({
      models: requestCount === 1
        ? [{ slug: "gpt-catalog-one", display_name: "GPT Catalog One" }]
        : [{ slug: "gpt-catalog-two", display_name: "GPT Catalog Two" }]
    });
  }));
  /** @type {Map<string, string>} */
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]);
  const vscode = fakeVscode(configurationValues({ model: "gpt-catalog-one" }));

  registerCocopiLanguageModelProvider(fakeContext(secrets), vscode);
  const first = await vscode.languageModelProvider?.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  nowMs += COCOPI_MODEL_CATALOG_CACHE_TTL_MS + 1;
  const second = await vscode.languageModelProvider?.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());

  assert.deepEqual(new Set(first?.map((model) => model.id)), new Set(["gpt-catalog-one"]));
  assert.deepEqual(new Set(second?.map((model) => model.id)), new Set(["gpt-catalog-one", "gpt-catalog-two"]));
  assert.deepEqual(
    new Set(JSON.parse(secrets.get(COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY) ?? "[]")),
    new Set(["gpt-catalog-one", "gpt-catalog-two"])
  );
});

test("registered provider returns protected models when discovery fails", async () => {
  const logger = fakeLogger();
  const vscode = fakeVscode(configurationValues({ model: "gpt-protected" }));
  const globalState = new Map([[COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY, ["gpt-history"]]]);

  registerCocopiLanguageModelProvider(fakeContext(new Map(), {
    getError: new Error("secret storage unavailable"),
    globalState
  }), vscode, { logger });
  const information = await vscode.languageModelProvider?.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());

  assert.deepEqual(new Set(information?.map((model) => model.id)), new Set(["gpt-protected", "gpt-history"]));
  assert.ok(logger.errorMessages.some((message) => message.includes("Cocopi model discovery failed")));
});

test("registered provider converts request failures to local non-authored text", async () => {
  const logger = fakeLogger();
  const progress = fakeProgress();
  const vscode = fakeVscode(configurationValues({ model: "gpt-protected" }));

  registerCocopiLanguageModelProvider(fakeContext(), vscode, { logger });
  await vscode.languageModelProvider?.provideLanguageModelChatResponse(
    fakeModel("gpt-protected"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "hello")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.equal(progress.parts.length, 1);
  assert.match(/** @type {LanguageModelTextPart} */ (progress.parts[0]).value, /^Cocopi local failure \(not model-authored\):/u);
  assert.match(/** @type {LanguageModelTextPart} */ (progress.parts[0]).value, /did not invoke a replacement provider for gpt-protected/u);
  assert.ok(logger.errorMessages.some((message) => message.includes("no replacement provider was invoked")));
});

test("provideLanguageModelChatInformation returns fallback while signed out in silent mode", async () => {
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(),
    vscode
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Sign in required")]);
  assert.deepEqual(vscode.warningMessages, []);
});

test("provideLanguageModelChatInformation exposes generic configured model while signed out in interactive mode", async () => {
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(),
    vscode
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Sign in required")]);
  assert.deepEqual(vscode.warningMessages, ["Cocopi is not signed in, so VS Code can only show the fallback model (gpt-test)."]);
  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  assert.equal(vscode.warningMessages.length, 1);
});

test("provideLanguageModelChatInformation refreshes metadata from Codex models at runtime", async (testContext) => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string> } }>} */
  const calls = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({
      url: String(url),
      options: /** @type {RequestInit & { headers: Record<string, string> }} */ (options)
    });
    return Response.json({
      models: [
        { slug: "gpt-5.2", display_name: "GPT-5.2", context_window: 272_000, description: "Professional work model." },
        { slug: "gpt-5-codex", display_name: "GPT-5 Codex", context_window: 128_000 }
      ]
    });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"],
      [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
    ])),
    fakeVscode(configurationValues({ apiBaseUrl: "https://chatgpt.example.test/backend-api/codex", model: "gpt-5-codex" }))
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [
    modelInformation("gpt-5-codex", "GPT-5 Codex"),
    modelInformation("gpt-5.2", "GPT-5.2", "gpt-5.2", { contextWindow: 272_000, tooltip: "Professional work model." })
  ]);
  assert.equal(calls[0].url, `https://chatgpt.example.test/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`);
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0].options.headers["ChatGPT-Account-ID"], "account-id");
});

test("provideLanguageModelChatInformation logs model-provided compaction limits", async (testContext) => {
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => Response.json({
    models: [
      { slug: "gpt-5-codex", display_name: "GPT-5 Codex", context_window: 100_000, auto_compact_token_limit: 64_000 }
    ]
  })));
  const logger = fakeLogger();
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    fakeVscode(configurationValues({ debugLevel: "metadata", model: "gpt-5-codex" })),
    { logger }
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [
    {
      ...modelInformation("gpt-5-codex", "GPT-5 Codex", "gpt-5-codex", { contextWindow: 100_000 }),
      maxInputTokens: 83_616,
      configurationSchema: {
        properties: {
          contextSize: {
            type: "number",
            title: "Context Size",
            description: "Controls how much chat context VS Code keeps before compacting Cocopi requests.",
            enum: [64_000, 83_616],
            enumItemLabels: ["64K", "83.6K"],
            enumDescriptions: ["Default recommended context size.", "Longer sessions without earlier VS Code compaction."],
            default: 64_000,
            group: "tokens"
          }
        }
      }
    }
  ]);
  assert.ok(logger.debugMessages.some((message) => message.includes("Cocopi language model compaction limit.")
    && message.includes("model=gpt-5-codex")
    && message.includes("source=model-provided")
    && message.includes("defaultInputTokens=64000")
    && message.includes("maxInputTokens=83616")
    && message.includes("maxOutputTokens=16384")
    && message.includes("contextWindow=100000")
    && message.includes("useModelDefaultCompactionLimit=true")
    && message.includes("compactionFallbackStrategy=ninety-percent")
    && message.includes("modelAutoCompactTokenLimit=64000")));
});

test("provideLanguageModelChatInformation logs fallback compaction limits", async (testContext) => {
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => Response.json({
    models: [
      { slug: "gpt-5-codex", display_name: "GPT-5 Codex", context_window: 100_000 }
    ]
  })));
  const logger = fakeLogger();
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    fakeVscode(configurationValues({ compactionFallbackStrategy: "full", debugLevel: "metadata", model: "gpt-5-codex" })),
    { logger }
  );

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());

  assert.ok(logger.debugMessages.some((message) => message.includes("Cocopi language model compaction limit.")
    && message.includes("model=gpt-5-codex")
    && message.includes("source=fallback-full")
    && message.includes("defaultInputTokens=83616")
    && message.includes("maxInputTokens=83616")
    && message.includes("maxOutputTokens=16384")
    && message.includes("contextWindow=100000")
    && message.includes("useModelDefaultCompactionLimit=true")
    && message.includes("compactionFallbackStrategy=full")
    && message.includes("modelAutoCompactTokenLimit=unavailable")));
});

test("provideLanguageModelChatInformation logs each compaction limit once", async (testContext) => {
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => Response.json({
    models: [
      { slug: "gpt-5-codex", display_name: "GPT-5 Codex", context_window: 100_000 }
    ]
  })));
  const logger = fakeLogger();
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    fakeVscode(configurationValues({ debugLevel: "metadata", model: "gpt-5-codex" })),
    { logger }
  );

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());

  assert.equal(logger.debugMessages.filter((message) => message.includes("Cocopi language model compaction limit.")).length, 1);
});

test("provideLanguageModelChatInformation does not log compaction limits when debug is off", async (testContext) => {
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => Response.json({
    models: [
      { slug: "gpt-5-codex", display_name: "GPT-5 Codex", context_window: 100_000, auto_compact_token_limit: 64_000 }
    ]
  })));
  const logger = fakeLogger();
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    fakeVscode(configurationValues({ model: "gpt-5-codex" })),
    { logger }
  );

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());

  assert.equal(logger.debugMessages.some((message) => message.includes("Cocopi language model compaction limit.")), false);
});

test("provideLanguageModelChatInformation returns fallback immediately during silent catalog refresh", async (testContext) => {
  /** @type {(value?: unknown) => void} */
  let resolveFetch = () => {};
  /** @type {(value?: unknown) => void} */
  let resolveFetchStarted = () => {};
  const fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    resolveFetchStarted();
    await new Promise((resolve) => {
      resolveFetch = resolve;
    });
    return Response.json({ models: [{ slug: "gpt-5-codex", display_name: "GPT-5 Codex" }] });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    fakeVscode(configurationValues({ model: "gpt-test" }))
  );
  const changeEvents = [];
  provider.onDidChangeLanguageModelChatInformation?.(() => {
    changeEvents.push("changed");
  });

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog loading")]);
  await fetchStarted;
  resolveFetch();
  await nextMacrotask();
  assert.equal(changeEvents.length, 1);
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
});

test("provideLanguageModelChatInformation coalesces silent background catalog refreshes", async (testContext) => {
  /** @type {(value?: unknown) => void} */
  let resolveFetch = () => {};
  /** @type {string[]} */
  const calls = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    calls.push("models");
    await new Promise((resolve) => {
      resolveFetch = resolve;
    });
    return Response.json({ models: [{ slug: "gpt-5-codex", display_name: "GPT-5 Codex" }] });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    fakeVscode(configurationValues({ model: "gpt-test" }))
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog loading")]);
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog loading")]);
  assert.equal(calls.length, 1);

  resolveFetch();
  await nextMacrotask();
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
});

test("provideLanguageModelChatInformation returns stored catalog during silent startup refresh", async (testContext) => {
  /** @type {(value?: unknown) => void} */
  let resolveFetch = () => {};
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"],
    [COCOPI_MODEL_CATALOG_STORAGE_KEY, JSON.stringify([{
      key: [DEFAULT_CODEX_API_BASE_URL, CODEX_CLIENT_VERSION, "account-id"].join("\n"),
      expiresAtMs: 1,
      models: [{ id: "gpt-stored", displayName: "GPT Stored" }]
    }])]
  ]);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    await new Promise((resolve) => {
      resolveFetch = resolve;
    });
    return Response.json({ models: [{ slug: "gpt-refreshed", display_name: "GPT Refreshed" }] });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(secrets),
    fakeVscode(configurationValues({ model: "gpt-stored" }))
  );
  const changeEvents = [];
  provider.onDidChangeLanguageModelChatInformation?.(() => {
    changeEvents.push("changed");
  });

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-stored", "GPT Stored")]);

  resolveFetch();
  await nextMacrotask();
  assert.equal(changeEvents.length, 1);
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-refreshed", "GPT Refreshed", "gpt-refreshed")]);
  assert.match(secrets.get(COCOPI_MODEL_CATALOG_STORAGE_KEY) ?? "", /gpt-refreshed/u);
});

test("provideLanguageModelChatResponse restores orchestration metadata from stored catalog", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [COCOPI_MODEL_CATALOG_STORAGE_KEY, JSON.stringify([{
      key: [DEFAULT_CODEX_API_BASE_URL, CODEX_CLIENT_VERSION, ""].join("\n"),
      expiresAtMs: Date.now() + 60_000,
      models: [{
        id: "gpt-stored-v2",
        displayName: "GPT Stored V2",
        multiAgentVersion: "v2",
        toolMode: "direct",
        supportsParallelToolCalls: false
      }]
    }])]
  ]);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.completed", response: { id: "resp-stored-v2" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(secrets),
    fakeVscode(configurationValues({ model: "gpt-stored-v2" }))
  );

  await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken());
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-stored-v2"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "delegate when useful")],
    fakeResponseOptions({
      toolMode: 2,
      modelOptions: { reasoningEffort: "ultra" },
      tools: [{ name: "runSubagent", description: "Run a subagent.", inputSchema: { type: "object" } }]
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.match(body.instructions, /delegate one task at a time/u);
  assert.equal(body.parallel_tool_calls, false);
});

test("provideLanguageModelChatInformation does not refresh expired auth before returning stored silent catalog", async (testContext) => {
  /** @type {string[]} */
  const calls = [];
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, fakeJwt({ exp: 1 })],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"],
    [COCOPI_MODEL_CATALOG_STORAGE_KEY, JSON.stringify([{
      key: [DEFAULT_CODEX_API_BASE_URL, CODEX_CLIENT_VERSION, "account-id"].join("\n"),
      expiresAtMs: 1,
      models: [{ id: "gpt-stored", displayName: "GPT Stored" }]
    }])]
  ]);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url) => {
    calls.push(String(url));
    return Response.json({ error: { message: "background refresh blocked" } }, { status: 500 });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(secrets),
    fakeVscode(configurationValues({ model: "gpt-stored" }))
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-stored", "GPT Stored")]);
  assert.ok(calls.every((url) => !url.endsWith("/oauth/token")));
});

test("provideLanguageModelChatInformation serves stale catalog during silent refresh", async (testContext) => {
  let nowMs = 1000;
  /** @type {string[]} */
  const calls = [];
  testContext.mock.method(Date, "now", () => nowMs);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    calls.push("models");
    return Response.json({
      models: calls.length === 1
        ? [{ slug: "gpt-5-codex", display_name: "GPT-5 Codex" }]
        : [{ slug: "gpt-5.2-codex", display_name: "GPT-5.2 Codex" }]
    });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    fakeVscode(configurationValues({ model: "gpt-5-codex" }))
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
  nowMs += COCOPI_MODEL_CATALOG_CACHE_TTL_MS + 1;
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
  await nextMacrotask();
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-5.2-codex", "GPT-5.2 Codex")]);
});

test("provideLanguageModelChatInformation does not let model catalog storage trigger a second model-info event", async (testContext) => {
  /** @type {string[]} */
  const storeKeys = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => Response.json({
    models: [{ slug: "gpt-5-codex", display_name: "GPT-5 Codex" }]
  })));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ]), {
      fireSecretChanges: true,
      onStore(key) {
        storeKeys.push(key);
      }
    }),
    fakeVscode(configurationValues({ model: "gpt-5-codex" }))
  );
  const changeEvents = [];
  provider.onDidChangeLanguageModelChatInformation?.(() => {
    changeEvents.push("changed");
  });

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);

  assert.equal(storeKeys.filter((key) => key === COCOPI_MODEL_CATALOG_STORAGE_KEY).length, 1);
  assert.equal(changeEvents.length, 1);
});

test("provideLanguageModelChatInformation does not rewrite unchanged stored model catalog during refresh", async (testContext) => {
  let nowMs = 1000;
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const storeKeys = [];
  testContext.mock.method(Date, "now", () => nowMs);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    calls.push("models");
    return Response.json({ models: [{ slug: "gpt-5-codex", display_name: "GPT-5 Codex" }] });
  }));
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"],
    [COCOPI_MODEL_CATALOG_STORAGE_KEY, JSON.stringify([{
      key: [DEFAULT_CODEX_API_BASE_URL, CODEX_CLIENT_VERSION, "account-id"].join("\n"),
      expiresAtMs: 1,
      models: [{ id: "gpt-5-codex", displayName: "GPT-5 Codex" }]
    }])]
  ]);
  const provider = createCocopiLanguageModelProvider(
    fakeContext(secrets, {
      fireSecretChanges: true,
      onStore(key) {
        storeKeys.push(key);
      }
    }),
    fakeVscode(configurationValues({ model: "gpt-5-codex" }))
  );
  const changeEvents = [];
  provider.onDidChangeLanguageModelChatInformation?.(() => {
    changeEvents.push("changed");
  });

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
  await nextMacrotask();

  assert.equal(calls.length, 1);
  assert.equal(storeKeys.filter((key) => key === COCOPI_MODEL_CATALOG_STORAGE_KEY).length, 0);
  assert.equal(changeEvents.length, 0);

  nowMs += 1;
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
  assert.equal(calls.length, 1);
});

test("provideLanguageModelChatInformation warns when silent background catalog refresh fails", async (testContext) => {
  const logger = fakeLogger();
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }));
  /** @type {string[]} */
  const calls = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url) => {
    calls.push(String(url));
    return Response.json({ error: { message: "expired" } }, { status: 401 });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    vscode,
    { logger }
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog loading")]);
  await nextMacrotask();

  assert.deepEqual(vscode.warningMessages, ["Cocopi could not refresh your Codex sign-in, so VS Code is showing only the fallback model (gpt-test)."]);
  assert.ok(logger.errorMessages.some((message) => /Cocopi background model catalog refresh failed/u.test(message)));
  await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken());
  await nextMacrotask();
  assert.equal(calls.filter((url) => url.includes("/models")).length, 1);
  assert.ok(logger.debugMessages.some((message) => /reason=backoff/u.test(message)));
  assert.equal(vscode.warningMessages.length, 1);
});

test("provideLanguageModelChatInformation uses exponential backoff after failed silent catalog refresh", async (testContext) => {
  let nowMs = 1000;
  const logger = fakeLogger();
  /** @type {string[]} */
  const calls = [];
  testContext.mock.method(Date, "now", () => nowMs);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url) => {
    calls.push(String(url));
    return Response.json({ error: { message: "catalog unavailable" } }, { status: 400 });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])),
    fakeVscode(configurationValues({ model: "gpt-test" })),
    { logger }
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog loading")]);
  for (let index = 0; index < 20; index += 1) {
    await nextMacrotask();
  }
  assert.equal(calls.filter((url) => url.includes("/models")).length, 1);

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog loading")]);
  await nextMacrotask();
  assert.equal(calls.filter((url) => url.includes("/models")).length, 1);

  nowMs += 10_001;
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog loading")]);
  for (let index = 0; index < 20; index += 1) {
    await nextMacrotask();
  }
  assert.equal(calls.filter((url) => url.includes("/models")).length, 2);

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog loading")]);
  await nextMacrotask();
  assert.equal(calls.filter((url) => url.includes("/models")).length, 2);
  assert.ok(logger.debugMessages.some((message) => /reason=backoff/u.test(message) && /delayMs=10000/u.test(message)));
});

test("provideLanguageModelChatInformation sign-in warning action runs sign-in command", async () => {
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }), { warningSelection: "Sign In" });
  const provider = createCocopiLanguageModelProvider(
    fakeContext(),
    vscode
  );
  const changeEvents = [];
  provider.onDidChangeLanguageModelChatInformation?.(() => {
    changeEvents.push("changed");
  });

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());

  assert.deepEqual(vscode.executedCommands, [COCOPI_COMMANDS.signIn]);
  assert.equal(changeEvents.length, 1);
});

test("provideLanguageModelChatInformation reuses fresh model catalog cache", async (testContext) => {
  /** @type {string[]} */
  const calls = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url) => {
    calls.push(String(url));
    return Response.json({ models: [{ slug: "gpt-5-codex", display_name: "GPT-5 Codex" }] });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"],
      [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
    ])),
    fakeVscode(configurationValues({ apiBaseUrl: "https://chatgpt.example.test/backend-api/codex", model: "gpt-5-codex" }))
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
  assert.equal(calls.length, 1);
});

test("provideLanguageModelChatInformation refreshes expired model catalog cache", async (testContext) => {
  let nowMs = 1000;
  /** @type {string[]} */
  const calls = [];
  testContext.mock.method(Date, "now", () => nowMs);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url) => {
    calls.push(String(url));
    return Response.json({
      models: calls.length === 1
        ? [{ slug: "gpt-5-codex", display_name: "GPT-5 Codex" }]
        : [{ slug: "gpt-5.2-codex", display_name: "GPT-5.2 Codex" }]
    });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"],
      [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
    ])),
    fakeVscode(configurationValues({ apiBaseUrl: "https://chatgpt.example.test/backend-api/codex", model: "gpt-5-codex" }))
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
  nowMs += COCOPI_MODEL_CATALOG_CACHE_TTL_MS + 1;
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [
    modelInformation("gpt-5.2-codex", "GPT-5.2 Codex")
  ]);
  assert.equal(calls.length, 2);
});

test("provideLanguageModelChatInformation refreshes and retries after 401", async (testContext) => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, "old-access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "old-refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "old-id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
  ]);
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({
      url: String(url),
      options: /** @type {RequestInit & { headers: Record<string, string>, body?: string | null }} */ (options)
    });

    if (String(url).endsWith("/oauth/token")) {
      return Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        id_token: "new-id-token"
      });
    }

    return calls.filter((call) => call.url.includes("/models")).length === 1
      ? Response.json({ error: { message: "expired" } }, { status: 401 })
      : Response.json({ models: [{ slug: "gpt-5-codex", display_name: "GPT-5 Codex" }] });
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(secrets),
    fakeVscode(configurationValues({ apiBaseUrl: "https://chatgpt.example.test/backend-api/codex", model: "gpt-5-codex" }))
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [modelInformation("gpt-5-codex", "GPT-5 Codex")]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer old-access-token");
  assert.equal(calls[2].options.headers.Authorization, "Bearer new-access-token");
  assert.equal(secrets.get(CODEX_SECRET_KEYS.accessToken), "new-access-token");
  assert.equal(secrets.get(CODEX_SECRET_KEYS.refreshToken), "new-refresh-token");
});

test("provideLanguageModelChatInformation falls back when runtime model refresh fails", async (testContext) => {
  const logger = fakeLogger();
  const vscode = fakeVscode(configurationValues({ model: "gpt-test" }));
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("network failed");
  }));
  const provider = createCocopiLanguageModelProvider(
    fakeContext(new Map([[CODEX_SECRET_KEYS.accessToken, "access-token"], [CODEX_SECRET_KEYS.refreshToken, "refresh-token"], [CODEX_SECRET_KEYS.idToken, "id-token"]])),
    vscode,
    { logger }
  );

  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken()), [modelInformation("gpt-test", "gpt-test", "Model catalog unavailable")]);
  assert.deepEqual(vscode.warningMessages, ["Cocopi could not load your Codex model list, so VS Code is showing only the fallback model (gpt-test). Check your sign-in and Cocopi output logs."]);
  assert.ok(logger.errorMessages.some((message) => /Cocopi model catalog refresh failed/u.test(message)));
  await provider.provideLanguageModelChatInformation({ silent: true }, fakeCancellationToken());
  assert.equal(vscode.warningMessages.length, 1);
});

test("languageModelInformationFromCodexModels orders the configured model first", () => {
  assert.deepEqual(languageModelInformationFromCodexModels([
    { id: "gpt-5.2", displayName: "GPT-5.2" },
    { id: "gpt-5-codex", displayName: "GPT-5 Codex" }
  ], "gpt-5-codex", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" }), [
    modelInformation("gpt-5-codex", "GPT-5 Codex"),
    modelInformation("gpt-5.2", "GPT-5.2")
  ]);
});

test("languageModelInformationFromCodexModels omits configured fallback when the signed-in catalog omits it", () => {
  assert.deepEqual(languageModelInformationFromCodexModels([
    { id: "gpt-5.2", displayName: "GPT-5.2" }
  ], "gpt-5-codex", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" }), [
    modelInformation("gpt-5.2", "GPT-5.2")
  ]);
});

test("languageModelInformationFromCodexModels remains eligible for the Agent Host BYOK bridge", () => {
  const [model] = languageModelInformationFromCodexModels([
    { id: "gpt-agent-host", displayName: "GPT Agent Host" }
  ], "gpt-agent-host", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" });

  assert.ok(model);
  assert.equal(model.isBYOK, true);
  assert.equal("targetChatSessionType" in model, false);
  assert.equal(/** @type {Record<string, unknown>} */ (model.capabilities).toolCalling, true);
  assert.equal(/** @type {Record<string, unknown>} */ (model.capabilities).agentMode, true);
});

test("languageModelInformationFromCodexModels can use model-provided auto-compact limits", () => {
  const [model] = languageModelInformationFromCodexModels([
    { id: "gpt-catalog", displayName: "GPT Catalog", contextWindow: 100_000, autoCompactTokenLimit: 64_000 }
  ], "gpt-catalog", { useModelDefaultCompactionLimit: true, compactionFallbackStrategy: "ninety-percent" });

  assert.equal(model.maxInputTokens, 83_616);
  assert.equal(model.maxOutputTokens, 16_384);
  const contextSize = /** @type {{ configurationSchema?: { properties?: Record<string, Record<string, unknown>> } }} */ (model).configurationSchema?.properties?.contextSize;
  assert.deepEqual(contextSize?.enum, [64_000, 83_616]);
  assert.deepEqual(contextSize?.enumItemLabels, ["64K", "83.6K"]);
  assert.equal(contextSize?.default, 64_000);
  assert.equal(contextSize?.group, "tokens");
});

test("languageModelInformationFromCodexModels can use server-advertised max context windows", () => {
  const [model] = languageModelInformationFromCodexModels([
    { id: "gpt-catalog", displayName: "GPT Catalog", contextWindow: 272_000, maxContextWindow: 1_000_000, autoCompactTokenLimit: null }
  ], "gpt-catalog", { useModelDefaultCompactionLimit: true, compactionFallbackStrategy: "ninety-percent" });

  assert.equal(model.maxInputTokens, 983_616);
  assert.equal(model.maxOutputTokens, 16_384);
  const contextSize = /** @type {{ configurationSchema?: { properties?: Record<string, Record<string, unknown>> } }} */ (model).configurationSchema?.properties?.contextSize;
  assert.deepEqual(contextSize?.enum, [255_616, 983_616]);
  assert.deepEqual(contextSize?.enumItemLabels, ["255.6K", "983.6K"]);
  assert.equal(contextSize?.default, 255_616);
  assert.equal(contextSize?.group, "tokens");
});

test("languageModelInformationFromCodexModels falls back to 90% without a model-provided limit", () => {
  const [model] = languageModelInformationFromCodexModels([
    { id: "gpt-catalog", displayName: "GPT Catalog", contextWindow: 100_000, autoCompactTokenLimit: null }
  ], "gpt-catalog", { useModelDefaultCompactionLimit: true, compactionFallbackStrategy: "ninety-percent" });

  assert.equal(model.maxInputTokens, 75_254);
  assert.equal(model.maxOutputTokens, 16_384);
  assert.ok(model.maxInputTokens + model.maxOutputTokens < 100_000);
});

test("languageModelInformationFromCodexModels uses full fallback without a model-provided limit", () => {
  const [model] = languageModelInformationFromCodexModels([
    { id: "gpt-catalog", displayName: "GPT Catalog", contextWindow: 100_000, autoCompactTokenLimit: null }
  ], "gpt-catalog", { useModelDefaultCompactionLimit: true, compactionFallbackStrategy: "full" });

  assert.equal(model.maxInputTokens, 83_616);
  assert.equal(model.maxOutputTokens, 16_384);
});

test("languageModelInformationFromCodexModels uses fallback when model-provided limits are disabled", () => {
  const [model] = languageModelInformationFromCodexModels([
    { id: "gpt-catalog", displayName: "GPT Catalog", contextWindow: 100_000, autoCompactTokenLimit: 64_000 }
  ], "gpt-catalog", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "full" });

  assert.equal(model.maxInputTokens, 83_616);
  assert.equal(model.maxOutputTokens, 16_384);
});

test("languageModelInformationFromCodexModels uses catalog image input metadata", () => {
  assert.deepEqual(languageModelInformationFromCodexModels([
    { id: "gpt-text-test", displayName: "Text Test" },
    { id: "gpt-image-test", displayName: "Image Test", imageInput: true },
    { id: "gpt-vision-test", displayName: "Vision Test", imageInput: false }
  ], "gpt-text-test", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" }), [
    modelInformation("gpt-text-test", "Text Test", "gpt-text-test", { imageInput: false }),
    modelInformation("gpt-image-test", "Image Test", "gpt-image-test", { imageInput: true }),
    modelInformation("gpt-vision-test", "Vision Test", "gpt-vision-test", { imageInput: false })
  ]);
});

test("languageModelInformationFromCodexModels exposes fast speed tiers as picker variants", () => {
  assert.deepEqual(languageModelInformationFromCodexModels([
    { id: "gpt-5.5", displayName: "GPT-5.5", additionalSpeedTiers: ["fast"] }
  ], "gpt-5.5", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" }), [
    modelInformation("gpt-5.5", "GPT-5.5", "gpt-5.5"),
    modelInformation("gpt-5.5:fast", "GPT-5.5 Fast", "gpt-5.5:fast")
  ]);
});

test("languageModelInformationFromCodexModels exposes catalog service tiers as picker variants", () => {
  assert.deepEqual(languageModelInformationFromCodexModels([
    {
      id: "gpt-tiered",
      displayName: "GPT Tiered",
      serviceTiers: [{ id: "priority", name: "Fast", description: "Priority processing." }],
      defaultServiceTier: "priority"
    }
  ], "gpt-tiered", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" }), [
    modelInformation("gpt-tiered", "GPT Tiered", "gpt-tiered"),
    modelInformation("gpt-tiered:fast", "GPT Tiered Fast", "gpt-tiered:fast")
  ]);
});

test("languageModelInformationFromCodexModels does not duplicate catalog fast variants", () => {
  assert.deepEqual(languageModelInformationFromCodexModels([
    { id: "gpt-5.5", displayName: "GPT-5.5", additionalSpeedTiers: ["fast"] },
    { id: "gpt-5.5:fast", displayName: "GPT-5.5 Fast" }
  ], "gpt-5.5", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" }), [
    modelInformation("gpt-5.5", "GPT-5.5", "gpt-5.5"),
    modelInformation("gpt-5.5:fast", "GPT-5.5 Fast", "gpt-5.5:fast")
  ]);
});

test("languageModelInformationFromCodexModels exposes navigation reasoning configuration schema", () => {
  const models = languageModelInformationFromCodexModels([
    {
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [
        { effort: "low", description: "Faster responses with less reasoning" },
        { effort: "medium", description: "Balanced reasoning and speed" },
        { effort: "high", description: "Greater reasoning depth but slower" },
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
        { effort: "ultra", description: "Maximum reasoning with automatic task delegation" }
      ],
      additionalSpeedTiers: ["fast"]
    }
  ], "gpt-5.5", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" });

  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, "gpt-5.5");
  assert.equal(models[1]?.id, "gpt-5.5:fast");
  const reasoningEffort = /** @type {{ configurationSchema?: { properties?: Record<string, Record<string, unknown>> } }} */ (models[0]).configurationSchema?.properties?.reasoningEffort;
  assert.deepEqual(reasoningEffort?.enum, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra"
  ]);
  assert.deepEqual(reasoningEffort?.enumItemLabels, [
    "Low",
    "Medium",
    "High",
    "Extra High",
    "Max",
    "Ultra"
  ]);
  assert.deepEqual(reasoningEffort?.enumDescriptions, [
    "Faster responses with less reasoning",
    "Balanced reasoning and speed",
    "Greater reasoning depth but slower",
    "Extra high reasoning depth for complex problems",
    "Maximum reasoning depth for the hardest problems",
    "Maximum reasoning with automatic task delegation"
  ]);
  assert.equal(reasoningEffort?.title, "Thinking Effort");
  assert.equal(reasoningEffort?.default, "medium");
  assert.equal(reasoningEffort?.group, "navigation");
  assert.equal(/** @type {{ configurationSchema?: { properties?: Record<string, unknown> } }} */ (models[0]).configurationSchema?.properties?.requestOptions, undefined);
});

test("languageModelInformationFromCodexModels uses default reasoning levels when catalog omits supported levels", () => {
  const [model] = languageModelInformationFromCodexModels([
    {
      id: "gpt-test",
      displayName: "GPT Test",
      defaultReasoningLevel: "xhigh",
      additionalSpeedTiers: ["fast"]
    }
  ], "gpt-test", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" });

  const reasoningEffort = /** @type {{ configurationSchema?: { properties?: Record<string, Record<string, unknown>> } }} */ (model).configurationSchema?.properties?.reasoningEffort;
  assert.deepEqual(reasoningEffort?.enum, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra"
  ]);
  const reasoningEffortLabels = /** @type {string[] | undefined} */ (reasoningEffort?.enumItemLabels);
  assert.equal(reasoningEffortLabels?.[3], "Extra High");
  assert.equal(reasoningEffort?.default, "xhigh");
});

test("languageModelInformationFromCodexModels exposes catalog-defined custom reasoning efforts", () => {
  const [model] = languageModelInformationFromCodexModels([{
    id: "gpt-future",
    displayName: "GPT Future",
    defaultReasoningLevel: "future",
    supportedReasoningLevels: [
      { effort: "medium", description: "Balanced" },
      { effort: "future", description: "Future model-defined effort" }
    ]
  }], "gpt-future", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" });

  const reasoningEffort = /** @type {{ configurationSchema?: { properties?: Record<string, Record<string, unknown>> } }} */ (model).configurationSchema?.properties?.reasoningEffort;
  assert.deepEqual(reasoningEffort?.enum, ["medium", "future"]);
  assert.deepEqual(reasoningEffort?.enumItemLabels, ["Medium", "future"]);
  assert.deepEqual(reasoningEffort?.enumDescriptions, ["Balanced", "Future model-defined effort"]);
  assert.equal(reasoningEffort?.default, "future");
});

test("languageModelInformationFromCodexModels uses advertised custom effort order for fallback defaults", () => {
  const [model] = languageModelInformationFromCodexModels([{
    id: "gpt-future-default",
    displayName: "GPT Future Default",
    supportedReasoningLevels: [
      { effort: "medium", description: "Balanced" },
      { effort: "future", description: "Future model-defined effort" }
    ]
  }], "gpt-future-default", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" });

  const reasoningEffort = /** @type {{ configurationSchema?: { properties?: Record<string, Record<string, unknown>> } }} */ (model).configurationSchema?.properties?.reasoningEffort;
  assert.equal(reasoningEffort?.default, "future");
});

test("languageModelInformationFromCodexModels omits configuration schema for unsupported reasoning models", () => {
  const [model] = languageModelInformationFromCodexModels([
    {
      id: "gpt-no-reasoning",
      displayName: "GPT No Reasoning",
      supportedReasoningLevels: [],
      supportsReasoningSummaries: false
    }
  ], "gpt-no-reasoning", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" });

  assert.equal(/** @type {{ configurationSchema?: unknown }} */ (model).configurationSchema, undefined);
});

test("languageModelInformationFromCodexModels keeps picker reasoning schema for external unsupported catalog models", () => {
  const [model] = languageModelInformationFromCodexModels([
    {
      id: "gpt-external-unsupported",
      displayName: "GPT External Unsupported",
      supportedInApi: false,
      defaultReasoningLevel: "high",
      supportedReasoningLevels: [
        { effort: "low", description: "Fast" },
        { effort: "high", description: "Deep" }
      ],
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "none"
    }
  ], "gpt-external-unsupported", { useModelDefaultCompactionLimit: false, compactionFallbackStrategy: "ninety-percent" });

  const reasoningEffort = /** @type {{ configurationSchema?: { properties?: Record<string, Record<string, unknown>> } }} */ (model).configurationSchema?.properties?.reasoningEffort;
  assert.deepEqual(reasoningEffort?.enum, ["low", "high"]);
  assert.equal(reasoningEffort?.default, "high");
});

test("codexInputFromLanguageModelMessages converts user and assistant text", () => {
  assert.deepEqual(codexInputFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "hello"),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.Assistant, "hi there"),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "   ")
  ], { LanguageModelChatMessageRole }), [
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
    { role: "assistant", content: [{ type: "output_text", text: "hi there" }] }
  ]);
});

test("codexRequestStateFromLanguageModelMessages promotes VS Code instruction preamble", () => {
  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, [
      "You are an expert AI programming assistant, working with a user in the VS Code editor.",
      "<instructions>",
      "Follow the user's requirements carefully.",
      "</instructions>",
      "<toolUseInstructions>",
      "Use tools when needed.",
      "</toolUseInstructions>"
    ].join("\n")),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "hello")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    instructions: [
      "You are an expert AI programming assistant, working with a user in the VS Code editor.",
      "<instructions>",
      "Follow the user's requirements carefully.",
      "</instructions>",
      "<toolUseInstructions>",
      "Use tools when needed.",
      "</toolUseInstructions>"
    ].join("\n"),
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello" }] }
    ]
  });
});

test("codexRequestStateFromLanguageModelMessages promotes instruction preamble with cache-control metadata", () => {
  const instructions = [
    "You are an expert AI programming assistant, working with a user in the VS Code editor.",
    "When asked for your name, you must respond with \"GitHub Copilot\".",
    "<instructions>",
    "Follow the user's requirements carefully.",
    "</instructions>",
    "<toolUseInstructions>",
    "Use tools when needed.",
    "</toolUseInstructions>"
  ].join("\n");

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelTextPart(instructions),
      new LanguageModelDataPart(new Uint8Array([1]), "cache_control")
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "hello")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    instructions,
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello" }] }
    ]
  });
});

test("codexRequestStateFromLanguageModelMessages keeps compaction prompt as user input", () => {
  const compactionPrompt = [
    "Your task is to create a comprehensive, detailed summary of the entire conversation that captures all essential information needed to seamlessly continue the work without any loss of context.",
    "This summary will be used to compact the conversation while preserving critical technical details, decisions, and progress.",
    "<analysis>",
    "Review the conversation.",
    "</analysis>"
  ].join("\n");

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, compactionPrompt)
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: compactionPrompt }] }
    ]
  });
});

test("codexInputFromLanguageModelMessages converts user image data parts", () => {
  assert.deepEqual(codexInputFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelTextPart("what is in this image?"),
      new LanguageModelDataPart(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), "image/png")
    ])
  ], { LanguageModelChatMessageRole }), [
    {
      role: "user",
      content: [
        { type: "input_text", text: "what is in this image?" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw==" }
      ]
    }
  ]);
});

test("codexInputFromLanguageModelMessages ignores non-image data parts", () => {
  assert.deepEqual(codexInputFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelTextPart("read this"),
      new LanguageModelDataPart(new TextEncoder().encode("plain text"), "text/plain")
    ])
  ], { LanguageModelChatMessageRole }), [
    { role: "user", content: [{ type: "input_text", text: "read this" }] }
  ]);
});

test("codexInputFromLanguageModelMessages ignores assistant image data parts", () => {
  assert.deepEqual(codexInputFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelTextPart("Here is an image."),
      new LanguageModelDataPart(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), "image/png")
    ])
  ], { LanguageModelChatMessageRole }), [
    { role: "assistant", content: [{ type: "output_text", text: "Here is an image." }] }
  ]);
});

test("codexInputFromLanguageModelMessages omits assistant reasoning summary parts from visible replay", () => {
  assert.deepEqual(codexInputFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelThinkingPart("**Continuing task.** Need update tests.", "rs-1:summary:0", {
        openai_event_type: "response.reasoning_summary_text.delta",
        openai_item_id: "rs-1"
      }),
      new LanguageModelTextPart("Preparing patch for language-model-provider.js.")
    ])
  ], { LanguageModelChatMessageRole }), [
    { role: "assistant", content: [{ type: "output_text", text: "Preparing patch for language-model-provider.js." }] }
  ]);
});

test("codexInputFromLanguageModelMessages preserves commentary thinking parts in visible replay", () => {
  assert.deepEqual(codexInputFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelThinkingPart("Planning descriptor copy.", "msg-plan:output:0", {
        openai_event_type: "response.output_text.delta",
        openai_item_id: "msg-plan",
        openai_phase: "commentary"
      })
    ])
  ], { LanguageModelChatMessageRole }), [
    { role: "assistant", content: [{ type: "output_text", text: "Planning descriptor copy." }] }
  ]);
});

test("codexInputFromLanguageModelMessages preserves commentary and final answer while omitting reasoning summary", () => {
  assert.deepEqual(codexInputFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelThinkingPart("Inspecting files.", "rs-1:summary:0", {
        openai_event_type: "response.reasoning_summary_text.delta",
        openai_item_id: "rs-1"
      }),
      new LanguageModelThinkingPart("Planning descriptor copy.", "msg-plan:output:0", {
        openai_event_type: "response.output_text.delta",
        openai_item_id: "msg-plan",
        openai_phase: "commentary"
      }),
      new LanguageModelTextPart("Done.")
    ])
  ], { LanguageModelChatMessageRole }), [
    {
      role: "assistant",
      content: [
        { type: "output_text", text: "Planning descriptor copy." },
        { type: "output_text", text: "Done." }
      ]
    }
  ]);
});

test("codexRequestStateFromLanguageModelMessages ignores legacy stateful marker items in message order", () => {
  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelTextPart("I will inspect the package."),
      new LanguageModelDataPart(new TextEncoder().encode(String.raw`other-model\resp-other`), COCOPI_STATEFUL_MARKER_MIME),
      statefulMarkerDataPart("gpt-test", [
        { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
        { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) }
      ]),
      new LanguageModelDataPart(new TextEncoder().encode(jsonString({ version: 1 })), "application/vnd.cocopi.responses-state+json"),
      new LanguageModelToolCallPart("call-1", "read_file", { path: "package.json" })
    ]),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))])
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "summarize it")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
      { role: "assistant", content: [{ type: "output_text", text: "I will inspect the package." }] },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
      { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) },
      { role: "user", content: [{ type: "input_text", text: "summarize it" }] }
    ]
  });
});

test("codexRequestStateFromLanguageModelMessages ignores hidden-progress-looking legacy marker text", () => {
  const logger = fakeLogger();

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [
        { role: "assistant", content: [{ type: "output_text", text: "**Continuing task.** Need update tests." }] }
      ])
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }, { debugLevel: "metadata", logger }), {
    input: []
  });
  assert.ok(logger.debugMessages.some((message) => message.includes("event=ignored") && message.includes("reason=legacy-marker-v1")));
});

test("codexRequestStateFromLanguageModelMessages migrates legacy v2 metadata markers", () => {
  const logger = fakeLogger();
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      legacyStatefulMarkerMetadataDataPart("gpt-test", { sessionId, hostRequestIndex: 4 }),
      new LanguageModelTextPart("visible answer")
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }, { debugLevel: "metadata", logger }), {
    input: [
      { role: "assistant", content: [{ type: "output_text", text: "visible answer" }] }
    ],
    sessionId,
    hostRequestIndex: 4
  });
  assert.ok(logger.debugMessages.some((message) => message.includes("event=migrated") && message.includes("fromVersion=2") && message.includes("toVersion=3")));
});

test("codexRequestStateFromLanguageModelMessages reads versioned v3 metadata markers", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      versionedStatefulMarkerMetadataDataPart("gpt-test", { sessionId }),
      new LanguageModelTextPart("continue")
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages rejects future marker versions", () => {
  const logger = fakeLogger();
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  const futureMarker = `${COCOPI_STATEFUL_MARKER_PREFIX}${base64UrlEncodeUtf8(JSON.stringify({ version: 4, sessionId }))}`;

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelDataPart(new TextEncoder().encode(`gpt-test\\${futureMarker}`), COCOPI_STATEFUL_MARKER_MIME),
      new LanguageModelTextPart("continue")
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }, { debugLevel: "metadata", logger }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ]
  });
  assert.ok(logger.debugMessages.some((message) => message.includes("event=decode-failed") && message.includes("reason=unsupported-state-version") && message.includes("version=4")));
});

test("codexRequestStateFromLanguageModelMessages ignores legacy marker replay items instead of sanitizing", () => {
  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [
        {
          role: "assistant",
          content: [{
            type: "output_text",
            text: "done",
            internal_chat_message_metadata_passthrough: { unexpected: true }
          }],
          phase: "final_answer",
          internal_chat_message_metadata_passthrough: { unexpected: true }
        },
        {
          type: "reasoning",
          id: "rs-1",
          encrypted_content: "encrypted-reasoning",
          internal_chat_message_metadata_passthrough: { unexpected: true }
        },
        {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: jsonString({ path: "package.json" }),
          internal_chat_message_metadata_passthrough: { unexpected: true }
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: jsonString({ name: "cocopi" }),
          internal_chat_message_metadata_passthrough: { unexpected: true }
        }
      ])
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ]
  });
});

test("codexRequestStateFromLanguageModelMessages drops unpaired tool replay items", () => {
  clearCocopiIssues();

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelToolCallPart("call-paired", "read_file", { path: "package.json" }),
      new LanguageModelToolCallPart("call-missing-output", "read_file", { path: "README.md" })
    ]),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart("call-paired", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))]),
      new LanguageModelToolResultPart("call-missing-call", [new LanguageModelTextPart("orphan output")])
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { type: "function_call", call_id: "call-paired", name: "read_file", arguments: jsonString({ path: "package.json" }) },
      { type: "function_call_output", call_id: "call-paired", output: jsonString({ name: "cocopi" }) }
    ]
  });

  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "tool-replay");
  assert.equal(issues[0].metadata.prunedToolCalls, 1);
  assert.equal(issues[0].metadata.prunedToolOutputs, 1);
});

test("codexRequestStateFromLanguageModelMessages restores the Cocopi session id from stateful markers", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", { sessionId })
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages restores the host request index from stateful markers", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", { sessionId, hostRequestIndex: 7 })
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId,
    hostRequestIndex: 7
  });
});

test("codexRequestStateFromLanguageModelMessages restores persistent continuation anchors", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  const firstUserItem = { role: "user", content: [{ type: "input_text", text: "first" }] };
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const anchor = codexContinuationAnchorFromInputItems("resp-one", [firstUserItem], [assistantItem]);

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "first"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", {
        sessionId,
        responseId: anchor.responseId,
        baselineItems: anchor.baselineItems,
        baselineDigest: anchor.baselineDigest
      }),
      new LanguageModelTextPart("done")
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "second")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      firstUserItem,
      assistantItem,
      { role: "user", content: [{ type: "input_text", text: "second" }] }
    ],
    sessionId,
    continuationAnchors: [anchor]
  });
});

test("codexRequestStateFromLanguageModelMessages restores compact v3 anchors from visible chat", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  const firstUserItem = { role: "user", content: [{ type: "input_text", text: "first" }] };
  const assistantItem = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const anchor = codexContinuationAnchorFromInputItems("resp-one", [firstUserItem], [assistantItem]);

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "first"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", {
        sessionId,
        responseId: anchor.responseId,
        baselineItems: anchor.baselineItems,
        baselineDigest: anchor.baselineDigest
      }),
      new LanguageModelTextPart("done")
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "second")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      firstUserItem,
      assistantItem,
      { role: "user", content: [{ type: "input_text", text: "second" }] }
    ],
    sessionId,
    continuationAnchors: [anchor]
  });
});

test("codexRequestStateFromLanguageModelMessages keeps only the newest restored persistent continuation anchor", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  const messages = [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "first")];
  const expectedInput = [
    { role: "user", content: [{ type: "input_text", text: "first" }] }
  ];
  /** @type {ReturnType<typeof codexContinuationAnchorFromInputItems>[]} */
  const anchors = [];

  for (let index = 0; index < 10; index += 1) {
    const assistantItem = { role: "assistant", content: [{ type: "output_text", text: `done ${index}` }] };
    const anchor = codexContinuationAnchorFromInputItems(`resp-${index}`, expectedInput, [assistantItem]);
    anchors.push(anchor);
    expectedInput.push(assistantItem);
    messages.push(fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", {
        sessionId,
        responseId: anchor.responseId,
        baselineItems: anchor.baselineItems,
        baselineDigest: anchor.baselineDigest
      }),
      new LanguageModelTextPart(`done ${index}`)
    ]));
  }

  const state = codexRequestStateFromLanguageModelMessages(messages, "gpt-test", { LanguageModelChatMessageRole });

  assert.deepEqual(state.input, expectedInput);
  assert.equal(state.sessionId, sessionId);
  assert.deepEqual(state.continuationAnchors?.map((anchor) => anchor.responseId), ["resp-9"]);
  assert.deepEqual(state.continuationAnchors?.map((anchor) => anchor.baselineItems), [anchors.at(-1)?.baselineItems]);
  assert.equal("input" in (state.continuationAnchors?.[0] ?? {}), false);
  assert.equal("responseItems" in (state.continuationAnchors?.[0] ?? {}), false);
});

test("codexRequestStateFromLanguageModelMessages carries stateful markers across model option changes", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelToolCallPart("call-1", "read_file", { path: "package.json" })
    ]),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      statefulMarkerMetadataDataPart("gpt-5.5:fast", { sessionId }),
      new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))])
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-5.5", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
      { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) },
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages restores Cocopi markers replayed on user messages", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      statefulMarkerMetadataDataPart("gpt-test", { sessionId })
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages restores session ids from empty Cocopi markers", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      statefulMarkerMetadataDataPart("gpt-test", { sessionId })
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages keeps assistant text beside empty Cocopi markers", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", { sessionId }),
      new LanguageModelTextPart("visible answer")
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "assistant", content: [{ type: "output_text", text: "visible answer" }] },
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages strips large legacy replay and migrates safe metadata", () => {
  const logger = fakeLogger();
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  const largeText = "x".repeat(70 * 1024);

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "first"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [
        { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
        { role: "assistant", content: [{ type: "output_text", text: largeText }] }
      ], { sessionId }),
      new LanguageModelTextPart(largeText)
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }, { debugLevel: "metadata", logger }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "first" }] },
      { role: "assistant", content: [{ type: "output_text", text: largeText }] },
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
  assert.ok(logger.debugMessages.some((message) => message.includes("event=migrated") && message.includes("fromVersion=1") && message.includes("droppedResponseItems=true")));
});

test("codexRequestStateFromLanguageModelMessages keeps compaction summaries in message order", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [
        { type: "reasoning", id: "rs-old", encrypted_content: "encrypted-reasoning" },
        { type: "function_call", call_id: "call-old", name: "read_file", arguments: jsonString({ path: "package.json" }) }
      ], { sessionId })
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "<conversation-summary>\nOld work was summarized.\n</conversation-summary>"),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }, { issueTracking: false }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
      { role: "user", content: [{ type: "input_text", text: "<conversation-summary>\nOld work was summarized.\n</conversation-summary>" }] },
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages restores v3 metadata beside compaction summaries", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  const anchor = codexContinuationAnchorFromInputItems("resp-old", [], []);

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      statefulMarkerMetadataDataPart("gpt-test", {
        sessionId,
        responseId: anchor.responseId,
        hostRequestIndex: 7,
        baselineItems: anchor.baselineItems,
        baselineDigest: anchor.baselineDigest
      }),
      new LanguageModelTextPart("<conversation-summary>\nOld work was summarized.\n</conversation-summary>")
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "<conversation-summary>\nOld work was summarized.\n</conversation-summary>" }] }
    ],
    sessionId,
    continuationAnchors: [anchor],
    hostRequestIndex: 7
  });
});

test("codexRequestStateFromLanguageModelMessages ignores invalid marker session ids", () => {
  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", { sessionId: "not-a-cocopi-session" })
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: []
  });
});

test("codexInputFromLanguageModelMessages preserves prior tool calls and results", () => {
  assert.deepEqual(codexInputFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelTextPart("I will inspect the package."),
      new LanguageModelToolCallPart("call-1", "read_file", { path: "package.json" })
    ]),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))])
    ])
  ], { LanguageModelChatMessageRole }), [
    { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
    { role: "assistant", content: [{ type: "output_text", text: "I will inspect the package." }] },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
    { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) }
  ]);
});

test("codexInputFromLanguageModelMessages serializes VS Code tool call input stably", () => {
  const first = codexInputFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelToolCallPart("call-1", "write_file", {
        path: "README.md",
        content: "hello",
        options: { z: true, a: 1 }
      })
    ]),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart("ok")])
    ])
  ], { LanguageModelChatMessageRole });
  const second = codexInputFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelToolCallPart("call-1", "write_file", {
        options: { a: 1, z: true },
        content: "hello",
        path: "README.md"
      })
    ]),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart("ok")])
    ])
  ], { LanguageModelChatMessageRole });

  assert.deepEqual(first, second);
  assert.deepEqual(first, [{
    type: "function_call",
    call_id: "call-1",
    name: "write_file",
    arguments: jsonString({ content: "hello", options: { a: 1, z: true }, path: "README.md" })
  }, {
    type: "function_call_output",
    call_id: "call-1",
    output: "ok"
  }]);
});

test("provideLanguageModelChatResponse restores v3 marker metadata without previous_response_id", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const progress = fakeProgress();
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000002";
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "done" }),
      sseData({ type: "response.completed", response: { id: "resp-2" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelTextPart("I will inspect the package."),
        statefulMarkerMetadataDataPart("gpt-test", { sessionId, hostRequestIndex: 7 }),
        new LanguageModelToolCallPart("call-1", "read_file", { path: "package.json" })
      ]),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))])
      ])
    ],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.prompt_cache_key, sessionId);
  assert.equal(body.client_metadata["x-cocopi-host-request-index"], "8");
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
    { role: "assistant", content: [{ type: "output_text", text: "I will inspect the package." }] },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
    { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) }
  ]);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(statefulMarkerPayloadFromDataPart(dataPart).sessionId, sessionId);
  assert.equal(statefulMarkerPayloadFromDataPart(dataPart).hostRequestIndex, 8);
  assertMetadataOnlyStatefulMarker(dataPart, 1);
});

test("provideLanguageModelChatResponse streams text parts", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "hel" }),
      sseData({ type: "response.output_text.delta", delta: "lo" }),
      sseData({ type: "response.completed", response: { id: "resp-hello" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
  ])), fakeVscode(configurationValues({ apiBaseUrl: "https://chatgpt.example.test/backend-api/codex", streamIdleTimeoutMs: 5000 })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say hello")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["hel", "lo"]);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(dataPart.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  const markerPayload = assertMetadataOnlyStatefulMarker(dataPart, 1);
  const body = JSON.parse(String(requestOptions?.body));
  const expectedAnchor = codexContinuationAnchorFromInputItems("resp-hello", body.input, [
    { role: "assistant", content: [{ type: "output_text", text: "hello" }] }
  ]);
  assert.equal(markerPayload.responseId, expectedAnchor.responseId);
  assert.equal(markerPayload.baselineItems, expectedAnchor.baselineItems);
  assert.equal(markerPayload.baselineDigest, expectedAnchor.baselineDigest);
  assert.equal(body.model, "gpt-test");
  assert.equal(body.stream, true);
  assert.match(body.prompt_cache_key, /^cocopi-language-model-[0-9a-f-]{36}$/u);
  assert.equal(body.client_metadata["x-cocopi-source"], "language-model");
  assert.equal(body.client_metadata["x-cocopi-host-request-index"], "1");
  assert.equal(body.client_metadata["x-cocopi-turn-id"], `${body.prompt_cache_key}:1`);
  assert.equal(body.client_metadata["x-codex-turn-metadata"], undefined);
  const headers = /** @type {Record<string, string>} */ (requestOptions?.headers);
  assert.deepEqual(JSON.parse(headers["x-codex-turn-metadata"]), {
    turn_id: `${body.prompt_cache_key}:1`,
    thread_source: "vscode",
    client: "cocopi",
    source: "language-model"
  });
  assert.equal(statefulMarkerPayloadFromDataPart(dataPart).sessionId, body.prompt_cache_key);
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "say hello" }] }]);
});

test("provideLanguageModelChatResponse reports usage for VS Code context usage", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "hello" }),
    sseData({
      type: "response.completed",
      response: {
        id: "resp-hello",
        usage: {
          input_tokens: 150,
          input_tokens_details: { cached_tokens: 75 },
          output_tokens: 12,
          output_tokens_details: { reasoning_tokens: 8 },
          total_tokens: 162
        }
      }
    })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say hello")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  const dataParts = progress.parts.filter((part) => part instanceof LanguageModelDataPart);
  assert.equal(dataParts[0]?.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  const usagePart = dataParts.find((part) => part.mimeType === VSCODE_LANGUAGE_MODEL_USAGE_MIME);
  assert.ok(usagePart instanceof LanguageModelDataPart);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(usagePart.data)), {
    prompt_tokens: 150,
    completion_tokens: 12,
    total_tokens: 162,
    prompt_tokens_details: { cached_tokens: 75 },
    completion_tokens_details: { reasoning_tokens: 8 }
  });
});

test("provideLanguageModelChatResponse streams tagged output text verbatim", async (testContext) => {
  const logger = fakeLogger();
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "<analysis>\nHidden" }),
    sseData({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: " analysis.\n</analysis>\n\n<summary>Hidden summary.</summary>\n\nVisible answer." }),
    sseData({ type: "response.output_item.done", item_id: "msg-1", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "<analysis>\nHidden analysis.\n</analysis>\n\n<summary>Hidden summary.</summary>\n\nVisible answer." }] } }),
    sseData({ type: "response.completed", response: { id: "resp-internal" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ debugLevel: "metadata" })), { logger });

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "answer")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), [
    "<analysis>\nHidden",
    " analysis.\n</analysis>\n\n<summary>Hidden summary.</summary>\n\nVisible answer."
  ]);
  assert.equal(logger.infoMessages.some((message) => /Parsed enhanced assistant output text/u.test(message)), false);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assertMetadataOnlyStatefulMarker(dataPart, 1);
});

test("provideLanguageModelChatResponse renders server-emitted reasoning without assistant output items", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Inspecting files." }),
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "Inspecting files." }], encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "off" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["<details open><summary>Thinking</summary>\n\n", "Inspecting files.", "\n\n</details>\n\n"]);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assertMetadataOnlyStatefulMarker(dataPart, 1);
});

test("provideLanguageModelChatResponse streams reasoning as native thinking when supported", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Inspecting files." }),
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "Inspecting files." }], encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), []);
  const thinkingParts = progress.parts.filter((part) => part instanceof LanguageModelThinkingPart);
  assert.deepEqual(thinkingParts.map((part) => part.value), ["Inspecting files.", ""]);
  assert.equal(thinkingParts[0].id, "rs-1:0");
  assert.deepEqual(thinkingParts[0].metadata, {
    openai_event_type: "response.reasoning_summary_text.delta",
    openai_item_id: "rs-1",
    openai_output_index: 0,
    openai_summary_index: 0
  });
  assert.equal(thinkingParts[1].id, "");
  assert.deepEqual(thinkingParts[1].metadata, { vscode_reasoning_done: true });
  assert.ok(progress.parts.some((part) => part instanceof LanguageModelDataPart));
});

test("provideLanguageModelChatResponse falls back when native thinking proposal access is denied", async (testContext) => {
  const progress = fakeProgress();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Inspecting files." }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPartDenied: true }), { logger });

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["<details open><summary>Thinking</summary>\n\n", "Inspecting files.", "\n\n</details>\n\n"]);
  assert.ok(logger.infoMessages.some((message) => message.includes("using text fallback") && message.includes("CANNOT use API proposal: languageModelThinkingPart")));
});

test("provideLanguageModelChatResponse strips exact standalone reasoning summary html comments", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "<!--" }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: " -->" }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "<!-- hidden -->" }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Inspecting files." }),
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "<!-- --><!-- hidden -->Inspecting files." }], encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), []);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelThinkingPart).map((part) => part.value), ["<!-- hidden -->", "Inspecting files.", ""]);
});

test("provideLanguageModelChatResponse strips split trailing reasoning summary html comment paragraphs", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "**heading**\n\n<!--" }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: " -->" }),
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "**heading**\n\n<!-- -->" }], encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), []);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelThinkingPart).map((part) => part.value), ["**heading**\n\n", ""]);
});

test("provideLanguageModelChatResponse routes commentary output as normal text when native thinking is supported", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { id: "msg-plan", type: "message", status: "in_progress", role: "assistant", phase: "commentary", content: [] }, output_index: 0 }),
    sseData({ type: "response.output_text.delta", item_id: "msg-plan", output_index: 0, content_index: 0, sequence_number: 2, delta: "Need maybe update descriptor_locations." }),
    sseData({ type: "response.output_item.done", item_id: "msg-plan", output_index: 0, item: { id: "msg-plan", type: "message", status: "completed", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Need maybe update descriptor_locations." }] } }),
    sseData({ type: "response.output_item.added", item: { id: "msg-final", type: "message", status: "in_progress", role: "assistant", phase: "final_answer", content: [] }, output_index: 1 }),
    sseData({ type: "response.output_text.delta", item_id: "msg-final", output_index: 1, content_index: 0, delta: "Done." }),
    sseData({ type: "response.output_item.done", item_id: "msg-final", output_index: 1, item: { id: "msg-final", type: "message", status: "completed", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] } }),
    sseData({ type: "response.completed", response: { id: "resp-commentary" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), [
    "Need maybe update descriptor_locations.",
    "\n\n",
    "Done."
  ]);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelThinkingPart), []);
});

test("provideLanguageModelChatResponse preserves exact standalone commentary html comments", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { id: "msg-plan", type: "message", status: "in_progress", role: "assistant", phase: "commentary", content: [] }, output_index: 0 }),
    sseData({ type: "response.output_text.delta", item_id: "msg-plan", output_index: 0, content_index: 0, delta: "<!-- -->" }),
    sseData({ type: "response.output_item.done", item_id: "msg-plan", output_index: 0, item: { id: "msg-plan", type: "message", status: "completed", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "<!-- -->" }] } }),
    sseData({ type: "response.completed", response: { id: "resp-commentary" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["<!-- -->"]);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelThinkingPart), []);
});

test("provideLanguageModelChatResponse keeps commentary output as normal text without native thinking support", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { id: "msg-plan", type: "message", status: "in_progress", role: "assistant", phase: "commentary", content: [] }, output_index: 0 }),
    sseData({ type: "response.output_text.delta", item_id: "msg-plan", output_index: 0, content_index: 0, delta: "Need maybe update descriptor_locations." }),
    sseData({ type: "response.output_item.done", item_id: "msg-plan", output_index: 0, item: { id: "msg-plan", type: "message", status: "completed", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Need maybe update descriptor_locations." }] } }),
    sseData({ type: "response.output_item.added", item: { id: "msg-final", type: "message", status: "in_progress", role: "assistant", phase: "final_answer", content: [] }, output_index: 1 }),
    sseData({ type: "response.output_text.delta", item_id: "msg-final", output_index: 1, content_index: 0, delta: "Done." }),
    sseData({ type: "response.completed", response: { id: "resp-commentary" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]])));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), [
    "Need maybe update descriptor_locations.",
    "\n\n",
    "Done."
  ]);
});

test("provideLanguageModelChatResponse keeps normal commentary before fallback reasoning", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { id: "msg-plan", type: "message", status: "in_progress", role: "assistant", phase: "commentary", content: [] }, output_index: 0 }),
    sseData({ type: "response.output_text.delta", item_id: "msg-plan", output_index: 0, content_index: 0, delta: "Planning descriptor copy." }),
    sseData({ type: "response.output_item.done", item_id: "msg-plan", output_index: 0, item: { id: "msg-plan", type: "message", status: "completed", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Planning descriptor copy." }] } }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 1, summary_index: 0, delta: "Checking file shape." }),
    sseData({ type: "response.completed", response: { id: "resp-commentary-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]])));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), [
    "Planning descriptor copy.",
    "<details open><summary>Thinking</summary>\n\n",
    "Checking file shape.",
    "\n\n</details>\n\n"
  ]);
});

test("provideLanguageModelChatResponse reports received reasoning summary deltas by default", async (testContext) => {
  const progress = fakeProgress();
  /** @type {RequestInit | undefined} */
  let responseRequestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      return Response.json({
        models: [{
          slug: "gpt-test",
          display_name: "GPT Test",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "medium", description: "Balanced" }
          ],
          supports_reasoning_summaries: true,
          default_reasoning_summary: "none"
        }]
      });
    }

    responseRequestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
      sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Inspecting files." }),
      sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "Inspecting files." }], encrypted_content: "encrypted-reasoning" } }),
      sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map(), { thinkingPart: true }));

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  const body = JSON.parse(String(responseRequestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), []);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelThinkingPart).map((part) => part.value), ["Inspecting files.", ""]);
  assert.ok(progress.parts.some((part) => part instanceof LanguageModelDataPart));
});

test("provideLanguageModelChatResponse separates native thinking summary parts", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_summary_part.added", item_id: "rs-1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "First section." }),
    sseData({ type: "response.reasoning_summary_part.done", item_id: "rs-1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "First section." } }),
    sseData({ type: "response.reasoning_summary_part.added", item_id: "rs-1", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "" } }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 1, delta: "Second section." }),
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "First section." }, { type: "summary_text", text: "Second section." }], encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  const thinkingParts = progress.parts.filter((part) => part instanceof LanguageModelThinkingPart);
  assert.deepEqual(thinkingParts.map((part) => part.value), ["First section.", "", "Second section.", ""]);
  assert.deepEqual(thinkingParts.map((part) => part.id), ["rs-1:0", "", "rs-1:1", ""]);
});

test("provideLanguageModelChatResponse streams reasoning text as native thinking", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_text.delta", item_id: "rs-1", output_index: 0, content_index: 0, delta: "Internal reasoning text.", sequence_number: 1 }),
    sseData({ type: "response.reasoning_text.done", item_id: "rs-1", output_index: 0, content_index: 0, text: "Internal reasoning text.", sequence_number: 2 }),
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  const thinkingParts = progress.parts.filter((part) => part instanceof LanguageModelThinkingPart);
  assert.deepEqual(thinkingParts.map((part) => part.value), ["Internal reasoning text.", ""]);
  assert.equal(thinkingParts[0].id, "rs-1:reasoning:0");
  assert.deepEqual(thinkingParts[0].metadata, {
    openai_event_type: "response.reasoning_text.delta",
    openai_item_id: "rs-1",
    openai_output_index: 0,
    openai_content_index: 0,
    openai_sequence_number: 1
  });
});

test("provideLanguageModelChatResponse renders reasoning summaries emitted by the server", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Inspecting files." }),
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "Inspecting files." }], encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ reasoningSummary: "off" }), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), []);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelThinkingPart).map((part) => part.value), ["Inspecting files.", ""]);
  assert.ok(progress.parts.some((part) => part instanceof LanguageModelDataPart));
});

test("provideLanguageModelChatResponse falls back to visible reasoning text when summaries are requested", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Inspecting files." }),
    sseData({ type: "response.output_text.delta", item_id: "msg-1", output_index: 1, content_index: 0, delta: "Done." }),
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "Inspecting files." }], encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]])));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), [
    "<details open><summary>Thinking</summary>\n\n",
    "Inspecting files.",
    "\n\n</details>\n\n",
    "Done."
  ]);
  assert.ok(progress.parts.some((part) => part instanceof LanguageModelDataPart));
});

test("provideLanguageModelChatResponse sends VS Code instruction preamble as top-level instructions", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const instructions = [
    "You are an expert AI programming assistant, working with a user in the VS Code editor.",
    "<instructions>",
    "Follow the user's requirements carefully.",
    "</instructions>",
    "<toolUseInstructions>",
    "Use tools when needed.",
    "</toolUseInstructions>"
  ].join("\n");
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, instructions),
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say hello")
    ],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.instructions, instructions);
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "say hello" }] }]);
});

test("provideLanguageModelChatResponse replaces VS Code instruction preamble when configured", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const sourceInstructions = [
    "You are an expert AI programming assistant, working with a user in the VS Code editor.",
    "<instructions>",
    "Follow the user's requirements carefully.",
    "</instructions>",
    "<toolUseInstructions>",
    "Use tools when needed.",
    "</toolUseInstructions>"
  ].join("\n");
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({
    chatInstructions: "Use concise replacement instructions.",
    chatInstructionsPlacement: "replace"
  })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
        new LanguageModelTextPart(sourceInstructions),
        new LanguageModelDataPart(new Uint8Array([1]), "cache_control")
      ]),
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say hello")
    ],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.instructions, "Use concise replacement instructions.");
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "say hello" }] }]);
});

test("provideLanguageModelChatResponse applies VS Code persisted modelConfiguration", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(), { logger });

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1, modelConfiguration: { reasoningEffort: "high", reasoningSummary: "detailed" } }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "high", summary: "detailed" });
  assert.ok(logger.infoMessages.some((message) => (
    /VS Code profile language model configuration applied\./u.test(message)
    && /modelConfigurationKeys=reasoningEffort,reasoningSummary/u.test(message)
    && /modelConfigurationReasoningEffort=high/u.test(message)
    && /modelConfigurationReasoningSummary=detailed/u.test(message)
  )));
});

test("provideLanguageModelChatResponse sends direct reasoning model options", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "medium", reasoningSummary: "concise" } }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "concise" });
});

test("provideLanguageModelChatResponse omits off reasoning summary", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "high", reasoningSummary: "off" } }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "high" });
});

test("provideLanguageModelChatResponse logs received model option values and changes", async (testContext) => {
  const logger = fakeLogger();
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000102";
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "ok" }),
    sseData({ type: "response.completed", response: { id: "resp-ok" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ serviceTier: "flex" })), { logger });
  const messages = [
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", { sessionId })
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")
  ];

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test:fast"),
    messages,
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "low", reasoningSummary: "concise" } }),
    fakeProgress(),
    fakeCancellationToken()
  );
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test:fast"),
    messages,
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "high", reasoningSummary: "detailed" } }),
    fakeProgress(),
    fakeCancellationToken()
  );

  assert.ok(logger.infoMessages.some((message) => (
    /VS Code language model options initial\./u.test(message)
    && /receivedModel=gpt-test:fast/u.test(message)
    && /codexModel=gpt-test/u.test(message)
    && /selectedReasoningEffort=low/u.test(message)
    && /resolvedServiceTier=priority/u.test(message)
    && /serviceTierSource=model/u.test(message)
  )));
  assert.ok(logger.infoMessages.some((message) => (
    /Cocopi effective language model state initial\./u.test(message)
    && /receivedModel=gpt-test:fast/u.test(message)
    && /selectedReasoningEffort=low/u.test(message)
    && /resolvedReasoningSummary=concise/u.test(message)
  )));
  assert.ok(logger.infoMessages.some((message) => (
    /Cocopi effective language model state changed\./u.test(message)
    && /selectedReasoningEffort=high/u.test(message)
    && /resolvedReasoningSummary=detailed/u.test(message)
    && /previous=/u.test(message)
  )));
  assert.ok(logger.infoMessages.some((message) => (
    /VS Code language model options changed\./u.test(message)
    && /selectedReasoningEffort=high/u.test(message)
    && /resolvedReasoningSummary=detailed/u.test(message)
    && /previous=/u.test(message)
  )));
});

test("provideLanguageModelChatResponse uses catalog default effort and auto summary when no effort is selected", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let responseRequestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      return Response.json({
        models: [{
          slug: "gpt-test",
          display_name: "GPT Test",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "medium", description: "Balanced" },
            { effort: "xhigh", description: "Deep work" }
          ]
        }]
      });
    }

    responseRequestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(responseRequestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
});

test("provideLanguageModelChatResponse omits summary when catalog reports no summary support", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let responseRequestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      return Response.json({
        models: [{
          slug: "gpt-no-summary-test",
          display_name: "GPT No Summary Test",
          default_reasoning_level: "xhigh",
          supported_reasoning_levels: [
            { effort: "medium", description: "Balanced" },
            { effort: "xhigh", description: "Deep work" }
          ],
          supports_reasoning_summaries: false,
          default_reasoning_summary: "detailed"
        }]
      });
    }

    responseRequestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ reasoningSummary: "detailed" })));

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-no-summary-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(responseRequestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "xhigh" });
});

test("provideLanguageModelChatResponse requests auto summary when catalog default is none", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let responseRequestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      return Response.json({
        models: [{
          slug: "gpt-default-no-summary-test",
          display_name: "GPT Default No Summary Test",
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "low", description: "Quick" },
            { effort: "high", description: "Deep" }
          ],
          supports_reasoning_summaries: true,
          default_reasoning_summary: "none"
        }]
      });
    }

    responseRequestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-default-no-summary-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(responseRequestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
});

test("provideLanguageModelChatResponse omits reasoning when catalog reports no reasoning support", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let responseRequestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      return Response.json(chatgptProCatalogFixture);
    }

    responseRequestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ reasoningEffort: "xhigh", reasoningSummary: "detailed" })));

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  const models = parseModelsResponse(chatgptProCatalogFixture);
  const unsupportedModel = models.find((model) => model.supportedInApi === false);
  assert.ok(unsupportedModel, "expected fixture to include a model marked unsupported in the external API");
  await provider.provideLanguageModelChatResponse(
    fakeModel(unsupportedModel.id),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "high", reasoningSummary: "detailed" } }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(responseRequestOptions?.body));
  assert.equal("reasoning" in body, false);
});

test("provideLanguageModelChatResponse matches reasoning request payload fixtures", async (testContext) => {
  /** @type {Record<string, unknown> | undefined} */
  let activeCatalog;
  /** @type {Record<string, unknown> | undefined} */
  let responseRequestBody;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      assert.ok(activeCatalog, "expected active catalog for model catalog request");
      return Response.json(activeCatalog);
    }

    responseRequestBody = JSON.parse(String(options.body));
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));

  const scenarios = [
    {
      fixture: "catalogDefaultReasoning",
      model: "gpt-fixture-reasoning",
      catalog: {
        models: [{
          slug: "gpt-fixture-reasoning",
          display_name: "GPT Fixture Reasoning",
          supported_in_api: true,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "medium", description: "Balanced" }
          ],
          supports_reasoning_summaries: true,
          default_reasoning_summary: "none"
        }]
      },
      responseOptions: fakeResponseOptions({ toolMode: 1 })
    },
    {
      fixture: "directLowConciseReasoning",
      model: "gpt-fixture-direct",
      responseOptions: fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "low", reasoningSummary: "concise" } })
    },
    {
      fixture: "nestedHighDetailedReasoning",
      model: "gpt-fixture-nested",
      responseOptions: fakeResponseOptions({
        toolMode: 1,
        modelOptions: {
          reasoning: {
            effort: "high",
            summary: "detailed"
          }
        }
      })
    },
    {
      fixture: "offSummaryReasoning",
      model: "gpt-fixture-off-summary",
      responseOptions: fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "high", reasoningSummary: "off" } })
    },
    {
      fixture: "legacyCatalogExplicitReasoning",
      model: "gpt-fixture-legacy-catalog",
      catalog: {
        models: [{
          slug: "gpt-fixture-legacy-catalog",
          display_name: "GPT Fixture Legacy Catalog",
          supported_in_api: true
        }]
      },
      responseOptions: fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "high", reasoningSummary: "detailed" } })
    },
    {
      fixture: "unsupportedCatalogOmitsReasoning",
      model: "gpt-fixture-unsupported",
      catalog: {
        models: [{
          slug: "gpt-fixture-unsupported",
          display_name: "GPT Fixture Unsupported",
          supported_in_api: false,
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "high", description: "Deep" }
          ],
          supports_reasoning_summaries: true,
          default_reasoning_summary: "detailed"
        }]
      },
      responseOptions: fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "high", reasoningSummary: "detailed" } })
    }
  ];

  for (const scenario of scenarios) {
    activeCatalog = scenario.catalog;
    responseRequestBody = undefined;
    const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
      [CODEX_SECRET_KEYS.accessToken, "access-token"],
      [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
      [CODEX_SECRET_KEYS.idToken, "id-token"]
    ])), fakeVscode());

    if (scenario.catalog) {
      await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
    }

    await provider.provideLanguageModelChatResponse(
      fakeModel(scenario.model),
      [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
      scenario.responseOptions,
      fakeProgress(),
      fakeCancellationToken()
    );

    assert.deepEqual(normalizeRequestPayloadForFixture(responseRequestBody), reasoningRequestPayloadFixtures[scenario.fixture], scenario.fixture);
  }
});

test("provideLanguageModelChatResponse does not apply model-specific summary rules before catalog load", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ reasoningEffort: "xhigh", reasoningSummary: "detailed" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-no-catalog-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningSummary: "detailed" } }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "detailed" });
});

test("provideLanguageModelChatResponse reads nested model reasoning options", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({
      toolMode: 1,
      modelOptions: {
        reasoning: {
          effort: "low",
          summary: "concise"
        }
      }
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "low", summary: "concise" });
});

test("provideLanguageModelChatResponse merges partial VS Code model option sources", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ debugLevel: "metadata", serviceTier: "flex" })), { logger });

  const responseOptions = /** @type {import("vscode").ProvideLanguageModelChatResponseOptions} */ ({
    requestInitiator: "cocopi.test",
    toolMode: 1,
    modelOptions: {
      reasoning: {
        effort: "low"
      }
    }
  });
  Reflect.set(responseOptions, "configuration", {
    serviceTier: "priority",
    reasoningSummary: "detailed"
  });

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    responseOptions,
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.service_tier, "priority");
  assert.deepEqual(body.reasoning, { effort: "low", summary: "detailed" });
  assert.ok(logger.debugMessages.some((message) => (
    /VS Code language model request options\./u.test(message)
    && /selectedReasoningEffort=low/u.test(message)
    && /selectedReasoningSummary=detailed/u.test(message)
    && /resolvedReasoningSummary=detailed/u.test(message)
  )));
  assert.ok(logger.infoMessages.some((message) => (
    /VS Code profile language model configuration applied\./u.test(message)
    && /configurationKeys=reasoningSummary,serviceTier/u.test(message)
    && /configurationReasoningSummary=detailed/u.test(message)
  )));
});

test("provideLanguageModelChatResponse keeps saved reasoning configuration over model option defaults", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  const responseOptions = /** @type {import("vscode").ProvideLanguageModelChatResponseOptions} */ ({
    requestInitiator: "cocopi.test",
    toolMode: 1,
    modelOptions: {
      reasoningEffort: "medium"
    }
  });
  Reflect.set(responseOptions, "configuration", {
    reasoningEffort: "xhigh"
  });

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    responseOptions,
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "auto" });
});

test("provideLanguageModelChatResponse sends configured service tier", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ serviceTier: "flex" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.service_tier, "flex");
});

test("provideLanguageModelChatResponse sends configured reasoning settings", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ reasoningEffort: "xhigh", reasoningSummary: "detailed" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "detailed" });
});

test("provideLanguageModelChatResponse lets model options override service tier", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ serviceTier: "flex" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    fakeResponseOptions({
      toolMode: 1,
      modelOptions: {
        serviceTier: "priority"
      }
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.service_tier, "priority");
});

test("provideLanguageModelChatResponse maps fast model variants to service tier", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-5.5:fast"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.service_tier, "priority");
});

test("provideLanguageModelChatResponse does not parse comma-separated modelConfiguration", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ reasoningEffort: "low", reasoningSummary: "concise", serviceTier: "flex" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-5.5"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    fakeResponseOptions({
      toolMode: 1,
      modelConfiguration: {
        reasoningEffort: "xhigh, detailed, fast"
      }
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.service_tier, "flex");
  assert.deepEqual(body.reasoning, { effort: "low", summary: "concise" });
});

test("provideLanguageModelChatResponse sends flat reasoning modelConfiguration", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ reasoningEffort: "low", reasoningSummary: "concise", serviceTier: "flex" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-5.5"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    fakeResponseOptions({
      toolMode: 1,
      modelConfiguration: {
        reasoningEffort: "xhigh"
      }
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.service_tier, "flex");
  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "concise" });
});

test("provideLanguageModelChatResponse maps fast option to service tier", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ serviceTier: "flex" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-5.5"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    fakeResponseOptions({
      toolMode: 1,
      modelOptions: {
        fast: "fast"
      }
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.service_tier, "priority");
});

test("provideLanguageModelChatResponse reads resolved model configuration", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ serviceTier: "flex" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    /** @type {import("vscode").ProvideLanguageModelChatResponseOptions} */ ({
      requestInitiator: "cocopi.test",
      toolMode: 1,
      modelOptions: {
        serviceTier: "priority",
        reasoningEffort: "minimal",
        reasoningSummary: "concise"
      }
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.service_tier, "priority");
  assert.deepEqual(body.reasoning, { effort: "minimal", summary: "concise" });
});

test("provideLanguageModelChatResponse supports proposed modelConfiguration", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "ok" }),
      sseData({ type: "response.completed", response: { id: "resp-ok" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ serviceTier: "flex" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "respond")],
    /** @type {import("vscode").ProvideLanguageModelChatResponseOptions} */ ({
      requestInitiator: "cocopi.test",
      toolMode: 1,
      modelConfiguration: {
        serviceTier: "priority",
        reasoningEffort: "minimal",
        reasoningSummary: "concise"
      }
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.service_tier, "priority");
  assert.deepEqual(body.reasoning, { effort: "minimal", summary: "concise" });
});

test("provideLanguageModelChatResponse logs token/cache summary for successful responses", async (testContext) => {
  clearCocopiTokenCacheDebugSummaries();
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "hello" }),
    sseData({ type: "response.completed", response: { id: "resp-hello", usage: { input_tokens: 150, input_tokens_details: { cached_tokens: 75 }, output_tokens: 4, total_tokens: 154 } } })
  ])));

  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ debugLevel: "metadata" })), { logger });

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test:fast"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say hello")],
    fakeResponseOptions({ toolMode: 1, modelOptions: { reasoningEffort: "xhigh", reasoningSummary: "detailed" } }),
    fakeProgress(),
    fakeCancellationToken()
  );

  assert.ok(logger.debugMessages.some((message) => /Codex token\/cache summary\./u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /source=language-model/u.test(message) && /hostRequest=1/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /conversationSummary=say_hello/u.test(message) && /conversationDescription=say_hello/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /cacheHitRatio=50.0/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /VS Code language model progress\..*textDeltas=1.*textBytes=5/u.test(message)));
  const [summary] = readCocopiTokenCacheDebugSummaries();
  assert.equal(summary?.conversationSummary, "say hello");
  assert.equal(summary?.conversationDescription, "say hello");
  assert.equal(summary?.selectedModel, "gpt-test:fast");
  assert.equal(summary?.model, "gpt-test");
  assert.equal(summary?.serviceTier, "priority");
  assert.equal(summary?.serviceTierSource, "model");
  assert.equal(summary?.reasoningEffort, "xhigh");
  assert.equal(summary?.reasoningSummary, "detailed");
  assert.equal(summary?.fastRequested, true);
});

test("provideLanguageModelChatResponse records tool-result continuations as separate token tracker rows", async (testContext) => {
  clearCocopiTokenCacheDebugSummaries();
  let fetchCalls = 0;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return eventStreamResponse([
        sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 0, call_id: "call-1", name: "create_file", arguments: jsonString({ content: "hello" }) }),
        sseData({ type: "response.output_item.done", item_id: "fc-1", output_index: 0, item: { type: "function_call", call_id: "call-1", name: "create_file", arguments: jsonString({ content: "hello" }) } }),
        sseData({ type: "response.completed", response: { id: "resp-tool", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 100, total_tokens: 1100 } } })
      ]);
    }

    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "done" }),
      sseData({ type: "response.completed", response: { id: "resp-done", usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 400 }, output_tokens: 50, total_tokens: 550 } } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());
  const firstProgress = fakeProgress();

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "create file")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "create_file", description: "Create a file.", inputSchema: { type: "object" } }] }),
    firstProgress,
    fakeCancellationToken()
  );

  const statefulMarker = firstProgress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(statefulMarker instanceof LanguageModelDataPart);

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "create file"),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
        statefulMarker,
        new LanguageModelToolCallPart("call-1", "create_file", { content: "hello" })
      ]),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart("created")])
      ])
    ],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const summaries = readCocopiTokenCacheDebugSummaries();
  const first = summaries.find((summary) => summary.hostRequestIndex === 1);
  const continuation = summaries.find((summary) => summary.hostRequestIndex === 2);
  assert.equal(summaries.length, 2);
  assert.equal(first?.inputTokens, 1000);
  assert.equal(first?.outputTokens, 100);
  assert.equal(first?.cachedTokens, 900);
  assert.equal(first?.billedTotalTokens, 200);
  assert.equal(first?.sessionCumulativeTokens, 200);
  assert.equal(first?.responseId, "resp-tool");
  assert.equal(continuation?.automaticContinuation, true);
  assert.equal(continuation?.inputTokens, 500);
  assert.equal(continuation?.outputTokens, 50);
  assert.equal(continuation?.cachedTokens, 400);
  assert.equal(continuation?.billedTotalTokens, 150);
  assert.equal(continuation?.sessionInitialTokens, 200);
  assert.equal(continuation?.sessionCumulativeTokens, 350);
  assert.equal(continuation?.responseId, "resp-done");
});

test("provideLanguageModelChatResponse emits metadata marker for completed output text", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "partial" }),
    sseData({ type: "response.completed", response: { id: "resp-complete", output_text: "complete" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say it")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(dataPart.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assertMetadataOnlyStatefulMarker(dataPart, 1);
});

test("provideLanguageModelChatResponse keeps large stateful markers metadata-only and replays visible text", async (testContext) => {
  const progress = fakeProgress();
  const largeText = "x".repeat(90 * 1024);
  /** @type {Record<string, unknown>[]} */
  const requestBodies = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestBodies.push(JSON.parse(String(options.body)));
    return requestBodies.length === 1
      ? eventStreamResponse([
        sseData({ type: "response.completed", response: { id: "resp-large", output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: largeText }] }] } })
      ])
      : eventStreamResponse([
        sseData({ type: "response.completed", response: { id: "resp-next", output_text: "next" } })
      ]);
  }));
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const provider = createCocopiLanguageModelProvider(context, fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say it")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(dataPart.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assert.ok(dataPart.data.byteLength <= 64 * 1024);
  const payload = statefulMarkerPayloadFromDataPart(dataPart);
  assert.equal(payload.version, 3);
  assert.equal(payload.responseItemCount, 1);
  assert.equal("responseItems" in payload, false);

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say it"),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [dataPart, new LanguageModelTextPart(largeText)]),
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
    ],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  assert.deepEqual(requestBodies[1].input, [
    { role: "user", content: [{ type: "input_text", text: "say it" }] },
    { role: "assistant", content: [{ type: "output_text", text: largeText }] },
    { role: "user", content: [{ type: "input_text", text: "continue" }] }
  ]);
});

test("provideLanguageModelChatResponse reports completed output text when deltas are absent", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.completed", response: { id: "resp-complete", output_text: "complete" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say it")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["complete"]);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(dataPart.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assertMetadataOnlyStatefulMarker(dataPart, 1);
});

test("provideLanguageModelChatResponse keeps completed output messages metadata-only", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "hello" }),
    sseData({ type: "response.completed", response: { id: "resp-message", output: [{ id: "msg-1", type: "message", status: "completed", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "hello" }] }] } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say hello")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["hello"]);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(dataPart.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assertMetadataOnlyStatefulMarker(dataPart, 1);
});

test("provideLanguageModelChatResponse emits metadata marker for phased output items", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.done", item_id: "msg-1", output_index: 0, item: { type: "message", status: "completed", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "I will inspect the files." }] } }),
    sseData({ type: "response.completed", response: { id: "resp-message" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "inspect")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["I will inspect the files."]);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(dataPart.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assertMetadataOnlyStatefulMarker(dataPart, 1);
});

test("provideLanguageModelChatResponse emits stateful marker after hidden reasoning output", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.completed", response: { id: "resp-reasoning" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think")],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  const [part] = progress.parts;
  assert.ok(part instanceof LanguageModelDataPart);
  assert.equal(part.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assertMetadataOnlyStatefulMarker(part, 1);
});

test("provideLanguageModelChatResponse serializes stateful marker payload canonically", async (testContext) => {
  const progressA = fakeProgress();
  const progressB = fakeProgress();
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  const messages = [
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerMetadataDataPart("gpt-test", { sessionId })
    ])
  ];
  const outputItems = [
    { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "same" }], encrypted_content: "encrypted-reasoning" },
    { encrypted_content: "encrypted-reasoning", summary: [{ text: "same", type: "summary_text" }], id: "rs-1", type: "reasoning" }
  ];
  let fetchCall = 0;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    const item = outputItems[fetchCall++] ?? outputItems.at(-1);
    return eventStreamResponse([
      sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item }),
      sseData({ type: "response.completed", response: { id: `resp-reasoning-${fetchCall}` } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    messages,
    fakeResponseOptions({ toolMode: 1 }),
    progressA,
    fakeCancellationToken()
  );
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    messages,
    fakeResponseOptions({ toolMode: 1 }),
    progressB,
    fakeCancellationToken()
  );

  const [partA] = progressA.parts;
  const [partB] = progressB.parts;
  assert.ok(partA instanceof LanguageModelDataPart);
  assert.ok(partB instanceof LanguageModelDataPart);
  assert.equal(normalizedStatefulMarkerJsonFromDataPart(partA), normalizedStatefulMarkerJsonFromDataPart(partB));
  assertMetadataOnlyStatefulMarker(partA, 1);
});

test("provideLanguageModelChatResponse emits stateful marker before visible tool calls", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.done", item_id: "rs-1", output_index: 0, item: { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" } }),
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 1, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }),
    sseData({ type: "response.output_item.done", item_id: "fc-1", output_index: 1, item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) } }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "read_file", description: "Read a workspace file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  assert.equal(progress.parts.length, 3);
  assert.ok(progress.parts[0] instanceof LanguageModelDataPart);
  assert.equal(progress.parts[0].mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assertMetadataOnlyStatefulMarker(progress.parts[0], 2);
  assert.ok(progress.parts[1] instanceof LanguageModelToolCallPart);
  assert.ok(progress.parts[2] instanceof LanguageModelDataPart);
  assertMetadataOnlyStatefulMarker(progress.parts[2], 2);
});

test("provideLanguageModelChatResponse flushes normal commentary before tool calls", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { id: "msg-plan", type: "message", status: "in_progress", role: "assistant", phase: "commentary", content: [] }, output_index: 0 }),
    sseData({ type: "response.output_text.delta", item_id: "msg-plan", output_index: 0, content_index: 0, delta: "Planning tool call." }),
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 1, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "read_file", description: "Read a workspace file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  const commentaryTextIndex = progress.parts.findIndex((part) => part instanceof LanguageModelTextPart && part.value === "Planning tool call.");
  const toolCallIndex = progress.parts.findIndex((part) => part instanceof LanguageModelToolCallPart);
  assert.notEqual(commentaryTextIndex, -1);
  assert.notEqual(toolCallIndex, -1);
  assert.ok(commentaryTextIndex < toolCallIndex);
});

test("provideLanguageModelChatResponse ignores malformed duplicate output item tool arguments", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 0, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }),
    sseData({ type: "response.output_item.done", item_id: "fc-1", output_index: 0, item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"README.md" } }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "read_file", description: "Read a workspace file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  assert.equal(progress.parts.length, 3);
  assert.ok(progress.parts[0] instanceof LanguageModelDataPart);
  assertMetadataOnlyStatefulMarker(progress.parts[0], 1);
  assert.deepEqual(progress.parts[1], new LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }));
  assert.ok(progress.parts[2] instanceof LanguageModelDataPart);
  assertMetadataOnlyStatefulMarker(progress.parts[2], 1);
});

test("provideLanguageModelChatResponse pins blank runSubagent model input", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 0, call_id: "call-1", name: "runSubagent", arguments: jsonString({ description: "Search code", model: "", prompt: "Find the relevant files" }) }),
    sseData({ type: "response.completed", response: { id: "resp-subagent" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-5.5", "GPT-5.5"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "delegate it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "runSubagent", description: "Run a subagent.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  const toolCall = progress.parts.find((part) => part instanceof LanguageModelToolCallPart);
  assert.ok(toolCall instanceof LanguageModelToolCallPart);
  assert.deepEqual(toolCall.input, {
    description: "Search code",
    model: "GPT-5.5 (cocopi)",
    prompt: "Find the relevant files"
  });
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assertMetadataOnlyStatefulMarker(dataPart, 1);
});

test("provideLanguageModelChatResponse translates Ultra into Max with proactive runSubagent guidance", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      return Response.json({
        models: [{
          slug: "gpt-5.6-sol",
          multi_agent_version: "v2",
          supports_parallel_tool_calls: true
        }]
      });
    }

    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.completed", response: { id: "resp-ultra" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-5.6-sol", "GPT-5.6 Sol"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "delegate when useful")],
    fakeResponseOptions({
      toolMode: 2,
      modelOptions: { reasoningEffort: "ultra" },
      tools: [{ name: "runSubagent", description: "Run a subagent.", inputSchema: { type: "object" } }]
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "max", summary: "auto" });
  assert.notEqual(body.reasoning.effort, "ultra");
  assert.match(body.instructions, /Proactive multi-agent delegation is active/u);
  assert.match(body.instructions, /`runSubagent` tool/u);
  assert.equal(body.parallel_tool_calls, true);
  const headers = new Headers(requestOptions?.headers);
  assert.equal(headers.has("x-openai-subagent"), false);
  assert.equal(headers.has("x-codex-parent-thread-id"), false);
});

test("provideLanguageModelChatResponse honors explicit and unknown multi-agent selectors", async (testContext) => {
  /** @type {RequestInit[]} */
  const responseRequests = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      return Response.json({
        models: [
          { slug: "gpt-v1", multi_agent_version: "v1", supports_parallel_tool_calls: true },
          { slug: "gpt-disabled", multi_agent_version: "disabled", supports_parallel_tool_calls: true },
          { slug: "gpt-unknown", supports_parallel_tool_calls: true }
        ]
      });
    }

    responseRequests.push(options);
    return eventStreamResponse([
      sseData({ type: "response.completed", response: { id: `resp-${responseRequests.length}` } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  for (const modelId of ["gpt-v1", "gpt-disabled", "gpt-unknown"]) {
    await provider.provideLanguageModelChatResponse(
      fakeModel(modelId),
      [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "delegate when useful")],
      fakeResponseOptions({
        toolMode: 2,
        modelOptions: { reasoningEffort: "ultra" },
        tools: [{ name: "runSubagent", description: "Run a subagent.", inputSchema: { type: "object" } }]
      }),
      fakeProgress(),
      fakeCancellationToken()
    );
  }

  assert.equal(responseRequests.length, 3);
  for (const options of responseRequests.slice(0, 2)) {
    const body = JSON.parse(String(options.body));
    assert.deepEqual(body.reasoning, { effort: "max", summary: "auto" });
    assert.doesNotMatch(body.instructions ?? "", /Proactive multi-agent delegation is active/u);
    assert.equal(body.parallel_tool_calls, false);
  }
  const unknownBody = JSON.parse(String(responseRequests[2].body));
  assert.match(unknownBody.instructions, /Proactive multi-agent delegation is active/u);
  assert.equal(unknownBody.parallel_tool_calls, true);
});

test("provideLanguageModelChatResponse uses serial Ultra guidance when parallel tools are unsupported", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let responseRequest;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    if (String(url).includes("/models?")) {
      return Response.json({
        models: [{
          slug: "gpt-v2-serial",
          multi_agent_version: "v2",
          supports_parallel_tool_calls: false
        }]
      });
    }

    responseRequest = options;
    return eventStreamResponse([
      sseData({ type: "response.completed", response: { id: "resp-v2-serial" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatInformation({ silent: false }, fakeCancellationToken());
  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-v2-serial"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "delegate when useful")],
    fakeResponseOptions({
      toolMode: 2,
      modelOptions: { reasoningEffort: "ultra" },
      tools: [{ name: "runSubagent", description: "Run a subagent.", inputSchema: { type: "object" } }]
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(responseRequest?.body));
  assert.match(body.instructions, /delegate one task at a time/u);
  assert.doesNotMatch(body.instructions, /host can run them in parallel/u);
  assert.equal(body.parallel_tool_calls, false);
});

test("provideLanguageModelChatResponse maps Ultra to Max without unavailable subagent guidance", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.completed", response: { id: "resp-ultra-no-subagent" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-5.6-sol", "GPT-5.6 Sol"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "work alone")],
    fakeResponseOptions({
      toolMode: 1,
      modelOptions: { reasoningEffort: "ultra" },
      tools: [{ name: "read_file", description: "Read a file.", inputSchema: { type: "object" } }]
    }),
    fakeProgress(),
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.reasoning, { effort: "max", summary: "auto" });
  assert.doesNotMatch(body.instructions ?? "", /Proactive multi-agent delegation is active/u);
  assert.equal(body.parallel_tool_calls, false);
});

test("provideLanguageModelChatResponse lets VS Code render tool starts without synthetic thinking", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", output_index: 1, sequence_number: 794, item: { id: "fc-1", type: "function_call", status: "in_progress", arguments: "", call_id: "call-1", name: "read_file" } }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 795, delta: "{\"" }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 796, delta: "path" }),
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 1, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map(), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "read_file", description: "Read a file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  const thinkingParts = progress.parts.filter((part) => part instanceof LanguageModelThinkingPart);
  assert.deepEqual(thinkingParts.map((part) => part.value), []);
  assert.ok(progress.parts.some((part) => part instanceof LanguageModelToolCallPart));
});

test("provideLanguageModelChatResponse reports file creation target while create_file arguments stream", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", output_index: 1, sequence_number: 794, item: { id: "fc-1", type: "function_call", status: "in_progress", arguments: "", call_id: "call-1", name: "create_file" } }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 795, delta: String.raw`{"filePath":"C:\\Users\\clsho\\Documents\\GitHub\\cocopi\\story.md"` }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 796, delta: String.raw`,"content":"hello` }),
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 1, call_id: "call-1", name: "create_file", arguments: jsonString({ filePath: String.raw`C:\Users\clsho\Documents\GitHub\cocopi\story.md`, content: "hello" }) }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map(), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "create it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "create_file", description: "Create a file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  const thinkingParts = progress.parts.filter((part) => part instanceof LanguageModelThinkingPart);
  const thinkingValues = thinkingParts.map((part) => part.value).filter(Boolean);
  assert.deepEqual(thinkingValues, ["Preparing file creation for story.md."]);
  assert.equal(new Set(thinkingParts.filter((part) => part.value).map((part) => part.id)).size, thinkingValues.length);
  const targetThinkingIndex = progress.parts.findIndex((part) => part instanceof LanguageModelThinkingPart && part.value === "Preparing file creation for story.md.");
  const firstToolIndex = progress.parts.findIndex((part) => part instanceof LanguageModelToolCallPart);
  assert.notEqual(targetThinkingIndex, -1);
  assert.ok(firstToolIndex > targetThinkingIndex);
});

test("provideLanguageModelChatResponse reports patch preparation while patch arguments stream", async (testContext) => {
  const progress = fakeProgress();
  const editInput = "*** Begin Patch\n*** Update File: src/story.md\n@@\n-old\n+new\n*** End Patch\n";
  const largePatchDelta = `\n+${"x".repeat(2400)}`;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", output_index: 1, sequence_number: 794, item: { id: "fc-1", type: "function_call", status: "in_progress", arguments: "", call_id: "call-1", name: "apply_patch" } }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 795, delta: String.raw`{"input":"*** Begin Patch\n*** Update File: src/story.md` }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 796, delta: String.raw`\n@@` }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 797, delta: largePatchDelta }),
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 1, call_id: "call-1", name: "apply_patch", arguments: jsonString({ input: editInput }) }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map(), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "edit it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "apply_patch", description: "Edit a file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  const thinkingParts = progress.parts.filter((part) => part instanceof LanguageModelThinkingPart);
  const thinkingValues = thinkingParts.map((part) => part.value).filter(Boolean);
  assert.deepEqual(thinkingValues, ["Preparing patch for story.md.", "Generating patch for story.md (3 KB streamed)."]);
  assert.equal(new Set(thinkingParts.filter((part) => part.value).map((part) => part.id)).size, thinkingValues.length);
  const targetThinkingIndex = progress.parts.findIndex((part) => part instanceof LanguageModelThinkingPart && part.value === "Preparing patch for story.md.");
  const firstToolIndex = progress.parts.findIndex((part) => part instanceof LanguageModelToolCallPart);
  assert.notEqual(targetThinkingIndex, -1);
  assert.ok(firstToolIndex > targetThinkingIndex);
});

test("provideLanguageModelChatResponse reports timed progress while patch arguments stream slowly", async (testContext) => {
  const progress = fakeProgress();
  const editInput = "*** Begin Patch\n*** Update File: src/story.md\n@@\n-old\n+new\n*** End Patch\n";
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => delayedEventStreamResponse([
    sseData({ type: "response.output_item.added", output_index: 1, sequence_number: 794, item: { id: "fc-1", type: "function_call", status: "in_progress", arguments: "", call_id: "call-1", name: "apply_patch" } }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 795, delta: String.raw`{"input":"*** Begin Patch\n*** Update File: src/story.md\n@@` })
  ], [
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 1, call_id: "call-1", name: "apply_patch", arguments: jsonString({ explanation: "Update file.", input: editInput }) }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ], 2300)));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ editProgressIntervalMs: 2000 }), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "edit it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "apply_patch", description: "Edit a file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  const thinkingValues = progress.parts
    .filter((part) => part instanceof LanguageModelThinkingPart)
    .map((part) => part.value)
    .filter(Boolean);
  assert.ok(thinkingValues.includes("Preparing patch for story.md."));
  assert.ok(thinkingValues.some((value) => typeof value === "string" && /^Generating patch for story\.md \(\d+ chars streamed, 2s elapsed\)\.$/u.test(value)));
});

test("provideLanguageModelChatResponse reports insertEdit target while arguments stream", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", output_index: 1, sequence_number: 794, item: { id: "fc-1", type: "function_call", status: "in_progress", arguments: "", call_id: "call-1", name: "copilot_insertEdit" } }),
    sseData({ type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 1, sequence_number: 795, delta: String.raw`{"explanation":"Update greeting.","filePath":"C:\\Users\\clsho\\Documents\\GitHub\\cocopi\\src\\index.js"` }),
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 1, call_id: "call-1", name: "copilot_insertEdit", arguments: jsonString({ explanation: "Update greeting.", filePath: String.raw`C:\Users\clsho\Documents\GitHub\cocopi\src\index.js`, code: "// ...existing code...\nconsole.log('hi');" }) }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map(), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "edit it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "copilot_insertEdit", description: "Edit a file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  const thinkingValues = progress.parts
    .filter((part) => part instanceof LanguageModelThinkingPart)
    .map((part) => part.value)
    .filter(Boolean);
  assert.deepEqual(thinkingValues, ["Preparing edit for index.js."]);
});

test("provideLanguageModelChatResponse keeps native thinking open through tool calls", async (testContext) => {
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1" }, output_index: 0 }),
    sseData({ type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "Inspecting files." }),
    sseData({ type: "response.output_item.added", output_index: 1, item: { id: "fc-1", type: "function_call", status: "in_progress", arguments: "", call_id: "call-1", name: "read_file" } }),
    sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 1, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }),
    sseData({ type: "response.completed", response: { id: "resp-tool" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(new Map([["reasoningSummary", "detailed"]]), { thinkingPart: true }));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read it")],
    fakeResponseOptions({ toolMode: 2, tools: [{ name: "read_file", description: "Read a workspace file.", inputSchema: { type: "object" } }] }),
    progress,
    fakeCancellationToken()
  );

  const firstThinkingIndex = progress.parts.findIndex((part) => part instanceof LanguageModelThinkingPart);
  const firstToolIndex = progress.parts.findIndex((part) => part instanceof LanguageModelToolCallPart);
  const firstThinkingDoneIndex = progress.parts.findIndex((part) => part instanceof LanguageModelThinkingPart && part.value === "");
  assert.notEqual(firstThinkingIndex, -1);
  assert.ok(firstToolIndex > firstThinkingIndex);
  assert.ok(firstThinkingDoneIndex > firstToolIndex);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelThinkingPart).map((part) => part.value), ["Inspecting files.", ""]);
});

test("provideLanguageModelChatResponse sends image input content", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([sseData({ type: "response.completed", response: {} })]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelTextPart("describe"),
      new LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/jpeg")
    ])],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  assert.deepEqual(JSON.parse(String(requestOptions?.body)).input, [{
    role: "user",
    content: [
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: "data:image/jpeg;base64,AQID" }
    ]
  }]);
});

test("provideLanguageModelChatResponse sends tools and streams tool calls from arguments done events", async (testContext) => {
  const logger = fakeLogger();
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.function_call_arguments.done", item_id: "item-1", output_index: 0, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }),
      sseData({ type: "response.completed", response: { id: "resp-arguments-done" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ debugLevel: "metadata" })), { logger });

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read it")],
    fakeResponseOptions({
      toolMode: 2,
      tools: [{
        name: "read_file",
        description: "Read a workspace file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
      }]
    }),
    progress,
    fakeCancellationToken()
  );

  assert.ok(progress.parts[0] instanceof LanguageModelDataPart);
  assert.equal(progress.parts[0].mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assertMetadataOnlyStatefulMarker(progress.parts[0], 1);
  assert.deepEqual(progress.parts[1], new LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }));
  assert.ok(logger.debugMessages.some((message) => /VS Code language model tool call reported\..*callId=call-1.*name=read_file.*inputKeys=path/u.test(message)));
  const body = JSON.parse(String(requestOptions?.body));
  assert.deepEqual(body.tools, [{
    type: "function",
    name: "read_file",
    description: "Read a workspace file.",
    parameters: { additionalProperties: false, type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    strict: true
  }]);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.stream, true);
  assert.equal(body.parallel_tool_calls, false);
  assert.ok(requestOptions);
  assert.equal(/** @type {Record<string, string>} */ (requestOptions.headers).Accept, "text/event-stream");
});

test("provideLanguageModelChatResponse rewrites VS Code tool completion summaries", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.output_text.delta", delta: "Done." }),
      sseData({ type: "response.completed", response: { id: "resp-tool-description" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "finish")],
    fakeResponseOptions({
      toolMode: 2,
      tools: [{
        name: "task_complete",
        description: "Do not restate the summary in your message text — it is shown to the user directly.",
        inputSchema: { type: "object" }
      }]
    }),
    progress,
    fakeCancellationToken()
  );

  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.tools[0].description, "Put the concise user-visible completion summary in this tool's summary field. It is shown as normal assistant text, so do not emit the same summary separately before calling the tool.");
});

test("provideLanguageModelChatResponse renders task completion without a model follow-up", async (testContext) => {
  const fetchMock = testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("terminal task completion must not reach Codex");
  }));
  const progress = fakeProgress();
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "finish"),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart("call-complete", "task_complete", { summary: "Completed successfully." })
      ]),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart("call-complete", [new LanguageModelTextPart("Completed successfully.")])
      ])
    ],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["Completed successfully."]);
});

test("provideLanguageModelChatResponse does not duplicate a completion summary already visible", async (testContext) => {
  const fetchMock = testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("terminal task completion must not reach Codex");
  }));
  const progress = fakeProgress();
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "finish"),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelTextPart("Completed successfully."),
        new LanguageModelToolCallPart("call-complete", "task_complete", { summary: "Completed successfully." })
      ]),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart("call-complete", [new LanguageModelTextPart("Completed successfully.")])
      ])
    ],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(progress.parts, []);
});

test("provideLanguageModelChatResponse requests a follow-up when task completion has no visible summary", async (testContext) => {
  const fetchMock = testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "Generated final response." }),
    sseData({ type: "response.completed", response: { id: "resp-follow-up" } })
  ])));
  const progress = fakeProgress();
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "finish"),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart("call-complete", "task_complete", {})
      ]),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart("call-complete", [new LanguageModelTextPart("Task completed.")])
      ])
    ],
    fakeResponseOptions({ toolMode: 1 }),
    progress,
    fakeCancellationToken()
  );

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), ["Generated final response."]);
});

test("provideLanguageModelChatResponse streams auto tool-capable requests on custom endpoints", async (testContext) => {
  /** @type {RequestInit | undefined} */
  let requestOptions;
  const progress = fakeProgress();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (_url, options = {}) => {
    requestOptions = options;
    return eventStreamResponse([
      sseData({ type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 0, call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }),
      sseData({ type: "response.completed", response: { id: "resp-auto-tool" } })
    ]);
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ apiBaseUrl: "https://example.test/codex" })));

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read it if needed")],
    fakeResponseOptions({
      toolMode: 1,
      tools: [{
        name: "read_file",
        description: "Read a workspace file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
      }]
    }),
    progress,
    fakeCancellationToken()
  );

  assert.deepEqual(progress.parts.find((part) => part instanceof LanguageModelToolCallPart), new LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }));
  const body = JSON.parse(String(requestOptions?.body));
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.stream, true);
  assert.ok(requestOptions);
  assert.equal(/** @type {Record<string, string>} */ (requestOptions.headers).Accept, "text/event-stream");
});

test("provideLanguageModelChatResponse logs debug metadata and rejects terminal failures", async (testContext) => {
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.completed", response: { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 } }, new_field: true } }),
    sseData({ type: "response.failed", error: { message: "backend failed" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ debugLevel: "metadata" })), { logger });

  await assert.rejects(
    async () => provider.provideLanguageModelChatResponse(fakeModel("gpt-test"), [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "hello")], fakeResponseOptions({ toolMode: 1 }), fakeProgress(), fakeCancellationToken()),
    /** @param {Error} error */ (error) => /Cocopi request failed/.test(error.message)
  );
  assert.ok(logger.debugMessages.some((message) => /VS Code language model messages/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /Codex request input\..*inputItems=1/u.test(message)));
  assert.ok(logger.debugMessages.some((message) => /unknownKeys=new_field/u.test(message) && /cachedTokens=4/u.test(message)));
  assert.ok(logger.errorMessages.some((message) => /Cocopi language model request failed/u.test(message)));
  assert.ok(logger.errorMessages.some((message) => /backend failed/u.test(message)));
});

test("provideLanguageModelChatResponse logs incoming tool call and result ids", async (testContext) => {
  const logger = fakeLogger();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.completed", response: { id: "resp-tool-result" } })
  ])));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(configurationValues({ debugLevel: "metadata" })), { logger });

  await provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart("call-1", "run_in_terminal", { command: "npm test" })
      ]),
      fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart("passed")])
      ]),
      fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
    ],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    fakeCancellationToken()
  );

  assert.ok(logger.debugMessages.some((message) => /VS Code language model messages\..*toolCallParts=1.*toolResultParts=1.*toolCallIds=call-1:run_in_terminal.*toolResultIds=call-1/u.test(message)));
});

test("provideLanguageModelChatResponse logs VS Code cancellation without surfacing an error", async (testContext) => {
  const logger = fakeLogger();
  const token = fakeCancellationToken();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => eventStreamResponse([
    sseData({ type: "response.output_text.delta", delta: "partial" })
  ], { close: false })));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode(), { logger });

  const responsePromise = provider.provideLanguageModelChatResponse(
    fakeModel("gpt-test"),
    [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "hello")],
    fakeResponseOptions({ toolMode: 1 }),
    fakeProgress(),
    token
  );
  await nextMacrotask();
  token.cancel();

  await responsePromise;
  assert.ok(logger.infoMessages.some((message) => /VS Code cancellation event received\..*source=language-model/u.test(message)));
  assert.deepEqual(logger.errorMessages, []);
});

test("provideLanguageModelChatResponse rejects when signed out", async () => {
  const provider = createCocopiLanguageModelProvider(fakeContext(), fakeVscode());

  await assert.rejects(
    async () => provider.provideLanguageModelChatResponse(fakeModel("gpt-test"), [], fakeResponseOptions({ toolMode: 1 }), fakeProgress(), fakeCancellationToken()),
    /Cocopi is not signed in/u
  );
});

test("provideLanguageModelChatResponse maps Codex failures to language model errors", async (testContext) => {
  clearCocopiIssues();
  clearCocopiTokenCacheDebugSummaries();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("Codex Responses request failed with status 429");
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await assert.rejects(
    async () => provider.provideLanguageModelChatResponse(fakeModel("gpt-test"), [], fakeResponseOptions({ toolMode: 1 }), fakeProgress(), fakeCancellationToken()),
    /** @param {Error & { code?: string }} error */ (error) => error.code === "Blocked"
  );

  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "token-cache");
  assert.equal(issues[0].title, "Codex request did not include usage counters");
  assert.equal(issues[0].metadata.source, "language-model");
  assert.equal(readCocopiTokenCacheDebugSummaries().length, 0);
});

test("provideLanguageModelChatResponse records issues for missing instructions errors", async (testContext) => {
  clearCocopiIssues();
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("Codex Responses WebSocket request failed; with status 400; message=Instructions are required");
  }));
  const provider = createCocopiLanguageModelProvider(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ])), fakeVscode());

  await assert.rejects(
    async () => provider.provideLanguageModelChatResponse(
      fakeModel("gpt-test"),
      [fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "say hello")],
      fakeResponseOptions({ toolMode: 1 }),
      fakeProgress(),
      fakeCancellationToken()
    ),
    /Cocopi request failed/u
  );

  const issues = readCocopiIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "response-stream");
  assert.equal(issues[0].metadata.source, "language-model");
  assert.equal(issues[0].metadata.transport, "sse");
  assert.equal(issues[0].metadata.hasTopLevelInstructions, false);
});

test("languageModelErrorFromCodexError maps common provider failure classes", () => {
  assert.equal(languageModelErrorFromCodexError(new Error("failed with status 401"), fakeAbortSignal(), fakeVscode()).code, "NoPermissions");
  assert.equal(languageModelErrorFromCodexError(new Error("failed with status 404"), fakeAbortSignal(), fakeVscode()).code, "NotFound");
  const rateLimitError = languageModelErrorFromCodexError(new Error("failed with status 429"), fakeAbortSignal(), fakeVscode());
  assert.equal(rateLimitError.code, "Blocked");
  assert.match(rateLimitError.message, /rate limited.*status 429/u);
  const idleError = languageModelErrorFromCodexError(new Error("Codex Responses WebSocket stream was idle for 120000ms."), fakeAbortSignal(), fakeVscode());
  assert.equal(idleError.code, "Blocked");
  assert.equal(idleError.message, "Cocopi request timed out waiting for Codex stream activity (idle for 120000ms).");
  const stalePreviousResponseError = languageModelErrorFromCodexError(new Error("Codex Responses WebSocket request failed; with status 400; code=previous_response_not_found; message=Previous response with id 'resp-missing' not found."), fakeAbortSignal(), fakeVscode());
  assert.equal(stalePreviousResponseError.code, undefined);
  assert.match(stalePreviousResponseError.message, /previous response id/u);
  assert.equal(languageModelErrorFromCodexError(new Error("transport broke"), fakeAbortSignal(), fakeVscode()).message, "Cocopi request failed: transport broke");
  const reasoningError = languageModelErrorFromCodexError({ error: { message: "Reasoning is not supported for this model." } }, fakeAbortSignal(), fakeVscode());
  assert.ok(reasoningError.message.includes("Reasoning is not supported for this model"));
  assert.equal(reasoningError.code, undefined);
});

test("provideTokenCount returns a stable rough count", async () => {
  const provider = createCocopiLanguageModelProvider(fakeContext(), fakeVscode());

  assert.equal(await provider.provideTokenCount(fakeModel("gpt-test"), "12345678", fakeCancellationToken()), 2);
});

test("provideTokenCount ignores large legacy Cocopi stateful marker replay cost", async () => {
  const provider = createCocopiLanguageModelProvider(fakeContext(), fakeVscode());
  const largeText = "x".repeat(70 * 1024);
  /** @type {import("../data/Codex.js").CodexResponseInputItem[]} */
  const responseItems = [
    { role: "assistant", content: [{ type: "output_text", text: largeText }] }
  ];
  const message = fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
    new LanguageModelTextPart("ok"),
    statefulMarkerDataPart("gpt-test", responseItems)
  ]);

  assert.equal(
    await provider.provideTokenCount(fakeModel("gpt-test"), message, fakeCancellationToken()),
    Math.ceil("ok".length / 4)
  );
});

test("provideTokenCount does not decode Cocopi stateful marker replay cost", async () => {
  const provider = createCocopiLanguageModelProvider(fakeContext(), fakeVscode());
  /** @type {import("../data/Codex.js").CodexResponseInputItem[]} */
  const responseItems = [
    { type: "reasoning", id: "rs-1", encrypted_content: "x".repeat(400) },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
    { role: "assistant", content: [{ type: "output_text", text: "done" }] }
  ];
  const message = fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
    new LanguageModelTextPart("ok"),
    statefulMarkerDataPart("gpt-test", responseItems)
  ]);

  assert.equal(
    await provider.provideTokenCount(fakeModel("gpt-test"), message, fakeCancellationToken()),
    Math.ceil("ok".length / 4)
  );
});

test("provideTokenCount ignores Cocopi stateful markers across model option changes", async () => {
  const provider = createCocopiLanguageModelProvider(fakeContext(), fakeVscode());
  /** @type {import("../data/Codex.js").CodexResponseInputItem[]} */
  const responseItems = [
    { type: "reasoning", id: "rs-1", encrypted_content: "x".repeat(400) }
  ];
  const message = fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
    new LanguageModelTextPart("ok"),
    statefulMarkerDataPart("gpt-5.5:fast", responseItems)
  ]);

  assert.equal(
    await provider.provideTokenCount(fakeModel("gpt-5.5"), message, fakeCancellationToken()),
    Math.ceil("ok".length / 4)
  );
});

/**
 * @param {Map<string, string>} [secrets]
 * @param {{ onStore?: (key: string, value: string) => void, fireSecretChanges?: boolean, getError?: Error, globalState?: Map<string, unknown> }} [options]
 */
function fakeContext(secrets = new Map(), options = {}) {
  /** @type {Set<(event: { key: string }) => void>} */
  const secretListeners = new Set();
  const fireSecretChange = (/** @type {string} */ key) => {
    if (!options.fireSecretChanges) {
      return;
    }

    for (const listener of secretListeners) {
      listener({ key });
    }
  };
  const secretStorage = {
    /** @param {string} key */
    async get(key) {
      if (options.getError) {
        throw options.getError;
      }
      return secrets.get(key);
    },
    /**
     * @param {string} key
     * @param {string} value
     */
    async store(key, value) {
      secrets.set(key, value);
      options.onStore?.(key, value);
      fireSecretChange(key);
    },
    /** @param {string} key */
    async delete(key) {
      secrets.delete(key);
      fireSecretChange(key);
    }
  };
  if (options.fireSecretChanges) {
    Object.assign(secretStorage, {
      onDidChange(/** @type {(event: { key: string }) => void} */ listener) {
        secretListeners.add(listener);
        return {
          dispose() {
            secretListeners.delete(listener);
          }
        };
      }
    });
  }

  return {
    subscriptions: [],
    secrets: secretStorage,
    globalState: {
      /** @param {string} key */
      get(key) {
        return options.globalState?.get(key);
      },
      /**
       * @param {string} key
       * @param {readonly string[]} value
       */
      async update(key, value) {
        options.globalState?.set(key, value);
      }
    }
  };
}

/**
 * @param {Map<string, string | number | boolean>} [configuration]
 * @param {{ warningSelection?: string, thinkingPart?: boolean, thinkingPartDenied?: boolean }} [options]
 */
function fakeVscode(configuration = new Map(), options = {}) {
  const vscode = {
    languageModelVendor: "",
    /** @type {import("vscode").LanguageModelChatProvider | undefined} */
    languageModelProvider: undefined,
    /** @type {string[]} */
    warningMessages: [],
    /** @type {string[]} */
    executedCommands: [],
    commands: {
      /** @param {string} command */
      async executeCommand(command) {
        vscode.executedCommands.push(command);
      }
    },
    lm: {
      /**
       * @param {string} vendor
       * @param {import("vscode").LanguageModelChatProvider} provider
       */
      registerLanguageModelChatProvider(vendor, provider) {
        vscode.languageModelVendor = vendor;
        vscode.languageModelProvider = provider;
        return { dispose() {} };
      }
    },
    LanguageModelTextPart,
    ...(options.thinkingPart || options.thinkingPartDenied
      ? { LanguageModelThinkingPart: options.thinkingPartDenied ? DeniedLanguageModelThinkingPart : LanguageModelThinkingPart }
      : {}),
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelDataPart,
    LanguageModelChatToolMode,
    LanguageModelChatMessageRole,
    LanguageModelError,
    workspace: {
      /** @param {string} [section] */
      getConfiguration(section) {
        return {
          /**
           * @template T
           * @param {string} key
           * @param {T} defaultValue
           * @returns {T}
           */
          get(key, defaultValue) {
            const qualifiedKey = section ? `${section}.${key}` : key;
            if (key === "transport" && !configuration.has(qualifiedKey) && !configuration.has(key)) {
              return /** @type {T} */ ("sse");
            }
            return /** @type {T} */ (configuration.get(qualifiedKey) ?? configuration.get(key) ?? defaultValue);
          }
        };
      }
    },
    window: {
      /**
       * @param {string} message
       * @returns {Promise<string | undefined>}
       */
      async showWarningMessage(message) {
        vscode.warningMessages.push(message);
        return options.warningSelection;
      }
    }
  };

  return vscode;
}

/**
 * @param {Record<string, string | number | boolean>} record
 */
function configurationValues(record) {
  /** @type {Map<string, string | number | boolean>} */
  const values = new Map();
  for (const [key, value] of Object.entries(record)) {
    values.set(key, value);
  }

  return values;
}

/**
 * @param {number} role
 * @param {string} text
 */
function fakeLanguageModelMessage(role, text) {
  return fakeLanguageModelMessageFromParts(role, [new LanguageModelTextPart(text)]);
}

/**
 * @param {number} role
 * @param {import("vscode").LanguageModelChatRequestMessage["content"]} content
 */
function fakeLanguageModelMessageFromParts(role, content) {
  return /** @type {import("vscode").LanguageModelChatRequestMessage} */ ({
    role,
    content,
    name: undefined
  });
}

/**
 * @param {string} id
 * @param {string} [name]
 */
function fakeModel(id, name = id) {
  return /** @type {import("vscode").LanguageModelChatInformation} */ ({
    id,
    name,
    family: "codex",
    version: id,
    maxInputTokens: 111_616,
    maxOutputTokens: 16_384,
    capabilities: {}
  });
}

function fakeProgress() {
  return {
    /** @type {import("vscode").LanguageModelResponsePart[]} */
    parts: [],
    /** @param {import("vscode").LanguageModelResponsePart} part */
    report(part) {
      this.parts.push(part);
    }
  };
}

/**
 * @param {Omit<import("vscode").ProvideLanguageModelChatResponseOptions, "requestInitiator"> & { requestInitiator?: string }} options
 * @returns {import("vscode").ProvideLanguageModelChatResponseOptions}
 */
function fakeResponseOptions(options) {
  return {
    requestInitiator: "cocopi.test",
    ...options
  };
}

/**
 * @param {string} modelId
 * @param {import("../data/Codex.js").CodexResponseInputItem[]} responseItems
 * @param {{ sessionId?: string, responseId?: string, requestState?: Record<string, import("../data/Codex.js").CodexJsonValue>, hostRequestIndex?: number }} [options]
 */
function statefulMarkerDataPart(modelId, responseItems, options = {}) {
  return new LanguageModelDataPart(new TextEncoder().encode(`${modelId}\\${encodeStatefulMarkerPayload(responseItems, options)}`), COCOPI_STATEFUL_MARKER_MIME);
}

/**
 * @param {string} modelId
 * @param {{ sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} [options]
 */
function statefulMarkerMetadataDataPart(modelId, options = {}) {
  return new LanguageModelDataPart(new TextEncoder().encode(`${modelId}\\${encodeStatefulMarkerMetadataPayload(options)}`), COCOPI_STATEFUL_MARKER_MIME);
}

/**
 * @param {string} modelId
 * @param {{ sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} [options]
 */
function legacyStatefulMarkerMetadataDataPart(modelId, options = {}) {
  return new LanguageModelDataPart(new TextEncoder().encode(`${modelId}\\${encodeLegacyStatefulMarkerMetadataPayload(options)}`), COCOPI_STATEFUL_MARKER_MIME);
}

/**
 * @param {string} modelId
 * @param {{ sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} [options]
 */
function versionedStatefulMarkerMetadataDataPart(modelId, options = {}) {
  return new LanguageModelDataPart(new TextEncoder().encode(`${modelId}\\${encodeVersionedStatefulMarkerMetadataPayload(options)}`), COCOPI_STATEFUL_MARKER_MIME);
}

/** @param {LanguageModelDataPart} part */
function statefulMarkerPayloadFromDataPart(part) {
  const payload = JSON.parse(statefulMarkerJsonFromDataPart(part));
  assert.ok(payload.version === 1 || payload.version === 2 || payload.version === 3);
  return payload;
}

/**
 * @param {LanguageModelDataPart} part
 * @param {number} [responseItemCount]
 */
function assertMetadataOnlyStatefulMarker(part, responseItemCount) {
  assert.ok(statefulMarkerFromDataPart(part).startsWith(COCOPI_STATEFUL_MARKER_PREFIX));
  const payload = statefulMarkerPayloadFromDataPart(part);
  assert.equal(payload.version, 3);
  assert.equal("responseItems" in payload, false);
  if (responseItemCount !== undefined) {
    assert.equal(payload.responseItemCount, responseItemCount);
  }
  return payload;
}

/** @param {LanguageModelDataPart} part */
function normalizedStatefulMarkerJsonFromDataPart(part) {
  return statefulMarkerJsonFromDataPart(part)
    .replace(/"sessionId":"[^"]+"/, "\"sessionId\":\"<session>\"")
    .replace(/"responseId":"[^"]+"/, "\"responseId\":\"<response>\"")
    .replace(/"hostRequestIndex":\d+/, "\"hostRequestIndex\":0");
}

/** @param {LanguageModelDataPart} part */
function statefulMarkerJsonFromDataPart(part) {
  const marker = statefulMarkerFromDataPart(part);
  const prefix = statefulMarkerPayloadPrefix(marker);
  return base64UrlDecodeUtf8(marker.slice(prefix.length));
}

/** @param {LanguageModelDataPart} part */
function statefulMarkerFromDataPart(part) {
  const text = new TextDecoder().decode(part.data);
  const separatorIndex = text.indexOf("\\");
  assert.notEqual(separatorIndex, -1);
  const marker = text.slice(separatorIndex + 1);
  assert.ok(
    marker.startsWith(COCOPI_LEGACY_STATEFUL_MARKER_PAYLOAD_PREFIX)
      || marker.startsWith(COCOPI_LEGACY_STATEFUL_MARKER_METADATA_PREFIX)
      || marker.startsWith(COCOPI_VERSIONED_STATEFUL_MARKER_METADATA_PREFIX)
      || marker.startsWith(COCOPI_STATEFUL_MARKER_PREFIX)
  );
  return marker;
}

/** @param {string} marker */
function statefulMarkerPayloadPrefix(marker) {
  if (marker.startsWith(COCOPI_LEGACY_STATEFUL_MARKER_PAYLOAD_PREFIX)) {
    return COCOPI_LEGACY_STATEFUL_MARKER_PAYLOAD_PREFIX;
  }
  if (marker.startsWith(COCOPI_LEGACY_STATEFUL_MARKER_METADATA_PREFIX)) {
    return COCOPI_LEGACY_STATEFUL_MARKER_METADATA_PREFIX;
  }
  if (marker.startsWith(COCOPI_VERSIONED_STATEFUL_MARKER_METADATA_PREFIX)) {
    return COCOPI_VERSIONED_STATEFUL_MARKER_METADATA_PREFIX;
  }
  return COCOPI_STATEFUL_MARKER_PREFIX;
}

/**
 * @param {import("../data/Codex.js").CodexResponseInputItem[]} responseItems
 * @param {{ sessionId?: string, responseId?: string, requestState?: Record<string, import("../data/Codex.js").CodexJsonValue>, hostRequestIndex?: number }} [options]
 */
function encodeStatefulMarkerPayload(responseItems, options = {}) {
  /** @type {{ version: number, responseItems: import("../data/Codex.js").CodexResponseInputItem[], sessionId?: string, responseId?: string, requestState?: Record<string, import("../data/Codex.js").CodexJsonValue>, hostRequestIndex?: number }} */
  const payload = {
    version: 1,
    responseItems
  };
  if (options.sessionId) {
    payload.sessionId = options.sessionId;
  }
  if (options.responseId) {
    payload.responseId = options.responseId;
  }
  if (options.requestState) {
    payload.requestState = options.requestState;
  }
  if (options.hostRequestIndex) {
    payload.hostRequestIndex = options.hostRequestIndex;
  }

  return `${COCOPI_LEGACY_STATEFUL_MARKER_PAYLOAD_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(payload))}`;
}

/**
 * @param {{ sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} [options]
 */
function encodeStatefulMarkerMetadataPayload(options = {}) {
  /** @type {{ version: number, sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} */
  const payload = { version: 3 };
  if (options.sessionId) {
    payload.sessionId = options.sessionId;
  }
  if (options.responseId) {
    payload.responseId = options.responseId;
  }
  if (options.hostRequestIndex) {
    payload.hostRequestIndex = options.hostRequestIndex;
  }
  if (options.responseItemCount) {
    payload.responseItemCount = options.responseItemCount;
  }
  if (options.baselineItems !== undefined && options.baselineDigest) {
    payload.baselineItems = options.baselineItems;
    payload.baselineDigest = options.baselineDigest;
  }

  return `${COCOPI_STATEFUL_MARKER_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(payload))}`;
}

/**
 * @param {{ sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} [options]
 */
function encodeVersionedStatefulMarkerMetadataPayload(options = {}) {
  /** @type {{ version: number, sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} */
  const payload = { version: 3 };
  if (options.sessionId) {
    payload.sessionId = options.sessionId;
  }
  if (options.responseId) {
    payload.responseId = options.responseId;
  }
  if (options.hostRequestIndex) {
    payload.hostRequestIndex = options.hostRequestIndex;
  }
  if (options.responseItemCount) {
    payload.responseItemCount = options.responseItemCount;
  }
  if (options.baselineItems !== undefined && options.baselineDigest) {
    payload.baselineItems = options.baselineItems;
    payload.baselineDigest = options.baselineDigest;
  }

  return `${COCOPI_VERSIONED_STATEFUL_MARKER_METADATA_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(payload))}`;
}

/**
 * @param {{ sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} [options]
 */
function encodeLegacyStatefulMarkerMetadataPayload(options = {}) {
  /** @type {{ version: number, sessionId?: string, responseId?: string, hostRequestIndex?: number, responseItemCount?: number, baselineItems?: number, baselineDigest?: string }} */
  const payload = { version: 2 };
  if (options.sessionId) {
    payload.sessionId = options.sessionId;
  }
  if (options.responseId) {
    payload.responseId = options.responseId;
  }
  if (options.hostRequestIndex) {
    payload.hostRequestIndex = options.hostRequestIndex;
  }
  if (options.responseItemCount) {
    payload.responseItemCount = options.responseItemCount;
  }
  if (options.baselineItems !== undefined && options.baselineDigest) {
    payload.baselineItems = options.baselineItems;
    payload.baselineDigest = options.baselineDigest;
  }

  return `${COCOPI_LEGACY_STATEFUL_MARKER_METADATA_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(payload))}`;
}

/** @param {string} text */
function base64UrlEncodeUtf8(text) {
  return btoa(String.fromCodePoint(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** @param {string} value */
function base64UrlDecodeUtf8(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return new TextDecoder().decode(bytes);
}

/** @param {Record<string, unknown>} payload */
function fakeJwt(payload) {
  return [
    base64UrlEncodeUtf8(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64UrlEncodeUtf8(JSON.stringify(payload)),
    "signature"
  ].join(".");
}

function fakeLogger() {
  return {
    /** @type {string[]} */
    debugMessages: [],
    /** @type {string[]} */
    infoMessages: [],
    /** @type {string[]} */
    errorMessages: [],
    /** @param {string} message */
    debug(message) {
      this.debugMessages.push(message);
    },
    /** @param {string} message */
    info(message) {
      this.infoMessages.push(message);
    },
    /**
     * @param {string} message
     * @param {Error | string | object | null | undefined} [error]
     */
    error(message, error) {
      this.errorMessages.push(message);
      if (error instanceof Error) {
        this.errorMessages.push(error.stack || `${error.name}: ${error.message}`);
      } else if (error) {
        this.errorMessages.push(String(error));
      }
    },
    dispose() {}
  };
}

/**
 * @param {string} id
 * @param {string} name
 * @param {string} [detail]
 * @param {{ contextWindow?: number, tooltip?: string, imageInput?: boolean, fast?: boolean }} [options]
 */
function modelInformation(id, name, detail = id, options = {}) {
  void options.fast;
  const contextWindow = options.contextWindow ?? 128_000;
  const maxOutputTokens = Math.min(16_384, contextWindow - 1);
  return {
    id,
    name,
    family: "codex",
    tooltip: options.tooltip ? `Cocopi - ${options.tooltip}` : "Remote Codex through Cocopi",
    detail: `Cocopi - ${detail}`,
    version: id,
    isBYOK: true,
    isUserSelectable: true,
    maxInputTokens: Math.max(1, Math.floor((contextWindow - maxOutputTokens) * 0.9)),
    maxOutputTokens,
    capabilities: {
      imageInput: options.imageInput ?? false,
      toolCalling: true,
      agentMode: true
    }
  };
}

function fakeAbortSignal() {
  return /** @type {AbortSignal} */ ({ aborted: false });
}

async function nextMacrotask() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function fakeCancellationToken() {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return /** @type {import("vscode").CancellationToken & { cancel(): void }} */ ({
    isCancellationRequested: false,
    /** @param {() => void} listener */
    onCancellationRequested(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        }
      };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners) {
        listener();
      }
    }
  });
}

/** @param {Record<string, unknown> | undefined} requestPayload */
function normalizeRequestPayloadForFixture(requestPayload) {
  assert.ok(requestPayload, "expected request payload");
  const payload = structuredClone(requestPayload);
  payload.prompt_cache_key = "<session-id>";
  if (payload.client_metadata && typeof payload.client_metadata === "object" && !Array.isArray(payload.client_metadata)) {
    const metadata = /** @type {Record<string, unknown>} */ (payload.client_metadata);
    metadata["x-cocopi-session-id"] = "<session-id>";
    metadata["x-cocopi-turn-id"] = "<session-id>:1";
    metadata["x-codex-turn-metadata"] = JSON.stringify({
      turn_id: "<session-id>:1",
      thread_source: "vscode",
      client: "cocopi",
      source: "language-model"
    });
  }

  return payload;
}

/**
 * @param {string[]} chunks
 * @param {{ close?: boolean }} [options]
 */
function eventStreamResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (options.close !== false) {
        controller.close();
      }
    }
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

/**
 * @param {string[]} initialChunks
 * @param {string[]} delayedChunks
 * @param {number} delayMs
 */
function delayedEventStreamResponse(initialChunks, delayedChunks, delayMs) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of initialChunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      setTimeout(() => {
        for (const chunk of delayedChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }, delayMs);
    }
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

/** @param {object} event */
function sseData(event) {
  return `data: ${jsonString(event)}\n\n`;
}

/** @param {object} value */
function jsonString(value) {
  return JSON.stringify(value);
}
