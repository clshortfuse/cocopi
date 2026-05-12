export const CODEX_AUTH_ISSUER = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ORIGINATOR = "cocopi";

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

export class DeviceCodeDisabledError extends Error {
  constructor() {
    super("ChatGPT/Codex device-code authorization is disabled for this account or workspace.");
    this.name = "DeviceCodeDisabledError";
  }
}

/**
 * @typedef {object} DeviceCode
 * @property {string} verificationUrl
 * @property {string} userCode
 * @property {string} deviceAuthId
 * @property {number} intervalSeconds
 */

/**
 * @typedef {object} DeviceAuthorization
 * @property {string} authorizationCode
 * @property {string} codeVerifier
 * @property {string} codeChallenge
 */

/**
 * @typedef {object} CodexTokenSet
 * @property {string} idToken
 * @property {string} accessToken
 * @property {string} refreshToken
 */

/**
 * @param {{ fetch?: typeof fetch, issuer?: string, clientId?: string }} [options]
 * @returns {Promise<DeviceCode>}
 */
export async function requestDeviceCode(options = {}) {
  const issuer = normalizeIssuer(options.issuer ?? CODEX_AUTH_ISSUER);
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: options.clientId ?? CODEX_CLIENT_ID
    })
  });

  if (response.status === 404) {
    throw new DeviceCodeDisabledError();
  }

  if (!response.ok) {
    throw new Error(`device code request failed with status ${response.status}`);
  }

  const body = /** @type {Record<string, CodexJsonValue>} */ (await response.json());
  const interval = readOptionalValue(body, "interval") ?? 5;
  return {
    verificationUrl: `${issuer}/codex/device`,
    userCode: readRequiredString(body, "user_code"),
    deviceAuthId: readRequiredString(body, "device_auth_id"),
    intervalSeconds: Number(interval)
  };
}

/**
 * @param {{ fetch?: typeof fetch, issuer?: string, deviceAuthId: string, userCode: string }} options
 * @returns {Promise<DeviceAuthorization | null>}
 */
export async function pollDeviceAuthorizationOnce(options) {
  const issuer = normalizeIssuer(options.issuer ?? CODEX_AUTH_ISSUER);
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${issuer}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      device_auth_id: options.deviceAuthId,
      user_code: options.userCode
    })
  });

  if (response.status === 403 || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`device auth poll failed with status ${response.status}`);
  }

  const body = /** @type {Record<string, CodexJsonValue>} */ (await response.json());
  return {
    authorizationCode: readRequiredString(body, "authorization_code"),
    codeVerifier: readRequiredString(body, "code_verifier"),
    codeChallenge: readRequiredString(body, "code_challenge")
  };
}

/**
 * @param {{ fetch?: typeof fetch, issuer?: string, clientId?: string, authorizationCode: string, codeVerifier: string, redirectUri?: string }} options
 * @returns {Promise<CodexTokenSet>}
 */
export async function exchangeAuthorizationCode(options) {
  const issuer = normalizeIssuer(options.issuer ?? CODEX_AUTH_ISSUER);
  const fetchImpl = options.fetch ?? fetch;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.authorizationCode,
    redirect_uri: options.redirectUri ?? `${issuer}/deviceauth/callback`,
    client_id: options.clientId ?? CODEX_CLIENT_ID,
    code_verifier: options.codeVerifier
  });

  const response = await fetchImpl(`${issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!response.ok) {
    throw new Error(`token exchange failed with status ${response.status}`);
  }

  const body = /** @type {Record<string, CodexJsonValue>} */ (await response.json());
  return {
    idToken: readRequiredString(body, "id_token"),
    accessToken: readRequiredString(body, "access_token"),
    refreshToken: readRequiredString(body, "refresh_token")
  };
}

/**
 * @param {{ fetch?: typeof fetch, issuer?: string, clientId?: string, refreshToken: string }} options
 * @returns {Promise<CodexTokenSet>}
 */
export async function refreshCodexTokens(options) {
  const issuer = normalizeIssuer(options.issuer ?? CODEX_AUTH_ISSUER);
  const fetchImpl = options.fetch ?? fetch;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: options.clientId ?? CODEX_CLIENT_ID,
    refresh_token: options.refreshToken
  });

  const response = await fetchImpl(`${issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!response.ok) {
    throw new Error(`token refresh failed with status ${response.status}`);
  }

  const body = /** @type {Record<string, CodexJsonValue>} */ (await response.json());
  return {
    idToken: readRequiredString(body, "id_token"),
    accessToken: readRequiredString(body, "access_token"),
    refreshToken: readOptionalString(body, "refresh_token") ?? options.refreshToken
  };
}

/**
 * @param {string} issuer
 */
function normalizeIssuer(issuer) {
  return issuer.replace(/\/+$/u, "");
}

/**
 * @param {Record<string, CodexJsonValue>} value
 * @param {string} key
 */
function readRequiredString(value, key) {
  if (!value || typeof value !== "object" || !(key in value)) {
    throw new Error(`missing ${key} in Codex auth response`);
  }

  const field = value[key];
  if (typeof field !== "string" || !field) {
    throw new Error(`invalid ${key} in Codex auth response`);
  }

  return field;
}

/**
 * @param {Record<string, CodexJsonValue>} value
 * @param {string} key
 */
function readOptionalValue(value, key) {
  if (!value || typeof value !== "object" || !(key in value)) {
    return;
  }

  return value[key];
}

/**
 * @param {{ issuer?: string, clientId?: string, redirectUri: string, codeChallenge: string, state: string, originator?: string, workspaceId?: string }} options
 */
export function buildBrowserAuthorizeUrl(options) {
  const issuer = normalizeIssuer(options.issuer ?? CODEX_AUTH_ISSUER);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId ?? CODEX_CLIENT_ID,
    redirect_uri: options.redirectUri,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: options.state,
    originator: options.originator ?? CODEX_ORIGINATOR
  });

  if (options.workspaceId) {
    params.set("allowed_workspace_id", options.workspaceId);
  }

  return `${issuer}/oauth/authorize?${params.toString()}`;
}

/**
 * @param {string} requestUrl
 * @param {string} expectedState
 */
export function parseBrowserCallback(requestUrl, expectedState) {
  const url = new URL(requestUrl, "http://localhost");
  if (url.pathname !== "/auth/callback") {
    throw new Error("Unexpected Codex login callback path.");
  }

  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    throw new Error(description ? `${error}: ${description}` : error);
  }

  const state = url.searchParams.get("state");
  if (!state || state !== expectedState) {
    throw new Error("Codex login callback state did not match.");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("Codex login callback did not include an authorization code.");
  }

  return code;
}

/**
 * @param {Record<string, CodexJsonValue>} value
 * @param {string} key
 */
function readOptionalString(value, key) {
  const field = readOptionalValue(value, key);
  return typeof field === "string" && field ? field : undefined;
}