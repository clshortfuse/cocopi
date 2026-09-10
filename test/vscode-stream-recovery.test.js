import test from "node:test";
import assert from "node:assert/strict";
import { withCompletedItemRecovery } from "../lib/vscode/stream-recovery.js";
import { CodexResponseWebSocketError } from "../lib/codex-api/websocket.js";

for (const stage of ["normalization", "serialization", "opening", "backoff", "timeout"]) {
  test(`recovery error boundary: ${stage}`, async (testContext) => {
    const abort = new AbortController();
    const deadline = new AbortController();
    if (stage === "timeout") {
      testContext.mock.method(AbortSignal, "timeout", () => deadline.signal);
    }
    const failure = new TypeError("fixture local failure");
    /** @type {string[]} */
    const reports = [];
    let attempts = 0;
    let captured = 0;
    const events = stage === "normalization" || stage === "serialization"
      ? [done, { ...done, output_index: 1 }]
      : [done];
    const recovered = withCompletedItemRecovery(stream(events, new TypeError("fixture read failure")), {
      signal: abort.signal,
      completedItem() {
        captured += 1;
        if (captured === 2 && stage === "normalization") {
          throw failure;
        }
        if (captured === 2 && stage === "serialization") {
          return { type: "reasoning", toJSON() { throw failure; } };
        }
        return { type: "reasoning", encrypted_content: "fixture" };
      },
      async resume() {
        attempts += 1;
        throw failure;
      },
      report(message) {
        reports.push(message);
        if (stage === "backoff" && message.includes("started")) {
          abort.abort();
        }
        if (stage === "timeout" && message.includes("started")) {
          deadline.abort(new DOMException("fixture deadline", "TimeoutError"));
        }
      }
    });
    await assert.rejects(async () => {
      for await (const event of recovered) {
        void event;
      }
    });
    assert.equal(attempts, stage === "opening" ? 1 : 0);
    if (stage === "normalization" || stage === "serialization") {
      assert.deepEqual(reports, [], "local errors must not initiate paid recovery");
    } else {
      assert.equal(reports.filter((message) => /recovery (failed|cancelled)\./u.test(message)).length, 1);
      assert.equal(reports.some((message) => message.includes("succeeded")), false);
      assert.ok(reports[1].includes(stage === "backoff" ? "recovery cancelled." : "recovery failed."));
      assert.ok(reports.every((message) => !message.includes("fixture")));
    }
  });
}

/** @typedef {import("../data/Codex.js").CodexResponseStreamEvent} Event */
for (const continuationText of ["A different opening and conclusion.", "The original answer."]) {
  test(`recovery preserves fresh generation without wording-based suppression: ${continuationText}`, async () => {
    /** @type {import("../data/Codex.js").CodexResponseInputItem} */
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "The original answer." }] };
    /** @type {Event} */
    const completedMessage = { type: "response.output_item.done", item_id: "message-original", output_index: 0, item };
    /** @type {Event} */
    const freshDelta = { type: "response.output_text.delta", output_index: 0, delta: continuationText };
    let attempts = 0;
    const recovered = withCompletedItemRecovery(stream([completedMessage], new CodexResponseWebSocketError("fixture transport error")), {
      signal: new AbortController().signal,
      completedItem: () => item,
      async resume(items) {
        attempts += 1;
        assert.deepEqual(items, [item], "completed context is supplied exactly once");
        return stream([freshDelta, { type: "response.completed", response: { id: "recovered" } }]);
      },
      report() {}
    });
    const output = [];
    for await (const event of recovered) {
      output.push(event);
    }
    assert.equal(attempts, 1);
    assert.deepEqual(output, [completedMessage, freshDelta, { type: "response.completed", response: { id: "recovered" } }],
      "retained events are not replayed, but all fresh output survives regardless of wording");
  });
}

/** @type {Event} */
const done = { type: "response.output_item.done", item_id: "rs", output_index: 0, item: { type: "reasoning", id: "rs", encrypted_content: "fixture" } };

/**
 * @param {Event[]} events
 * @param {Error} [error]
 * @yields {Event}
 */
async function* stream(events, error) {
  yield* events;
  if (error) {
    throw error;
  }
}

for (const scenario of ["recover", "exhaustion", "tool", "partial", "quota", "cancel", "oversize", "terminal", "cancel-backoff"]) {
  test(`completed-item recovery safety: ${scenario}`, async () => {
    const abort = new AbortController();
    let attempts = 0;
    /** @type {string[]} */
    const reports = [];
    /** @type {Event[]} */
    const events = [done];
    if (scenario === "tool") {
      events.push({ type: "response.function_call_arguments.done", item_id: "fc", output_index: 1, call_id: "call", name: "read_file", arguments: "{}" });
    }
    if (scenario === "partial") {
      events.push({ type: "response.output_text.delta", output_index: 1, delta: "partial" });
    }
    if (scenario === "terminal") {
      events.push({ type: "response.completed", response: { id: "complete" } });
    }
    if (scenario === "cancel") {
      abort.abort();
    }
    const error = scenario === "quota" ? new Error("quota exceeded") : new CodexResponseWebSocketError("fixture transport error");
    const recovered = withCompletedItemRecovery(stream(events, error), {
      signal: abort.signal,
      completedItem() {
        return { type: "reasoning", id: "rs", encrypted_content: scenario === "oversize" ? "x".repeat(1024 * 1024 + 1) : "fixture" };
      },
      async resume(items) {
        attempts += 1;
        assert.equal(items.length, 1);
        return scenario === "exhaustion" ? stream([], error) : stream([{ type: "response.completed", response: { id: "recovered" } }]);
      },
      report(message) {
        reports.push(message);
        if (scenario === "cancel-backoff") {
          abort.abort();
        }
      }
    });
    const consume = async () => {
      const output = [];
      for await (const event of recovered) {
        output.push(event);
      }
      return output;
    };
    if (scenario === "recover" || scenario === "terminal") {
      const output = await consume();
      assert.equal(output.filter((event) => event.type === "response.output_item.done").length, 1);
      assert.equal(attempts, scenario === "recover" ? 1 : 0);
    } else {
      await assert.rejects(consume);
      assert.equal(attempts, scenario === "exhaustion" ? 1 : 0);
    }
    assert.equal(reports.some((message) => message.includes("succeeded")), scenario === "recover");
    assert.ok(reports.every((message) => !message.includes("fixture")));
  });
}