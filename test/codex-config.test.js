import test from "node:test";
import assert from "node:assert/strict";

import { CODEX_CLIENT_VERSION, DEFAULT_CODEX_API_BASE_URL, DEFAULT_CODEX_MODEL, codexConfigFromEnv } from "../lib/codex-api/config.js";

test("codexConfigFromEnv uses ChatGPT Codex backend and Codex model defaults", () => {
  assert.deepEqual(codexConfigFromEnv({}), {
    apiBaseUrl: DEFAULT_CODEX_API_BASE_URL,
    model: DEFAULT_CODEX_MODEL,
    chatgptAccountId: undefined,
    clientVersion: CODEX_CLIENT_VERSION
  });
});

test("codexConfigFromEnv accepts local overrides", () => {
  assert.deepEqual(codexConfigFromEnv({
    CODEX_API_BASE_URL: "https://example.test/codex/",
    CODEX_MODEL: "model-test",
    CODEX_CHATGPT_ACCOUNT_ID: "account-id",
    CODEX_CLIENT_VERSION: "1.2.3"
  }), {
    apiBaseUrl: "https://example.test/codex",
    model: "model-test",
    chatgptAccountId: "account-id",
    clientVersion: "1.2.3"
  });
});

test("codexConfigFromEnv accepts legacy Cocopi client version overrides", () => {
  assert.equal(codexConfigFromEnv({
    COCOPI_CLIENT_VERSION: "2.3.4"
  }).clientVersion, "2.3.4");
});