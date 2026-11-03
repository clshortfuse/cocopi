import test from "node:test";
import assert from "node:assert/strict";

import { HttpResponseError, fetchWithRetries, throwHttpError } from "../lib/utils/http.js";
import { decodeWorkerError, encodeWorkerError } from "../lib/codex-api/worker-protocol.js";

test("terminal HTTP retry timing survives serialized worker errors without a sleep cap", async (context) => {
  const now = Date.UTC(2026, 9, 21);
  context.mock.method(Date, "now", () => now);
  for (const [header, expected] of [
    ["120", 120_000], ["0", 0],
    [new Date(now + 120_000).toUTCString(), 120_000],
    [new Date(now - 1000).toUTCString(), 0],
    ["invalid", undefined], ["-1", undefined], ["9".repeat(400), undefined]
  ]) {
    await assert.rejects(
      throwHttpError(new Response("", { status: 429, headers: { "Retry-After": String(header) } }), "Codex"),
      (error) => {
        assert.ok(error instanceof HttpResponseError);
        const wire = JSON.stringify(encodeWorkerError(error));
        const decoded = decodeWorkerError(JSON.parse(wire));
        assert.ok(decoded instanceof HttpResponseError);
        assert.equal(decoded.retryAfter, expected);
        assert.equal(decoded.message, error.message);
        return true;
      }
    );
  }
});

test("local retry sleeps remain capped while terminal rate-limit timing is preserved", async () => {
  /** @type {number[]} */
  const delays = [];
  let attempts = 0;
  const response = await fetchWithRetries("https://codex.example.test/responses", {}, {
    fetch: async () => {
      attempts += 1;
      return new Response("", { status: 429, headers: { "Retry-After": "120" } });
    },
    retryDelay: async (milliseconds) => { delays.push(milliseconds); }
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [30_000, 30_000]);
  await assert.rejects(throwHttpError(response, "Codex"), (error) => {
    assert.ok(error instanceof HttpResponseError);
    assert.equal(error.retryAfter, 120_000);
    return true;
  });
});

test("non-rate-limit HTTP errors retain sanitized diagnostics without retry hints", async () => {
  await assert.rejects(throwHttpError(Response.json({
    error: { code: "unavailable", message: "Service unavailable" }, access_token: "synthetic-private-value"
  }, { status: 503, headers: { "Retry-After": "120" } }), "Codex"), (error) => {
    assert.ok(error instanceof HttpResponseError);
    const wire = JSON.stringify(encodeWorkerError(error));
    const decoded = decodeWorkerError(JSON.parse(wire));
    assert.ok(decoded instanceof HttpResponseError);
    assert.equal(decoded.retryAfter, undefined);
    assert.match(decoded.message, /status 503/u);
    assert.match(decoded.message, /unavailable/u);
    assert.ok(!decoded.message.includes("synthetic-private-value"));
    return true;
  });
});