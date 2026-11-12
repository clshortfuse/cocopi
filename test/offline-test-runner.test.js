import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("offline runner excludes live modules and forwards options before test paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cocopi-offline-runner-"));
  try {
    await mkdir(path.join(directory, "scripts"));
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    const runner = path.join(directory, "scripts", "test-offline.js");
    await copyFile(new URL("../scripts/test-offline.js", import.meta.url), runner);
    await writeFile(path.join(directory, "test", "fixture.test.js"), `
import test from "node:test";
test("selected offline case", () => {});
test("unselected case", () => { throw new Error("option was not forwarded"); });
`);
    await writeFile(path.join(directory, "test", "fixture-live.test.js"), 'throw new Error("live module must not load");');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner, "--test-name-pattern=^selected offline case$"], {
      cwd: tmpdir(),
      env,
      encoding: "utf8"
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /selected offline case/u);
    assert.doesNotMatch(result.stdout + result.stderr, /live module must not load/u);

    await writeFile(path.join(directory, "test", "failure.test.js"), 'import test from "node:test"; test("selected failure", () => { throw new Error("fixture failure"); });');
    const failure = spawnSync(process.execPath, [runner, "--test-name-pattern=^selected failure$"], { encoding: "utf8", env });
    assert.ifError(failure.error);
    assert.equal(failure.status, 1, failure.stdout + failure.stderr);
    assert.match(failure.stdout + failure.stderr, /fixture failure/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
