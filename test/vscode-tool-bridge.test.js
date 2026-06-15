import test from "node:test";
import assert from "node:assert/strict";

import {
  codexFunctionCallInputItemFromToolCall,
  codexFunctionCallOutputInputItemFromToolResult,
  codexToolChoiceFromLanguageModelToolMode,
  codexToolsFromLanguageModelTools,
  languageModelQualifiedName,
  readCodexReasoningInputItem,
  readCodexToolCall,
  stripUnsupportedLanguageModelToolSchemaMetadata,
  withDefaultRunSubagentToolModel,
  withOptionalNullToolArgumentsRemoved
} from "../lib/vscode/tool-bridge.js";

test("codexToolsFromLanguageModelTools maps VS Code tools to Responses function tools", () => {
  assert.deepEqual(codexToolsFromLanguageModelTools([{
    name: "read_file",
    description: "Read a file from the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  }]), [{
    type: "function",
    name: "read_file",
    description: "Read a file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  }]);
});

test("codexToolsFromLanguageModelTools emits cache-stable tool order and schemas", () => {
  const first = codexToolsFromLanguageModelTools([
    {
      name: "write_file",
      description: "Write a file.",
      inputSchema: {
        required: ["path", "content"],
        properties: {
          path: { description: "Path", type: "string" },
          content: { type: "string", description: "Content" }
        },
        type: "object"
      }
    },
    {
      name: "read_file",
      description: "Read a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path" }
        },
        required: ["path"]
      }
    }
  ]);
  const second = codexToolsFromLanguageModelTools([
    {
      name: "read_file",
      description: "Read a file.",
      inputSchema: {
        required: ["path"],
        properties: {
          path: { description: "Path", type: "string" }
        },
        type: "object"
      }
    },
    {
      name: "write_file",
      description: "Write a file.",
      inputSchema: {
        type: "object",
        properties: {
          content: { description: "Content", type: "string" },
          path: { type: "string", description: "Path" }
        },
        required: ["path", "content"]
      }
    }
  ]);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.map((tool) => tool.name), ["read_file", "write_file"]);
  const parameters = /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (first[1].parameters);
  const properties = /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (parameters.properties);
  assert.deepEqual(Object.keys(parameters), ["properties", "required", "type"]);
  assert.deepEqual(Object.keys(properties), ["content", "path"]);
});

test("codexToolsFromLanguageModelTools puts create_file path before content", () => {
  const tools = codexToolsFromLanguageModelTools([{
    name: "create_file",
    description: "Create a file.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        filePath: { type: "string" }
      },
      required: ["content", "filePath"]
    }
  }]);

  const parameters = /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (tools[0].parameters);
  const properties = /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (parameters.properties);
  assert.deepEqual(Object.keys(properties), ["filePath", "content"]);
  assert.deepEqual(parameters.required, ["filePath", "content"]);
});

test("codexToolsFromLanguageModelTools leaves unexpected create_file schemas untouched", () => {
  const tools = codexToolsFromLanguageModelTools([{
    name: "create_file",
    description: "Create a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    }
  }]);

  const parameters = /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (tools[0].parameters);
  const properties = /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (parameters.properties);
  assert.deepEqual(Object.keys(properties), ["content", "path"]);
  assert.deepEqual(parameters.required, ["path", "content"]);
});

test("codexToolsFromLanguageModelTools normalizes VS Code schemas to the Codex tool subset", () => {
  assert.deepEqual(codexToolsFromLanguageModelTools([{
    name: "run_in_terminal",
    description: "Run a terminal command.",
    inputSchema: {
      type: "object",
      default: {},
      properties: {
        mode: {
          type: "string",
          enum: ["sync", "background"],
          enumDescriptions: ["Wait for the command.", "Run in the background."],
          default: "sync"
        },
        nested: {
          additionalProperties: false,
          properties: {
            strategy: {
              const: "pty",
              enumDescriptions: ["UI-only metadata"]
            }
          }
        },
        tags: {
          type: "array",
          minItems: 1
        },
        passthrough: true,
        maybeText: {
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "null" }
          ]
        }
      },
      required: ["mode"]
    }
  }]), [{
    type: "function",
    name: "run_in_terminal",
    description: "Run a terminal command.",
    parameters: {
      type: "object",
      properties: {
        maybeText: {
          anyOf: [
            { type: "string" },
            { type: "null" }
          ]
        },
        mode: {
          type: "string",
          enum: ["sync", "background"]
        },
        nested: {
          type: "object",
          properties: {
            strategy: {
              type: "string",
              enum: ["pty"]
            }
          },
          additionalProperties: false
        },
        passthrough: {
          type: "string"
        },
        tags: {
          type: "array",
          items: {
            type: "string"
          }
        }
      },
      required: ["mode"]
    }
  }]);
});

test("codexToolsFromLanguageModelTools fills top-level object properties", () => {
  assert.deepEqual(codexToolsFromLanguageModelTools([{
    name: "empty",
    description: "Empty schema.",
    inputSchema: {
      type: "object"
    }
  }]), [{
    type: "function",
    name: "empty",
    description: "Empty schema.",
    parameters: {
      type: "object",
      properties: {}
    }
  }]);
});

test("codexToolsFromLanguageModelTools emits strict structured-output schemas", () => {
  assert.deepEqual(codexToolsFromLanguageModelTools([{
    name: "search",
    description: "Search files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        caseSensitive: { type: "boolean" },
        filters: {
          type: "object",
          properties: {
            include: { type: "array", items: { type: "string" } },
            maxResults: { type: "integer" }
          },
          required: ["include"]
        }
      },
      required: ["query"]
    }
  }], { strict: true }), [{
    type: "function",
    name: "search",
    description: "Search files.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        caseSensitive: { type: ["boolean", "null"] },
        filters: {
          type: ["object", "null"],
          properties: {
            include: { type: "array", items: { type: "string" } },
            maxResults: { type: ["integer", "null"] }
          },
          required: ["include", "maxResults"],
          additionalProperties: false
        },
        query: { type: "string" }
      },
      required: ["caseSensitive", "filters", "query"],
      additionalProperties: false
    }
  }]);
});

test("stripUnsupportedLanguageModelToolSchemaMetadata removes host compile blockers in place", () => {
  const originalSchema = {
    type: "object",
    markdownDescription: "Run command.",
    properties: {
      mode: {
        type: "string",
        enum: ["sync", "async"],
        enumDescriptions: ["Wait.", "Return immediately."],
        default: "sync"
      },
      options: {
        type: "object",
        properties: {
          shell: {
            type: "string",
            enumItemLabels: ["PowerShell"]
          }
        }
      }
    }
  };
  const tools = [{
    name: "run_in_terminal",
    description: "Run a terminal command.",
    inputSchema: originalSchema
  }];

  assert.equal(stripUnsupportedLanguageModelToolSchemaMetadata(tools), 3);
  assert.notEqual(tools[0].inputSchema, originalSchema);
  assert.deepEqual(tools[0].inputSchema, {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["sync", "async"],
        default: "sync"
      },
      options: {
        type: "object",
        properties: {
          shell: {
            type: "string"
          }
        }
      }
    }
  });
});

test("codexToolsFromLanguageModelTools supplies an object schema fallback", () => {
  assert.deepEqual(codexToolsFromLanguageModelTools([{
    name: "refresh",
    description: "Refresh the current view."
  }]), [{
    type: "function",
    name: "refresh",
    description: "Refresh the current view.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }]);
});

test("codexFunctionCallInputItemFromToolCall serializes fallback arguments stably", () => {
  assert.deepEqual(codexFunctionCallInputItemFromToolCall({
    callId: "call-1",
    name: "write_file",
    input: {
      path: "README.md",
      content: "hello",
      nested: {
        z: true,
        a: 1
      }
    }
  }), {
    type: "function_call",
    call_id: "call-1",
    name: "write_file",
    arguments: jsonString({ content: "hello", nested: { a: 1, z: true }, path: "README.md" })
  });
});

test("languageModelQualifiedName formats VS Code model references for runSubagent", () => {
  assert.equal(languageModelQualifiedName({ id: "gpt-5.5", name: "GPT-5.5" }, "cocopi"), "GPT-5.5 (cocopi)");
  assert.equal(languageModelQualifiedName({ id: "gpt-5.5" }, "cocopi"), "gpt-5.5 (cocopi)");
  assert.equal(languageModelQualifiedName({ id: " ", name: " " }, "cocopi"), undefined);
});

test("withDefaultRunSubagentToolModel fills blank model input", () => {
  const toolCall = withDefaultRunSubagentToolModel({
    callId: "call-1",
    name: "runSubagent",
    input: {
      description: "Search code",
      model: "",
      prompt: "Find the relevant files"
    },
    rawArguments: jsonString({ description: "Search code", model: "", prompt: "Find the relevant files" })
  }, "GPT-5.5 (cocopi)");

  assert.deepEqual(toolCall, {
    callId: "call-1",
    name: "runSubagent",
    input: {
      description: "Search code",
      model: "GPT-5.5 (cocopi)",
      prompt: "Find the relevant files"
    },
    rawArguments: jsonString({ description: "Search code", model: "GPT-5.5 (cocopi)", prompt: "Find the relevant files" })
  });
});

test("withDefaultRunSubagentToolModel preserves explicit model input", () => {
  const original = {
    callId: "call-1",
    name: "runSubagent",
    input: {
      description: "Search code",
      model: "Claude Sonnet 4.5 (copilot)",
      prompt: "Find the relevant files"
    },
    rawArguments: jsonString({ description: "Search code", model: "Claude Sonnet 4.5 (copilot)", prompt: "Find the relevant files" })
  };

  assert.equal(withDefaultRunSubagentToolModel(original, "GPT-5.5 (cocopi)"), original);
});

test("withOptionalNullToolArgumentsRemoved removes strict-mode optional nulls", () => {
  assert.deepEqual(withOptionalNullToolArgumentsRemoved({
    callId: "call-1",
    name: "search",
    input: {
      query: "needle",
      caseSensitive: null,
      filters: {
        include: ["src/**"],
        maxResults: null
      },
      requiredNullable: null
    },
    rawArguments: jsonString({
      query: "needle",
      caseSensitive: null,
      filters: { include: ["src/**"], maxResults: null },
      requiredNullable: null
    })
  }, [{
    name: "search",
    description: "Search files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        caseSensitive: { type: "boolean" },
        filters: {
          type: "object",
          properties: {
            include: { type: "array", items: { type: "string" } },
            maxResults: { type: "integer" }
          },
          required: ["include"]
        },
        requiredNullable: { type: ["string", "null"] }
      },
      required: ["query", "filters", "requiredNullable"]
    }
  }]), {
    callId: "call-1",
    name: "search",
    input: {
      query: "needle",
      filters: {
        include: ["src/**"]
      },
      requiredNullable: null
    },
    rawArguments: jsonString({ filters: { include: ["src/**"] }, query: "needle", requiredNullable: null })
  });
});

test("codexToolChoiceFromLanguageModelToolMode maps VS Code modes", () => {
  assert.equal(codexToolChoiceFromLanguageModelToolMode(1, true, 2), "auto");
  assert.equal(codexToolChoiceFromLanguageModelToolMode(2, true, 2), "required");
  assert.equal(codexToolChoiceFromLanguageModelToolMode(2, false, 2), "none");
});

test("readCodexToolCall parses function-call arguments done events", () => {
  assert.deepEqual(readCodexToolCall({
    type: "response.function_call_arguments.done",
    item_id: "item-1",
    output_index: 0,
    name: "read_file",
    arguments: jsonString({ path: "README.md" }),
    call_id: "call-1"
  }), {
    callId: "call-1",
    name: "read_file",
    input: { path: "README.md" },
    rawArguments: jsonString({ path: "README.md" })
  });
});

test("readCodexToolCall parses function output item done events", () => {
  assert.deepEqual(readCodexToolCall({
    type: "response.output_item.done",
    item_id: "item-2",
    output_index: 0,
    item: {
      type: "function_call",
      call_id: "call-2",
      name: "search",
      arguments: jsonString({ query: "tool bridge" })
    }
  }), {
    callId: "call-2",
    name: "search",
    input: { query: "tool bridge" },
    rawArguments: jsonString({ query: "tool bridge" })
  });
});

test("readCodexToolCall ignores non-function output items", () => {
  assert.equal(readCodexToolCall({
    type: "response.output_item.done",
    item_id: "item-3",
    output_index: 0,
    item: { type: "message" }
  }), undefined);
});

test("readCodexReasoningInputItem preserves encrypted reasoning output items", () => {
  assert.deepEqual(readCodexReasoningInputItem({
    type: "response.output_item.done",
    item_id: "item-4",
    output_index: 0,
    item: {
      type: "reasoning",
      id: "rs_123",
      summary: [],
      encrypted_content: "encrypted-thinking",
      phase: "tool_use"
    }
  }), {
    type: "reasoning",
    id: "rs_123",
    summary: [],
    encrypted_content: "encrypted-thinking",
    phase: "tool_use"
  });
});

test("readCodexReasoningInputItem ignores non-reasoning events", () => {
  assert.equal(readCodexReasoningInputItem({
    type: "response.output_text.delta",
    delta: "hello"
  }), undefined);
});

test("readCodexToolCall rejects non-object function arguments", () => {
  assert.throws(() => readCodexToolCall({
    type: "response.function_call_arguments.done",
    item_id: "item-4",
    output_index: 0,
    name: "bad_args",
    arguments: "[]"
  }), /JSON object/u);
});

test("codexFunctionCallOutputInputItemFromToolResult serializes text and JSON-like results", () => {
  const encoder = new TextEncoder();

  assert.deepEqual(codexFunctionCallOutputInputItemFromToolResult("call-1", {
    content: [
      { value: "plain text" },
      { value: { ok: true, count: 2 } },
      { data: encoder.encode(jsonString({ name: "cocopi" })), mimeType: "application/json" },
      { data: encoder.encode("markdown text"), mimeType: "text/markdown" }
    ]
  }), {
    type: "function_call_output",
    call_id: "call-1",
    output: [
      "plain text",
      jsonString({ ok: true, count: 2 }),
      jsonString({ name: "cocopi" }),
      "markdown text"
    ].join("\n\n")
  });
});

/** @param {object} value */
function jsonString(value) {
  return JSON.stringify(value);
}

test("codexFunctionCallOutputInputItemFromToolResult summarizes binary data", () => {
  assert.deepEqual(codexFunctionCallOutputInputItemFromToolResult("call-2", {
    content: [{ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }]
  }), {
    type: "function_call_output",
    call_id: "call-2",
    output: "[image/png data, 3 bytes]"
  });
});
