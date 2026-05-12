import test from "node:test";
import assert from "node:assert/strict";

import { codexTokenMetadata, decodeJwtPayload, isJwtExpired } from "../lib/auth/token.js";

/** @typedef {import("../data/Codex.js").CodexJsonValue} CodexJsonValue */

test("decodeJwtPayload decodes base64url JWT payload", () => {
  const jwt = fakeJwt({ sub: "user", nested: { ok: true } });

  assert.deepEqual(decodeJwtPayload(jwt), { sub: "user", nested: { ok: true } });
});

test("decodeJwtPayload decodes Unicode JWT payloads as UTF-8", () => {
  const jwt = fakeJwt({ text: "€🙈", nested: { currency: "£" } });

  assert.deepEqual(decodeJwtPayload(jwt), { text: "€🙈", nested: { currency: "£" } });
});

test("decodeJwtPayload ignores expired JWT payloads by default", () => {
  const jwt = fakeJwt({ sub: "user", exp: 1 });

  assert.equal(decodeJwtPayload(jwt, { nowMs: 2000, refreshSkewMs: 0 }), undefined);
  assert.deepEqual(decodeJwtPayload(jwt, { nowMs: 2000, refreshSkewMs: 0, allowExpired: true }), { sub: "user", exp: 1 });
});

test("codexTokenMetadata reads ChatGPT account id and plan type", () => {
  const idToken = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-id",
      chatgpt_plan_type: "plus"
    }
  });

  assert.deepEqual(codexTokenMetadata({ idToken }), {
    chatgptAccountId: "account-id",
    chatgptPlanType: "plus"
  });
});

test("codexTokenMetadata prefers explicit account id", () => {
  const idToken = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "token-account" } });

  assert.deepEqual(codexTokenMetadata({ idToken, explicitAccountId: "explicit-account" }), {
    chatgptAccountId: "explicit-account",
    chatgptPlanType: undefined
  });
});

test("codexTokenMetadata falls back to access token claims", () => {
  const accessToken = fakeJwt({ chatgpt_account_id: "access-account" });

  assert.deepEqual(codexTokenMetadata({ accessToken }), {
    chatgptAccountId: "access-account",
    chatgptPlanType: undefined
  });
});

test("codexTokenMetadata ignores expired token claims", () => {
  const idToken = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "expired-account", chatgpt_plan_type: "plus" }, exp: 1 });
  const accessToken = fakeJwt({ chatgpt_account_id: "fresh-account", exp: 4_102_444_800 });

  assert.deepEqual(codexTokenMetadata({ idToken, accessToken }), {
    chatgptAccountId: "fresh-account",
    chatgptPlanType: undefined
  });
});

test("isJwtExpired can inspect expired JWT payloads", () => {
  assert.equal(isJwtExpired(fakeJwt({ exp: 1 }), { nowMs: 2000, refreshSkewMs: 0 }), true);
});

/**
 * @param {Record<string, CodexJsonValue>} payload
 */
function fakeJwt(payload) {
  const encode = (/** @type {CodexJsonValue} */ value) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

/**
 * @param {Uint8Array} bytes
 */
function base64UrlEncode(bytes) {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}