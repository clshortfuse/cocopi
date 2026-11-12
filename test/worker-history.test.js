import assert from "node:assert/strict";
import test from "node:test";
import { WorkerHistory } from "../lib/codex-api/worker-history.js";

test("history patches append, rewind, rewrite and replace exactly", () => {
  const sender = new WorkerHistory(4096);
  const receiver = new WorkerHistory(4096);
  const histories = [["a", "b"], ["a", "b", "c"], ["a"], ["a", "new"], ["compacted"], []];
  const keeps = [0, 2, 1, 1, 0, 0];
  for (const [index, input] of histories.entries()) {
    const patch = sender.prepare(input);
    assert.equal(patch.keep, keeps[index]);
    assert.deepEqual(receiver.apply(patch), input.map((item) => JSON.stringify(item)));
    sender.apply(patch);
  }
});

test("history preparation observes in-place edits and does not commit failed sends", () => {
  const history = new WorkerHistory(4096);
  const input = [{ text: "before" }, { text: "tail" }];
  const first = history.prepare(input);
  assert.equal(history.revision, 0);
  assert.deepEqual(history.prepare(input), first);
  const snapshot = history.apply(first);
  input[0].text = "after";
  const rewrite = history.prepare(input);
  assert.equal(rewrite.keep, 0);
  history.apply(rewrite);
  assert.deepEqual(snapshot, ['{"text":"before"}', '{"text":"tail"}']);
  assert.throws(() => history.apply(first), /base mismatch/u);
});

test("history budget and invalid prefixes fail atomically", () => {
  const history = new WorkerHistory(8);
  const patch = history.prepare(["a"]);
  history.apply(patch);
  assert.throws(() => history.apply({ base: 1, revision: 2, keep: 2, suffix: [] }), /base mismatch/u);
  assert.throws(() => history.apply(history.prepare(["too large"])), /budget exceeded/u);
  assert.equal(history.revision, 1);
  assert.equal(history.bytes, 3);
  assert.deepEqual(history.items, ['"a"']);
  const restarted = new WorkerHistory(8);
  assert.throws(() => restarted.apply(history.prepare(["a", "b"])), /base mismatch/u);
});

test("fingerprint-only sender handles rewrites without retaining serialized payloads", () => {
  const sender = new WorkerHistory(1024 * 1024, true);
  const receiver = new WorkerHistory(1024 * 1024);
  const original = { text: "private synthetic history".repeat(8192) };
  for (const input of [[original], [original, { text: "tail" }], [original], [{ text: "edited" }], []]) {
    const patch = sender.prepare(input);
    receiver.apply(patch);
    sender.apply(patch);
    assert.equal(sender.bytes, receiver.bytes);
    assert.deepEqual(receiver.items, input.map((item) => JSON.stringify(item)));
    assert.ok(sender.items.every((item) => /^[\da-f]{64}$/u.test(item)));
    assert.doesNotMatch(JSON.stringify(sender), /private synthetic history/u);
  }
});