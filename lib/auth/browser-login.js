import { createServer } from "node:http";

import { CODEX_AUTH_ISSUER, buildBrowserAuthorizeUrl, exchangeAuthorizationCode, parseBrowserCallback } from "./oauth.js";

/** @typedef {import("./oauth.js").CodexTokenSet} CodexTokenSet */

/**
 * @param {{ issuer?: string, port?: number, openExternal: (url: string) => void | Promise<void>, fetch?: typeof fetch }} options
 * @returns {Promise<CodexTokenSet>}
 */
export async function runBrowserCodexLogin(options) {
  const issuer = options.issuer ?? CODEX_AUTH_ISSUER;
  const pkce = await createPkce();
  const state = randomToken();
  const server = createServer();
  const callback = waitForBrowserCallback(server, state);

  try {
    await listen(server, options.port ?? 1455);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port ?? 1455;
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const authUrl = buildBrowserAuthorizeUrl({
      issuer,
      redirectUri,
      codeChallenge: pkce.codeChallenge,
      state
    });

    await options.openExternal(authUrl);
    const authorizationCode = await callback;
    return exchangeAuthorizationCode({
      issuer,
      authorizationCode,
      codeVerifier: pkce.codeVerifier,
      redirectUri,
      fetch: options.fetch
    });
  } catch (error) {
    server.close();
    throw error;
  }
}

/**
 * @param {import("node:http").Server} server
 * @param {string} expectedState
 */
function waitForBrowserCallback(server, expectedState) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Codex browser login timed out after 5 minutes."));
    }, 5 * 60 * 1000);

    server.on("request", (request, response) => {
      try {
        const code = parseBrowserCallback(request.url ?? "", expectedState);
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("Cocopi sign-in complete. You can close this tab.");
        clearTimeout(timeout);
        server.close();
        resolve(code);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end(error instanceof Error ? error.message : "Cocopi sign-in failed.");
        clearTimeout(timeout);
        server.close();
        reject(error);
      }
    });
  });
}

/**
 * @param {import("node:http").Server} server
 * @param {number} preferredPort
 */
function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EADDRINUSE" && preferredPort !== 0) {
        server.listen(0, "127.0.0.1");
        return;
      }

      reject(error);
    });
    server.once("listening", resolve);
    server.listen(preferredPort, "127.0.0.1");
  });
}

async function createPkce() {
  const codeVerifier = randomToken();
  const codeChallenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  return { codeVerifier, codeChallenge };
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * @param {ArrayBuffer | Uint8Array} bytes
 */
function base64UrlEncode(bytes) {
  const byteArray = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCodePoint(...byteArray))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}