import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalCodexJsonDigest, canonicalCodexJsonString } from "../lib/codex-api/json.js";

test("incremental canonical digest matches canonical serialization", () => {
  const sparse = Array.from({ length: 3 });
  delete sparse[0];
  delete sparse[2];
  sparse[1] = "middle";
  const values = [
    undefined, null, true, false, 0, -0, 1.25, Number.NaN, Infinity,
    "quotes\"\\\n😀\uD800", [], {}, sparse,
    { z: undefined, a: [undefined, null, { b: 2, a: 1 }] },
    { "10": "ten", "2": "two", "01": "leading", "4294967295": "not-index", a: "last" },
    JSON.parse('{"__proto__":{"hidden":true},"4294967294":1,"0":2,"-0":3,"1e2":4}'),
    { input: Array.from({ length: 100 }, (_, index) => ({ text: `${index}😀`.repeat(500), optional: undefined })) }
  ];
  for (const value of values) {
    const expected = createHash("sha256").update(canonicalCodexJsonString(value)).digest("hex");
    assert.equal(canonicalCodexJsonDigest(value), expected);
  }
});

test("incremental canonical digest reflects mutations without an identity cache", () => {
  const value = { text: "before" };
  const before = canonicalCodexJsonDigest(value);
  value.text = "after";
  assert.notEqual(canonicalCodexJsonDigest(value), before);
  assert.equal(canonicalCodexJsonDigest({ b: 2, a: 1 }), canonicalCodexJsonDigest({ a: 1, b: 2 }));
});

test("selected root fields share canonical traversal without changing any digest", () => {
  const body = {
    z: "tail", input: [{ text: "😀".repeat(10_000), tools: ["nested"] }, null],
    tools: [{ parameters: { properties: { input: { type: "string" } } }, name: "synthetic" }],
    optional: undefined, a: "prefix"
  };
  const fields = new Map([["input", ""], ["tools", ""], ["optional", "absent"], ["missing", "absent"]]);
  assert.equal(canonicalCodexJsonDigest(body, fields), canonicalCodexJsonDigest(body));
  assert.equal(fields.get("input"), canonicalCodexJsonDigest(body.input));
  assert.equal(fields.get("tools"), canonicalCodexJsonDigest(body.tools));
  assert.equal(fields.get("optional"), "absent");
  assert.equal(fields.get("missing"), "absent");
});

test("grouped digests reuse encoded byte views across hash states", (context) => {
  const body = { input: [{ text: "😀é漢字".repeat(20_000) }], tools: [] };
  const expected = canonicalCodexJsonDigest(body);
  const expectedInput = canonicalCodexJsonDigest(body.input);
  const prototype = Object.getPrototypeOf(createHash("sha256"));
  const update = prototype.update;
  /** @type {Uint8Array | undefined} */
  let previous;
  let sharedUpdates = 0;
  /**
   * @this {import('node:crypto').Hash}
   * @param {import('node:crypto').BinaryLike} data
   * @param {import('node:crypto').Encoding} [encoding]
   */
  function observedUpdate(data, encoding) {
    if (data instanceof Uint8Array) {
      assert.ok(data.byteLength <= 65_536);
      if (previous === data) sharedUpdates += 1;
      previous = data;
    } else {
      previous = undefined;
    }
    return Reflect.apply(update, this, [data, encoding]);
  }
  context.mock.method(prototype, "update", observedUpdate);
  const fields = new Map([["input", ""], ["tools", ""]]);
  assert.equal(canonicalCodexJsonDigest(body, fields), expected);
  assert.equal(fields.get("input"), expectedInput);
  assert.ok(sharedUpdates > 0);
});