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