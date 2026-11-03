import { randomUUID } from "node:crypto";

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

const COCOPI_SESSION_ID_PATTERN = /^cocopi-(?:chat|language-model|autocomplete)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * @param {"chat" | "language-model" | "autocomplete"} scope
 */
export function newCocopiSessionId(scope) {
  return `cocopi-${scope}-${randomUUID()}`;
}

/**
 * Map opaque host conversation IDs to bounded, replay-compatible session IDs.
 * Existing UUID identities retain their cache keys. Other IDs use UUIDv5 with
 * the DNS namespace and a Cocopi-specific name; raw host IDs never reach logs.
 * @param {string} conversationId
 * @returns {Promise<string | undefined>}
 */
export async function cocopiSessionIdFromHostConversation(conversationId) {
  if (conversationId.length === 0) {
    return;
  }
  const existing = normalizeCocopiSessionId(`cocopi-language-model-${conversationId}`);
  if (existing) {
    return existing;
  }
  const namespace = Uint8Array.from([0x6B, 0xA7, 0xB8, 0x10, 0x9D, 0xAD, 0x11, 0xD1, 0x80, 0xB4, 0x00, 0xC0, 0x4F, 0xD4, 0x30, 0xC8]);
  const name = new TextEncoder().encode(`cocopi.host-conversation:${conversationId}`);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0F) | 0x50;
  bytes[8] = (bytes[8] & 0x3F) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `cocopi-language-model-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * @param {CodexJsonValue | undefined} value
 * @returns {string | undefined}
 */
export function normalizeCocopiSessionId(value) {
  return typeof value === "string" && COCOPI_SESSION_ID_PATTERN.test(value)
    ? value
    : undefined;
}
