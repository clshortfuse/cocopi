import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { access, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { codexTokenMetadata } from "../lib/auth/token.js";
import { browserLaunchCommand } from "../lib/utils/browser-launch.js";
import { parseEnvFile, upsertEnvValues } from "../lib/utils/env-file.js";
import {
  CODEX_AUTH_ISSUER,
  DeviceCodeDisabledError,
  buildBrowserAuthorizeUrl,
  exchangeAuthorizationCode,
  parseBrowserCallback,
  pollDeviceAuthorizationOnce,
  requestDeviceCode
} from "../lib/auth/oauth.js";

const ENV_PATH = ".env";
const ENV_EXAMPLE_PATH = ".env.example";
const args = new Set(process.argv.slice(2));

async function main() {
  const envText = await readLocalEnvText();
  const env = parseEnvFile(envText);
  const issuer = env.CODEX_AUTH_ISSUER || CODEX_AUTH_ISSUER;
  const authMode = args.has("--device-code") ? "chatgpt_device_code" : "chatgpt_browser";
  const tokens = authMode === "chatgpt_device_code" ? await runDeviceCodeLogin(issuer) : await runBrowserLogin(issuer);
  const metadata = codexTokenMetadata({ idToken: tokens.idToken, accessToken: tokens.accessToken });

  /** @type {Record<string, string>} */
  const updates = {
    COCOPI_AUTH_MODE: authMode,
    CODEX_CHATGPT_ACCESS_TOKEN: tokens.accessToken,
    CODEX_CHATGPT_REFRESH_TOKEN: tokens.refreshToken,
    CODEX_CHATGPT_ID_TOKEN: tokens.idToken,
    CODEX_AUTH_ISSUER: issuer
  };

  if (metadata.chatgptAccountId) {
    updates.CODEX_CHATGPT_ACCOUNT_ID = metadata.chatgptAccountId;
  }

  if (metadata.chatgptPlanType) {
    updates.CODEX_CHATGPT_PLAN_TYPE = metadata.chatgptPlanType;
  }

  await writeFile(ENV_PATH, upsertEnvValues(envText, updates), "utf8");
  console.log(`Saved ChatGPT/Codex tokens to ${ENV_PATH}.`);
}

/**
 * @param {string} issuer
 */
async function runBrowserLogin(issuer) {
  const pkce = await createPkce();
  const state = randomToken();
  const server = createServer();
  const callback = waitForBrowserCallback(server, state);

  await listen(server, 1455);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 1455;
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const authUrl = buildBrowserAuthorizeUrl({
    issuer,
    redirectUri,
    codeChallenge: pkce.codeChallenge,
    state
  });

  console.log(`Starting local login server on ${redirectUri}.`);
  console.log("Complete ChatGPT/Codex login in your browser:");
  console.log(authUrl);

  if (!args.has("--no-browser")) {
    openBrowser(authUrl);
  }

  const authorizationCode = await callback;
  return exchangeAuthorizationCode({
    issuer,
    authorizationCode,
    codeVerifier: pkce.codeVerifier,
    redirectUri
  });
}

/**
 * @param {string} issuer
 */
async function runDeviceCodeLogin(issuer) {
  const deviceCode = await requestDeviceCode({ issuer });

  console.log("Complete ChatGPT/Codex login in your browser:");
  console.log(deviceCode.verificationUrl);
  console.log(`Code: ${deviceCode.userCode}`);

  if (!args.has("--no-browser")) {
    openBrowser(deviceCode.verificationUrl);
  }

  const authorization = await waitForAuthorization({
    issuer,
    deviceAuthId: deviceCode.deviceAuthId,
    userCode: deviceCode.userCode,
    intervalSeconds: deviceCode.intervalSeconds
  });
  const tokens = await exchangeAuthorizationCode({
    issuer,
    authorizationCode: authorization.authorizationCode,
    codeVerifier: authorization.codeVerifier
  });
  return tokens;
}

/**
 * @param {{ issuer: string, deviceAuthId: string, userCode: string, intervalSeconds: number }} options
 */
async function waitForAuthorization(options) {
  const startedAt = Date.now();
  const maxWaitMs = 15 * 60 * 1000;
  const intervalMs = Math.max(options.intervalSeconds, 1) * 1000;

  while (Date.now() - startedAt < maxWaitMs) {
    const authorization = await pollDeviceAuthorizationOnce(options);
    if (authorization) {
      return authorization;
    }

    await delay(intervalMs);
  }

  throw new Error("Codex device login timed out after 15 minutes.");
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
        response.end("Codex login complete. You can close this tab.");
        clearTimeout(timeout);
        server.close();
        resolve(code);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end(error instanceof Error ? error.message : "Codex login failed.");
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

async function readLocalEnvText() {
  if (await exists(ENV_PATH)) {
    return readFile(ENV_PATH, "utf8");
  }

  if (await exists(ENV_EXAMPLE_PATH)) {
    return readFile(ENV_EXAMPLE_PATH, "utf8");
  }

  return "";
}

/**
 * @param {string} filePath
 */
async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 */
function openBrowser(url) {
  const launch = browserLaunchCommand(url);
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

try {
  await main();
} catch (error) {
  if (error instanceof DeviceCodeDisabledError) {
    console.error(error.message);
    console.error("Run `npm run setup:codex-login` without --device-code to use browser callback login instead.");
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}