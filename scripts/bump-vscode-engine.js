import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT_URL = new URL("../", import.meta.url);
const VSCODE_DTS_URL = new URL("data/vscode-dts/", ROOT_URL);
const VSCODE_STABLE_RELEASES_URL = "https://update.code.visualstudio.com/api/releases/stable";

const version = await resolveVersionArgument(process.argv[2]);
const runtime = await resolveVscodeRuntime(version);

await updateJsonFile(new URL("package.json", ROOT_URL), (manifest) => {
  const packageJson = readRecord(manifest, "package.json");
  const engines = readRecord(packageJson.engines, "package.json.engines");
  engines.vscode = `^${version}`;
  delete engines.node;
});

runNpmPackageLockInstall();
runVscodeDts(version);

console.log(`Resolved VS Code ${version} to Electron ${runtime.electronVersion} with Node.js ${runtime.nodeVersion}.`);
console.log(`Updated VS Code engine target to ^${version}.`);

/**
 * @param {string | undefined} value
 * @returns {Promise<string>}
 */
async function resolveVersionArgument(value) {
  const versionArgument = value?.trim() || "latest";
  if (versionArgument === "latest") {
    return resolveLatestStableVscodeVersion();
  }

  if (isSemver(versionArgument)) {
    return versionArgument;
  }

  throw new Error("Usage: npm run vscode:engine -- [latest|<vscode-version>], for example npm run vscode:engine -- 1.120.0");
}

async function resolveLatestStableVscodeVersion() {
  const releases = readArray(await fetchJson(VSCODE_STABLE_RELEASES_URL), "VS Code stable releases");
  const versionArgument = releases.find((item) => typeof item === "string" && isSemver(item));
  if (typeof versionArgument !== "string") {
    throw new TypeError("Could not resolve the latest stable VS Code version.");
  }

  return versionArgument;
}

/**
 * @param {string} vscodeVersion
 * @returns {Promise<{ electronVersion: string, nodeVersion: string }>}
 */
async function resolveVscodeRuntime(vscodeVersion) {
  const vscodePackage = readRecord(await fetchJson(`https://raw.githubusercontent.com/microsoft/vscode/${vscodeVersion}/package.json`), "VS Code package.json");
  const devDependencies = readRecord(vscodePackage.devDependencies, "VS Code package.json devDependencies");
  const electronVersion = readDependencyVersion(devDependencies.electron, "VS Code Electron dependency");

  const releases = readArray(await fetchJson("https://releases.electronjs.org/releases.json"), "Electron releases");
  const release = releases
    .map((item) => readRecord(item, "Electron release"))
    .find((item) => item.version === electronVersion);
  if (!release) {
    throw new Error(`Could not find Electron ${electronVersion} release metadata.`);
  }

  const nodeVersion = readVersionString(release.node, `Electron ${electronVersion} Node.js runtime`);
  return { electronVersion, nodeVersion };
}

/** @param {string} url */
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  }

  return /** @type {import("../data/Codex.js").CodexJsonValue} */ (await response.json());
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue | undefined} value
 * @param {string} label
 */
function readDependencyVersion(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }

  const version = semverFromRange(value);
  if (!version) {
    throw new Error(`${label} does not contain a SemVer version: ${value}`);
  }

  return version;
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue | undefined} value
 * @param {string} label
 */
function readVersionString(value, label) {
  if (typeof value !== "string" || !isSemver(value)) {
    throw new TypeError(`${label} must be a SemVer string.`);
  }

  return value;
}

/** @param {string} value */
function semverFromRange(value) {
  for (const token of value.trim().split(" ")) {
    const version = trimRangePrefix(token.trim());
    if (isSemver(version)) {
      return version;
    }
  }
}

/** @param {string} value */
function trimRangePrefix(value) {
  let index = 0;
  while (index < value.length && !isDigit(value[index])) {
    index += 1;
  }

  return value.slice(index);
}

/** @param {string} value */
function isSemver(value) {
  const core = value.split("-")[0].split("+")[0];
  const parts = core.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0 && isDigitString(part));
}

/** @param {string | undefined} value */
function isDigit(value) {
  return value !== undefined && value >= "0" && value <= "9";
}

/** @param {string} value */
function isDigitString(value) {
  for (const char of value) {
    if (!isDigit(char)) {
      return false;
    }
  }

  return true;
}

/**
 * @param {URL} fileUrl
 * @param {(value: import("../data/Codex.js").CodexJsonValue) => void} update
 */
async function updateJsonFile(fileUrl, update) {
  const value = JSON.parse(await readFile(fileUrl, "utf8"));
  update(value);
  await writeJsonFile(fileUrl, value);
}

/**
 * @param {URL} fileUrl
 * @param {import("../data/Codex.js").CodexJsonValue} value
 */
async function writeJsonFile(fileUrl, value) {
  await writeFile(fileUrl, `${JSON.stringify(value, null, 2)}\n`);
}

function runNpmPackageLockInstall() {
  const args = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
  runCommand(npmCommand(), npmCommandArgs(args), {
    cwd: fileURLToPath(ROOT_URL),
    failureLabel: "npm package-lock update"
  });
}

/** @param {string} gitTag */
function runVscodeDts(gitTag) {
  const cliPath = fileURLToPath(new URL("node_modules/@vscode/dts/index.js", ROOT_URL));
  runCommand(process.execPath, [cliPath, gitTag], {
    cwd: fileURLToPath(VSCODE_DTS_URL),
    failureLabel: "@vscode/dts"
  });
  runCommand(process.execPath, [cliPath, "dev", gitTag], {
    cwd: fileURLToPath(VSCODE_DTS_URL),
    failureLabel: "@vscode/dts"
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, failureLabel: string }} options
 */
function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${options.failureLabel} failed with exit code ${result.status ?? 1}.`);
  }
}

function npmCommand() {
  return process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
}

/** @param {string[]} args */
function npmCommandArgs(args) {
  if (process.platform !== "win32") {
    return args;
  }

  return ["/d", "/s", "/c", ["npm", ...args].map((arg) => windowsCommandArg(arg)).join(" ")];
}

/** @param {string} value */
function windowsCommandArg(value) {
  return isWindowsCommandArgSafe(value) ? value : `"${value.replaceAll('"', String.raw`\"`)}"`;
}

/** @param {string} value */
function isWindowsCommandArgSafe(value) {
  for (const char of value) {
    if (!isWindowsCommandArgSafeChar(char)) {
      return false;
    }
  }

  return value.length > 0;
}

/** @param {string} char */
function isWindowsCommandArgSafeChar(char) {
  return isAsciiLetter(char)
    || isDigit(char)
    || char === "."
    || char === "_"
    || char === ":"
    || char === "@"
    || char === "/"
    || char === "\\"
    || char === "-";
}

/** @param {string} value */
function isAsciiLetter(value) {
  return (value >= "A" && value <= "Z") || (value >= "a" && value <= "z");
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue | undefined} value
 * @param {string} label
 * @returns {import("../data/Codex.js").CodexJsonValue[]}
 */
function readArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`);
  }

  return value;
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue | undefined} value
 * @param {string} label
 * @returns {Record<string, import("../data/Codex.js").CodexJsonValue>}
 */
function readRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (value);
}
