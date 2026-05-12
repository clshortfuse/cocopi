import { canonicalCodexJsonValue } from "../codex-api/json.js";
import { normalizeCocopiSessionId } from "./session-id.js";

/** @typedef {import("../../data/Codex.js").CodexResponseInputItem} CodexResponseInputItem */
/** @typedef {import("../../data/Codex.js").CodexResponseInputMessage} CodexResponseInputMessage */

export const COCOPI_RESPONSE_ITEMS_METADATA_KEY = "cocopi.responseItems";
export const COCOPI_SESSION_ID_METADATA_KEY = "cocopi.sessionId";
export const COCOPI_CONVERSATION_SUMMARY_METADATA_KEY = "cocopi.conversationSummary";
export const COCOPI_CONVERSATION_DESCRIPTION_METADATA_KEY = "cocopi.conversationDescription";

/**
 * @param {import("vscode").ChatContext} chatContext
 * @param {string} currentPrompt
 * @returns {CodexResponseInputItem[]}
 */
export function codexInputFromChatHistory(chatContext, currentPrompt) {
  /** @type {CodexResponseInputItem[]} */
  const input = [];

  for (const turn of chatContext.history) {
    if ("prompt" in turn) {
      pushMessage(input, "user", turn.prompt);
    } else {
      input.push(...codexResponseItemsFromChatResult(turn.result));
      pushMessage(input, "assistant", markdownTextFromResponseTurn(turn));
    }
  }

  pushMessage(input, "user", currentPrompt);
  return input;
}

/**
 * @param {CodexResponseInputItem[]} responseItems
 * @returns {import("vscode").ChatResult}
 */
export function chatResultWithCodexResponseItems(responseItems) {
  return responseItems.length > 0
    ? { metadata: { [COCOPI_RESPONSE_ITEMS_METADATA_KEY]: canonicalCodexResponseItems(responseItems) } }
    : {};
}

/**
 * @param {CodexResponseInputItem[]} responseItems
 * @param {string} sessionId
 * @param {{ summary?: string | undefined, description?: string | undefined }} [conversationMetadata]
 * @returns {import("vscode").ChatResult}
 */
export function chatResultWithCodexState(responseItems, sessionId, conversationMetadata) {
  /** @type {Record<string, string | CodexResponseInputItem[]>} */
  const metadata = /** @type {Record<string, string | CodexResponseInputItem[]>} */ ({
    [COCOPI_SESSION_ID_METADATA_KEY]: sessionId
  });
  if (responseItems.length > 0) {
    metadata[COCOPI_RESPONSE_ITEMS_METADATA_KEY] = canonicalCodexResponseItems(responseItems);
  }

  if (conversationMetadata?.summary) {
    metadata[COCOPI_CONVERSATION_SUMMARY_METADATA_KEY] = conversationMetadata.summary;
  }

  if (conversationMetadata?.description) {
    metadata[COCOPI_CONVERSATION_DESCRIPTION_METADATA_KEY] = conversationMetadata.description;
  }

  return { metadata };
}

/**
 * @param {CodexResponseInputItem[]} responseItems
 * @returns {CodexResponseInputItem[]}
 */
function canonicalCodexResponseItems(responseItems) {
  return /** @type {CodexResponseInputItem[]} */ (canonicalCodexJsonValue(responseItems) ?? []);
}

/**
 * @param {import("vscode").ChatContext} chatContext
 * @returns {string | undefined}
 */
export function cocopiSessionIdFromChatHistory(chatContext) {
  for (const turn of chatContext.history.toReversed()) {
    if (!("result" in turn)) {
      continue;
    }

    const sessionId = normalizeCocopiSessionId(turn.result?.metadata?.[COCOPI_SESSION_ID_METADATA_KEY]);
    if (sessionId) {
      return sessionId;
    }
  }
}

/**
 * @param {import("vscode").ChatResult | undefined} result
 * @returns {CodexResponseInputItem[]}
 */
function codexResponseItemsFromChatResult(result) {
  const value = result?.metadata?.[COCOPI_RESPONSE_ITEMS_METADATA_KEY];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => isCodexResponseInputItem(item));
}

/* eslint-disable jsdoc/reject-any-type -- VS Code ChatResult metadata is external data; validate before replaying. */
/**
 * @param {*} value
 * @returns {value is CodexResponseInputItem}
 */
function isCodexResponseInputItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const type = "type" in value ? value.type : undefined;
  return type === "reasoning" || type === "function_call" || type === "function_call_output";
}
/* eslint-enable jsdoc/reject-any-type */

/**
 * @param {CodexResponseInputItem[]} input
 * @param {'user' | 'assistant'} role
 * @param {string} text
 */
function pushMessage(input, role, text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  input.push(/** @type {CodexResponseInputMessage} */ ({
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text: trimmed }]
  }));
}

/**
 * @param {import("vscode").ChatResponseTurn} turn
 */
function markdownTextFromResponseTurn(turn) {
  return turn.response
    .map((part) => markdownTextFromResponsePart(part))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * @param {import("vscode").ChatResponseTurn["response"][number]} part
 */
function markdownTextFromResponsePart(part) {
  if (!("value" in part)) {
    return "";
  }

  const value = part.value;
  if (!value || typeof value !== "object" || !("value" in value) || typeof value.value !== "string") {
    return "";
  }

  return value.value;
}
