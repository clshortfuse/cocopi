import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

/** @typedef {{ prependInstructions?: string, appendInstructions?: string }} GoalkeeperSettings */

export function goalkeeperDirectory() {
  return path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "cocopi-goalkeeper");
}

/** @param {string} directory */
export async function readGoalkeeperSettings(directory) {
  try {
    const settings = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"));
    return {
      prependInstructions: typeof settings?.prependInstructions === "string" ? settings.prependInstructions.trim() : "",
      appendInstructions: typeof settings?.appendInstructions === "string" ? settings.appendInstructions.trim() : ""
    };
  } catch {
    return {};
  }
}

/**
 * @param {GoalkeeperSettings} settings
 * @param {string} [directory]
 */
export async function writeGoalkeeperSettings(settings, directory = goalkeeperDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "settings.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(settings), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
