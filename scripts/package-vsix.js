import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageName = safePackageFilePart(String(manifest.name ?? "cocopi"));
const packageVersion = safePackageFilePart(String(manifest.version ?? "0.0.0"));
const outputPath = path.join("out", `${packageName}-${packageVersion}.vsix`);

mkdirSync(new URL("../out/", import.meta.url), { recursive: true });

const vsceArgs = [
  "--yes",
  "@vscode/vsce",
  "package",
  "--no-dependencies",
  "--skip-license",
  "--out",
  outputPath
];
const result = spawnSync(packageCommand(), packageCommandArgs(vsceArgs), {
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;

/** @param {string} value */
function safePackageFilePart(value) {
  return value
    .replaceAll("@", "")
    .replaceAll("/", "-")
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-");
}

/** @returns {string} */
function packageCommand() {
  return process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npx";
}

/**
 * @param {string[]} args
 * @returns {string[]}
 */
function packageCommandArgs(args) {
  if (process.platform !== "win32") {
    return args;
  }

  return ["/d", "/s", "/c", ["npx", ...args].map((arg) => windowsCommandArg(arg)).join(" ")];
}

/** @param {string} value */
function windowsCommandArg(value) {
  return /^[A-Za-z0-9._:@/\\-]+$/u.test(value) ? value : `"${value.replaceAll('"', String.raw`\"`)}"`;
}