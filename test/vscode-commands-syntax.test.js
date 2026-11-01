import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("status dashboard module parses before loading extension dependencies", () => {
  const result = spawnSync(process.execPath, [
    "--check", fileURLToPath(new URL("../lib/vscode/commands.js", import.meta.url))
  ], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});