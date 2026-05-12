import { randomUUID } from "node:crypto";

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

const COCOPI_SESSION_ID_PATTERN = /^cocopi-(?:chat|language-model)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * @param {"chat" | "language-model"} scope
 */
export function newCocopiSessionId(scope) {
  return `cocopi-${scope}-${randomUUID()}`;
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
