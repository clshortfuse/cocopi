import { CODEX_CLIENT_VERSION } from "../codex-api/config.js";
import { refreshCodexTokens } from "../auth/oauth.js";
import { codexTokenMetadata, isJwtExpired } from "../auth/token.js";
import { readCodexAuth, storeCodexAuth } from "./secret-storage.js";
import { readCocopiConfiguration } from "./configuration.js";

/** @typedef {import("./configuration.js").CocopiConfiguration} CocopiConfiguration */
/** @typedef {import("./secret-storage.js").StoredCodexAuth} StoredCodexAuth */

/**
 * @typedef {object} CocopiSecretContext
 * @property {import("./secret-storage.js").SecretStorageLike} secrets
 */

/**
 * @typedef {object} CocopiRuntime
 * @property {CocopiConfiguration} configuration
 * @property {StoredCodexAuth | undefined} auth
 * @property {string} clientVersion
 */

/**
 * @param {CocopiSecretContext} context
 * @param {import("./configuration.js").ConfigurationApiLike} vscode
 * @param {{ refreshAuth?: boolean }} [options]
 * @returns {Promise<CocopiRuntime>}
 */
export async function readCocopiRuntime(context, vscode, options = {}) {
  const auth = options.refreshAuth === false ? await readCodexAuth(context.secrets) : await readFreshCodexAuth(context);
  return {
    configuration: readCocopiConfiguration(vscode),
    auth,
    clientVersion: CODEX_CLIENT_VERSION
  };
}

/**
 * @param {Error | string | object | null | undefined} error
 */
export function isCodexAuthFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /status\s+401\b|unauthorized/iu.test(message);
}

/**
 * @param {CocopiSecretContext} context
 * @returns {Promise<StoredCodexAuth | undefined>}
 */
export async function refreshStoredCodexAuth(context) {
  const auth = await readCodexAuth(context.secrets);
  return auth ? refreshStoredAuth(context, auth) : undefined;
}

/**
 * @param {CocopiSecretContext} context
 */
async function readFreshCodexAuth(context) {
  const auth = await readCodexAuth(context.secrets);
  if (!auth || !isJwtExpired(auth.accessToken)) {
    return auth;
  }

  return refreshStoredAuth(context, auth);
}

/**
 * @param {CocopiSecretContext} context
 * @param {StoredCodexAuth} auth
 */
async function refreshStoredAuth(context, auth) {
  const tokens = await refreshCodexTokens({
    refreshToken: auth.refreshToken
  });
  const metadata = codexTokenMetadata({
    idToken: tokens.idToken,
    accessToken: tokens.accessToken
  });
  const refreshedAuth = {
    ...tokens,
    chatgptAccountId: auth.chatgptAccountId ?? metadata.chatgptAccountId,
    chatgptPlanType: metadata.chatgptPlanType
  };
  await storeCodexAuth(context.secrets, refreshedAuth);
  return refreshedAuth;
}