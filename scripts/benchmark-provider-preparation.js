import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildTextResponseBody } from "../lib/codex-api/response-body.js";
import { summarizeCodexRequestBodyForDiagnostics } from "../lib/vscode/diagnostics.js";
import { codexRequestStateFromLanguageModelMessages } from "../lib/vscode/language-model-provider.js";

const level = process.argv[2];
const workload = process.argv[3] ?? "text";
assert.ok(["text", "tools", "images", "markers", "encrypted"].includes(workload), "workload must be text, tools, images, markers, or encrypted");
if (level === undefined) {
  for (const size of [8, 32, 128, 512]) {
    const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), String(size), workload], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "Preparation profile failed");
    process.stdout.write(result.stdout);
  }
} else {
  const count = Number(level);
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 512, "message count must be 1..512");
  const roles = { User: 1, Assistant: 2 };
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? roles.User : roles.Assistant,
    name: undefined,
    content: [{ value: `${index}: synthetic history 😀\n`.repeat(256) }]
  }));
  // Flatten fixture text before baseline collection, outside measured stages.
  for (const message of messages) new TextEncoder().encode(message.content[0].value);
  /** @type {import('vscode').LanguageModelChatRequestMessage[]} */
  let history = workload === "tools"
    ? Array.from({ length: count }, (_, index) => [
      { role: roles.Assistant, name: undefined, content: [{ callId: `call-${index}`, name: "read_file", input: { path: `synthetic-${index}.txt` } }] },
      { role: roles.User, name: undefined, content: [{ callId: `call-${index}`, content: [{ value: messages[index].content[0].value }] }] }
    ]).flat()
    : messages;
  if (workload === "images") {
    // Synthetic binary payloads exercise encoding, not image decoding or quality.
    history = Array.from({ length: count }, (_, index) => ({
      role: roles.User,
      name: undefined,
      content: [{ mimeType: "image/png", data: Uint8Array.from({ length: 8192 }, (_, byte) => (byte + index) % 256) }]
    }));
  }
  const sessionId = "cocopi-language-model-437611ad-e695-4e3b-9e84-88542e6bb612";
  const encryptedPayloads = workload === "encrypted"
    ? Array.from({ length: count }, (_, index) => Buffer.alloc(8192, index % 251 + 1).toString("base64")) : [];
  if (workload === "encrypted") {
    // Synthetic opaque bytes exercise replay/serialization, not encryption.
    history = messages.map((message, index) => ({
      role: roles.Assistant, name: undefined,
      content: [{
        id: `synthetic-reasoning-${index}`, value: [],
        metadata: {
          encrypted_content: encryptedPayloads[index],
          vscode_thinking_origin_api: "responses"
        }
      }, message.content[0]]
    }));
  }
  if (workload === "markers") {
    history = messages.map((message, index) => {
      const payload = {
        version: 3, sessionId, responseId: `synthetic-response-${index}`,
        hostRequestIndex: index + 1, baselineItems: index + 1,
        baselineDigest: `sha256:${createHash("sha256").update(String(index)).digest("hex")}`
      };
      return {
        role: roles.Assistant, name: undefined,
        content: [message.content[0], {
          mimeType: "stateful_marker",
          data: new TextEncoder().encode(String.raw`synthetic\cocopi:state:${Buffer.from(JSON.stringify(payload)).toString("base64url")}`)
        }]
      };
    });
  }
  globalThis.gc?.();
  const baseline = process.memoryUsage();
  const totals = { conversionMs: 0, constructionMs: 0, digestsMs: 0, uploadMs: 0 };
  const encoder = new TextEncoder();
  let uploadBytes = 0;
  let inputItems = 0;
  const iterations = 10;
  for (let iteration = 0; iteration < iterations + 1; iteration += 1) {
    let started = performance.now();
    const state = codexRequestStateFromLanguageModelMessages(history, "synthetic", { LanguageModelChatMessageRole: roles }, { issueTracking: false, debugLevel: "off", includeEncryptedThinking: workload === "encrypted" });
    const conversionMs = performance.now() - started;
    started = performance.now();
    const body = buildTextResponseBody({ model: "synthetic", input: state.input, instructions: state.instructions, promptCacheKey: "synthetic-profile", stream: true });
    const constructionMs = performance.now() - started;
    started = performance.now();
    const summary = summarizeCodexRequestBodyForDiagnostics(body);
    assert.ok(summary.inputDigest);
    assert.ok(summary.toolsDigest);
    assert.ok(summary.bodyDigest);
    const digestsMs = performance.now() - started;
    started = performance.now();
    const upload = encoder.encode(JSON.stringify({ apiBaseUrl: "https://example.invalid", accessToken: "synthetic-local", body, transport: "websocket" }));
    const uploadMs = performance.now() - started;
    uploadBytes = upload.byteLength;
    inputItems = state.input.length;
    if (workload === "tools") {
      assert.equal(state.input.filter((item) => item.type === "function_call").length, count);
      assert.equal(state.input.filter((item) => item.type === "function_call_output").length, count);
    }
    if (workload === "images") {
      assert.equal(state.input.filter((item) => "content" in item && Array.isArray(item.content)
        && item.content.some((part) => part.type === "input_image")).length, count);
    }
    if (workload === "markers") {
      assert.equal(state.sessionId, sessionId);
      assert.equal(state.hostRequestIndex, count);
      assert.equal(state.continuationAnchors?.length, 1);
      assert.equal(state.continuationAnchors[0].responseId, `synthetic-response-${count - 1}`);
      assert.equal(state.continuationAnchors[0].baselineItems, count);
      assert.ok(!JSON.stringify(body).includes("cocopi:state:"));
    }
    if (workload === "encrypted") {
      for (let index = 0; index < count; index += 1) {
        const reasoning = state.input[index * 2];
        assert.equal(reasoning.type, "reasoning");
        if (reasoning.type === "reasoning") {
          assert.equal(reasoning.id, `synthetic-reasoning-${index}`);
          assert.equal(reasoning.encrypted_content, encryptedPayloads[index]);
          assert.deepEqual(reasoning.summary, []);
        }
        const visible = state.input[index * 2 + 1];
        assert.ok("role" in visible && visible.role === "assistant" && "content" in visible);
        assert.deepEqual(visible.content, [{ type: "output_text", text: messages[index].content[0].value.trim() }]);
      }
    }
    if (iteration > 0) {
      totals.conversionMs += conversionMs;
      totals.constructionMs += constructionMs;
      totals.digestsMs += digestsMs;
      totals.uploadMs += uploadMs;
    }
  }
  assert.equal(inputItems, workload === "tools" || workload === "encrypted" ? count * 2 : count);
  globalThis.gc?.();
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    kind: "preparation-profile", workload, messages: history.length, iterations, inputItems, uploadBytes,
    averageMs: Object.fromEntries(Object.entries(totals).map(([stage, total]) => [stage, total / iterations])),
    hostHeapDeltaBytesAfterGc: memory.heapUsed - baseline.heapUsed,
    hostExternalDeltaBytesAfterGc: memory.external - baseline.external,
    maxRssKiB: process.resourceUsage().maxRSS,
    note: "Synthetic text, tools, binary images, compact markers, or opaque encrypted-thinking replay; excludes cryptography, auth/catalog/routing, legacy payload markers, image decoding, tool schema adaptation, transport, rendering, and live VS Code. No transfer or network call."
  }));
}