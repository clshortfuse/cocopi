import assert from "node:assert/strict";
import { logCodexRequestDiagnostics, noopCocopiLogger, summarizeCodexRequestBodyForDiagnostics } from "../lib/vscode/diagnostics.js";

const body = {
  model: "synthetic",
  input: Array.from({ length: 256 }, (_, index) => ({ role: "user", content: [{ type: "input_text", text: `${index}:` + "synthetic history ".repeat(256) }] }))
};
let lastLog = "";
const logger = { ...noopCocopiLogger, debug: /** @param {string} message */ (message) => { lastLog = message; } };
/** @type {string | undefined} */
let expectedLog;
for (const reuse of [false, true]) {
  const started = performance.now();
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const summary = summarizeCodexRequestBodyForDiagnostics(body);
    // Token tracking consumes these fields before logging in the providers.
    assert.ok(summary.inputDigest);
    assert.ok(summary.toolsDigest);
    assert.ok(summary.bodyDigest);
    logCodexRequestDiagnostics(logger, "metadata", body, {}, reuse ? summary : undefined);
    expectedLog ??= lastLog;
    assert.equal(lastLog, expectedLog);
  }
  console.log(JSON.stringify({ algorithm: reuse ? "shared-summary" : "duplicate-summary", iterations: 20, items: body.input.length, elapsedMs: performance.now() - started }));
}