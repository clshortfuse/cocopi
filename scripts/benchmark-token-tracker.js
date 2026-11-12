import assert from "node:assert/strict";
import { initializeCocopiTokenCacheDebugStorage, recordCocopiTokenCacheSummary, readCocopiTokenCacheDebugSummaries, waitForCocopiTokenCacheDebugStorage } from "../lib/vscode/token-cache-debug.js";

const count = Number(process.argv[2] ?? 5000);
assert.ok(Number.isInteger(count) && count >= 0 && count <= 5000, "history count must be 0..5000");
let storedBytes = 0;
let writes = 0;
await initializeCocopiTokenCacheDebugStorage({
  get: async () => "",
  store: async (key, value) => { void key; storedBytes = Buffer.byteLength(value); writes += 1; },
  delete: async () => {}
});
/** @param {number} index */
function record(index) {
  recordCocopiTokenCacheSummary({
    source: "language-model", model: "synthetic", sessionId: `synthetic-session-${index % 32}`,
    hostRequestIndex: index, inputItems: index + 1, inputTokens: 1000,
    outputTokens: 100, totalTokens: 1100, cachedTokens: 500, cacheStatus: "hit",
    promptCacheKey: `synthetic-session-${index % 32}`, responseId: `synthetic-${index}`,
    reasoningTokens: 0, cacheHitRatio: 0.5
  });
}
for (let index = 0; index < count; index += 1) record(index);
await waitForCocopiTokenCacheDebugStorage();
const iterations = 20;
let recordMs = 0;
let persistenceMs = 0;
const initialWrites = writes;
for (let index = 0; index < iterations; index += 1) {
  let started = performance.now();
  record(count + index);
  recordMs += performance.now() - started;
  started = performance.now();
  await waitForCocopiTokenCacheDebugStorage();
  persistenceMs += performance.now() - started;
}
const entries = readCocopiTokenCacheDebugSummaries().length;
assert.equal(entries, Math.min(5000, count + iterations));
console.log(JSON.stringify({ kind: "token-tracker-profile", seedEntries: count, entries, iterations,
  averageRecordMs: recordMs / iterations, averagePersistenceMs: persistenceMs / iterations,
  storedBytes, writes: writes - initialWrites,
  note: "Synthetic metadata, in-memory storage; persistence includes encoding and byte counting, not VS Code SecretStorage I/O. No credentials or network."
}));