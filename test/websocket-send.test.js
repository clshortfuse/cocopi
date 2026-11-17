import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

import { sendWebSocketText } from "../lib/codex-api/websocket-send.js";
import { CodexResponsesWebSocketSession } from "../lib/codex-api/websocket.js";

/** @typedef {{ binary?: boolean, fin?: boolean }} FrameOptions */
/** @typedef {(error?: Error) => void} WriteCallback */

/** @param {import('node:test').TestContext} context */
async function fixture(context) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  context.after(() => {
    for (const peer of server.clients) peer.terminate();
    server.close();
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const connected = once(server, "connection");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.terminate());
  const [peer] = await connected;
  await once(socket, "open");
  return { socket, peer, address };
}

for (const size of [0, 1024 * 1024, 1024 * 1024 + 1]) {
  test(`WebSocket text upload uses bounded frames for ${size} bytes`, async (context) => {
    const { socket, peer } = await fixture(context);
    const send = context.mock.method(socket, "send");
    const received = once(peer, "message");
    const text = "a".repeat(size);
    await sendWebSocketText(socket, text);
    const [data, binary] = await received;
    assert.equal(binary, false);
    assert.equal(data.toString(), text);
    assert.deepEqual(send.mock.calls.map(({ arguments: args }) => {
      assert.ok(Buffer.isBuffer(args[0]));
      return [args[0].length, args[1].fin, args[1].binary];
    }),
      size <= 1024 * 1024 ? [[size, true, false]] : [[1024 * 1024, false, false], [1, true, false]]);
  });
}

test("fragmented text waits for each write callback and preserves split UTF-8", async (context) => {
  const { socket, peer } = await fixture(context);
  const text = `${"a".repeat(1024 * 1024 - 1)}\u{1F600}${"b".repeat(1024 * 1024)}`;
  const received = once(peer, "message");
  const send = socket.send.bind(socket);
  /** @type {() => void} */
  let release = () => {};
  let written = () => {};
  /** @type {Promise<void>} */
  const firstWritten = new Promise((resolve) => { written = () => resolve(); });
  let first = true;
  const mocked = context.mock.method(socket, "send", /**
                                                      * @param {Buffer} data
                                                      * @param {FrameOptions} options
                                                      * @param {WriteCallback} callback
                                                      */ (data, options, callback) => {
    if (!first) return send(data, options, callback);
    first = false;
    send(data, options, (error) => {
      release = () => callback(error);
      written();
    });
  });
  const pending = sendWebSocketText(socket, text);
  await firstWritten;
  assert.equal(mocked.mock.calls.length, 1, "later frames must wait for write completion");
  release();
  await pending;
  const [data, binary] = await received;
  assert.equal(binary, false);
  assert.equal(data.toString(), text);
  assert.equal(mocked.mock.calls.length, 3);
});

test("write errors reject upload without sending later fragments", async (context) => {
  const { socket } = await fixture(context);
  const send = context.mock.method(socket, "send", /**
                                                    * @param {Buffer} _data
                                                    * @param {FrameOptions} _options
                                                    * @param {WriteCallback} callback
                                                    */ (_data, _options, callback) => callback(new Error("synthetic write failure")));
  await assert.rejects(sendWebSocketText(socket, "a".repeat(2 * 1024 * 1024)), /synthetic write failure/u);
  assert.equal(send.mock.calls.length, 1);
});

test("aborting a fragmented request closes instead of interleaving a cancel message", async (context) => {
  const { address } = await fixture(context);
  const send = WebSocket.prototype.send;
  /** @type {() => void} */
  let release = () => {};
  let written = () => {};
  /** @type {Promise<void>} */
  const firstWritten = new Promise((resolve) => { written = () => resolve(); });
  const mocked = context.mock.method(WebSocket.prototype, "send", /**
                                                                   * @this {WebSocket}
                                                                   * @param {Buffer} data
                                                                   * @param {FrameOptions} options
                                                                   * @param {WriteCallback} callback
                                                                   */ function (data, options, callback) {
    send.call(this, data, options, (error) => {
      release = () => callback(error);
      written();
    });
  });
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    accessToken: "synthetic",
    WebSocketConstructor: /** @type {typeof globalThis.WebSocket} */ (/** @type {object} */ (WebSocket))
  });
  context.after(() => session.dispose());
  const abort = new AbortController();
  const opening = session.request({ body: { model: "synthetic", input: "a".repeat(2 * 1024 * 1024) }, signal: abort.signal });
  const rejected = assert.rejects(opening, /synthetic abort/u);
  await firstWritten;
  abort.abort(new Error("synthetic abort"));
  release();
  await rejected;
  assert.equal(mocked.mock.calls.length, 1);
  assert.equal(session.socket, undefined);
});
