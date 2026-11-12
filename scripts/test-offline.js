import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const tests = readdirSync(new URL("test/", root))
  .filter((name) => name.endsWith(".test.js") && !name.endsWith("-live.test.js"))
  .toSorted()
  .map((name) => fileURLToPath(new URL(`test/${name}`, root)));
if (tests.length === 0) {
  throw new Error("No offline test files found.");
}
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...tests], {
  cwd: fileURLToPath(root),
  stdio: "inherit"
});
if (result.error) {
  throw result.error;
}
// eslint-disable-next-line unicorn/no-process-exit -- CLI wrapper must preserve the test runner's exit status.
process.exit(result.status ?? 1);
