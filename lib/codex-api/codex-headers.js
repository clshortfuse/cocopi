import { arch, platform, release } from "node:os";

import { COCOPI_USER_AGENT_PRODUCT, COCOPI_USER_AGENT_VERSION, CODEX_CLIENT_VERSION } from "./config.js";

/** @typedef {import("../../data/Codex.js").CodexAuthHeaderOptions} CodexAuthHeaderOptions */

/**
 * @typedef {{
 *   Authorization: string,
 *   "Content-Type": string,
 *   "User-Agent": string,
 *   originator: string,
 *   version: string,
 *   "ChatGPT-Account-ID"?: string,
 *   "X-OpenAI-Fedramp"?: string,
 *   Accept?: string,
 *   "OpenAI-Beta"?: string,
 *   "session-id"?: string,
 *   "thread-id"?: string,
 *   "x-client-request-id"?: string,
 *   "x-codex-turn-metadata"?: string
 * }} CodexAuthHeaders
 */

export const COCOPI_ORIGINATOR = "cocopi";
export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";

/** @type {string | undefined} */
let cachedCodexUserAgent;

/**
 * @returns {string}
 */
export function codexUserAgent() {
  cachedCodexUserAgent ??= sanitizeUserAgent(`${COCOPI_USER_AGENT_PRODUCT}/${COCOPI_USER_AGENT_VERSION} (${operatingSystemName()} ${operatingSystemVersion()}; ${architectureName()}) ${runtimeUserAgent()}`);
  return cachedCodexUserAgent;
}

/**
 * @param {CodexAuthHeaderOptions} options
 * @returns {CodexAuthHeaders}
 */
export function codexAuthHeaders(options) {
  if (!options.accessToken) {
    throw new Error("missing ChatGPT/Codex access token");
  }

  /** @type {CodexAuthHeaders} */
  const headers = {
    Authorization: `Bearer ${options.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": codexUserAgent(),
    originator: COCOPI_ORIGINATOR,
    version: CODEX_CLIENT_VERSION
  };

  if (options.chatgptAccountId) {
    headers["ChatGPT-Account-ID"] = options.chatgptAccountId;
  }

  if (options.originator) {
    headers.originator = options.originator;
  }

  if (options.fedramp) {
    headers["X-OpenAI-Fedramp"] = "true";
  }

  return headers;
}

/**
 * @param {import("../../data/Codex.js").CodexResponseCreateRequest} body
 * @returns {string | undefined}
 */
export function codexTurnMetadataHeaderFromResponseBody(body) {
  const value = body.client_metadata?.[CODEX_TURN_METADATA_HEADER];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * @param {import("../../data/Codex.js").CodexResponseCreateRequest} body
 * @returns {import("../../data/Codex.js").CodexResponseCreateRequest}
 */
export function responseBodyWithoutCodexTurnMetadata(body) {
  if (!body.client_metadata || !(CODEX_TURN_METADATA_HEADER in body.client_metadata)) {
    return body;
  }

  const { [CODEX_TURN_METADATA_HEADER]: _turnMetadata, ...clientMetadata } = body.client_metadata;
  void _turnMetadata;
  return {
    ...body,
    ...(Object.keys(clientMetadata).length > 0 ? { client_metadata: clientMetadata } : { client_metadata: undefined })
  };
}

/**
 * @param {string} value
 */
function sanitizeUserAgent(value) {
  return value.replaceAll(/[^\u0020-\u007E]/gu, "_");
}

function operatingSystemName() {
  switch (platform()) {
    case "win32": {
      return "Windows";
    }
    case "darwin": {
      return "Mac OS";
    }
    case "linux": {
      return "Linux";
    }
    default: {
      return platform() || "unknown";
    }
  }
}

function operatingSystemVersion() {
  return release();
}

function architectureName() {
  switch (arch()) {
    case "x64": {
      return "x86_64";
    }
    case "arm64": {
      return "arm64";
    }
    default: {
      return arch() || "unknown";
    }
  }
}

function runtimeUserAgent() {
  return `node/${process.versions.node}`;
}
