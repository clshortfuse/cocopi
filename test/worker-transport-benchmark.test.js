import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

for (const workload of ["fixed", "growing", "release", "sessions", "backpressure", "cancel"]) {
  test(`offline transport benchmark completes ${workload} workload and exits`, () => {
    const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../scripts/benchmark-worker-transport.js", import.meta.url)), workload, "2"], {
      encoding: "utf8", timeout: 15_000
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const summary = rows.at(-1);
    assert.equal(summary.kind, "summary");
    assert.equal(summary.workload, workload);
    assert.equal(summary.ipcMode, "full");
    assert.equal(summary.turns, 2);
    assert.equal(summary.generations, 3);
    assert.doesNotMatch(result.stdout, /synthetic history|synthetic-local/u);
    if (workload === "release") {
      const release = rows.find((row) => row.kind === "release");
      assert.ok(release);
      assert.equal(summary.hostGcCheckpoint, "before-history-release");
      assert.equal(release.releasedItems, 2);
      assert.ok(release.releasedTextBytes > 0);
      assert.equal(release.activeHostInvocations, 0);
      assert.equal(release.reservedHostUploadBytes, 0);
      for (const key of ["hostHeapBaselineBytes", "hostHeapWithHistoryBytes", "hostHeapAfterReleaseBytes"]) {
        assert.ok(Number.isFinite(release[key]) && release[key] > 0);
      }
    }
    if (summary.cachedSessions !== null && workload !== "cancel") assert.equal(summary.cachedSessions, workload === "sessions" ? 2 : 1);
    for (const sample of rows.filter((row) => row.kind === "sample")) {
      assert.equal(sample.activeHostInvocations, 0);
      assert.equal(sample.reservedHostUploadBytes, 0);
      assert.ok(sample.inputTextBytes > 0);
      if (workload !== "cancel") assert.ok(sample.workerHeapBytes > 0);
      if (workload === "backpressure") {
        assert.equal(sample.deliveredDeltas, 30);
        assert.ok(sample.spoolHighWaterBytes > 0);
      }
      assert.equal(sample.cancelled, workload === "cancel");
    }
  });
}

test("history release benchmark requires explicit host GC support", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/benchmark-worker-transport.js", import.meta.url)), "release", "2"], {
    encoding: "utf8", timeout: 15_000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release workload requires --expose-gc/u);
  assert.equal(result.stdout, "");
});

test("transport CPU mode reports separate host and worker samples", { skip: typeof Reflect.get(Worker.prototype, "startCpuProfile") !== "function" }, () => {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../scripts/benchmark-worker-transport.js", import.meta.url)), "growing", "2", "full", "cpu"], {
    encoding: "utf8", timeout: 15_000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const profile = result.stdout.trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.kind === "cpu");
  assert.ok(profile);
  for (const thread of [profile.host, profile.worker]) {
    assert.ok(thread.samples > 0);
    assert.equal(thread.samples, thread.activeSamples + thread.idleSamples);
    for (const row of thread.topSelfSamples) assert.ok(row.activePercent >= 0 && row.activePercent <= 100);
  }
  assert.doesNotMatch(result.stdout, /synthetic history|synthetic-local/u);
});