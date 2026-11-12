import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
const profile = readProfile(process.argv.slice(2));
const packageName = safePackageFilePart(String(manifest.name ?? "cocopi"));
const packageVersion = safePackageFilePart(String(manifest.version ?? "0.0.0"));
const profileSuffix = profile === "full" ? "" : `-${profile}`;
const outputPath = path.join(REPOSITORY_ROOT, "out", `${packageName}-${packageVersion}${profileSuffix}.vsix`);
const stagingPath = path.join(REPOSITORY_ROOT, ".tmp", `package-${profile}`);

mkdirSync(path.dirname(outputPath), { recursive: true });
rmSync(stagingPath, { force: true, recursive: true });

try {
  prepareStagingDirectory(stagingPath, manifest, profile);
  const vsceArgs = [
    "--no-install",
    "vsce",
    "package",
    "--skip-license",
    "--out",
    outputPath
  ];
  const result = spawnSync(packageCommand(), packageCommandArgs(vsceArgs), {
    cwd: stagingPath,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(stagingPath, { force: true, recursive: true });
}

/**
 * @param {string} stagingDirectory
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} sourceManifest
 * @param {"full" | "marketplace"} buildProfile
 */
function prepareStagingDirectory(stagingDirectory, sourceManifest, buildProfile) {
  mkdirSync(stagingDirectory, { recursive: true });
  const packageEntries = [
    ...readStringArray(sourceManifest.files, "package files"),
    "package-lock.json"
  ];
  for (const entry of packageEntries) {
    const source = path.join(REPOSITORY_ROOT, entry);
    if (!existsSync(source)) {
      throw new Error(`Missing package input ${entry}.`);
    }
    const destination = path.join(stagingDirectory, entry);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }

  const stagedManifest = structuredClone(sourceManifest);
  if (buildProfile === "marketplace") {
    delete stagedManifest.enabledApiProposals;
    stagedManifest.files = readStringArray(stagedManifest.files, "package files")
      .filter((entry) => entry !== ".env.example" && entry !== "types");
    rmSync(path.join(stagingDirectory, ".env.example"), { force: true });
    rmSync(path.join(stagingDirectory, "types"), { force: true, recursive: true });
    rmSync(path.join(stagingDirectory, "data", "vscode-dts"), { force: true, recursive: true });
    rmSync(path.join(stagingDirectory, "media", "icon.svg"), { force: true });
    rmSync(path.join(stagingDirectory, "media", "promo.svg"), { force: true });
    rmSync(path.join(stagingDirectory, "media", "status-icons"), { force: true, recursive: true });
    writeFileSync(
      path.join(stagingDirectory, "data", "build-profile.js"),
      'export const COCOPI_BUILD_PROFILE = "marketplace";\nexport const COCOPI_PROPOSED_APIS_ENABLED = false;\n'
    );
  }

  writeFileSync(path.join(stagingDirectory, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`);
}

/** @param {string[]} arguments_ */
function readProfile(arguments_) {
  const profileArgument = arguments_.find((argument) => argument.startsWith("--profile="));
  const value = profileArgument?.slice("--profile=".length) ?? "full";
  if (value !== "full" && value !== "marketplace") {
    throw new Error(`Unknown package profile ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue} value
 * @param {string} label
 * @returns {string[]}
 */
function readStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`Expected ${label} to be an array of strings.`);
  }
  return value;
}

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
 * @param {string[]} arguments_
 * @returns {string[]}
 */
function packageCommandArgs(arguments_) {
  if (process.platform !== "win32") {
    return arguments_;
  }

  return ["/d", "/s", "/c", ["npx", ...arguments_].map((argument) => windowsCommandArgument(argument)).join(" ")];
}

/** @param {string} value */
function windowsCommandArgument(value) {
  return /^[A-Za-z0-9._:@/\\-]+$/u.test(value) ? value : `"${value.replaceAll('"', String.raw`\"`)}"`;
}