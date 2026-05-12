import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_CLIENT_ID,
  DeviceCodeDisabledError,
  exchangeAuthorizationCode,
  pollDeviceAuthorizationOnce,
  refreshCodexTokens,
  requestDeviceCode
} from "../lib/auth/oauth.js";

/** @typedef {import("../data/Codex.js").CodexJsonValue} CodexJsonValue */

test("requestDeviceCode calls the ChatGPT/Codex user-code endpoint", async () => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const deviceCode = await requestDeviceCode({
    issuer: "https://auth.example.test/",
    fetch: fakeFetch(calls, {
      status: 200,
      body: {
        device_auth_id: "device-auth-123",
        user_code: "CODE-1234",
        interval: "2"
      }
    })
  });

  assert.deepEqual(deviceCode, {
    verificationUrl: "https://auth.example.test/codex/device",
    userCode: "CODE-1234",
    deviceAuthId: "device-auth-123",
    intervalSeconds: 2
  });
  assert.equal(calls[0].url, "https://auth.example.test/api/accounts/deviceauth/usercode");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].options.body)), {
    client_id: CODEX_CLIENT_ID
  });
});

test("pollDeviceAuthorizationOnce returns null while login is pending", async () => {
  const authorization = await pollDeviceAuthorizationOnce({
    issuer: "https://auth.example.test",
    deviceAuthId: "device-auth-123",
    userCode: "CODE-1234",
    fetch: fakeFetch([], { status: 404, body: {} })
  });

  assert.equal(authorization, null);
});

test("requestDeviceCode reports disabled device-code authorization", async () => {
  await assert.rejects(
    requestDeviceCode({
      issuer: "https://auth.example.test",
      fetch: fakeFetch([], { status: 404, body: {} })
    }),
    DeviceCodeDisabledError
  );
});

test("pollDeviceAuthorizationOnce reads authorization code and PKCE details", async () => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const authorization = await pollDeviceAuthorizationOnce({
    issuer: "https://auth.example.test",
    deviceAuthId: "device-auth-123",
    userCode: "CODE-1234",
    fetch: fakeFetch(calls, {
      status: 200,
      body: {
        authorization_code: "auth-code",
        code_verifier: "verifier",
        code_challenge: "challenge"
      }
    })
  });

  assert.deepEqual(authorization, {
    authorizationCode: "auth-code",
    codeVerifier: "verifier",
    codeChallenge: "challenge"
  });
  assert.equal(calls[0].url, "https://auth.example.test/api/accounts/deviceauth/token");
  assert.deepEqual(JSON.parse(String(calls[0].options.body)), {
    device_auth_id: "device-auth-123",
    user_code: "CODE-1234"
  });
});

test("exchangeAuthorizationCode sends Codex OAuth token exchange", async () => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const tokens = await exchangeAuthorizationCode({
    issuer: "https://auth.example.test",
    authorizationCode: "auth-code",
    codeVerifier: "verifier",
    fetch: fakeFetch(calls, {
      status: 200,
      body: {
        id_token: "id-token",
        access_token: "access-token",
        refresh_token: "refresh-token"
      }
    })
  });

  assert.deepEqual(tokens, {
    idToken: "id-token",
    accessToken: "access-token",
    refreshToken: "refresh-token"
  });
  assert.equal(calls[0].url, "https://auth.example.test/oauth/token");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");

  const form = new URLSearchParams(String(calls[0].options.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "auth-code");
  assert.equal(form.get("redirect_uri"), "https://auth.example.test/deviceauth/callback");
  assert.equal(form.get("client_id"), CODEX_CLIENT_ID);
  assert.equal(form.get("code_verifier"), "verifier");
});

test("refreshCodexTokens sends Codex OAuth refresh token exchange", async () => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} */
  const calls = [];
  const tokens = await refreshCodexTokens({
    issuer: "https://auth.example.test",
    refreshToken: "old-refresh-token",
    fetch: fakeFetch(calls, {
      status: 200,
      body: {
        id_token: "new-id-token",
        access_token: "new-access-token",
        refresh_token: "new-refresh-token"
      }
    })
  });

  assert.deepEqual(tokens, {
    idToken: "new-id-token",
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token"
  });
  assert.equal(calls[0].url, "https://auth.example.test/oauth/token");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");

  const form = new URLSearchParams(String(calls[0].options.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("client_id"), CODEX_CLIENT_ID);
  assert.equal(form.get("refresh_token"), "old-refresh-token");
});

/**
 * @param {Array<{ url: string, options: RequestInit & { headers: Record<string, string>, body?: string | null } }>} calls
 * @param {{ status: number, body: CodexJsonValue }} response
 * @returns {typeof fetch}
 */
function fakeFetch(calls, response) {
  return /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({
      url: String(url),
      options: /** @type {RequestInit & { headers: Record<string, string>, body?: string | null }} */ (options)
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body
    };
  });
}