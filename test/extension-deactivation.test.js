import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { initializeCocopiTokenCacheDebugStorage, recordCocopiTokenCacheSummary, waitForCocopiTokenCacheDebugStorage } from "../lib/vscode/token-cache-debug.js";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "vscode"
      ? { url: "data:text/javascript,export {};", shortCircuit: true }
      : nextResolve(specifier, context);
  }
});
const { deactivate } = await import("../extension.js");
hooks.deregister();

test("extension deactivation waits for pending token persistence", async (context) => {
  let start = () => {};
  let release = () => {};
  const started = new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => { start = resolve; });
  const stored = new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => { release = resolve; });
  context.after(async () => { release(); await waitForCocopiTokenCacheDebugStorage(); });
  await initializeCocopiTokenCacheDebugStorage({
    get: async () => "",
    store: async () => { start(); await stored; },
    delete: async () => {}
  });
  recordCocopiTokenCacheSummary({ source: "language-model", model: "synthetic", sessionId: "synthetic-shutdown",
    hostRequestIndex: 1, inputItems: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2,
    cachedTokens: 0, reasoningTokens: 0, cacheHitRatio: 0, cacheStatus: "miss",
    promptCacheKey: "synthetic-shutdown", responseId: "synthetic" });
  await started;
  const shutdown = deactivate();
  assert.ok(shutdown instanceof Promise, "deactivation must return the persistence drain");
  let completed = false;
  const completion = shutdown.then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "pending storage must keep graceful deactivation open");
  release();
  await completion;
  assert.equal(completed, true);
});

test("extension deactivation propagates a pending persistence failure", async () => {
  let start = () => {};
  let release = () => {};
  const started = new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => { start = resolve; });
  const stored = new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => { release = resolve; });
  let attempts = 0;
  await initializeCocopiTokenCacheDebugStorage({
    get: async () => "",
    store: async () => {
      attempts += 1;
      if (attempts === 1) {
        start();
        await stored;
        throw new Error("synthetic shutdown write failure");
      }
    },
    delete: async () => {}
  });
  recordCocopiTokenCacheSummary({ source: "language-model", model: "synthetic", sessionId: "synthetic-shutdown",
    hostRequestIndex: 2, inputItems: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2,
    cachedTokens: 0, reasoningTokens: 0, cacheHitRatio: 0, cacheStatus: "miss",
    promptCacheKey: "synthetic-shutdown", responseId: "synthetic" });
  await started;
  const shutdown = assert.rejects(deactivate(), /synthetic shutdown write failure/u);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await shutdown;
  assert.equal(attempts, 1);
  await waitForCocopiTokenCacheDebugStorage();
  assert.equal(attempts, 2);
});