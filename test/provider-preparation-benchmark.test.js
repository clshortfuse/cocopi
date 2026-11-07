import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("provider preparation profile preserves opaque thinking without logging replay payloads", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../scripts/benchmark-provider-preparation.js", import.meta.url)), "8", "encrypted"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.workload, "encrypted");
  assert.equal(profile.messages, 8);
  assert.equal(profile.inputItems, 16);
  assert.ok(profile.uploadBytes > 8 * 8192);
  for (const value of Object.values(profile.averageMs)) assert.ok(Number(value) >= 0);
  assert.doesNotMatch(result.stdout, /synthetic history|synthetic-reasoning-|encrypted_content|AQEBAQEB/u);
});

test("provider preparation profile uses offline production helpers and reports stages", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../scripts/benchmark-provider-preparation.js", import.meta.url)), "8"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.kind, "preparation-profile");
  assert.equal(profile.messages, 8);
  assert.equal(profile.inputItems, 8);
  assert.ok(profile.uploadBytes > 0);
  for (const stage of ["conversionMs", "constructionMs", "digestsMs", "uploadMs"]) assert.ok(profile.averageMs[stage] >= 0);
  assert.doesNotMatch(result.stdout, /synthetic history/u);
});

test("provider preparation profile preserves paired tool history without logging payloads", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../scripts/benchmark-provider-preparation.js", import.meta.url)), "8", "tools"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.workload, "tools");
  assert.equal(profile.messages, 16);
  assert.equal(profile.inputItems, 16);
  assert.ok(profile.uploadBytes > 0);
  for (const value of Object.values(profile.averageMs)) assert.ok(Number(value) >= 0);
  assert.doesNotMatch(result.stdout, /synthetic history|synthetic-\d+\.txt|call-\d+/u);
});

test("provider preparation profile encodes binary images without logging image URLs", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../scripts/benchmark-provider-preparation.js", import.meta.url)), "8", "images"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.workload, "images");
  assert.equal(profile.messages, 8);
  assert.equal(profile.inputItems, 8);
  assert.ok(profile.uploadBytes > 8 * 8192);
  for (const value of Object.values(profile.averageMs)) assert.ok(Number(value) >= 0);
  assert.doesNotMatch(result.stdout, /data:image|base64,/u);
});

test("provider preparation profile restores compact markers without logging hidden state", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../scripts/benchmark-provider-preparation.js", import.meta.url)), "8", "markers"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.workload, "markers");
  assert.equal(profile.messages, 8);
  assert.equal(profile.inputItems, 8);
  assert.ok(profile.uploadBytes > 0);
  for (const value of Object.values(profile.averageMs)) assert.ok(Number(value) >= 0);
  assert.doesNotMatch(result.stdout, /cocopi:state:|synthetic-response-|baselineDigest|437611ad/u);
});