import { readFile } from "node:fs/promises";

/**
 * Parse a dotenv-style file without mutating process.env.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const values = {};

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    values[key] = unquoteEnvValue(rawValue);
  }

  return values;
}

/**
 * @param {string} filePath
 * @returns {Promise<Record<string, string>>}
 */
export async function readEnvFile(filePath) {
  return parseEnvFile(await readFile(filePath, "utf8"));
}

/**
 * Update or append values in dotenv-style text while preserving unrelated lines.
 * @param {string} text
 * @param {Record<string, string>} updates
 * @returns {string}
 */
export function upsertEnvValues(text, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = text.split(/\r?\n/u);
  const output = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      return rawLine;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      return rawLine;
    }

    const key = line.slice(0, separator).trim();
    if (!pending.has(key)) {
      return rawLine;
    }

    const value = pending.get(key) ?? "";
    pending.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });

  if (output.length > 0 && output.at(-1) === "") {
    output.pop();
  }

  for (const [key, value] of pending) {
    output.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${output.join("\n")}\n`;
}

/**
 * @param {string} value
 */
function unquoteEnvValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll(String.raw`\"`, '"').replaceAll(String.raw`\n`, "\n");
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * @param {string} value
 */
function formatEnvValue(value) {
  if (!value) {
    return "";
  }

  if (/^[A-Za-z0-9_./:@-]+$/u.test(value)) {
    return value;
  }

  return `"${value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`).replaceAll("\n", String.raw`\n`)}"`;
}