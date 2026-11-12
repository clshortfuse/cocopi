import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceManifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const defaultPath = path.join(repositoryRoot, "out", `${sourceManifest.name}-${sourceManifest.version}-marketplace.vsix`);
const packagePath = path.resolve(process.argv[2] ?? defaultPath);
const archive = new AdmZip(packagePath);
const entries = new Set(archive.getEntries().map((entry) => entry.entryName));
const normalizedEntries = new Set([...entries].map((entry) => entry.toLowerCase()));
const manifest = readJsonEntry("extension/package.json");

if (Object.hasOwn(manifest, "enabledApiProposals")) {
  throw new Error("Marketplace VSIX must not contain enabledApiProposals.");
}
if (normalizedEntries.has("extension/.env.example")) {
  throw new Error("Marketplace VSIX must not contain .env.example.");
}
if ([...entries].some((entry) => entry.startsWith("extension/types/") || entry.includes("/vscode.proposed."))) {
  throw new Error("Marketplace VSIX contains development declarations or proposed API declarations.");
}
if ([...normalizedEntries].some((entry) => entry.endsWith(".svg"))) {
  throw new Error("Marketplace VSIX contains SVG artwork, which Marketplace publishing rejects.");
}
for (const requiredEntry of [
  "extension/readme.md",
  "extension/data/build-profile.js",
  "extension/extension.js"
]) {
  if (!normalizedEntries.has(requiredEntry)) {
    throw new Error(`Marketplace VSIX is missing ${requiredEntry}.`);
  }
}

const buildProfile = readTextEntry("extension/data/build-profile.js");
if (!buildProfile.includes('COCOPI_BUILD_PROFILE = "marketplace"') || !buildProfile.includes("COCOPI_PROPOSED_APIS_ENABLED = false")) {
  throw new Error("Marketplace VSIX does not contain the disabled proposed-API build profile.");
}

console.log(`Marketplace VSIX verification passed: ${packagePath}`);

/** @param {string} entryName */
function readTextEntry(entryName) {
  const entry = archive.getEntry(entryName);
  if (!entry) {
    throw new Error(`VSIX entry not found: ${entryName}.`);
  }
  return entry.getData().toString("utf8");
}

/** @param {string} entryName */
function readJsonEntry(entryName) {
  return JSON.parse(readTextEntry(entryName));
}