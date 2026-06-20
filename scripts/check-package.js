import { access, readFile } from "node:fs/promises";

import { COCOPI_CHAT_PARTICIPANT_ID } from "../lib/vscode/chat-participant.js";
import { COCOPI_COMMANDS } from "../lib/vscode/commands.js";
import { COCOPI_AUTH_MODES, COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES, COCOPI_COMPACTION_FALLBACK_STRATEGIES, COCOPI_REASONING_EFFORTS, COCOPI_REASONING_SUMMARIES, COCOPI_TOKEN_TRACKER_TIMELINE_MODES, COCOPI_TRANSPORTS, DEFAULT_EDIT_PROGRESS_INTERVAL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_TOKEN_TRACKER_TIMELINE_DAYS } from "../lib/vscode/configuration.js";
import { COCOPI_LANGUAGE_MODEL_VENDOR } from "../lib/vscode/language-model-provider.js";
import { DEFAULT_CODEX_API_BASE_URL, DEFAULT_CODEX_MODEL } from "../lib/codex-api/config.js";

const PACKAGE_PATH = new URL("../package.json", import.meta.url);
const REQUIRED_FILES = [
  "README.md",
  "extension.js",
  "media/cocopi.woff",
  "media/icon.png",
  "media/icon.svg",
  "media/promo.png",
  "media/promo.svg",
  "media/status-icons/cocopi.svg",
  "tsconfig.types.json",
  "types/extension.d.ts",
  "types/lib/vscode/commands.d.ts",
  "lib/vscode/activate.js",
  "lib/vscode/chat-participant.js",
  "lib/vscode/commands.js",
  "lib/vscode/language-model-provider.js"
];

const PACKAGE_FILES = [
  ".env.example",
  "README.md",
  "data",
  "extension.js",
  "lib",
  "media",
  "types"
];
const PACKAGE_KEYWORDS = [
  "vscode",
  "chat",
  "codex",
  "language-models"
];

async function main() {
  const manifest = JSON.parse(await readFile(PACKAGE_PATH, "utf8"));
  await assertRequiredFilesExist();
  checkManifest(manifest);
  console.log("Cocopi package manifest check passed.");
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} manifest
 */
function checkManifest(manifest) {
  const contributes = readRecord(manifest.contributes, "contributes");
  const configuration = readRecord(contributes.configuration, "contributes.configuration");
  const properties = readRecord(configuration.properties, "contributes.configuration.properties");
  const engines = readRecord(manifest.engines, "engines");

  assertEqual(manifest.name, "cocopi", "package name");
  assertEqual(manifest.type, "module", "package type");
  assertEqual(manifest.main, "./extension.js", "extension main");
  assertEqual(manifest.types, "./types/extension.d.ts", "extension declaration entry");
  assertNonEmptyString(engines.vscode, "VS Code engine range");
  assertPropertyAbsent(engines, "node", "Node engine range");
  assertStringArrayEqual(readArray(manifest.activationEvents, "activationEvents"), ["onLanguageModelChat:cocopi", "onStartupFinished"], "activation events");
  assertStringArrayEqual(readArray(manifest.enabledApiProposals, "enabledApiProposals"), ["chatStatusItem", "chatProvider", "languageModelThinkingPart"], "enabled API proposals");
  assertStringArrayEqual(readArray(manifest.files, "files"), PACKAGE_FILES, "package files");
  assertStringArrayEqual(readArray(manifest.keywords, "keywords"), PACKAGE_KEYWORDS, "package keywords");
  assertEqual(manifest.icon, "media/icon.png", "package icon");
  assertCocopiIconContribution(contributes);
  assertPackageExports(readRecord(manifest.exports, "exports"));
  assertTypesVersions(readRecord(manifest.typesVersions, "typesVersions"));

  assertConfigurationProperty(properties, "cocopi.apiBaseUrl", "string", DEFAULT_CODEX_API_BASE_URL);
  assertConfigurationProperty(properties, "cocopi.model", "string", DEFAULT_CODEX_MODEL);
  assertConfigurationProperty(properties, "cocopi.authMode", "string", COCOPI_AUTH_MODES.secretStorage);
  assertConfigurationProperty(properties, "cocopi.reasoningEffort", "string", COCOPI_REASONING_EFFORTS.default);
  assertConfigurationProperty(properties, "cocopi.reasoningSummary", "string", COCOPI_REASONING_SUMMARIES.auto);
  assertConfigurationProperty(properties, "cocopi.chatParticipantModelSource", "string", COCOPI_CHAT_PARTICIPANT_MODEL_SOURCES.selected);
  assertConfigurationProperty(properties, "cocopi.transport", "string", COCOPI_TRANSPORTS.websocket);
  assertConfigurationProperty(properties, "cocopi.editProgressIntervalMs", "number", DEFAULT_EDIT_PROGRESS_INTERVAL_MS);
  assertConfigurationProperty(properties, "cocopi.streamIdleTimeoutMs", "number", DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  assertConfigurationProperty(properties, "cocopi.showTokenTrackerTimeline", "boolean", true);
  assertConfigurationProperty(properties, "cocopi.tokenTrackerTimelineDays", "number", DEFAULT_TOKEN_TRACKER_TIMELINE_DAYS);
  assertConfigurationProperty(properties, "cocopi.tokenTrackerTimelineMode", "string", COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both);
  assertConfigurationProperty(properties, "cocopi.useModelDefaultCompactionLimit", "boolean", true);
  assertConfigurationProperty(properties, "cocopi.compactionFallbackStrategy", "string", COCOPI_COMPACTION_FALLBACK_STRATEGIES.ninetyPercent);

  const commands = readArray(contributes.commands, "contributes.commands");
  assertIncludesCommand(commands, COCOPI_COMMANDS.manage);
  assertIncludesCommand(commands, COCOPI_COMMANDS.showDiagnostics);
  assertIncludesCommand(commands, COCOPI_COMMANDS.showTokenTracker);
  assertIncludesCommand(commands, COCOPI_COMMANDS.signIn);
  assertIncludesCommand(commands, COCOPI_COMMANDS.selectModel);
  assertIncludesCommand(commands, COCOPI_COMMANDS.status);
  assertIncludesCommand(commands, COCOPI_COMMANDS.signOut);

  const chatParticipants = readArray(contributes.chatParticipants, "contributes.chatParticipants");
  const chatParticipant = chatParticipants.find((participant) => readRecord(participant, "chat participant").id === COCOPI_CHAT_PARTICIPANT_ID);
  if (!chatParticipant) {
    throw new Error(`Missing chat participant ${COCOPI_CHAT_PARTICIPANT_ID}.`);
  }
  const chatParticipantRecord = readRecord(chatParticipant, "chat participant");
  if (chatParticipantRecord.commands !== undefined && readArray(chatParticipantRecord.commands, "chat participant commands").length > 0) {
    throw new Error("Cocopi chat participant should not contribute slash commands.");
  }

  const languageModelProviders = readArray(contributes.languageModelChatProviders, "contributes.languageModelChatProviders");
  const provider = languageModelProviders.find((item) => readRecord(item, "language model provider").vendor === COCOPI_LANGUAGE_MODEL_VENDOR);
  if (!provider) {
    throw new Error(`Missing language model provider ${COCOPI_LANGUAGE_MODEL_VENDOR}.`);
  }

  const languageModelProvider = readRecord(provider, "language model provider");
  assertValidLanguageModelProviderKeys(languageModelProvider);
  if ("configuration" in languageModelProvider) {
    readRecord(languageModelProvider.configuration, "language model provider configuration");
  }
  assertEqual(languageModelProvider.displayName, "Cocopi", "language model provider display name");
  assertEqual(languageModelProvider.managementCommand, COCOPI_COMMANDS.manage, "language model provider management command");
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} contributes
 */
function assertCocopiIconContribution(contributes) {
  const iconFonts = readArray(contributes.iconFonts, "contributes.iconFonts");
  const iconFont = iconFonts.find((font) => readRecord(font, "icon font contribution").id === "cocopi-font");
  if (!iconFont) {
    throw new Error("Missing Cocopi icon font contribution.");
  }

  const iconFontRecord = readRecord(iconFont, "icon font contribution");
  const sources = readArray(iconFontRecord.src, "Cocopi icon font sources");
  const woffSource = sources.find((source) => readRecord(source, "Cocopi icon font source").path === "media/cocopi.woff");
  if (!woffSource) {
    throw new Error("Missing Cocopi WOFF icon font source.");
  }
  assertEqual(readRecord(woffSource, "Cocopi icon font source").format, "woff", "Cocopi icon font format");

  const icons = readRecord(contributes.icons, "contributes.icons");
  const cocopiIcon = readRecord(icons["cocopi-logo"], "Cocopi icon contribution");
  const defaultIcon = readRecord(cocopiIcon.default, "Cocopi default icon contribution");
  assertEqual(defaultIcon.fontPath, "media/cocopi.woff", "Cocopi icon font path");
  assertEqual(defaultIcon.fontCharacter, String.raw`\ea01`, "Cocopi icon font character");
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} exportsField
 */
function assertPackageExports(exportsField) {
  assertEqual(readRecord(exportsField["."], "exports root").types, "./types/extension.d.ts", "exports root types");
  assertEqual(readRecord(exportsField["."], "exports root").import, "./extension.js", "exports root import");
  assertEqual(readRecord(exportsField["./data/*.js"], "exports data").types, "./types/data/*.d.ts", "exports data types");
  assertEqual(readRecord(exportsField["./data/*.js"], "exports data").import, "./data/*.js", "exports data import");
  assertEqual(readRecord(exportsField["./lib/*.js"], "exports lib").types, "./types/lib/*.d.ts", "exports lib types");
  assertEqual(readRecord(exportsField["./lib/*.js"], "exports lib").import, "./lib/*.js", "exports lib import");
  assertEqual(readRecord(exportsField["./lib/*/*.js"], "exports nested lib").types, "./types/lib/*/*.d.ts", "exports nested lib types");
  assertEqual(readRecord(exportsField["./lib/*/*.js"], "exports nested lib").import, "./lib/*/*.js", "exports nested lib import");
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} typesVersions
 */
function assertTypesVersions(typesVersions) {
  const wildcard = readRecord(typesVersions["*"], "typesVersions wildcard");
  assertStringArrayEqual(readArray(wildcard["*"], "typesVersions wildcard entries"), ["types/*"], "typesVersions wildcard entries");
}

async function assertRequiredFilesExist() {
  await Promise.all(REQUIRED_FILES.map(async (relativePath) => {
    await access(new URL(`../${relativePath}`, import.meta.url));
  }));
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} properties
 * @param {string} key
 * @param {string} expectedType
 * @param {string | number | boolean} expectedDefault
 */
function assertConfigurationProperty(properties, key, expectedType, expectedDefault) {
  const property = readRecord(properties[key], key);
  assertEqual(property.type, expectedType, `${key} type`);
  assertEqual(property.default, expectedDefault, `${key} default`);
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue[]} commands
 * @param {string} commandId
 */
function assertIncludesCommand(commands, commandId) {
  if (!commands.some((command) => readRecord(command, "command contribution").command === commandId)) {
    throw new Error(`Missing command contribution ${commandId}.`);
  }
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue} value
 * @param {string} label
 * @returns {Record<string, import("../data/Codex.js").CodexJsonValue>}
 */
function readRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an object.`);
  }

  return /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (value);
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue} value
 * @param {string} label
 * @returns {import("../data/Codex.js").CodexJsonValue[]}
 */
function readArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an array.`);
  }

  return value;
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue} actual
 * @param {import("../data/Codex.js").CodexJsonValue} expected
 * @param {string} label
 */
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Expected ${label} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue} value
 * @param {string} label
 */
function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Expected ${label} to be a non-empty string.`);
  }
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} record
 * @param {string} key
 * @param {string} label
 */
function assertPropertyAbsent(record, key, label) {
  if (Object.hasOwn(record, key)) {
    throw new Error(`Expected ${label} to be absent, got ${JSON.stringify(record[key])}.`);
  }
}

/**
 * @param {import("../data/Codex.js").CodexJsonValue[]} actual
 * @param {string[]} expected
 * @param {string} label
 */
function assertStringArrayEqual(actual, expected, label) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} languageModelProvider
 */
function assertValidLanguageModelProviderKeys(languageModelProvider) {
  const actualKeys = Object.keys(languageModelProvider);
  const allowedKeys = new Set(["vendor", "displayName", "configuration", "managementCommand", "when"]);
  for (const key of actualKeys) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected language model provider contribution key: ${JSON.stringify(key)}.`);
    }
  }

  const requiredKeys = new Set(["vendor", "displayName"]);
  for (const key of requiredKeys) {
    if (!actualKeys.includes(key)) {
      throw new Error(`Missing required language model provider contribution key: ${JSON.stringify(key)}.`);
    }
  }
}

await main();
