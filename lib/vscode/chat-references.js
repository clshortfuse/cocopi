/** @typedef {import("vscode").ChatPromptReference} ChatPromptReference */
export class ResolvedChatImage {
  /** @param {string} imageUrl */
  constructor(imageUrl) { this.imageUrl = imageUrl; }
}

export class ChatReferenceError extends Error {}

/**
 * @typedef {object} ChatReferenceApi
 * @property {typeof import("vscode").Uri} Uri
 * @property {typeof import("vscode").Location} Location
 * @property {typeof import("vscode").ChatReferenceBinaryData} [ChatReferenceBinaryData]
 * @property {Pick<typeof import("vscode").workspace, "openTextDocument" | "textDocuments">} workspace
 */

/**
 * Resolve only explicitly attached host resources, never strings as paths.
 * @param {readonly ChatPromptReference[]} references
 * @param {ChatReferenceApi} api
 * @param {AbortSignal} signal
 * @returns {Promise<ChatPromptReference[]>}
 */
export async function resolveChatReferences(references, api, signal) {
  /** @type {ChatPromptReference[]} */
  const resolved = [];
  let bytes = 0;
  let imageBytes = 0;
  for (const reference of references) {
    signal.throwIfAborted();
    const value = reference.value;
    if (typeof value === "string") {
      bytes += new TextEncoder().encode(value).byteLength;
      resolved.push(reference);
    } else if (api.ChatReferenceBinaryData && value instanceof api.ChatReferenceBinaryData) {
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.mimeType)) {
        throw new ChatReferenceError("Unsupported participant image MIME type.");
      }
      const data = await value.data();
      signal.throwIfAborted();
      imageBytes += data.byteLength;
      if (data.byteLength > 5 * 1024 * 1024 || imageBytes > 10 * 1024 * 1024) {
        throw new ChatReferenceError("Participant images exceed the 5 MiB per-image or 10 MiB total limit.");
      }
      resolved.push({ ...reference, value: new ResolvedChatImage(`data:${value.mimeType};base64,${Buffer.from(data).toString("base64")}`) });
    } else {
      const location = value instanceof api.Location ? value : undefined;
      const uri = location?.uri ?? (value instanceof api.Uri ? value : undefined);
      if (!uri || !["file", "vscode-remote", "untitled"].includes(uri.scheme)) {
        throw new ChatReferenceError("Unsupported participant attachment. Attach text or a file/location resource.");
      }
      const open = api.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
      if (uri.scheme === "untitled" && !open) {
        throw new ChatReferenceError("The attached untitled document is no longer open.");
      }
      const document = open ?? await api.workspace.openTextDocument(uri);
      signal.throwIfAborted();
      const text = document.getText(location?.range);
      bytes += new TextEncoder().encode(text).byteLength;
      resolved.push({ ...reference, value: text });
    }
    if (bytes > 1024 * 1024) {
      throw new ChatReferenceError("Participant attachments exceed the 1 MiB text limit.");
    }
  }
  signal.throwIfAborted();
  return resolved;
}