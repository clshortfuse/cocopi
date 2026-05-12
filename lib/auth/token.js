/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

import { decodeBase64UrlAsUtf8 } from "../utils/base64.js";

/**
 * @typedef {object} CodexTokenMetadata
 * @property {string | undefined} chatgptAccountId
 * @property {string | undefined} chatgptPlanType
 */

/**
 * @param {{ idToken?: string, accessToken?: string, explicitAccountId?: string }} options
 * @returns {CodexTokenMetadata}
 */
export function codexTokenMetadata(options) {
  const explicitAccountId = cleanString(options.explicitAccountId);
  if (explicitAccountId) {
    return { chatgptAccountId: explicitAccountId, chatgptPlanType: undefined };
  }

  const idClaims = decodeJwtPayload(options.idToken);
  const accessClaims = decodeJwtPayload(options.accessToken);
  return mergeMetadata(readChatgptClaims(idClaims), readChatgptClaims(accessClaims));
}

/**
 * @param {string | undefined} value
 * @param {{ nowMs?: number, refreshSkewMs?: number, allowExpired?: boolean }} [options]
 * @returns {Record<string, CodexJsonValue> | undefined}
 */
export function decodeJwtPayload(value, options = {}) {
  if (typeof value !== "string") {
    return;
  }

  const parts = value.split(".");
  if (parts.length < 2 || !parts[1]) {
    return;
  }

  try {
    const json = decodeBase64UrlAsUtf8(parts[1]);
    const payload = JSON.parse(json);
    const claims = payload && typeof payload === "object" && !Array.isArray(payload) ? /** @type {Record<string, CodexJsonValue>} */ (payload) : undefined;
    return claims && (options.allowExpired || !claimsAreExpired(claims, options)) ? claims : undefined;
  } catch {
    return;
  }
}

/**
 * @param {Record<string, CodexJsonValue> | undefined} claims
 * @returns {CodexTokenMetadata}
 */
function readChatgptClaims(claims) {
  const auth = readRecord(claims?.["https://api.openai.com/auth"]);
  return {
    chatgptAccountId: cleanString(auth?.chatgpt_account_id) ?? cleanString(claims?.chatgpt_account_id) ?? cleanString(claims?.account_id),
    chatgptPlanType: cleanString(auth?.chatgpt_plan_type) ?? cleanString(claims?.chatgpt_plan_type)
  };
}

/**
 * @param {CodexTokenMetadata} primary
 * @param {CodexTokenMetadata} fallback
 */
function mergeMetadata(primary, fallback) {
  return {
    chatgptAccountId: primary.chatgptAccountId ?? fallback.chatgptAccountId,
    chatgptPlanType: primary.chatgptPlanType ?? fallback.chatgptPlanType
  };
}

/**
 * @param {CodexJsonValue | undefined} value
 */
function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, CodexJsonValue>} */ (value) : undefined;
}

/**
 * @param {CodexJsonValue | undefined} value
 */
function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * @param {string | undefined} value
 * @param {{ nowMs?: number, refreshSkewMs?: number }} [options]
 */
export function isJwtExpired(value, options = {}) {
  const payload = decodeJwtPayload(value, { ...options, allowExpired: true });
  return payload ? claimsAreExpired(payload, options) : false;
}

/**
 * @param {Record<string, CodexJsonValue>} payload
 * @param {{ nowMs?: number, refreshSkewMs?: number }} [options]
 */
function claimsAreExpired(payload, options = {}) {
  const expiration = payload?.exp;
  if (typeof expiration !== "number") {
    return false;
  }

  const nowMs = options.nowMs ?? Date.now();
  const refreshSkewMs = options.refreshSkewMs ?? 60_000;
  return expiration * 1000 <= nowMs + refreshSkewMs;
}