/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

/**
 * @param {'language-model' | 'chat'} source
 * @param {string} sessionId
 * @param {number} hostRequestIndex
 * @returns {Record<string, string>}
 */
export function cocopiTurnClientMetadata(source, sessionId, hostRequestIndex) {
  const turnId = `${sessionId}:${hostRequestIndex}`;
  return {
    "x-cocopi-session-id": sessionId,
    "x-cocopi-source": source,
    "x-cocopi-host-request-index": String(hostRequestIndex),
    "x-cocopi-turn-id": turnId,
    "x-codex-turn-metadata": JSON.stringify({
      turn_id: turnId,
      thread_source: "vscode",
      client: "cocopi",
      source
    })
  };
}
