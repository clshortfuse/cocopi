import test from "node:test";
import assert from "node:assert/strict";

import { CODEX_CLIENT_ID, buildBrowserAuthorizeUrl, parseBrowserCallback } from "../lib/auth/oauth.js";

test("buildBrowserAuthorizeUrl creates Codex browser OAuth URL", () => {
  const authUrl = new URL(
    buildBrowserAuthorizeUrl({
      issuer: "https://auth.example.test/",
      redirectUri: "http://localhost:1455/auth/callback",
      codeChallenge: "challenge",
      state: "state-123",
      originator: "codex_vscode"
    })
  );

  assert.equal(authUrl.origin, "https://auth.example.test");
  assert.equal(authUrl.pathname, "/oauth/authorize");
  assert.equal(authUrl.searchParams.get("response_type"), "code");
  assert.equal(authUrl.searchParams.get("client_id"), CODEX_CLIENT_ID);
  assert.equal(authUrl.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(authUrl.searchParams.get("scope"), "openid profile email offline_access api.connectors.read api.connectors.invoke");
  assert.equal(authUrl.searchParams.get("code_challenge"), "challenge");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(authUrl.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(authUrl.searchParams.get("state"), "state-123");
  assert.equal(authUrl.searchParams.get("originator"), "codex_vscode");
});

test("parseBrowserCallback returns authorization code for matching state", () => {
  assert.equal(parseBrowserCallback("/auth/callback?code=auth-code&state=state-123", "state-123"), "auth-code");
});

test("parseBrowserCallback rejects state mismatch", () => {
  assert.throws(() => parseBrowserCallback("/auth/callback?code=auth-code&state=wrong", "state-123"), /state did not match/u);
});

test("parseBrowserCallback reports OAuth callback errors", () => {
  assert.throws(() => parseBrowserCallback("/auth/callback?error=access_denied&error_description=nope&state=state-123", "state-123"), /access_denied: nope/u);
});