import test from "node:test";
import assert from "node:assert/strict";
import { resolveChatReferences } from "../lib/vscode/chat-references.js";
import { codexInputFromChatHistory } from "../lib/vscode/chat-history.js";

class Uri {
  /** @param {string} scheme */
  constructor(scheme) { this.scheme = scheme; }
  toString() { return `${this.scheme}:/attached`; }
}
class Location {
  /** @param {Uri} uri */
  constructor(uri) { this.uri = uri; this.range = {}; }
}

test("binary references preserve image bytes only when the host class is enabled", async () => {
  let reads = 0;
  class BinaryReference {
    /** @param {string} mimeType */
    constructor(mimeType) { this.mimeType = mimeType; }
    async data() { reads += 1; return new Uint8Array([1, 2, 3]); }
  }
  const api = { Uri, Location, ChatReferenceBinaryData: BinaryReference, workspace: { textDocuments: [], openTextDocument() { throw new Error("not a document"); } } };
  // eslint-disable-next-line jsdoc/check-types -- Minimal injected host constructors.
  const host = /** @type {import("../lib/vscode/chat-references.js").ChatReferenceApi} */ (/** @type {unknown} */ (api));
  const signal = new AbortController().signal;
  const references = await resolveChatReferences([{ id: "image", value: new BinaryReference("image/png") }], host, signal);
  assert.deepEqual(codexInputFromChatHistory({ history: [] }, "inspect", references), [
    { role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: "data:image/png;base64,AQID" }] }
  ]);
  await assert.rejects(resolveChatReferences([{ id: "pdf", value: new BinaryReference("application/pdf") }], host, signal), /MIME/u);
  const { ChatReferenceBinaryData: omitted, ...stable } = host;
  void omitted;
  await assert.rejects(resolveChatReferences([{ id: "image", value: new BinaryReference("image/png") }], stable, signal), /Unsupported/u);
  assert.equal(reads, 1);
});

test("image limits reject oversized and aggregate attachments", async () => {
  class BinaryReference {
    mimeType = "image/png";
    /** @param {number} size */
    constructor(size) { this.size = size; }
    async data() { return new Uint8Array(this.size); }
  }
  // eslint-disable-next-line jsdoc/check-types -- Minimal injected host constructors.
  const host = /** @type {import("../lib/vscode/chat-references.js").ChatReferenceApi} */ (/** @type {unknown} */ ({ Uri, Location, ChatReferenceBinaryData: BinaryReference, workspace: { textDocuments: [] } }));
  const signal = new AbortController().signal;
  await assert.rejects(resolveChatReferences([{ id: "large", value: new BinaryReference(5 * 1024 * 1024 + 1) }], host, signal), /5 MiB/u);
  await assert.rejects(resolveChatReferences([0, 1, 2].map((id) => ({ id: String(id), value: new BinaryReference(4 * 1024 * 1024) })), host, signal), /10 MiB/u);
});

test("references use unsaved host text and exact location range", async () => {
  const uri = new Uri("file");
  const location = new Location(uri);
  const api = {
    Uri, Location,
    workspace: {
      textDocuments: [{ uri, getText: (/** @type {object} */ range) => {
        assert.equal(range, location.range);
        return "unsaved selected text";
      } }],
      openTextDocument: () => { throw new Error("must use open document"); }
    }
  };
  // eslint-disable-next-line jsdoc/check-types -- Deliberately minimal injected host fixture.
  const host = /** @type {import("../lib/vscode/chat-references.js").ChatReferenceApi} */ (/** @type {unknown} */ (api));
  assert.deepEqual(await resolveChatReferences([{ id: "selection", value: location }], host, new AbortController().signal), [
    { id: "selection", value: "unsaved selected text" }
  ]);
});

test("reference resolution checks schemes, budgets, and cancellation without arbitrary accessors", async () => {
  let reads = 0;
  const abort = new AbortController();
  const api = {
    Uri, Location,
    workspace: {
      textDocuments: [],
      openTextDocument: async () => {
        reads += 1;
        abort.abort();
        return { getText: () => { throw new Error("must not read after cancellation"); } };
      }
    }
  };
  // eslint-disable-next-line jsdoc/check-types -- Deliberately minimal injected host fixture.
  const host = /** @type {import("../lib/vscode/chat-references.js").ChatReferenceApi} */ (/** @type {unknown} */ (api));
  const signal = new AbortController().signal;
  for (const value of [new Uri("https"), { data: () => { throw new Error("must not invoke"); } }]) {
    await assert.rejects(resolveChatReferences([{ id: "unsupported", value }], host, signal), /Unsupported participant attachment/u);
  }
  await assert.rejects(resolveChatReferences([{ id: "untitled", value: new Uri("untitled") }], host, signal), /no longer open/u);
  await assert.rejects(resolveChatReferences([{ id: "large", value: "x".repeat(1024 * 1024 + 1) }], host, signal), /1 MiB/u);
  assert.equal(reads, 0);
  await assert.rejects(resolveChatReferences([{ id: "file", value: new Uri("file") }], host, abort.signal), { name: "AbortError" });
  assert.equal(reads, 1);
  await assert.rejects(resolveChatReferences([{ id: "file", value: new Uri("file") }], host, abort.signal), { name: "AbortError" });
  assert.equal(reads, 1);
});