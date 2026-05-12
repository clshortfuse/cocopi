import test from "node:test";
import assert from "node:assert/strict";

import { runBrowserCodexLogin } from "../lib/auth/browser-login.js";

/** @typedef {import("../data/Codex.js").CodexJsonValue} CodexJsonValue */

test("runBrowserCodexLogin opens browser auth and exchanges callback code", async () => {
  /** @type {string[]} */
  const openedUrls = [];
  /** @type {Array<{ url: string, options: RequestInit & { body?: string | null } }>} */
  const tokenCalls = [];

  const tokens = await runBrowserCodexLogin({
    issuer: "https://auth.example.test",
    port: 0,
    async openExternal(url) {
      openedUrls.push(url);
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get("redirect_uri");
      const state = authUrl.searchParams.get("state");
      assert.ok(redirectUri, "expected redirect uri");
      assert.ok(state, "expected state");
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "auth-code");
      callback.searchParams.set("state", state);
      const response = await fetch(callback);
      assert.equal(response.status, 200);
    },
    fetch: /** @type {typeof fetch} */ (async (url, options = {}) => {
      tokenCalls.push({
        url: String(url),
        options: /** @type {RequestInit & { body?: string | null }} */ (options)
      });
      return Response.json({
        id_token: "id-token",
        access_token: "access-token",
        refresh_token: "refresh-token"
      });
    })
  });

  assert.deepEqual(tokens, {
    idToken: "id-token",
    accessToken: "access-token",
    refreshToken: "refresh-token"
  });
  assert.equal(openedUrls.length, 1);
  assert.equal(new URL(openedUrls[0]).origin, "https://auth.example.test");
  assert.equal(tokenCalls[0].url, "https://auth.example.test/oauth/token");

  const form = new URLSearchParams(String(tokenCalls[0].options.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "auth-code");
  assert.match(form.get("redirect_uri") ?? "", /^http:\/\/localhost:\d+\/auth\/callback$/u);
  assert.ok(form.get("code_verifier"));
});
