export const DEFAULT_CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const CODEX_CLIENT_VERSION = "0.125.0";
export const COCOPI_USER_AGENT_PRODUCT = "cocopi";
export const COCOPI_USER_AGENT_VERSION = "0.0.1";

/**
 * @param {Record<string, string | undefined>} env
 */
export function codexConfigFromEnv(env) {
  return {
    apiBaseUrl: normalizeBaseUrl(env.CODEX_API_BASE_URL || DEFAULT_CODEX_API_BASE_URL),
    model: env.CODEX_MODEL || DEFAULT_CODEX_MODEL,
    chatgptAccountId: env.CODEX_CHATGPT_ACCOUNT_ID || undefined,
    clientVersion: env.CODEX_CLIENT_VERSION || env.COCOPI_CLIENT_VERSION || CODEX_CLIENT_VERSION
  };
}

/**
 * @param {string} value
 */
export function normalizeBaseUrl(value) {
  return value.replace(/\/+$/u, "");
}