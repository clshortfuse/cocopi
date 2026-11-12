import assert from "node:assert/strict";
import test from "node:test";
import { CodexTransport } from "../lib/codex-api/transport.js";
import { CodexResponsesWebSocketSession, codexContinuationRequestState } from "../lib/codex-api/websocket.js";

function session() {
  return new CodexResponsesWebSocketSession({ apiBaseUrl: "https://example.invalid", accessToken: "synthetic" });
}

test("default transport bounds idle sessions like the worker", () => {
  const transport = new CodexTransport();
  const sessions = Array.from({ length: 40 }, () => session());
  for (const [index, value] of sessions.entries()) transport.sessions.set(String(index), value);
  transport.trimSessions();
  assert.equal(transport.sessions.size, 32);
  assert.ok(sessions.slice(0, 8).every((value) => value.disposed));
  assert.ok(sessions.slice(8).every((value) => !value.disposed));
  transport.dispose();
});

test("disposing a session releases continuation state", () => {
  const value = session();
  value.recordContinuationAnchors([{ responseId: "synthetic", baselineItems: 0, baselineDigest: "synthetic" }]);
  assert.equal(value.continuationAnchors.length, 1);
  value.dispose();
  assert.equal(value.continuationAnchors.length, 0);
});

test("trimming protects queued and opening requests even above the idle limit", () => {
  const transport = new CodexTransport({ sessions: 1 });
  const busy = session();
  busy.pendingRequests = 1;
  const idle = session();
  transport.sessions.set("busy", busy);
  transport.sessions.set("idle", idle);
  transport.trimSessions();
  assert.equal(transport.sessions.get("busy"), busy);
  assert.equal(busy.disposed, false);
  assert.equal(idle.disposed, true);
  busy.pendingRequests = 0;
  transport.dispose();
});

test("default transport bounds retained continuation bytes", () => {
  const transport = new CodexTransport();
  const value = session();
  value.recordContinuationAnchors([{
    responseId: "synthetic", baselineItems: 0, baselineDigest: "synthetic",
    requestState: { instructions: "x".repeat(17 * 1024 * 1024) }
  }]);
  transport.sessions.set("large", value);
  assert.equal(value.continuationAnchors.length, 1);
  transport.trimSessions();
  assert.equal(value.continuationAnchors.length, 0);
  transport.dispose();
});

test("cache trimming measures immutable continuation snapshots only once", () => {
  const transport = new CodexTransport();
  const value = session();
  const state = codexContinuationRequestState({ model: "synthetic", input: [], instructions: "synthetic instructions" });
  value.recordContinuationAnchors([{ responseId: "synthetic", baselineItems: 0, baselineDigest: "synthetic", requestState: state }]);
  transport.sessions.set("synthetic", value);
  let serializations = 0;
  const stringify = JSON.stringify;
  JSON.stringify = (...args) => {
    if (args[0] === value.continuationAnchors[0]) serializations += 1;
    return Reflect.apply(stringify, JSON, args);
  };
  try {
    transport.trimSessions();
    transport.trimSessions();
    transport.trimSessions();
    assert.equal(serializations, 1);
  } finally {
    JSON.stringify = stringify;
    transport.dispose();
  }
});

test("cache trimming remeasures caller-owned mutable request state", () => {
  const transport = new CodexTransport({ cacheBytes: 500 });
  const value = session();
  const state = { instructions: "small" };
  value.recordContinuationAnchors([{ responseId: "synthetic", baselineItems: 0, baselineDigest: "synthetic", requestState: state }]);
  transport.sessions.set("synthetic", value);
  transport.trimSessions();
  assert.equal(value.continuationAnchors.length, 1);
  state.instructions = "x".repeat(1000);
  transport.trimSessions();
  assert.equal(value.continuationAnchors.length, 0);
  transport.dispose();
});

test("owned continuation snapshots freeze only their detached request copy", () => {
  const text = { format: { type: "text" } };
  const state = codexContinuationRequestState({ model: "synthetic", input: [], text });
  assert.ok(Object.isFrozen(state));
  assert.ok(state.text);
  assert.ok(Object.isFrozen(state.text));
  assert.equal(Object.isFrozen(text), false);
  text.format.type = "changed";
  assert.notEqual(JSON.stringify(state.text), JSON.stringify(text));
});

test("identical continuation request state reuses the previous immutable snapshot", () => {
  const body = { model: "synthetic", input: [], instructions: "stable", tools: [{ type: "function", name: "synthetic", parameters: { type: "object" } }] };
  const first = codexContinuationRequestState(body);
  const next = codexContinuationRequestState({ ...body, input: [{ role: "user", content: [{ type: "input_text", text: "new turn" }] }] }, first);
  assert.equal(next, first);
  const changed = codexContinuationRequestState({ ...body, instructions: "changed" }, first);
  assert.notEqual(changed, first);
  body.tools[0].parameters.type = "string";
  assert.notEqual(codexContinuationRequestState(body, first), first, "tool schemas affect response context compatibility");
});

test("caller-owned state is not reused as an immutable snapshot", () => {
  const mutable = { model: "synthetic", instructions: "stable" };
  const state = codexContinuationRequestState({ ...mutable, input: [] }, mutable);
  assert.notEqual(state, mutable);
  assert.ok(Object.isFrozen(state));
  assert.equal(Object.isFrozen(mutable), false);
});

test("refreshed anchors do not reuse the previous snapshot byte count", () => {
  const transport = new CodexTransport({ cacheBytes: 500 });
  const value = session();
  const anchor = { responseId: "synthetic", baselineItems: 0, baselineDigest: "synthetic" };
  value.recordContinuationAnchors([{ ...anchor, requestState: codexContinuationRequestState({ model: "synthetic", input: [], instructions: "small" }) }]);
  transport.sessions.set("synthetic", value);
  transport.trimSessions();
  assert.equal(value.continuationAnchors.length, 1);
  value.refreshContinuationAnchors([{ ...anchor, requestState: codexContinuationRequestState({ model: "synthetic", input: [], instructions: "x".repeat(1000) }) }]);
  transport.trimSessions();
  assert.equal(value.continuationAnchors.length, 0);
  transport.dispose();
});

for (const ending of ["complete", "error", "cancel"]) {
  test(`transport trims idle sessions after ${ending}`, async () => {
    const transport = new CodexTransport({ sessions: 1 });
    const oldest = session();
    const newest = session();
    transport.sessions.set("old", oldest);
    transport.sessions.set("new", newest);
    transport.websocket = async () => new ReadableStream({
      start(controller) {
        if (ending === "complete") controller.close();
        if (ending === "error") controller.error(new Error("synthetic failure"));
      }
    });
    const stream = await transport.request({
      transport: "websocket", apiBaseUrl: "https://example.invalid", accessToken: "synthetic",
      body: { model: "synthetic", input: [], stream: true }
    });
    if (ending === "cancel") {
      await stream.cancel();
    } else if (ending === "error") {
      await assert.rejects(stream.getReader().read(), /synthetic failure/u);
    } else {
      const result = await stream.getReader().read();
      assert.equal(result.done, true);
    }
    assert.equal(transport.sessions.size, 1);
    assert.equal(oldest.disposed, true);
    assert.equal(newest.disposed, false);
    transport.dispose();
  });
}