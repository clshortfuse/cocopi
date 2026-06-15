import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CODEX_CLIENT_VERSION, DEFAULT_CODEX_API_BASE_URL } from "../lib/codex-api/config.js";
import { parseModelsResponse } from "../lib/codex-api/models.js";
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
import { CODEX_SECRET_KEYS } from "../lib/vscode/secret-storage.js";
import { clearCocopiTokenCacheDebugSummaries, readCocopiTokenCacheDebugSummaries } from "../lib/vscode/token-cache-debug.js";

const chatgptProCatalogFixture = JSON.parse(await readFile(new URL("fixtures/codex-models/chatgpt-pro-catalog.json", import.meta.url), "utf8"));
const reasoningRequestPayloadFixtures = JSON.parse(await readFile(new URL("fixtures/codex-request-payloads/reasoning-variants.json", import.meta.url), "utf8"));

const LanguageModelChatMessageRole = Object.freeze({ User: 1, Assistant: 2 });
const LanguageModelChatToolMode = Object.freeze({ Auto: 1, Required: 2 });
const COCOPI_STATEFUL_MARKER_PAYLOAD_PREFIX = "cocopi:response-items:v1:";
const COCOPI_MODEL_CATALOG_STORAGE_KEY = "cocopi.modelCatalog.v1";

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
  assert.equal(context.subscriptions.length, 1);
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
  assert.equal(calls[0].url, "https://chatgpt.example.test/backend-api/codex/models?client_version=0.125.0");
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
      maxInputTokens: 64_000
    }
  ]);
  assert.ok(logger.debugMessages.some((message) => message.includes("Cocopi language model compaction limit.")
    && message.includes("model=gpt-5-codex")
    && message.includes("source=model-provided")
    && message.includes("maxInputTokens=64000")
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

test("languageModelInformationFromCodexModels can use model-provided auto-compact limits", () => {
  const [model] = languageModelInformationFromCodexModels([
    { id: "gpt-catalog", displayName: "GPT Catalog", contextWindow: 100_000, autoCompactTokenLimit: 64_000 }
  ], "gpt-catalog", { useModelDefaultCompactionLimit: true, compactionFallbackStrategy: "ninety-percent" });

  assert.equal(model.maxInputTokens, 64_000);
  assert.equal(model.maxOutputTokens, 16_384);
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
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" }
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
    "xhigh"
  ]);
  assert.deepEqual(reasoningEffort?.enumItemLabels, [
    "Low",
    "Medium",
    "High",
    "Extra High"
  ]);
  assert.deepEqual(reasoningEffort?.enumDescriptions, [
    "Faster responses with less reasoning",
    "Balanced reasoning and speed",
    "Greater reasoning depth but slower",
    "Extra high reasoning depth for complex problems"
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
    "xhigh"
  ]);
  const reasoningEffortLabels = /** @type {string[] | undefined} */ (reasoningEffort?.enumItemLabels);
  assert.equal(reasoningEffortLabels?.[3], "Extra High");
  assert.equal(reasoningEffort?.default, "xhigh");
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

test("codexRequestStateFromLanguageModelMessages replays matching stateful marker items in message order", () => {
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
      { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
      { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) },
      { role: "user", content: [{ type: "input_text", text: "summarize it" }] }
    ]
  });
});

test("codexRequestStateFromLanguageModelMessages drops unpaired tool replay items", () => {
  clearCocopiIssues();

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [
        { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
        { type: "function_call", call_id: "call-paired", name: "read_file", arguments: jsonString({ path: "package.json" }) },
        { type: "function_call", call_id: "call-missing-output", name: "read_file", arguments: jsonString({ path: "README.md" }) }
      ])
    ]),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart("call-paired", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))]),
      new LanguageModelToolResultPart("call-missing-call", [new LanguageModelTextPart("orphan output")])
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
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
      statefulMarkerDataPart("gpt-test", [
        { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" }
      ], { sessionId })
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
      { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages restores the host request index from stateful markers", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [
        { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" }
      ], { sessionId, hostRequestIndex: 7 })
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
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
  const requestState = {
    model: "gpt-test",
    stream: true,
    prompt_cache_key: sessionId,
    client_metadata: {
      "x-codex-installation-id": "cocopi-language-model",
      "x-cocopi-session-id": sessionId,
      "x-cocopi-source": "language-model"
    }
  };

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "first"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [assistantItem], {
        sessionId,
        responseId: "resp-one",
        requestState
      })
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "second")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      firstUserItem,
      assistantItem,
      { role: "user", content: [{ type: "input_text", text: "second" }] }
    ],
    sessionId,
    continuationAnchors: [{
      input: [firstUserItem],
      responseItems: [assistantItem],
      responseId: "resp-one",
      requestState
    }]
  });
});

test("codexRequestStateFromLanguageModelMessages carries stateful markers across model option changes", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "read package metadata"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      statefulMarkerDataPart("gpt-5.5:fast", [
        { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
        { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) }
      ], { sessionId }),
      new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))])
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-5.5", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
      { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
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
      statefulMarkerDataPart("gpt-test", [
        { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
        { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) }
      ], { sessionId }),
      new LanguageModelToolResultPart("call-1", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))])
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "read package metadata" }] },
      { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
      { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) },
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages restores session ids from empty Cocopi markers", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      statefulMarkerDataPart("gpt-test", [], { sessionId })
    ]),
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "continue")
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
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
      { type: "reasoning", id: "rs-old", encrypted_content: "encrypted-reasoning" },
      { role: "user", content: [{ type: "input_text", text: "<conversation-summary>\nOld work was summarized.\n</conversation-summary>" }] },
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ],
    sessionId
  });
});

test("codexRequestStateFromLanguageModelMessages restores markers replayed beside compaction summaries", () => {
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  /** @type {import("../data/Codex.js").CodexResponseInputItem[]} */
  const responseItems = [
    { type: "reasoning", id: "rs-old", encrypted_content: "encrypted-reasoning" },
    { type: "function_call", call_id: "call-old", name: "read_file", arguments: jsonString({ path: "package.json" }) }
  ];
  /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */
  const requestState = { model: "gpt-test", input: [] };

  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.User, [
      statefulMarkerDataPart("gpt-test", responseItems, {
        sessionId,
        responseId: "resp-old",
        requestState,
        hostRequestIndex: 7
      }),
      new LanguageModelTextPart("<conversation-summary>\nOld work was summarized.\n</conversation-summary>"),
      new LanguageModelToolResultPart("call-old", [new LanguageModelTextPart(jsonString({ name: "cocopi" }))])
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [
      { type: "reasoning", id: "rs-old", encrypted_content: "encrypted-reasoning" },
      { type: "function_call", call_id: "call-old", name: "read_file", arguments: jsonString({ path: "package.json" }) },
      { role: "user", content: [{ type: "input_text", text: "<conversation-summary>\nOld work was summarized.\n</conversation-summary>" }] },
      { type: "function_call_output", call_id: "call-old", output: jsonString({ name: "cocopi" }) }
    ],
    sessionId,
    continuationAnchors: [{
      input: [],
      responseItems,
      responseId: "resp-old",
      requestState
    }],
    hostRequestIndex: 7
  });
});

test("codexRequestStateFromLanguageModelMessages ignores invalid marker session ids", () => {
  assert.deepEqual(codexRequestStateFromLanguageModelMessages([
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [
        { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" }
      ], { sessionId: "not-a-cocopi-session" })
    ])
  ], "gpt-test", { LanguageModelChatMessageRole }), {
    input: [{ type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" }]
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

test("provideLanguageModelChatResponse replays marker state without previous_response_id", async (testContext) => {
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
        statefulMarkerDataPart("gpt-test", [
          { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
          { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) }
        ], { sessionId, hostRequestIndex: 7 }),
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
    { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
    { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) }
  ]);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(statefulMarkerPayloadFromDataPart(dataPart).sessionId, sessionId);
  assert.equal(statefulMarkerPayloadFromDataPart(dataPart).hostRequestIndex, 8);
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    { role: "assistant", content: [{ type: "output_text", text: "done" }] }
  ]);
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    { role: "assistant", content: [{ type: "output_text", text: "hello" }] }
  ]);
  const body = JSON.parse(String(requestOptions?.body));
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    {
      role: "assistant",
      content: [{
        type: "output_text",
        text: "<analysis>\nHidden analysis.\n</analysis>\n\n<summary>Hidden summary.</summary>\n\nVisible answer."
      }]
    }
  ]);
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    {
      type: "reasoning",
      id: "rs-1",
      summary: [{ type: "summary_text", text: "Inspecting files." }],
      encrypted_content: "encrypted-reasoning"
    }
  ]);
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

test("provideLanguageModelChatResponse routes commentary output text as visible text when native thinking is supported", async (testContext) => {
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
    "Done."
  ]);
  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelThinkingPart).map((part) => part.value), []);
});

test("provideLanguageModelChatResponse keeps commentary output visible without native thinking support", async (testContext) => {
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
    "Done."
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
    chatInstructionsMode: "replace"
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
      statefulMarkerDataPart("gpt-test", [{ role: "assistant", content: [{ type: "output_text", text: "prior" }] }], { sessionId })
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

test("provideLanguageModelChatResponse emits completed output text as the stateful marker", async (testContext) => {
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    { role: "assistant", content: [{ type: "output_text", text: "partial" }] }
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    { role: "assistant", content: [{ type: "output_text", text: "complete" }] }
  ]);
});

test("provideLanguageModelChatResponse merges completed output messages into stateful marker", async (testContext) => {
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    { role: "assistant", content: [{ type: "output_text", text: "hello" }], phase: "final_answer" }
  ]);
});

test("provideLanguageModelChatResponse preserves assistant output item phase in stateful marker", async (testContext) => {
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

  assert.deepEqual(progress.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value), [
    "I will inspect the files."
  ]);
  const dataPart = progress.parts.find((part) => part instanceof LanguageModelDataPart);
  assert.ok(dataPart instanceof LanguageModelDataPart);
  assert.equal(dataPart.mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    { role: "assistant", content: [{ type: "output_text", text: "I will inspect the files." }], phase: "commentary" }
  ]);
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(part), [
    { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" }
  ]);
});

test("provideLanguageModelChatResponse serializes stateful marker payload canonically", async (testContext) => {
  const progressA = fakeProgress();
  const progressB = fakeProgress();
  const sessionId = "cocopi-language-model-00000000-0000-4000-8000-000000000001";
  const messages = [
    fakeLanguageModelMessage(LanguageModelChatMessageRole.User, "think"),
    fakeLanguageModelMessageFromParts(LanguageModelChatMessageRole.Assistant, [
      statefulMarkerDataPart("gpt-test", [], { sessionId })
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(partA), [
    { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "same" }], encrypted_content: "encrypted-reasoning" }
  ]);
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

  assert.equal(progress.parts.length, 2);
  assert.ok(progress.parts[0] instanceof LanguageModelDataPart);
  assert.equal(progress.parts[0].mimeType, COCOPI_STATEFUL_MARKER_MIME);
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(progress.parts[0]), [
    { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-reasoning" },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }
  ]);
  assert.ok(progress.parts[1] instanceof LanguageModelToolCallPart);
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

  assert.equal(progress.parts.length, 2);
  assert.ok(progress.parts[0] instanceof LanguageModelDataPart);
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(progress.parts[0]), [
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }
  ]);
  assert.deepEqual(progress.parts[1], new LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }));
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(dataPart), [
    { type: "function_call", call_id: "call-1", name: "runSubagent", arguments: jsonString({ description: "Search code", model: "GPT-5.5 (cocopi)", prompt: "Find the relevant files" }) }
  ]);
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
  assert.deepEqual(responseItemsFromStatefulMarkerDataPart(progress.parts[0]), [
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "README.md" }) }
  ]);
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

test("provideTokenCount includes decoded Cocopi stateful marker replay cost", async () => {
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
    Math.ceil(("ok".length + JSON.stringify(responseItems).length) / 4)
  );
});

test("provideTokenCount includes Cocopi stateful markers across model option changes", async () => {
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
    Math.ceil(("ok".length + JSON.stringify(responseItems).length) / 4)
  );
});

/**
 * @param {Map<string, string>} [secrets]
 * @param {{ onStore?: (key: string, value: string) => void, fireSecretChanges?: boolean }} [options]
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
    secrets: secretStorage
  };
}

/**
 * @param {Map<string, string | number | boolean>} [configuration]
 * @param {{ warningSelection?: string, thinkingPart?: boolean }} [options]
 */
function fakeVscode(configuration = new Map(), options = {}) {
  const vscode = {
    languageModelVendor: "",
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
        void provider;
        vscode.languageModelVendor = vendor;
        return { dispose() {} };
      }
    },
    LanguageModelTextPart,
    ...(options.thinkingPart ? { LanguageModelThinkingPart } : {}),
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelDataPart,
    LanguageModelChatToolMode,
    LanguageModelChatMessageRole,
    LanguageModelError,
    workspace: {
      getConfiguration() {
        return {
          /**
           * @template T
           * @param {string} key
           * @param {T} defaultValue
           * @returns {T}
           */
          get(key, defaultValue) {
            if (key === "transport" && !configuration.has(key)) {
              return /** @type {T} */ ("sse");
            }
            return /** @type {T} */ (configuration.get(key) ?? defaultValue);
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

/** @param {LanguageModelDataPart} part */
function responseItemsFromStatefulMarkerDataPart(part) {
  return statefulMarkerPayloadFromDataPart(part).responseItems;
}

/** @param {LanguageModelDataPart} part */
function statefulMarkerPayloadFromDataPart(part) {
  const payload = JSON.parse(statefulMarkerJsonFromDataPart(part));
  assert.equal(payload.version, 1);
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
  return base64UrlDecodeUtf8(marker.slice(COCOPI_STATEFUL_MARKER_PAYLOAD_PREFIX.length));
}

/** @param {LanguageModelDataPart} part */
function statefulMarkerFromDataPart(part) {
  const text = new TextDecoder().decode(part.data);
  const separatorIndex = text.indexOf("\\");
  assert.notEqual(separatorIndex, -1);
  const marker = text.slice(separatorIndex + 1);
  assert.ok(marker.startsWith(COCOPI_STATEFUL_MARKER_PAYLOAD_PREFIX));
  return marker;
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

  return `${COCOPI_STATEFUL_MARKER_PAYLOAD_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(payload))}`;
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
    isUserSelectable: true,
    maxInputTokens: Math.max(1, Math.floor((contextWindow - maxOutputTokens) * 0.9)),
    maxOutputTokens,
    capabilities: {
      imageInput: options.imageInput ?? false,
      toolCalling: true
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
