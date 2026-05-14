import test from "node:test";
import assert from "node:assert/strict";

import { CODEX_CLIENT_VERSION, DEFAULT_CODEX_API_BASE_URL, DEFAULT_CODEX_MODEL } from "../lib/codex-api/config.js";
import { CODEX_SECRET_KEYS } from "../lib/vscode/secret-storage.js";
import { readCocopiRuntime } from "../lib/vscode/runtime.js";

test("readCocopiRuntime combines configuration with SecretStorage auth", async () => {
  const configuration = configurationValues({
    apiBaseUrl: "https://example.test/codex/",
    model: "model-test",
    streamIdleTimeoutMs: 5000
  });

  const runtime = await readCocopiRuntime(fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"],
    [CODEX_SECRET_KEYS.chatgptPlanType, "plus"]
  ])), fakeVscodeConfiguration(configuration));

  assert.deepEqual(runtime, {
    configuration: {
      apiBaseUrl: "https://example.test/codex",
      model: "model-test",
      authMode: "secretStorage",
      serviceTier: "auto",
      reasoningEffort: "default",
      reasoningSummary: "default",
      chatParticipantModelSource: "selected",
      transport: "websocket",
      debugLevel: "off",
      issueTracking: true,
      tokenTracking: true,
      showTokenTrackerTimeline: true,
      tokenTrackerTimelineDays: 7,
      tokenTrackerTimelineMode: "both",
      toolStrict: true,
      chatInstructions: "",
      chatInstructionsMode: "optional",
      chatInstructionsRegexPattern: "",
      chatInstructionsRegexReplacement: "",
      chatInstructionsRegexFlags: "g",
      streamIdleTimeoutMs: 5000,
      useModelDefaultCompactionLimit: true,
      compactionFallbackStrategy: "ninety-percent"
    },
    auth: {
      accessToken: "access-token",
      chatgptAccountId: "account-id",
      chatgptPlanType: "plus"
    },
    clientVersion: CODEX_CLIENT_VERSION
  });
});

test("readCocopiRuntime returns signed-out runtime state", async () => {
  assert.deepEqual(await readCocopiRuntime(fakeContext(), fakeVscodeConfiguration()), {
    configuration: {
      apiBaseUrl: DEFAULT_CODEX_API_BASE_URL,
      model: DEFAULT_CODEX_MODEL,
      authMode: "secretStorage",
      serviceTier: "auto",
      reasoningEffort: "default",
      reasoningSummary: "default",
      chatParticipantModelSource: "selected",
      transport: "websocket",
      debugLevel: "off",
      issueTracking: true,
      tokenTracking: true,
      showTokenTrackerTimeline: true,
      tokenTrackerTimelineDays: 7,
      tokenTrackerTimelineMode: "both",
      toolStrict: true,
      chatInstructions: "",
      chatInstructionsMode: "optional",
      chatInstructionsRegexPattern: "",
      chatInstructionsRegexReplacement: "",
      chatInstructionsRegexFlags: "g",
      streamIdleTimeoutMs: 120_000,
      useModelDefaultCompactionLimit: true,
      compactionFallbackStrategy: "ninety-percent"
    },
    auth: undefined,
    clientVersion: CODEX_CLIENT_VERSION
  });
});

test("readCocopiRuntime refreshes expired SecretStorage auth", async (testContext) => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, fakeJwt({ exp: 1 })],
    [CODEX_SECRET_KEYS.refreshToken, "old-refresh-token"],
    [CODEX_SECRET_KEYS.idToken, fakeJwt({})],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"],
    [CODEX_SECRET_KEYS.chatgptPlanType, "plus"]
  ]);

  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({
      url: String(url),
      options: /** @type {RequestInit & { headers: Record<string, string>, body?: string | null }} */ (options)
    });
    return Response.json({
      access_token: fakeJwt({ exp: 4_102_444_800 }),
      refresh_token: "new-refresh-token",
      id_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "token-account", chatgpt_plan_type: "team" } })
    });
  }));

  const runtime = await readCocopiRuntime(fakeContext(secrets), fakeVscodeConfiguration());

  assert.equal(calls.length, 1);
  const form = new URLSearchParams(String(calls[0].options.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "old-refresh-token");
  assert.equal(runtime.auth?.accessToken, secrets.get(CODEX_SECRET_KEYS.accessToken));
  assert.equal(runtime.auth?.chatgptAccountId, "account-id");
  assert.equal(runtime.auth?.chatgptPlanType, "team");
  assert.equal(secrets.get(CODEX_SECRET_KEYS.refreshToken), "new-refresh-token");
});

/**
 * @param {Map<string, string>} [secrets]
 */
function fakeContext(secrets = new Map()) {
  return {
    secrets: {
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
      },
      /** @param {string} key */
      async delete(key) {
        secrets.delete(key);
      }
    }
  };
}

/**
 * @param {Record<string, string | number>} record
 */
function configurationValues(record) {
  /** @type {Map<string, string | number>} */
  const values = new Map();
  for (const [key, value] of Object.entries(record)) {
    values.set(key, value);
  }

  return values;
}

/**
 * @param {Map<string, string | number>} [values]
 */
function fakeVscodeConfiguration(values = new Map()) {
  return {
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
            return /** @type {T} */ (values.get(key) ?? defaultValue);
          }
        };
      }
    }
  };
}

/** @param {Record<string, import("../data/Codex.js").CodexJsonValue>} payload */
function fakeJwt(payload) {
  const encode = (/** @type {import("../data/Codex.js").CodexJsonValue} */ value) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

/** @param {Uint8Array} bytes */
function base64UrlEncode(bytes) {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
