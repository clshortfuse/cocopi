import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalCodexJsonString } from "../lib/codex-api/json.js";
import { createCodexContinuationInputDigestBuilder } from "../lib/codex-api/websocket.js";

test("continuation framing uses canonical UTF-16 lengths rather than encoded byte lengths", () => {
  const items = [
    { role: "user", content: [{ type: "input_text", text: "😀é漢字".repeat(8192) }] },
    { type: "function_call_output", call_id: "synthetic", output: "\uD800\n\"\\😀" }
  ];
  const expected = createHash("sha256");
  const byteFramed = createHash("sha256");
  for (const item of items) {
    const text = canonicalCodexJsonString(item);
    expected.update(`${text.length}:`).update(text).update(";");
    byteFramed.update(`${Buffer.byteLength(text)}:`).update(text).update(";");
  }
  const builder = createCodexContinuationInputDigestBuilder([items]);
  const snapshot = builder.snapshot();
  assert.equal(snapshot.items, 2);
  assert.equal(snapshot.digest, `sha256:${expected.digest("hex")}`);
  assert.notEqual(snapshot.digest, `sha256:${byteFramed.digest("hex")}`);
  const branch = builder.fork();
  branch.update({ role: "user", content: "rewritten branch" });
  assert.deepEqual(builder.snapshot(), snapshot, "branching must not mutate the retained prefix");
});