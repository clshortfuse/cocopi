import test from "node:test";
import assert from "node:assert/strict";

import { COCOPI_RESPONSE_ITEMS_METADATA_KEY, chatResultWithCodexResponseItems, chatResultWithCodexState, codexInputFromChatHistory } from "../lib/vscode/chat-history.js";

test("codexInputFromChatHistory converts prior participant turns and current prompt", () => {
  assert.deepEqual(codexInputFromChatHistory({
    history: [
      fakeRequestTurn("first question"),
      fakeResponseTurn(["first answer", "second answer"]),
      fakeRequestTurn("   "),
      fakeResponseTurn([""])
    ]
  }, "follow up"), [
    { role: "user", content: [{ type: "input_text", text: "first question" }] },
    { role: "assistant", content: [{ type: "output_text", text: "first answer\n\nsecond answer" }] },
    { role: "user", content: [{ type: "input_text", text: "follow up" }] }
  ]);
});

test("codexInputFromChatHistory replays hidden Codex response items from chat result metadata", () => {
  assert.deepEqual(codexInputFromChatHistory({
    history: [
      fakeRequestTurn("read package"),
      fakeResponseTurn(["Cocopi package."], chatResultWithCodexResponseItems([
        { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "encrypted-thinking" },
        { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
        { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) }
      ]))
    ]
  }, "what did it say?"), [
    { role: "user", content: [{ type: "input_text", text: "read package" }] },
    { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "encrypted-thinking" },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: jsonString({ path: "package.json" }) },
    { type: "function_call_output", call_id: "call-1", output: jsonString({ name: "cocopi" }) },
    { role: "assistant", content: [{ type: "output_text", text: "Cocopi package." }] },
    { role: "user", content: [{ type: "input_text", text: "what did it say?" }] }
  ]);
});

test("codexInputFromChatHistory omits hidden thinking progress parts", () => {
  assert.deepEqual(codexInputFromChatHistory({
    history: [
      fakeRequestTurn("update tests"),
      fakeResponseTurnWithParts([
        fakeThinkingMarkdownPart("**Continuing task.** Need update tests.", {
          openai_event_type: "response.reasoning_summary_text.delta",
          openai_item_id: "rs-1"
        }),
        fakeMarkdownPart("Preparing patch.")
      ])
    ]
  }, "continue"), [
    { role: "user", content: [{ type: "input_text", text: "update tests" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Preparing patch." }] },
    { role: "user", content: [{ type: "input_text", text: "continue" }] }
  ]);
});

test("codexInputFromChatHistory preserves commentary progress parts", () => {
  assert.deepEqual(codexInputFromChatHistory({
    history: [
      fakeRequestTurn("update tests"),
      fakeResponseTurnWithParts([
        fakeMetadataMarkdownPart("Planning descriptor copy.", {
          openai_event_type: "response.output_text.delta",
          openai_item_id: "msg-plan",
          openai_phase: "commentary"
        })
      ])
    ]
  }, "continue"), [
    { role: "user", content: [{ type: "input_text", text: "update tests" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Planning descriptor copy." }] },
    { role: "user", content: [{ type: "input_text", text: "continue" }] }
  ]);
});

test("codexInputFromChatHistory preserves commentary and final answer while omitting reasoning summary", () => {
  assert.deepEqual(codexInputFromChatHistory({
    history: [
      fakeRequestTurn("update tests"),
      fakeResponseTurnWithParts([
        fakeMetadataMarkdownPart("Inspecting files.", {
          openai_event_type: "response.reasoning_summary_text.delta",
          openai_item_id: "rs-1"
        }),
        fakeMetadataMarkdownPart("Planning descriptor copy.", {
          openai_event_type: "response.output_text.delta",
          openai_item_id: "msg-plan",
          openai_phase: "commentary"
        }),
        fakeMarkdownPart("Done.")
      ])
    ]
  }, "continue"), [
    { role: "user", content: [{ type: "input_text", text: "update tests" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Planning descriptor copy.\n\nDone." }] },
    { role: "user", content: [{ type: "input_text", text: "continue" }] }
  ]);
});

/** @param {object} value */
function jsonString(value) {
  return JSON.stringify(value);
}

test("chatResultWithCodexResponseItems omits empty metadata", () => {
  assert.deepEqual(chatResultWithCodexResponseItems([]), {});
  assert.deepEqual(chatResultWithCodexResponseItems([{ type: "reasoning", encrypted_content: "encrypted" }]), {
    metadata: {
      [COCOPI_RESPONSE_ITEMS_METADATA_KEY]: [{ type: "reasoning", encrypted_content: "encrypted" }]
    }
  });
});

test("chatResultWithCodexState stores hidden replay metadata canonically", () => {
  const first = chatResultWithCodexState([
    { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "same" }], encrypted_content: "encrypted" }
  ], "cocopi-chat-00000000-0000-4000-8000-000000000001");
  const second = chatResultWithCodexState([
    { encrypted_content: "encrypted", summary: [{ text: "same", type: "summary_text" }], id: "rs-1", type: "reasoning" }
  ], "cocopi-chat-00000000-0000-4000-8000-000000000001");

  assert.equal(JSON.stringify(first.metadata?.[COCOPI_RESPONSE_ITEMS_METADATA_KEY]), JSON.stringify(second.metadata?.[COCOPI_RESPONSE_ITEMS_METADATA_KEY]));
  assert.equal(JSON.stringify(first.metadata?.[COCOPI_RESPONSE_ITEMS_METADATA_KEY]), jsonString([
    { encrypted_content: "encrypted", id: "rs-1", summary: [{ text: "same", type: "summary_text" }], type: "reasoning" }
  ]));
});

/** @param {string} prompt */
function fakeRequestTurn(prompt) {
  return /** @type {import("vscode").ChatRequestTurn} */ ({ prompt, participant: "cocopi.chat", references: [], toolReferences: [] });
}

/**
 * @param {string[]} values
 * @param {import("vscode").ChatResult} [result]
 */
function fakeResponseTurn(values, result = {}) {
  return fakeResponseTurnWithParts(values.map((value) => fakeMarkdownPart(value)), result);
}

/**
 * @param {import("vscode").ChatResponsePart[]} response
 * @param {import("vscode").ChatResult} [result]
 */
function fakeResponseTurnWithParts(response, result = {}) {
  return /** @type {import("vscode").ChatResponseTurn} */ ({
    participant: "cocopi.chat",
    result,
    response
  });
}

/** @param {string} value */
function fakeMarkdownPart(value) {
  return /** @type {import("vscode").ChatResponseMarkdownPart} */ ({
    value: fakeMarkdownString(value)
  });
}

/**
 * @param {string} value
 * @param {Record<string, unknown>} metadata
 */
function fakeThinkingMarkdownPart(value, metadata) {
  return fakeMetadataMarkdownPart(value, metadata);
}

/**
 * @param {string} value
 * @param {Record<string, unknown>} metadata
 */
function fakeMetadataMarkdownPart(value, metadata) {
  return /** @type {import("vscode").ChatResponsePart} */ ({
    value: fakeMarkdownString(value),
    metadata
  });
}

/** @param {string} value */
function fakeMarkdownString(value) {
  const markdownString = {
    value,
    /** @param {string} text */
    appendText(text) {
      this.value += text;
      return this;
    },
    /** @param {string} text */
    appendMarkdown(text) {
      this.value += text;
      return this;
    },
    /** @param {string} text */
    appendCodeblock(text) {
      this.value += text;
      return this;
    }
  };

  return /** @type {import("vscode").MarkdownString} */ (markdownString);
}