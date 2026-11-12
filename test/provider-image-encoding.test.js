import assert from "node:assert/strict";
import test from "node:test";
import { codexRequestStateFromLanguageModelMessages } from "../lib/vscode/language-model-provider.js";

test("image encoding preserves offset bytes and padding without binary-string conversion", (context) => {
  context.mock.method(globalThis, "btoa", () => {
    throw new Error("image encoding must not materialize a binary string");
  });
  for (const length of [0, 1, 2, 3, 255, 32_767, 32_768, 32_769, 65_537]) {
    const storage = Uint8Array.from({ length: length + 19 }, (_, index) => index % 256);
    const data = storage.subarray(7, 7 + length);
    const original = new Uint8Array(storage);
    const state = codexRequestStateFromLanguageModelMessages([{
      role: 1, name: undefined, content: [{ mimeType: "image/png", data }]
    }], "synthetic", { LanguageModelChatMessageRole: { User: 1, Assistant: 2 } }, { issueTracking: false, debugLevel: "off" });
    assert.deepEqual(state.input, [{ role: "user", content: [{
      type: "input_image", image_url: `data:image/png;base64,${Buffer.from(data).toString("base64")}`
    }] }]);
    assert.deepEqual(storage, original);
  }
});