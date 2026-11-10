import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("preparation offload profile verifies exact offline digests and upload bytes", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/benchmark-preparation-offload.js", import.meta.url)), "8", "2"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.kind, "preparation-offload-profile");
  assert.equal(profile.messages, 8);
  assert.equal(profile.iterations, 2);
  assert.ok(profile.uploadBytes > 8 * 8192);
  for (const value of Object.values(profile.averageMs)) assert.ok(Number(value) >= 0);
  assert.doesNotMatch(result.stdout, /synthetic history|encrypted_content|AQEBAQEB/u);
});

for (const concurrency of [1, 3, 8]) {
  test(`preparation pressure profile correlates ${concurrency} bounded requests without logging payloads`, () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/benchmark-preparation-offload.js", import.meta.url)), "8", "2", String(concurrency)], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const profile = JSON.parse(result.stdout);
    assert.equal(profile.kind, "preparation-pressure-profile");
    assert.equal(profile.inputItems, 16);
    assert.equal(profile.concurrency, concurrency);
    assert.equal(profile.reservedUploadBytes, profile.uploadBytes * concurrency);
    for (const value of Object.values(profile.averageMs)) assert.ok(Number.isFinite(value) && Number(value) >= 0);
    for (const value of Object.values(profile.sampledMemory)) assert.ok(Number.isFinite(value) && Number(value) > 0);
    assert.doesNotMatch(result.stdout, /synthetic history|encrypted_content|AQEBAQEB/u);
  });

test("preparation pressure profile rejects an oversized cloned-request batch", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/benchmark-preparation-offload.js", import.meta.url)), "512", "1", "4"], { encoding: "utf8", timeout: 15_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /batch exceeds 32 MiB synthetic upload budget/u);
  assert.equal(result.stdout, "");
});
}

test("preparation pressure profile rejects invalid concurrency before measuring", () => {
  for (const concurrency of ["0", "9", "1.5"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/benchmark-preparation-offload.js", import.meta.url)), "8", "1", concurrency], { encoding: "utf8", timeout: 15_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /concurrency must be 1\.\.8/u);
    assert.equal(result.stdout, "");
  }
});