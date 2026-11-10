import assert from "node:assert/strict";
import test from "node:test";
import { CodexResponsesWebSocketSession, codexContinuationAnchorFromInputItems } from "../lib/codex-api/websocket.js";

for (const outputMode of ["empty", "completed", "streamed"]) {
for (const scenario of ["matched", "mismatched", "prepared-mutation", "decision-mutation"]) {
test(`${scenario} continuation prefix handles ${outputMode} anchor`, async () => {
  const matched = scenario === "matched";
  let reads = 0;
  let content = "synthetic-prefix";
  const prefix = { role: "user", get content() { reads += 1; return content; } };
  const suffix = { role: "user", content: "synthetic-next" };
  const output = { type: "message", id: "message-next", role: "assistant", content: [{ type: "output_text", text: "synthetic-answer" }] };
  /** @type {object[]} */
  const sent = [];
  class Socket extends EventTarget {
    OPEN = 1;
    readyState = 1;
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    /** @param {string} data */
    send(data) {
      const request = JSON.parse(data);
      sent.push(request);
      if (request.type === "response.create") queueMicrotask(() => {
        if (outputMode === "streamed") this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          type: "response.output_item.done", item: output
        }) }));
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          type: "response.completed", response: { id: "response-next", status: "completed", output: outputMode === "completed" ? [output] : [] }
        }) }));
      });
    }
    close() { this.readyState = 3; }
  }
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: "https://offline.invalid", accessToken: "synthetic",
    WebSocketConstructor: /** @type {typeof WebSocket} */ (/** @type {object} */ (Socket))
  });
  session.continuationAnchors = [codexContinuationAnchorFromInputItems("response-prior", [matched ? prefix : { role: "user", content: "different-prefix" }])];
  reads = 0;
  try {
    const mutate = () => { content = "changed-by-hook"; };
    const stream = await session.request({
      body: { model: "synthetic", input: [prefix, suffix], stream: true },
      ...(scenario === "prepared-mutation" ? { onWebSocketRequestPrepared: mutate } : {}),
      ...(scenario === "decision-mutation" ? { onWebSocketContinuationDecision: mutate } : {})
    });
    for await (const event of stream) assert.ok(["response.output_item.done", "response.completed"].includes(event.type));
    if (!scenario.endsWith("mutation")) assert.equal(reads, matched ? 1 : 2, "one prefix hash, plus one wire serialization read on full-input fallback");
    assert.equal(Reflect.get(sent[0], "previous_response_id"), matched ? "response-prior" : undefined);
    assert.deepEqual(Reflect.get(sent[0], "input"), matched ? [suffix] : [prefix, suffix]);
    const expected = codexContinuationAnchorFromInputItems("response-next", [prefix, suffix], outputMode === "empty" ? [] : [output]);
    const anchor = session.continuationAnchors.find((item) => item.responseId === "response-next");
    assert.equal(anchor?.baselineDigest, expected.baselineDigest);
    assert.equal(anchor?.baselineItems, expected.baselineItems);
    const followUp = { role: "user", content: "synthetic-follow-up" };
    const next = await session.request({ body: { model: "synthetic", stream: true,
      input: [{ role: "user", content }, suffix, ...(outputMode === "empty" ? [] : [output]), followUp]
    } });
    for await (const event of next) assert.ok(event.type);
    assert.equal(Reflect.get(sent[1], "previous_response_id"), "response-next");
    assert.deepEqual(Reflect.get(sent[1], "input"), [followUp]);
  } finally {
    session.dispose();
  }
});
}
}