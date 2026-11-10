import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";

test("transport fixture respects keepOpen after its normal delta stream", () => {
  const source = readFileSync(new URL("fixtures/transport-server.js", import.meta.url), "utf8");
  const generateSource = source.slice(source.indexOf("function generate("), source.indexOf("\nserver.listen"));
  for (const keepOpen of [true, false]) {
    /** @type {(() => void) | undefined} */
    let tick;
    let closed = 0;
    let completed = 0;
    const generate = new Script(`(${generateSource})`).runInNewContext({
      workerData: { keepOpen },
      counts: new Int32Array(new SharedArrayBuffer(12)),
      Atomics,
      setInterval: /** @param {() => void} callback */ (callback) => { tick = callback; return 1; },
      clearInterval() {}
    });
    generate("events", /** @param {{ type: string }} event */ (event) => {
      if (event.type === "response.completed") completed += 1;
    }, () => { closed += 1; });
    assert.ok(tick);
    for (let index = 0; index < 31; index += 1) tick();
    assert.equal(completed, 1);
    assert.equal(closed, keepOpen ? 0 : 1);
  }
});