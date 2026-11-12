import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("token tracker profile measures bounded persistence without logging records", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/benchmark-token-tracker.js", import.meta.url)), "5000"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.kind, "token-tracker-profile");
  assert.equal(profile.entries, 5000);
  assert.equal(profile.iterations, 20);
  assert.equal(profile.writes, 20);
  assert.ok(profile.averageRecordMs >= 0);
  assert.ok(profile.averagePersistenceMs >= 0);
  assert.ok(profile.storedBytes > 0);
  assert.doesNotMatch(result.stdout, /synthetic-session-|synthetic-\d+/u);
});